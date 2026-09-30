import { cidForCbor } from '@atproto/common'
import { Secp256k1Keypair } from '@atproto/crypto'
import * as plc from '@did-plc/lib'
import { MigrationError } from '../../../../../entryway-core/src/pds-fleet/migration/errors.js'
import type { EntrywayPlcSigner } from '../../../../../entryway-core/src/identity/custody/port.js'

/** The private rotation key is received only at composition. */
export class Secp256k1MigrationPlcSigner implements EntrywayPlcSigner {
  public readonly keyReference: string
  private constructor(private readonly key: Secp256k1Keypair, keyReference: string) { this.keyReference = keyReference }
  public static async fromHex(hex: string, keyReference = 'entryway-plc-rotation'): Promise<Secp256k1MigrationPlcSigner> {
    const key = await Secp256k1Keypair.import(Buffer.from(hex, 'hex'))
    return new Secp256k1MigrationPlcSigner(key, keyReference)
  }
  public publicKey(): string { return this.key.did() }
  public async signMigrationMove(input: { workflowId: string; did: string; handoffOperation: unknown; targetPdsUrl: string; targetRepositoryKey: string; handle: string }): Promise<{ operation: unknown; cid: string }> {
    void input.workflowId
    const previous = input.handoffOperation as plc.Operation
    const normalized = plc.normalizeOp(previous)
    if (!normalized.rotationKeys.includes(this.key.did())) throw new MigrationError('AuthorityNotDelegated', 'Entryway authority is absent from handoff')
    const operation = await plc.createUpdateOp(previous, this.key, op => ({
      ...op,
      alsoKnownAs: [`at://${input.handle}`],
      verificationMethods: { ...op.verificationMethods, atproto: input.targetRepositoryKey },
      services: { ...op.services, atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: input.targetPdsUrl } },
    }))
    return { operation, cid: String(await cidForCbor(operation)) }
  }
}
