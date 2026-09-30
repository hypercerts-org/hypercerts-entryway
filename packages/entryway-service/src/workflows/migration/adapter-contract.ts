import type { ExternalMigrationServiceDependencies } from './adapter.js'
import type { SourceFixtureClient } from '../../features/pds-fleet/adapters/source-fixture-client.js'
import type { PdsHttpMigrationAdapter } from '../../features/pds-fleet/adapters/pds-http-adapter.js'

/** Compile-time proof that the actual transport adapters satisfy the service ports. */
type Assert<T extends true> = T
export type SourceAdapterContract = Assert<SourceFixtureClient extends ExternalMigrationServiceDependencies['source'] ? true : false>
export type TargetAdapterContract = Assert<PdsHttpMigrationAdapter extends ExternalMigrationServiceDependencies['target'] ? true : false>
