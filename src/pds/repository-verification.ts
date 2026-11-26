import {
  MemoryBlockstore,
  def,
  ensureV3Commit,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepoCar,
} from "@atproto/repo";
import { DomainError } from "../accounts/errors.js";

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
