import {
  MemoryBlockstore,
  def,
  ensureV3Commit,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepoCar,
} from "@atproto/repo";
import { DomainError } from "../accounts/errors.js";

/** The import target must reproduce this exact source-signed commit before re-signing. */
export async function verifyFrozenRepositoryRoot(
  car: Uint8Array,
  did: string,
  signingKey: string,
  observedHead: string,
): Promise<string> {
  try {
    if (!signingKey || !observedHead) throw Error("MissingSourceIdentity");
    const repo = await verifyRepoCar(car, did, signingKey);
    const root = repo.commit.cid.toString();
    if (root !== observedHead) throw Error("SourceHeadMismatch");
    return root;
  } catch {
    throw new DomainError(
      "OperationRecoveryRequired",
      409,
      "The source repository does not verify against its recorded signing key and frozen head",
    );
  }
}

/** The retained repository must be a signed, unchanged subset of the snapshot. */
export async function verifyRetainedAdditive(input: {
  sourceCar: Uint8Array;
  targetCar: Uint8Array;
  did: string;
  sourceSigningKey: string;
  sourceRoot: string;
  targetSigningKey: string;
  targetRoot: string;
}): Promise<void> {
  try {
    const source = await verifyRepoCar(
      input.sourceCar,
      input.did,
      input.sourceSigningKey,
    );
    const target = await verifyRepoCar(
      input.targetCar,
      input.did,
      input.targetSigningKey,
    );
    if (
      String(source.commit.cid) !== input.sourceRoot ||
      String(target.commit.cid) !== input.targetRoot
    )
      throw Error("HeadMismatch");
    const records = new Map(
      source.creates.map((r) => [`${r.collection}/${r.rkey}`, String(r.cid)]),
    );
    if (
      target.creates.some(
        (r) => records.get(`${r.collection}/${r.rkey}`) !== String(r.cid),
      )
    )
      throw Error("NotAdditive");
  } catch {
    throw new DomainError(
      "OperationRecoveryRequired",
      409,
      "The retained repository is not a verified additive baseline",
    );
  }
}

/** Compare verified record CID inventories, not record counts. CAR decoding also
 * verifies each included CID and requires every referenced record leaf. */
export async function verifyRepositorySnapshot(input: {
  sourceCar: Uint8Array;
  targetCar: Uint8Array;
  did: string;
  sourceCommit: string;
  targetSigningKey: string;
  sourceSigningKey?: string;
}): Promise<{
  targetCommit: string;
  targetSignatureValid: boolean;
  recordCount: number;
}> {
  try {
    const source = await verifyRepoCar(input.sourceCar, input.did);
    const target = await verifyRepoCar(input.targetCar, input.did);
    const inventory = (records: typeof source.creates) =>
      records
        .map(
          (record) =>
            `${record.collection}/${record.rkey}/${record.cid.toString()}`,
        )
        .sort();
    if (
      source.commit.cid.toString() !== input.sourceCommit ||
      JSON.stringify(inventory(source.creates)) !==
        JSON.stringify(inventory(target.creates))
    )
      throw Error("SnapshotDiverged");
    if (input.sourceSigningKey !== undefined) {
      const sourceCar = await readCarWithRoot(input.sourceCar);
      const sourceCommit = ensureV3Commit(
        await new MemoryBlockstore(sourceCar.blocks).readObj(
          sourceCar.root,
          def.versionedCommit,
        ),
      );
      if (!(await verifyCommitSig(sourceCommit, input.sourceSigningKey)))
        throw Error("InvalidSourceSignature");
    }
    const car = await readCarWithRoot(input.targetCar);
    const commit = ensureV3Commit(
      await new MemoryBlockstore(car.blocks).readObj(
        car.root,
        def.versionedCommit,
      ),
    );
    return {
      targetCommit: target.commit.cid.toString(),
      recordCount: source.creates.length,
      targetSignatureValid: await verifyCommitSig(
        commit,
        input.targetSigningKey,
      ),
    };
  } catch {
    throw new DomainError(
      "OperationRecoveryRequired",
      409,
      "The target repository differs from the saved snapshot or cannot be verified; keep the account pending for operator inspection",
    );
  }
}
