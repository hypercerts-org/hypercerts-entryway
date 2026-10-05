import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, exportJWK, jwtVerify } from 'jose'
import { createTargetAccessTokenSigner } from '../../dist/src/pds/access-token.js'
test('target token signer exposes only public custody metadata and pins audience',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('ES256K',{extractable:true})
  const privateJwk=await exportJWK(privateKey)
  const signer=await createTargetAccessTokenSigner({privateJwk,issuer:'https://entryway.test',audience:'did:web:target.test'})
  const signed=await signer.sign('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')
  const verified=await jwtVerify(signed,publicKey,{issuer:'https://entryway.test',audience:'did:web:target.test'})
  assert.equal(verified.payload.sub,'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(verified.payload.scope,'com.atproto.access')
  assert.equal(signer.publicInventoryItem.purpose,'oauth-issuer')
  assert.ok(!JSON.stringify(signer.publicInventoryItem).includes(privateJwk.d))
})
