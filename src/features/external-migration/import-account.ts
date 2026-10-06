import { advance, commandFor, requireSameOwner } from "./state-machine.js";
import { createHash } from "node:crypto";
import { publicKeyAlgorithm } from "../../plc/custody.js";
import { MigrationError } from "./errors.js";
import type {
  DestinationPrincipalPort,
  MigrationWorkflowReader,
  MigrationWorkflowTransactor,
  SnapshotReader,
  SnapshotTransactor,
  MigrationStartTransactor,
} from "../../database/migration-journal.port.js";
import type {
  MigrationPhase,
  MigrationWorkflow,
  PublicAuthorityEvidence,
} from "./types.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
import type { PdsMigrationClient } from "../../pds/migration-client.js";
// The only current caller is the synthetic managed migration harness. These
// concrete fixture types disappear from emitted JavaScript; no fixture endpoint
// or private source authority is promoted into production composition. A real
// provider implementation remains a separate product acceptance requirement.
import type { SourceFixtureClient } from "../../../tests/fixtures/source-client.js";
import type { BoundFixtureSourceHandoffSigner } from "../../../tests/fixtures/source-handoff.js";
import type { CustodyInventoryTransactor } from "../../database/custody.port.js";
import type { PublicKeyInventoryItem } from "../../plc/types.js";

export class FixtureCheckpointPause extends Error {
  public constructor(public readonly phase: MigrationPhase) {
    super(`Paused after ${phase}`);
  }
}
export interface StartExternalMigration {
  readonly workflowId: string;
  readonly did: string;
  readonly ownerUserId: string;
  readonly ownerSessionId: string;
  readonly sourceEmail: string;
  readonly handle: string;
  readonly sourcePdsUrl: string;
  readonly targetPdsId: string;
  readonly targetPdsUrl: string;
  readonly authority: PublicAuthorityEvidence;
}
const moved: readonly MigrationPhase[] = [
  "target-created",
  "repo-imported",
  "blobs-imported",
  "target-ready",
  "account-bound",
  "complete",
];

