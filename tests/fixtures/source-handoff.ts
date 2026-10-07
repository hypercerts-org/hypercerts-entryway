import { MigrationError } from '../../src/features/external-migration/errors.js'
import type { SourceFixtureClient } from './source-client.js'

/**
 * Client for the fixture-only source signer. The fixture service enforces the
 * same four bindings. It has no general sign method and no source key input.
 */
export class BoundFixtureSourceHandoffSigner {
  public constructor(
    private readonly client: SourceFixtureClient,
    private readonly allowed: { did: string; rotationAuthorityKey: string; targetPdsUrl: string },
  ) {}

  public async signBoundHandoff(input: { workflowId: string; did: string; expectedPreviousCid: string; rotationAuthorityKey: string; targetPdsUrl: string }): Promise<{ operation: unknown; cid: string }> {
    if (input.did !== this.allowed.did || input.rotationAuthorityKey !== this.allowed.rotationAuthorityKey)
      throw new MigrationError('AuthorityNotDelegated', 'Source fixture rejected an unbound handoff request')
    const signed = await this.client.signBoundHandoff({
      did: input.did, expectedPreviousCid: input.expectedPreviousCid,
      rotationAuthorityKey: input.rotationAuthorityKey,
      targetPdsUrl: input.targetPdsUrl,
    })
    if (!signed.cid) throw new MigrationError('UnexpectedPlcHead', 'Source fixture did not report an operation CID')
    return signed
  }
}
