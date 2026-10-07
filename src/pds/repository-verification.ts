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
}): Promise<{ targetCommit: string; targetSignatureValid: boolean }> {
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
    const car = await readCarWithRoot(input.targetCar);
    const commit = ensureV3Commit(
      await new MemoryBlockstore(car.blocks).readObj(
        car.root,
        def.versionedCommit,
      ),
    );
    return {
      targetCommit: target.commit.cid.toString(),
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
