import { MigrationError } from "./errors.js";
import type {
  MigrationCommand,
  MigrationPhase,
  MigrationWorkflow,
} from "./types.js";

const order: readonly MigrationPhase[] = [
  "owner-confirmed",
  "source-frozen",
  "snapshot-ready",
  "handoff-journaled",
  "authority-handed-off",
  "move-journaled",
  "target-created",
  "repo-imported",
  "blobs-imported",
  "target-ready",
  "account-bound",
  "complete",
];

export function commandFor(workflow: MigrationWorkflow): MigrationCommand {
  switch (workflow.phase) {
    case "owner-confirmed":
      return { kind: "freeze-source" };
    case "source-frozen":
      return { kind: "capture-snapshot" };
    case "snapshot-ready":
      return { kind: "obtain-source-handoff" };
    case "handoff-journaled":
      return { kind: "publish-source-handoff" };
    case "authority-handed-off":
      return { kind: "sign-entryway-move" };
    case "move-journaled":
      return { kind: "create-inactive-target" };
    case "target-created":
      return { kind: "import-repository" };
    case "repo-imported":
      return { kind: "import-blobs" };
    case "blobs-imported":
      return { kind: "verify-target" };
    case "target-ready":
      return { kind: "complete-binding" };
    case "account-bound":
      return { kind: "activate-target" };
    case "complete":
      throw new MigrationError(
        "ManualRecoveryRequired",
        "Migration is already complete",
      );
    case "manual-recovery-required":
      return { kind: "manual-recovery" };
  }
}

export function advances(from: MigrationPhase, to: MigrationPhase): boolean {
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  return fromIndex >= 0 && toIndex === fromIndex + 1;
}

export function advance(
  workflow: MigrationWorkflow,
  phase: MigrationPhase,
  changes: Partial<MigrationWorkflow> = {},
): MigrationWorkflow {
  if (!advances(workflow.phase, phase))
    throw new MigrationError(
      "ManualRecoveryRequired",
      "Illegal migration checkpoint transition",
    );
  return {
    ...workflow,
    ...changes,
    phase,
    version: workflow.version + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function requireSameOwner(
  workflow: MigrationWorkflow,
  userId: string,
): void {
  if (workflow.ownerUserId !== userId)
    throw new MigrationError(
      "OwnerBindingChanged",
      "Verified destination owner changed",
    );
}

export function reconcileTargetCreation(input: {
  did: string;
  handle: string;
  previousCid: string;
  operationCid: string;
  observedCid: string;
  account: { did: string; handle?: string } | null;
}): "create" | "already-created" {
  if (input.account) {
    if (
      input.account.did === input.did &&
      input.account.handle === input.handle &&
      input.observedCid === input.operationCid
    )
      return "already-created";
    throw new MigrationError(
      "TargetConflict",
      "Existing target differs from journaled move",
    );
  }
  if (input.observedCid === input.operationCid)
    throw new MigrationError(
      "TargetConflict",
      "Move is published but the target account is absent",
    );
  if (input.observedCid !== input.previousCid)
    throw new MigrationError(
      "UnexpectedPlcHead",
      "PLC head differs before target creation",
    );
  return "create";
}
