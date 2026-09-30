import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'
import * as plc from '@did-plc/lib'
import { cidForLex } from '@atproto/lex-cbor'
import { HttpError, xrpc } from './accounts.mjs'

const fail = (error, message, status = 400) => {
  throw new HttpError(status, error, message)
}
const emailAddress = (value) => {
  const email = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    fail('InvalidEmail', 'Provide a valid email address')
  return email
}

export async function createEntrywayExtras({ db, config, accounts }) {
  const jwtKey = await importJWK(config.jwtJwk, 'ES256K')
  const challengeDigest = (purpose, subject, value) =>
    createHmac('sha256', config.betterAuthSecret)
      .update(JSON.stringify(['entryway-extra-code/v1', purpose, subject, String(value)]))
      .digest('hex')
  const rateLimit = (key, limit = 5, window = 600_000) => {
    const now = Date.now()
    const old = db.get('entryway:limits', key)
    const row = old && old.until > now ? old : { count: 0, until: now + window }
    if (row.count >= limit) fail('RateLimitExceeded', 'Please wait before trying again', 429)
    db.set('entryway:limits', key, { ...row, count: row.count + 1 })
  }
  const sendCode = (purpose, subject, destination, channel = 'email', did) => {
    rateLimit(`${purpose}:${subject}`)
    const otp = String(randomInt(10_000_000, 100_000_000))
    db.set('entryway:challenges', `${purpose}:${subject}`, {
      hash: challengeDigest(purpose, subject, otp),
      attempts: 0,
      expiresAt: Date.now() + 600_000,
      ...(did ? { did, version: db.get('security:versions', did) ?? 0 } : {}),
    })
    db.set(channel === 'email' ? 'outbox' : 'sms-outbox', destination, {
      [channel === 'email' ? 'email' : 'phoneNumber']: destination,
      otp,
      type: purpose,
      createdAt: new Date(),
    })
    return {}
  }
  const consumeCode = (purpose, subject, code) =>
    db.sqlite.transaction(() => {
      const key = `${purpose}:${subject}`
      const row = db.get('entryway:challenges', key)
      if (!row || row.expiresAt <= Date.now() || row.attempts >= 5) return false
      // Challenges written before version binding was introduced must not survive
      // a security upgrade and become reusable after an account reset.
      if (purpose === 'plc-operation' && (!row.did || !Number.isInteger(row.version))) return false
      if (row.did) {
        const current = accounts.get(row.did)
        if (
          !current ||
          current.did !== row.did ||
          ['deleted', 'provisioning'].includes(current.status) ||
          row.version !== (db.get('security:versions', row.did) ?? 0)
        )
          return false
      }
      const valid =
        typeof code === 'string' &&
        timingSafeEqual(
          Buffer.from(row.hash, 'hex'),
          Buffer.from(challengeDigest(purpose, subject, code), 'hex'),
        )
      if (valid) db.delete('entryway:challenges', key)
      else db.set('entryway:challenges', key, { ...row, attempts: row.attempts + 1 })
      return valid
    })()
  const requireCode = (purpose, subject, code) => {
    if (!consumeCode(purpose, subject, code))
      fail('InvalidToken', 'Code is invalid, expired or already used')
  }
  const internalAccess = async (row) =>
    new SignJWT({ scope: 'com.atproto.access' })
      .setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt' })
      .setSubject(row.did)
      .setAudience(accounts.pdsFor(row).did)
      .setIssuedAt()
      .setExpirationTime('30s')
      .setJti(randomBytes(16).toString('hex'))
      .sign(jwtKey)
  const pdsCall = async (row, nsid, body) =>
    xrpc(accounts.pdsFor(row).internalUrl, nsid, body, `Bearer ${await internalAccess(row)}`)
  const choosePds = (pdsId) => {
    const pds = config.pds.find((p) => p.id === (pdsId ?? config.pds[0].id))
    if (!pds) fail('InvalidPds', 'Choose an enrolled PDS')
    return pds
  }
  const requestSignup = ({ email }) => sendCode('signup', emailAddress(email), emailAddress(email))
  const verifySignup = ({ email, token }) => requireCode('signup', emailAddress(email), token)
  const requestPhoneVerification = ({ phoneNumber }) => {
    if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber ?? ''))
      fail('InvalidPhoneNumber', 'Use an E.164 phone number')
    return sendCode('phone-verification', phoneNumber, phoneNumber, 'sms')
  }
  const verifyPhone = ({ phoneNumber, token }) =>
    requireCode('phone-verification', phoneNumber, token)
  const reserveSigningKey = async ({ did, pdsId } = {}) => {
    const existing = did && accounts.get(did)
    const pds = existing ? accounts.pdsFor(existing) : choosePds(pdsId)
    return xrpc(pds.internalUrl, 'com.atproto.server.reserveSigningKey', did ? { did } : {})
  }
  const requestPlcOperationSignature = (row) => {
    accounts.assertNoMigration?.(row.did)
    return sendCode('plc-operation', `${row.did}:${row.email}`, row.email, 'email', row.did)
  }
  const signPlcOperation = async (row, body) => {
    accounts.assertNoMigration?.(row.did)
    const current = await accounts.plcClient.getLastOp(row.did)
    if (current.type === 'plc_tombstone') fail('InvalidRequest', 'The identity is tombstoned')
    const allowed = ['token', 'rotationKeys', 'alsoKnownAs', 'verificationMethods', 'services']
    if (Object.keys(body).some((k) => !allowed.includes(k)))
      fail('InvalidRequest', 'Unknown operation field')
    let operation
    try {
      operation = await plc.createUpdateOp(current, accounts.rotation, (op) => ({
        ...op,
        ...Object.fromEntries(
          allowed.filter((k) => k !== 'token' && body[k] !== undefined).map((k) => [k, body[k]]),
        ),
      }))
      plc.def.operation.parse(operation)
      await plc.assureValidOp(operation)
      if (
        !operation.verificationMethods.atproto ||
        operation.services.atproto_pds?.type !== 'AtprotoPersonalDataServer'
      )
        throw new Error('Missing AT Protocol identity fields')
      const endpoint = new URL(operation.services.atproto_pds.endpoint)
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search
      )
        throw new Error('Invalid PDS URL')
      if (!operation.alsoKnownAs.some((a) => a.startsWith('at://')))
        throw new Error('Missing handle')
      await plc.assureValidSig(plc.normalizeOp(current).rotationKeys, operation)
    } catch {
      fail(
        'InvalidPlcOperation',
        'The requested identity operation is invalid or this entryway no longer has signing authority',
      )
    }
    // Validate first; the purpose-bound email proof is consumed exactly once before
    // returning a signature. A signature for migration can transfer all authority.
    const currentAccount = accounts.get(row.did)
    if (
      !currentAccount ||
      currentAccount.did !== row.did ||
      currentAccount.email !== row.email ||
      ['deleted', 'provisioning'].includes(currentAccount.status)
    )
      fail('InvalidToken', 'Account authority changed; request a new signature code')
    accounts.assertNoMigration?.(row.did)
    requireCode('plc-operation', `${row.did}:${row.email}`, body.token)
    db.set('events', `plc:${crypto.randomUUID()}`, {
      type: 'plc.signed',
      did: row.did,
      prev: operation.prev,
      at: new Date(),
    })
    return { operation }
  }
  const submitPlcOperation = async (row, { operation }) => {
    accounts.assertNoMigration?.(row.did)
    // The hosting PDS enforces its own key/handle/endpoint invariants and sequences
    // identity events. A migration-away operation is signed here and submitted to
    // the directory by its owner, rather than weakening the stock PDS constraints.
    await pdsCall(row, 'com.atproto.identity.submitPlcOperation', { operation })
    return {}
  }
  const checkAccountStatus = (row) => pdsCall(row, 'com.atproto.server.checkAccountStatus')
  const createInviteCode = ({ useCount, forAccount = 'admin' }) => {
    if (!Number.isInteger(useCount) || useCount < 1 || useCount > 1000)
      fail('InvalidRequest', 'useCount must be between 1 and 1000')
    if (
      forAccount !== 'admin' &&
      (!accounts.get(forAccount) || accounts.get(forAccount).status === 'deleted')
    )
      fail('AccountNotFound', 'Account not found')
    const code = `spike-${randomBytes(12).toString('hex')}`
    db.set('entryway:invites', code, {
      code,
      // Stock invite.available is total capacity; uses records completed claims.
      available: useCount,
      remaining: useCount,
      disabled: false,
      forAccount,
      createdBy: 'admin',
      createdAt: new Date().toISOString(),
      uses: [],
    })
    return { code }
  }
  // Preserve pre-fix spike invite balances if an existing volume contains them.
  // Each reservation already decremented the old available field exactly once.
  db.sqlite.transaction(() => {
    const reservations = db.list('entryway:invite-reservations')
    for (const { key, value } of db.list('entryway:invites')) {
      if (Number.isInteger(value.remaining)) continue
      const claimed = reservations.filter(
        ({ value: reservation }) => reservation.code === key,
      ).length
      db.set('entryway:invites', key, {
        ...value,
        available: value.available + claimed,
        remaining: value.available,
      })
    }
  })()
  const getAccountInviteCodes = (row, { includeUsed = true } = {}) => ({
    codes: db
      .list('entryway:invites')
      .map(({ value }) => value)
      .filter((c) => c.forAccount === row.did && !c.disabled && (includeUsed || c.remaining > 0))
      .map(({ remaining, ...code }) => code),
  })
  const reserveInvite = (code, email) =>
    db.sqlite.transaction(() => {
      email = emailAddress(email)
      const reserved = db.get('entryway:invite-reservations', email)
      if (reserved) {
        if (code && reserved.code !== code)
          fail('InvalidInviteCode', 'Signup already reserved another invite')
        const original = db.get('entryway:invites', reserved.code)
        if (!original || original.disabled) fail('InvalidInviteCode', 'Invite code is invalid')
        if (reserved.did && accounts.get(email)?.did !== reserved.did)
          fail('InvalidInviteCode', 'The invitation was already used by another account')
        // A reconciliation retry has the verified email and recorded assignment,
        // but need not retain or re-present its original invitation secret.
        return
      }
      if (!code && !config.inviteCodeRequired) return
      const row = db.get('entryway:invites', code)
      if (!row || row.disabled) fail('InvalidInviteCode', 'Invite code is invalid')
      if (row.remaining < 1) fail('InvalidInviteCode', 'Invite code is exhausted')
      db.set('entryway:invites', code, { ...row, remaining: row.remaining - 1 })
      db.set('entryway:invite-reservations', email, { code, email, at: new Date() })
    })()
  const completeInvite = (row) =>
    db.sqlite.transaction(() => {
      const reserved = db.get('entryway:invite-reservations', row.email)
      if (!reserved) return
      if (reserved.did) {
        if (reserved.did !== row.did)
          fail('InvalidInviteCode', 'The invitation was already used by another account')
        return
      }
      const invite = db.get('entryway:invites', reserved.code)
      if (!invite) fail('InvalidInviteCode', 'The reserved invitation could not be found')
      db.set('entryway:invites', reserved.code, {
        ...invite,
        uses: [...invite.uses, { usedBy: row.did, usedAt: new Date().toISOString() }],
      })
      db.set('entryway:invite-reservations', row.email, { ...reserved, did: row.did })
    })()
  const registerScope = async (scope) => {
    if (
      typeof scope !== 'string' ||
      !scope.split(' ').includes('atproto') ||
      scope.length > 8192 ||
      scope.startsWith('ref:')
    )
      fail('InvalidScope', 'Provide an inline AT Protocol scope')
    const ref = `ref:${await cidForLex(scope)}`
    db.set('entryway:scopes', ref, { scope })
    return { ref }
  }
  const dereferenceScope = (scope) => {
    const row =
      typeof scope === 'string' && scope.startsWith('ref:') && db.get('entryway:scopes', scope)
    if (!row) fail('InvalidScopeReference', 'Scope reference was not found')
    return row
  }
  const sendEmail = (
    row,
    { content, subject = 'Message from your account service', senderDid, comment },
  ) => {
    if (
      typeof content !== 'string' ||
      !content ||
      content.length > 16_000 ||
      typeof senderDid !== 'string'
    )
      fail('InvalidRequest', 'Provide bounded email content and senderDid')
    db.set('mail-outbox', crypto.randomUUID(), {
      email: row.email,
      recipientDid: row.did,
      content,
      subject,
      senderDid,
      comment,
      createdAt: new Date(),
    })
    return { sent: true }
  }
  return {
    rateLimit,
    requestSignup,
    verifySignup,
    requestPhoneVerification,
    verifyPhone,
    reserveSigningKey,
    requestPlcOperationSignature,
    signPlcOperation,
    submitPlcOperation,
    checkAccountStatus,
    createInviteCode,
    getAccountInviteCodes,
    reserveInvite,
    completeInvite,
    registerScope,
    dereferenceScope,
    sendEmail,
  }
}
