import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MigrationError } from '../../../../../entryway-core/src/pds-fleet/migration/errors.js'
import type { SnapshotManifest } from '../../../../../entryway-core/src/pds-fleet/migration/types.js'
import { verifySnapshotDigest } from './migration-snapshot.js'
import { parseMigrationJson, validateSnapshotManifest } from '../../../../../entryway-core/src/pds-fleet/migration/validation.js'

export interface SnapshotPayload {
  readonly manifest: SnapshotManifest
  readonly car: Uint8Array
  readonly blobs: readonly { cid: string; bytes: Uint8Array }[]
}

/** Bounded durable bytes. Only the manifest is stored in SQLite. */
export class MigrationPayloadStore {
  public constructor(private readonly root: string) {}
  private directory(workflowId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workflowId)) throw new MigrationError('MissingSnapshot', 'Invalid workflow identifier')
    return join(this.root, workflowId)
  }
  public async save(workflowId: string, payload: SnapshotPayload): Promise<void> {
    this.verify(payload)
    const directory = this.directory(workflowId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const files: [string, Uint8Array][] = [['repo.car', payload.car], ...payload.blobs.map((blob, i): [string, Uint8Array] => [`blob-${i}`, blob.bytes])]
    for (const [name, bytes] of files) {
      const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
      await writeFile(temporary, bytes, { mode: 0o600 })
      await rename(temporary, join(directory, name))
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(payload.manifest), { mode: 0o600 })
  }
  public async read(workflowId: string, expected: SnapshotManifest): Promise<SnapshotPayload> {
    const directory = this.directory(workflowId)
    try {
      const stored = validateSnapshotManifest(parseMigrationJson(await readFile(join(directory, 'manifest.json'), 'utf8'), 'SnapshotDigestMismatch'))
      const validExpected = validateSnapshotManifest(expected)
      if (JSON.stringify(stored) !== JSON.stringify(validExpected)) throw new MigrationError('SnapshotDigestMismatch', 'Snapshot manifest changed')
      const car = await readFile(join(directory, 'repo.car'))
      const blobs = await Promise.all(expected.blobs.map(async (blob, i) => ({ cid: blob.cid, bytes: await readFile(join(directory, `blob-${i}`)) })))
      const payload = { manifest: expected, car, blobs }
      this.verify(payload)
      return payload
    } catch (error) {
      if (error instanceof MigrationError) throw error
      throw new MigrationError('MissingSnapshot', 'Durable snapshot payload is missing')
    }
  }
  private verify(payload: SnapshotPayload): void {
    const { manifest, car, blobs } = payload
    validateSnapshotManifest(manifest)
    if (car.length !== manifest.carBytes || car.length === 0 || car.length > 32_000_000) throw new MigrationError('SnapshotDigestMismatch', 'CAR size differs from manifest')
    verifySnapshotDigest(car, manifest.carDigest)
    if (blobs.length !== manifest.blobs.length) throw new MigrationError('MissingSnapshot', 'Blob count differs from manifest')
    for (const [index, expected] of manifest.blobs.entries()) {
      const blob = blobs[index]
      if (!blob || blob.cid !== expected.cid || blob.bytes.length !== expected.bytes || blob.bytes.length > 8_000_000) throw new MigrationError('SnapshotDigestMismatch', 'Blob differs from manifest')
      verifySnapshotDigest(blob.bytes, expected.digest)
    }
  }
}
