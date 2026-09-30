import { decodeProtectedHeader } from 'jose'
import { createHash, timingSafeEqual } from 'node:crypto'
import { verifyJwt } from '@atproto/xrpc-server'
import { getVerificationMaterial } from '@atproto/common'
import { getDidKeyFromMultibase } from '@atproto/identity'
import { ScopePermissionsTransition } from '@atproto/oauth-scopes'
import { HttpError } from './accounts.mjs'

export const phaseOneUnsupported = [
  'com.atproto.server.createSession',
  'com.atproto.server.refreshSession',
  'com.atproto.server.deleteSession',
  'com.atproto.server.createAppPassword',
  'com.atproto.server.listAppPasswords',
  'com.atproto.server.revokeAppPassword',
  'com.atproto.server.getAccountInviteCodes',
  'com.atproto.server.checkAccountStatus',
  'com.atproto.server.reserveSigningKey',
  'com.atproto.server.requestEmailConfirmation',
  'com.atproto.server.confirmEmail',
  'com.atproto.server.requestEmailUpdate',
  'com.atproto.server.updateEmail',
  'com.atproto.server.requestPasswordReset',
  'com.atproto.server.resetPassword',
  'com.atproto.server.requestAccountDelete',
  'com.atproto.server.deleteAccount',
  'com.atproto.server.activateAccount',
  'com.atproto.server.deactivateAccount',
  'com.atproto.identity.requestPlcOperationSignature',
  'com.atproto.identity.signPlcOperation',
  'com.atproto.identity.submitPlcOperation',
  'com.atproto.temp.dereferenceScope',
  'com.atproto.temp.checkSignupQueue',
  'com.atproto.temp.requestPhoneVerification',
  'com.atproto.admin.sendEmail',
  'com.atproto.admin.updateAccountEmail',
  'com.atproto.admin.updateAccountPassword',
]
export const unsupported = []
export async function mountXrpc({
  app,
  db,
  config,
  accounts,
  oauth,
  legacy,
  security,
  extras,
  migration,
  reconcile,
}) {
  const fullLegacy = new Set([
    'createAppPassword',
    'getAccountInviteCodes',
    'requestEmailUpdate',
    'updateEmail',
    'requestAccountDelete',
    'activateAccount',
    'deactivateAccount',
    'requestPlcOperationSignature',
    'signPlcOperation',
    'createAccount',
  ])
  const checkCredentialCreation = (req, did) => {
    if (req.legacyCredential) legacy.assertAccessCurrent(req.legacyCredential)
    if (!req.auth?.service) return
    const revokedAt = db.get('security:revoked-at', did)
    const releaseAt = Number(revokedAt) + 5 * 60_000
    if (
      revokedAt &&
      (Date.now() < releaseAt || new Date(req.auth.authenticatedAt).getTime() < releaseAt)
    )
      throw new HttpError(
        403,
        'ReauthenticationRequired',
        'Use the entryway account console or sign in directly to entryway; PDS credential creation is temporarily paused after a security change',
      )
  }
  const authenticate = async (req, nsid) => {
    const method = nsid.split('.').at(-1)
    if (req.headers.authorization?.startsWith('DPoP ')) {
      req.res.set('DPoP-Nonce', oauth.provider.nextDpopNonce())
      let payload
      try {
        payload = await oauth.provider.authenticateRequest(
          req.method,
          new URL(req.originalUrl, config.issuer),
          req.headers,
          { audience: config.pds.map((p) => p.did), scope: ['atproto'] },
        )
      } catch (error) {
        if (error.wwwAuthenticateHeader)
          req.res.set('WWW-Authenticate', error.wwwAuthenticateHeader)
        throw new HttpError(401, 'InvalidToken', error.message)
      }
      const account = accounts.get(payload.sub)
      if (!account || ['deleted', 'provisioning'].includes(account.status))
        throw new HttpError(403, 'AccountUnavailable', 'Account unavailable')
      if (req.body?.did && req.body.did !== account.did)
        throw new HttpError(403, 'Forbidden', 'Subject does not match credential')
      req.permissions = new ScopePermissionsTransition(payload.scope)
      let allowed = ['getSession', 'checkAccountStatus'].includes(method)
      if (method === 'updateHandle') allowed = req.permissions.allowsIdentity({ attr: 'handle' })
      if (
        ['requestPlcOperationSignature', 'signPlcOperation', 'submitPlcOperation'].includes(method)
      )
        allowed = req.permissions.allowsIdentity({ attr: '*' })
      if (['requestEmailConfirmation', 'confirmEmail'].includes(method))
        allowed = req.permissions.allowsAccount({ attr: 'email', action: 'manage' })
      if (!allowed)
        throw new HttpError(
          403,
          'InsufficientScope',
          'This credential cannot authorize the account operation',
        )
      req.auth = { did: account.did, kind: 'oauth', authenticatedAt: new Date(payload.iat * 1000) }
      return account
    }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    if (!match)
      throw new HttpError(401, 'AuthRequired', 'A supported authorization credential is required')
    const token = match[1]
    let did
    try {
      const { typ } = decodeProtectedHeader(token)
      if (typ === 'at+jwt') {
        const credential = await legacy.verifyAccess(token, { full: fullLegacy.has(method) })
        req.legacyCredential = credential
        did = credential.account.did
        req.auth = { did, kind: 'legacy', authenticatedAt: new Date(), scope: credential.scope }
      } else {
        const payload = await verifyJwt(token, config.serviceDid, nsid, async (iss) => {
          if (iss.includes('#')) throw new Error('Unsupported signing identity')
          const doc = await accounts.plcClient.getDocument(iss)
          const material = getVerificationMaterial(doc, 'atproto')
          if (!material) throw new Error('Missing signing key')
          return getDidKeyFromMultibase(material)
        })
        did = payload.iss
        req.auth = {
          did,
          kind: 'legacy',
          authenticatedAt: new Date(payload.iat * 1000),
          service: true,
        }
        const now = Math.floor(Date.now() / 1000)
        if (
          typeof payload.jti !== 'string' ||
          !payload.jti ||
          !Number.isInteger(payload.iat) ||
          !Number.isInteger(payload.exp) ||
          payload.iat > now + 60 ||
          payload.exp - payload.iat > 300 ||
          payload.exp <= payload.iat
        )
          throw new Error('Invalid service token claims')
        for (const { key, value } of db.list('service-replay'))
          if (value.expiresAt < now) db.delete('service-replay', key)
        if (payload.jti) {
          const replayKey = `${did}:${payload.jti}`
          if (db.get('service-replay', replayKey)) throw new Error('Replayed service credential')
          db.set('service-replay', replayKey, { expiresAt: payload.exp })
        }
      }
    } catch (e) {
      if (e.status === 403) throw e
      throw new HttpError(401, 'InvalidToken', 'Invalid authorization credential')
    }
    const account = accounts.get(did)
    if (!account || account.status === 'deleted' || account.status === 'provisioning')
      throw new HttpError(401, 'AccountNotFound', 'Account not found')
    // The signature proves control of the user's repository key; never trust a
    // body.did supplied independently of that verified subject.
    if (req.body?.did && req.body.did !== did)
      throw new HttpError(403, 'Forbidden', 'Subject does not match credential')
    if (method === 'createAppPassword') checkCredentialCreation(req, did)
    return account
  }
  const route = (verb, name, fn) =>
    app[verb](`/xrpc/com.atproto.${name}`, async (req, res, next) => {
      try {
        if (
          req.body !== undefined &&
          (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        )
          throw new HttpError(400, 'InvalidRequest', 'Expected an object request body')
        req.body ??= {}
        res.set('Cache-Control', 'no-store')
        res.json((await fn(req)) ?? {})
      } catch (e) {
        next(e)
      }
    })
  const authenticatedRoute = (verb, name, fn) =>
    route(verb, name, async (req) => {
      const account = await authenticate(req, `com.atproto.${name}`)
      if (req.legacyCredential) legacy.assertAccessCurrent(req.legacyCredential)
      if (name === 'server.createAppPassword') checkCredentialCreation(req, account.did)
      return fn(req, account)
    })
  const migrationPrincipal = async (req) => {
    const session = await oauth.requireSession(req)
    if (session?.user?.emailVerified) {
      const account = accounts.get(session.user.email.toLowerCase())
      if (!account) throw new HttpError(404, 'AccountNotFound', 'Account not found')
      const browser = await oauth.loadBrowser(req, req.res)
      oauth.checkCsrf(req, browser)
      return {
        did: account.did,
        userId: session.user.id,
        sessionId: session.session.id,
        kind: 'better-auth',
        authenticatedAt: new Date(session.session.createdAt),
      }
    }
    await authenticate(req, 'com.atproto.server.createAccount')
    if (req.auth.service)
      throw new HttpError(
        403,
        'ReauthenticationRequired',
        'Use a tracked entryway session for account migration',
      )
    return req.auth
  }
  const admin = (req, did, global = false) => {
    const hash = (s) => createHash('sha256').update(String(s)).digest()
    const supplied = hash(req.headers.authorization ?? '')
    const candidates = [
      { password: config.adminPassword },
      ...(global ? [] : config.pds.map((p) => ({ password: p.adminPassword, pdsId: p.id }))),
    ]
    const matched = candidates.find((c) =>
      timingSafeEqual(
        supplied,
        hash(`Basic ${Buffer.from(`admin:${c.password}`).toString('base64')}`),
      ),
    )
    if (!matched) throw new HttpError(401, 'AuthRequired', 'Administrator credentials required')
    if (did && matched.pdsId && accounts.get(did)?.pdsId !== matched.pdsId)
      throw new HttpError(403, 'Forbidden', 'Administrator credential belongs to a different PDS')
    return { did, kind: 'admin', authenticatedAt: new Date() }
  }
  app.get('/xrpc/com.atproto.server.describeServer', (_req, res) =>
    res.json({
      did: config.serviceDid,
      availableUserDomains: config.handleDomains,
      inviteCodeRequired: Boolean(config.inviteCodeRequired),
      links: { privacyPolicy: `${config.issuer}/`, termsOfService: `${config.issuer}/` },
    }),
  )
  app.get('/xrpc/com.atproto.identity.resolveHandle', (req, res, next) => {
    const row = accounts.get(String(req.query.handle ?? '').toLowerCase())
    if (!row || ['deleted', 'provisioning'].includes(row.status))
      return next(new HttpError(400, 'HandleNotFound', 'Handle not found'))
    res.json({ did: row.did })
  })
  app.get('/xrpc/com.atproto.server.getSession', async (req, res, next) => {
    try {
      const a = await authenticate(req, 'com.atproto.server.getSession')
      res.json({
        did: a.did,
        handle: a.handle,
        ...(!req.permissions || req.permissions.allowsAccount({ attr: 'email', action: 'read' })
          ? { email: a.email, emailConfirmed: a.emailVerified !== false }
          : {}),
        active: a.status === 'active',
        ...(a.status === 'deactivated' ? { status: 'deactivated' } : {}),
        didDoc: await accounts.plcClient.getDocument(a.did),
      })
    } catch (e) {
      next(e)
    }
  })
  app.post('/xrpc/com.atproto.identity.updateHandle', async (req, res, next) => {
    try {
      const a = await authenticate(req, 'com.atproto.identity.updateHandle')
      await accounts.updateHandle(a.did, req.body.handle)
      res.json({})
    } catch (e) {
      next(e)
    }
  })
  app.post('/signup/request-code', async (req, res, next) => {
    try {
      extras.rateLimit(`signup-ip:${req.ip}`, 30)
      res.json(extras.requestSignup(req.body))
    } catch (e) {
      next(e)
    }
  })
  app.post('/migration/request', async (req, res, next) => {
    try {
      res.json(await migration.requestMigration(await migrationPrincipal(req), req.body))
    } catch (e) {
      next(e)
    }
  })
  app.post('/migration/status', async (req, res, next) => {
    try {
      res.json(await migration.status(await migrationPrincipal(req), { did: req.body?.did }))
    } catch (e) {
      next(e)
    }
  })
  route('post', 'server.createAccount', async (req) => {
    extras.rateLimit(`create-ip:${req.ip}`, 30)
    if (req.body.did) {
      const result = await migration.importAccount(await migrationPrincipal(req), req.body)
      return { ...(await legacy.createAccountSession(result.did)), migration: result }
    }
    const {
      email,
      handle,
      pdsId = config.pds[0].id,
      password,
      recoveryKey,
      inviteCode,
      verificationCode,
      verificationPhone,
    } = req.body
    if (req.body.plcOp)
      throw new HttpError(
        400,
        'InvalidRequest',
        'A supplied PLC operation requires an authenticated existing DID migration',
      )
    const normalized = String(email ?? '')
      .trim()
      .toLowerCase()
    const session = await oauth.requireSession(req)
    if (
      password !== undefined &&
      (typeof password !== 'string' || password.length < 12 || password.length > 256)
    )
      throw new HttpError(400, 'InvalidPassword', 'Password must contain 12 to 256 characters')
    if (!(session?.user?.emailVerified && session.user.email.toLowerCase() === normalized))
      extras.verifySignup({
        email: normalized,
        token: verificationPhone ? req.body.emailVerificationCode : verificationCode,
      })
    if (verificationPhone)
      extras.verifyPhone({ phoneNumber: verificationPhone, token: verificationCode })
    const prior = accounts.get(normalized)
    if (prior && prior.status !== 'provisioning')
      throw new HttpError(409, 'AccountExists', 'This email already has an account')
    extras.reserveInvite(inviteCode, normalized)
    const account = await accounts.create({
      email: normalized,
      handle,
      pdsId,
      recoveryKey,
      inviteCode,
    })
    await security.bindVerifiedIdentity({
      did: account.did,
      email: normalized,
      userId: session?.user?.email === normalized ? session.user.id : undefined,
    })
    if (password) await legacy.setPassword(account.did, password)
    extras.completeInvite(account)
    return legacy.createAccountSession(account.did)
  })
  route('post', 'server.createSession', (req) => {
    extras.rateLimit(`login-ip:${req.ip}`, 60)
    return legacy.createSession(req.body)
  })
  route('post', 'server.refreshSession', (req) => legacy.refreshSession(req.headers.authorization))
  route('post', 'server.deleteSession', (req) => legacy.deleteSession(req.headers.authorization))
  authenticatedRoute('post', 'server.createAppPassword', (req, a) =>
    legacy.createAppPassword(a.did, req.body),
  )
  authenticatedRoute('get', 'server.listAppPasswords', (_req, a) => legacy.listAppPasswords(a.did))
  authenticatedRoute('post', 'server.revokeAppPassword', (req, a) =>
    legacy.revokeAppPassword(a.did, req.body.name),
  )
  authenticatedRoute('post', 'server.requestEmailConfirmation', (req) =>
    security.requestEmailConfirmation(req.auth),
  )
  authenticatedRoute('post', 'server.confirmEmail', (req) =>
    security.confirmEmail(req.auth, req.body),
  )
  authenticatedRoute('post', 'server.requestEmailUpdate', (req) =>
    security.requestEmailUpdate(req.auth),
  )
  authenticatedRoute('post', 'server.updateEmail', (req) =>
    security.updateEmail(req.auth, req.body),
  )
  route('post', 'server.requestPasswordReset', (req) => {
    extras.rateLimit(`reset-ip:${req.ip}`, 30)
    return security.requestPasswordReset(req.body)
  })
  route('post', 'server.resetPassword', (req) => security.resetPassword(req.body))
  authenticatedRoute('post', 'server.requestAccountDelete', (req) =>
    security.requestAccountDelete(req.auth),
  )
  route('post', 'server.deleteAccount', (req) => security.deleteAccount(req.body))
  for (const [name, status] of [
    ['activateAccount', 'active'],
    ['deactivateAccount', 'deactivated'],
  ])
    authenticatedRoute('post', `server.${name}`, async (req, a) => {
      if (req.body?.deleteAfter && !Number.isFinite(Date.parse(req.body.deleteAfter)))
        throw new HttpError(400, 'InvalidRequest', 'Invalid deletion timestamp')
      await accounts.setStatus(a.did, status, { deleteAfter: req.body?.deleteAfter })
      if (status === 'deactivated') await security.revokeAccount(a.did)
      return {}
    })
  authenticatedRoute('get', 'server.checkAccountStatus', (_req, a) => extras.checkAccountStatus(a))
  route('post', 'server.reserveSigningKey', (req) => {
    extras.rateLimit(`reserve-ip:${req.ip}`, 30)
    return extras.reserveSigningKey(req.body)
  })
  authenticatedRoute('post', 'identity.requestPlcOperationSignature', (_req, a) =>
    extras.requestPlcOperationSignature(a),
  )
  authenticatedRoute('post', 'identity.signPlcOperation', (req, a) =>
    extras.signPlcOperation(a, req.body),
  )
  authenticatedRoute('post', 'identity.submitPlcOperation', (req, a) =>
    extras.submitPlcOperation(a, req.body),
  )
  authenticatedRoute('get', 'server.getAccountInviteCodes', (req, a) =>
    extras.getAccountInviteCodes(a, { includeUsed: req.query.includeUsed !== 'false' }),
  )
  route('post', 'server.createInviteCode', (req) => {
    admin(req, req.body.forAccount)
    return extras.createInviteCode(req.body)
  })
  authenticatedRoute('get', 'temp.checkSignupQueue', (_req, a) => ({
    activated: a.status === 'active',
    ...(a.status === 'provisioning' ? { placeInQueue: 1 } : {}),
  }))
  route('post', 'temp.requestPhoneVerification', (req) => {
    extras.rateLimit(`phone-ip:${req.ip}`, 30)
    return extras.requestPhoneVerification(req.body)
  })
  route('get', 'temp.dereferenceScope', (req) => extras.dereferenceScope(req.query.scope))
  app.post('/admin/scope-reference', async (req, res, next) => {
    try {
      admin(req, undefined, true)
      res.json(await extras.registerScope(req.body.scope))
    } catch (e) {
      next(e)
    }
  })
  app.post('/admin/reconcile', async (req, res, next) => {
    try {
      admin(req, undefined, true)
      res.json(await reconcile())
    } catch (e) {
      next(e)
    }
  })
  route('post', 'admin.updateAccountEmail', (req) => {
    const did = accounts.get(req.body.account)?.did
    if (!did) {
      admin(req)
      throw new HttpError(404, 'AccountNotFound', 'Account not found')
    }
    return security.adminUpdateEmail(admin(req, did), { did, email: req.body.email })
  })
  route('post', 'admin.updateAccountPassword', (req) =>
    security.adminUpdatePassword(admin(req, req.body.did), {
      did: req.body.did,
      password: req.body.password,
    }),
  )
  route('post', 'admin.sendEmail', async (req) => {
    let a
    if (req.headers.authorization?.startsWith('Basic ')) {
      admin(req, req.body.recipientDid)
      a = accounts.get(req.body.recipientDid)
    } else {
      a = await authenticate(req, 'com.atproto.admin.sendEmail')
      if (!req.auth.service || a.did !== req.body.recipientDid)
        throw new HttpError(403, 'Forbidden', 'Expected recipient-bound PDS service authorization')
    }
    if (!a || a.status === 'deleted')
      throw new HttpError(404, 'AccountNotFound', 'Recipient account not found')
    return extras.sendEmail(a, req.body)
  })
  return { authenticate }
}
