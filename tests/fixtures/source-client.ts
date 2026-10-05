import { cidForCbor } from '@atproto/common'
import { MigrationError } from '../../src/features/external-migration/errors.js'
import { isCid, isDidKey, isDigest, isPlcDid, isRecord, parseMigrationJson, validateJournaledOperation, validateSnapshotManifest } from '../../src/features/external-migration/validation.js'
import type { SnapshotManifest } from '../../src/features/external-migration/types.js'
import { MigrationPayloadStore } from '../../src/database/sqlite/migration-payload.js'

export interface SourceFixtureStatus {
  did: string; email: string; sourceHandle: string; sourcePdsUrl: string; targetPdsUrl: string
  sourceRecoveryKey: string; entrywayRotationKey: string; sourceRepositoryKey: string
  sourcePlcHead: string; head: string; record: { uri: string; cid: string; commit: { cid: string } }
  blobCid: string; blobSha256: string; frozen: boolean; sourceCommit?: string
}
const invalid = (): never => { throw new MigrationError('SourceChanged', 'Source fixture response is invalid') }
function fixtureStatus(value: unknown): SourceFixtureStatus {
  if (!isRecord(value) || !isPlcDid(value.did) || typeof value.email !== 'string' || !value.email.includes('@') || typeof value.sourceHandle !== 'string' || typeof value.sourcePdsUrl !== 'string' || !value.sourcePdsUrl.startsWith('https://') || typeof value.targetPdsUrl !== 'string' || !value.targetPdsUrl.startsWith('https://') || !isDidKey(value.sourceRecoveryKey) || !isDidKey(value.entrywayRotationKey) || !isDidKey(value.sourceRepositoryKey) || !isCid(value.sourcePlcHead) || (value.head !== undefined && !isCid(value.head)) || !isCid(value.blobCid) || !isDigest(value.blobSha256) || typeof value.frozen !== 'boolean' || (value.sourceCommit !== undefined && !isCid(value.sourceCommit)) || !isRecord(value.record) || typeof value.record.uri !== 'string' || !value.record.uri.startsWith(`at://${value.did}/`) || !isCid(value.record.cid) || !isRecord(value.record.commit) || !isCid(value.record.commit.cid)) return invalid()
  return {
    did: value.did, email: value.email, sourceHandle: value.sourceHandle,
    sourcePdsUrl: value.sourcePdsUrl, targetPdsUrl: value.targetPdsUrl,
    sourceRecoveryKey: value.sourceRecoveryKey, entrywayRotationKey: value.entrywayRotationKey,
    sourceRepositoryKey: value.sourceRepositoryKey, sourcePlcHead: value.sourcePlcHead,
    head: typeof value.head === 'string' ? value.head : value.sourcePlcHead,
    record: { uri: value.record.uri, cid: value.record.cid, commit: { cid: value.record.commit.cid } },
    blobCid: value.blobCid, blobSha256: value.blobSha256, frozen: value.frozen,
    ...(typeof value.sourceCommit === 'string' ? { sourceCommit: value.sourceCommit } : {}),
  }
}

export class SourceFixtureClient {
  public constructor(private readonly origin: string, private readonly token: string, private readonly payloads: MigrationPayloadStore) {}
  private async call(path: string, input?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.origin), {
      method: input === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), redirect: 'error', signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new MigrationError('SourceChanged', 'Source fixture rejected migration command')
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 60_000_000) throw new MigrationError('SourceChanged', 'Source fixture response exceeds limit')
    const chunks: Uint8Array[] = []
    let size = 0
    if (!response.body) throw new MigrationError('SourceChanged', 'Source fixture returned no response')
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 60_000_000) throw new MigrationError('SourceChanged', 'Source fixture response exceeds limit')
      chunks.push(chunk)
    }
    return parseMigrationJson(Buffer.concat(chunks).toString('utf8'), 'SourceChanged')
  }
  public async initialize(): Promise<SourceFixtureStatus> { return fixtureStatus(await this.call('/initialize', {})) }
  public async status(): Promise<SourceFixtureStatus> { return fixtureStatus(await this.call('/status')) }
  public async verifyOldCredentialsDenied(did: string): Promise<{ frozen: boolean; sourceCommit: string; oldSourceWriteDenied: boolean; oldTargetWriteDenied: boolean }> {
    const value = await this.call('/verify', { did })
    if (!isRecord(value) || value.frozen !== true || !isCid(value.sourceCommit) || value.oldSourceWriteDenied !== true || value.oldTargetWriteDenied !== true) return invalid()
    return { frozen: true, sourceCommit: value.sourceCommit, oldSourceWriteDenied: true, oldTargetWriteDenied: true }
  }
  public async observePlcHead(did: string): Promise<string> { const status = await this.status(); if (status.did !== did) throw new MigrationError('SourceChanged', 'Fixture DID differs'); return status.head }
  public async freezeSource(did: string): Promise<void> {
    const value = await this.call('/freeze', { did })
    if (!isRecord(value) || value.frozen !== true || !isCid(value.sourceCommit)) invalid()
  }
  public async captureSnapshot(did: string, workflowId: string): Promise<SnapshotManifest> {
    const response = await this.call('/snapshot', { did })
    if (!isRecord(response) || typeof response.carBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.carBase64) || !Array.isArray(response.blobs) || response.blobs.length > 100) return invalid()
    const manifest = validateSnapshotManifest(response.manifest)
    const blobs = response.blobs.map((blob, index) => {
      if (!isRecord(blob) || !isCid(blob.cid) || blob.cid !== manifest.blobs[index]?.cid || typeof blob.bytesBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob.bytesBase64)) return invalid()
      return { cid: blob.cid, bytes: Buffer.from(blob.bytesBase64, 'base64') }
    })
    await this.payloads.save(workflowId, { manifest, car: Buffer.from(response.carBase64, 'base64'), blobs })
    return manifest
  }
  public async signBoundHandoff(input: { did: string; expectedPreviousCid: string; entrywayRotationKey: string; targetPdsUrl: string }): Promise<{ operation: unknown; cid: string }> {
    const value = await this.call('/sign-handoff', input)
    if (!isRecord(value)) return invalid()
    validateJournaledOperation(value.operation, value.cid)
    const cid = String(await cidForCbor(value.operation))
    if (cid !== value.cid) throw new MigrationError('UnexpectedPlcHead', 'Source handoff CID differs from signed operation')
    return { operation: value.operation, cid }
  }
  public async publishPlcOperation(input: { did: string; operation: unknown; expectedPreviousCid: string; cid: string }): Promise<'published' | 'already-published'> {
    const response = await this.call('/publish', input)
    if (!isRecord(response) || !isCid(response.head) || typeof response.alreadyPublished !== 'boolean') return invalid()
    if (response.head !== input.cid) throw new MigrationError('UnexpectedPlcHead', 'Published handoff head differs')
    return response.alreadyPublished ? 'already-published' : 'published'
  }
}
