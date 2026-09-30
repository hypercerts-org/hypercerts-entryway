import assert from 'node:assert/strict'
import test from 'node:test'
import { requestFailureEvent } from '../../dist/packages/entryway-service/src/infra/logging/request-event.js'

test('unexpected transport failure logs only a stable code and status', () => {
  const marker = 'synthetic-private-token-marker'
  const operationId = '2d00ada4-5c26-4a8b-844d-47d221768e47'
  const event = requestFailureEvent(503, new Error(`Transport failed: ${marker}`), operationId)
  assert.deepEqual(event, { event: 'request.failed', status: 503, code: 'RequestFailed', operationId })
  assert.equal(JSON.stringify(event).includes(marker), false)
  assert.deepEqual(requestFailureEvent(409, { error: 'IdentityConflict', message: marker }, operationId), {
    event: 'request.failed', status: 409, code: 'IdentityConflict', operationId,
  })
  assert.equal(requestFailureEvent(401, { error: 'AuthRequired' }, operationId).code, 'AuthRequired')
  assert.deepEqual(requestFailureEvent(502, { error: 'SyntheticPrivateToken123', message: marker }, operationId), {
    event: 'request.failed', status: 502, code: 'RequestFailed', operationId,
  })
})
