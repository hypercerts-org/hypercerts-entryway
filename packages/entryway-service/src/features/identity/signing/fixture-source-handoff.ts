import { MigrationError } from '../../../../../entryway-core/src/pds-fleet/migration/errors.js'
import type { SourceHandoffSigner } from '../../../../../entryway-core/src/identity/custody/port.js'

export interface FixtureSourceSignerClient {
  signBoundHandoff(input: { did: string; expectedPreviousCid: string; entrywayRotationKey: string; targetPdsUrl: string }): Promise<{ operation: unknown; cid: string }>
}

/**
 * Client for the fixture-only source signer. The fixture service enforces the
 * same four bindings. It has no general sign method and no source key input.
 */
export class BoundFixtureSourceHandoffSigner implements SourceHandoffSigner {
  public constructor(
    private readonly client: FixtureSourceSignerClient,
    private readonly allowed: { did: string; entrywayRotationKey: string; targetPdsUrl: string },
  ) {}

  public async signBoundHandoff(input: { workflowId: string; did: string; expectedPreviousCid: string; entrywayRotationKey: string; targetPdsUrl: string }): Promise<{ operation: unknown; cid: string }> {
    if (input.did !== this.allowed.did || input.entrywayRotationKey !== this.allowed.entrywayRotationKey)
      throw new MigrationError('AuthorityNotDelegated', 'Source fixture rejected an unbound handoff request')
    const signed = await this.client.signBoundHandoff({
      did: input.did, expectedPreviousCid: input.expectedPreviousCid,
      entrywayRotationKey: input.entrywayRotationKey,
      targetPdsUrl: input.targetPdsUrl,
    })
    if (!signed.cid) throw new MigrationError('UnexpectedPlcHead', 'Source fixture did not report an operation CID')
    return signed
  }
}