export class ExternalMigrationService {
  public constructor(
    private readonly d: {
      readonly workflows: MigrationWorkflowReader & MigrationWorkflowTransactor;
      readonly start: MigrationStartTransactor;
      readonly snapshots: SnapshotReader & SnapshotTransactor;
      readonly accounts: DestinationPrincipalPort;
      readonly source: SourceFixtureClient;
      readonly target: PdsMigrationClient;
      readonly sourceHandoffSigner: BoundFixtureSourceHandoffSigner;
      readonly plcRotationSigner: Secp256k1MigrationPlcSigner;
      readonly audit: (input: {
        workflowId: string;
        event: string;
        phase: string;
      }) => void;
      readonly custody: CustodyInventoryTransactor;
      readonly oauthIssuerKey: PublicKeyInventoryItem;
      readonly checkpointObserver?: (
        workflow: MigrationWorkflow,
      ) => Promise<void>;
    },
  ) {}
  public async start(
    input: StartExternalMigration,
  ): Promise<MigrationWorkflow> {
    const owner = await this.d.accounts.getVerifiedOwner({
      userId: input.ownerUserId,
      sessionId: input.ownerSessionId,
    });
    if (!owner)
      throw new MigrationError(
        "OwnerBindingChanged",
        "A recent verified destination session is required",
      );
    if (owner.email.toLowerCase() !== input.sourceEmail.toLowerCase())
      throw new MigrationError(
        "OwnerBindingChanged",
        "Verified destination email differs from source identity",
      );
    if (await this.d.workflows.getByDid(input.did))
      throw new MigrationError(
        "ManualRecoveryRequired",
        "A migration workflow already exists for this DID",
      );
    const head = await this.d.source.observePlcHead(input.did);
    if (head !== input.authority.sourcePlcHead)
      throw new MigrationError(
        "UnexpectedPlcHead",
        "Source PLC head differs from public evidence",
      );
    const now = new Date().toISOString();
    const workflow: MigrationWorkflow = {
      id: input.workflowId,
      did: input.did,
      ownerUserId: owner.userId,
      ownerEmail: owner.email.toLowerCase(),
      ownerSessionReference: input.ownerSessionId,
      handle: input.handle,
      sourcePdsUrl: input.sourcePdsUrl,
      targetPdsId: input.targetPdsId,
      targetPdsUrl: input.targetPdsUrl,
      authority: input.authority,
      phase: "owner-confirmed",
      expectedPlcHead: head,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const reservation = {
      workflowId: workflow.id,
      did: workflow.did,
      userId: owner.userId,
      sessionId: input.ownerSessionId,
      targetPdsId: workflow.targetPdsId,
      targetPdsUrl: workflow.targetPdsUrl,
      handle: workflow.handle,
    };
    await this.d.start.createReservedWorkflow({ reservation, workflow });
    this.audit(workflow, "created");
    return workflow;
  }
  public async resume(
    workflowId: string,
    actor: { userId: string; sessionId: string },
  ): Promise<MigrationWorkflow> {
    const workflow = await this.d.workflows.getById(workflowId);
    if (!workflow)
      throw new MigrationError(
        "ManualRecoveryRequired",
        "Migration workflow is missing",
      );
    requireSameOwner(workflow, actor.userId);
    const owner = await this.d.accounts.getVerifiedOwner(actor);
    if (
      !owner ||
      owner.userId !== workflow.ownerUserId ||
      owner.email.toLowerCase() !== workflow.ownerEmail
    )
      throw new MigrationError(
        "OwnerBindingChanged",
        "Recent verified destination ownership changed",
      );
    return this.execute(workflow, owner.email, actor.sessionId);
  }
  private async transition(
    before: MigrationWorkflow,
    after: MigrationWorkflow,
    id: string,
  ): Promise<void> {
    await this.d.workflows.transition(before, after, id);
    this.audit(after, id);
    await this.d.checkpointObserver?.(after);
  }
  private async execute(
    initial: MigrationWorkflow,
    email: string,
    currentSessionId: string,
  ): Promise<MigrationWorkflow> {
    let w = initial;
    try {
      await this.assertHead(w);
      while (w.phase !== "complete") {
        if (moved.includes(w.phase)) await this.ensureInventory(w);
        switch (commandFor(w).kind) {
          case "freeze-source":
            await this.d.source.freezeSource(w.did);
            {
              const n = advance(w, "source-frozen");
              await this.transition(w, n, "freeze-source");
              w = n;
            }
            break;
          case "capture-snapshot":
            {
              const m = await this.d.source.captureSnapshot(w.did, w.id);
              await this.d.snapshots.save(w.id, m);
              const n = advance(w, "snapshot-ready", {
                snapshotDigest: m.carDigest,
              });
              await this.transition(w, n, "capture-snapshot");
              w = n;
            }
            break;
          case "obtain-source-handoff":
            {
              const s = await this.d.sourceHandoffSigner.signBoundHandoff({
                workflowId: w.id,
                did: w.did,
                expectedPreviousCid: w.expectedPlcHead ?? "",
                rotationAuthorityKey: w.authority.rotationAuthorityKey,
                targetPdsUrl: w.targetPdsUrl,
              });
              const n = advance(w, "handoff-journaled", {
                handoffOperation: s.operation,
                handoffOperationCid: s.cid,
              });
              await this.transition(w, n, "journal-source-handoff");
              w = n;
            }
            break;
          case "publish-source-handoff":
            {
              await this.requireOwner(w, currentSessionId);
              await this.snapshot(w);
              await this.d.target.verifySnapshotPayload(w.id);
              const handoffCid = w.handoffOperationCid;
              if (!handoffCid)
                throw new MigrationError(
                  "ManualRecoveryRequired",
                  "Journaled source handoff is missing its CID",
                );
              await this.d.source.publishPlcOperation({
                did: w.did,
                operation: w.handoffOperation,
                cid: handoffCid,
                expectedPreviousCid: w.expectedPlcHead ?? "",
              });
              const n = advance(w, "authority-handed-off", {
                expectedPlcHead: handoffCid,
              });
              await this.transition(w, n, "publish-source-handoff");
              w = n;
            }
            break;
          case "sign-entryway-move":
            {
              await this.assertHead(w);
              const k = await this.d.target.reserveTargetRepositoryKey(w.did);
              const s = await this.d.plcRotationSigner.signMigrationMove({
                workflowId: w.id,
                did: w.did,
                handoffOperation: w.handoffOperation,
                targetPdsUrl: w.targetPdsUrl,
                targetRepositoryKey: k,
                handle: w.handle,
              });
              const n = advance(w, "move-journaled", {
                moveOperation: s.operation,
                moveOperationCid: s.cid,
                targetRepositoryKey: k,
              });
              await this.transition(w, n, "journal-entryway-move");
              w = n;
            }
            break;
          case "create-inactive-target":
            await this.requireOwner(w, currentSessionId);
            await this.snapshot(w);
            await this.d.target.verifySnapshotPayload(w.id);
            await this.assertHead(w);
            await this.d.target.createInactiveTarget({
              did: w.did,
              handle: w.handle,
              operation: w.moveOperation,
            });
            {
              const n = advance(w, "target-created");
              await this.transition(w, n, "create-inactive-target");
              w = n;
            }
            break;
          case "import-repository":
            await this.snapshot(w);
            await this.d.target.importRepository({
              did: w.did,
              workflowId: w.id,
            });
            {
              const n = advance(w, "repo-imported");
              await this.transition(w, n, "import-repository");
              w = n;
            }
            break;
          case "import-blobs":
            await this.snapshot(w);
            await this.d.target.importBlobs({ did: w.did, workflowId: w.id });
            {
              const n = advance(w, "blobs-imported");
              await this.transition(w, n, "import-blobs");
              w = n;
            }
            break;
          case "verify-target":
            {
              const m = await this.snapshot(w);
              await this.d.target.verifyInactiveTarget({
                did: w.did,
                manifest: m,
                expectedRepositoryKey: w.targetRepositoryKey ?? "",
              });
              const n = advance(w, "target-ready");
              await this.transition(w, n, "verify-target");
              w = n;
            }
            break;
          case "complete-binding":
            await this.requireOwner(w, currentSessionId);
            await this.assertHead(w);
            await this.d.accounts.finalizeImportedAccount({
              workflowId: w.id,
              did: w.did,
              userId: w.ownerUserId,
              email,
              handle: w.handle,
              pdsId: w.targetPdsId,
              pdsUrl: w.targetPdsUrl,
            });
            {
              const n = advance(w, "account-bound");
              await this.transition(w, n, "finalize-account-binding");
              w = n;
            }
            break;
          case "activate-target":
            await this.requireOwner(w, currentSessionId);
            await this.assertHead(w);
            await this.d.target.activateTarget(w.did);
            await this.d.accounts.activateImportedAccount({
              workflowId: w.id,
              did: w.did,
              userId: w.ownerUserId,
            });
            {
              const n = advance(w, "complete");
              await this.transition(w, n, "activate-target");
              w = n;
            }
            break;
          case "manual-recovery":
            return w;
        }
      }
      return w;
    } catch (error: unknown) {
      if (error instanceof FixtureCheckpointPause) throw error;
      if (!(error instanceof MigrationError)) {
        await this.d.workflows.markRetryable({
          ...w,
          stableErrorCode: "RetryPending",
        });
        this.audit(w, "retry-pending");
        throw error;
      }
      const blocked: MigrationWorkflow = {
        ...w,
        phase: "manual-recovery-required",
        stableErrorCode: error.code,
        version: w.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.d.workflows.markManualRecovery(blocked);
      this.audit(blocked, "manual-recovery-required");
      throw error;
    }
  }
  private async assertHead(w: MigrationWorkflow): Promise<void> {
    const observed = await this.d.source.observePlcHead(w.did);
    const accepted =
      w.phase === "handoff-journaled" || w.phase === "move-journaled"
        ? [w.expectedPlcHead, w.handoffOperationCid, w.moveOperationCid]
        : moved.includes(w.phase)
          ? [w.moveOperationCid]
          : [w.expectedPlcHead];
    if (!accepted.includes(observed))
      throw new MigrationError(
        "UnexpectedPlcHead",
        "Observed PLC head differs from recorded workflow intent",
      );
  }
  private async requireOwner(
    w: MigrationWorkflow,
    sessionId: string,
  ): Promise<void> {
    const owner = await this.d.accounts.getVerifiedOwner({
      userId: w.ownerUserId,
      sessionId,
    });
    if (
      !owner ||
      owner.userId !== w.ownerUserId ||
      owner.email.toLowerCase() !== w.ownerEmail
    )
      throw new MigrationError(
        "OwnerBindingChanged",
        "Verified owner session is no longer current",
      );
  }
  private async snapshot(w: MigrationWorkflow) {
    const m = await this.d.snapshots.getManifest(w.id);
    if (!m)
      throw new MigrationError(
        "MissingSnapshot",
        "Durable migration snapshot is missing",
      );
    if (m.carDigest !== w.snapshotDigest)
      throw new MigrationError(
        "SnapshotDigestMismatch",
        "Snapshot digest no longer matches the workflow",
      );
    return m;
  }
  private audit(w: MigrationWorkflow, event: string): void {
    this.d.audit({ workflowId: w.id, event, phase: w.phase });
  }
  private async ensureInventory(workflow: MigrationWorkflow): Promise<void> {
    if (!workflow.targetRepositoryKey)
      throw new MigrationError(
        "InvalidCustodyInventory",
        "Target repository key is missing",
      );
    const publicKey = (
      keyReference: string,
      purpose: "source-recovery" | "entryway-plc" | "pds-repository",
      custodian: "user" | "entryway" | "pds",
    ): PublicKeyInventoryItem => ({
      keyReference,
      purpose,
      custodian,
      algorithm: publicKeyAlgorithm(keyReference),
      fingerprint: `sha256:${createHash("sha256").update(keyReference).digest("hex")}`,
      lifecycle: "active",
    });
    await this.d.custody.save({
      did: workflow.did,
      keys: [
        publicKey(
          workflow.authority.sourceRecoveryKey,
          "source-recovery",
          "user",
        ),
        publicKey(
          workflow.authority.rotationAuthorityKey,
          "entryway-plc",
          "entryway",
        ),
        publicKey(workflow.targetRepositoryKey, "pds-repository", "pds"),
        this.d.oauthIssuerKey,
      ],
    });
  }
}
