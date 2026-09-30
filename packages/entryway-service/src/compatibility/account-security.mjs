import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { HttpError } from './accounts.mjs'

const TEN_MINUTES = 600_000
const fail = (status, error, message) => new HttpError(status, error, message)
const normalizeEmail = (email) => {
  email = String(email ?? '')
    .trim()
    .toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw fail(400, 'InvalidEmail', 'Enter a valid email address')
  return email
}

/**
 * Account security boundary. Principals are supplied by verified HTTP middleware,
 * never copied from request bodies: {did,kind,authenticatedAt}. Better Auth
 * principals additionally require their live userId and sessionId.
 * Only Better Auth session creation is accepted as recent authentication; an
 * OAuth/service token's issuance time is not a fresh user-presence assertion.
 * XRPC email challenges therefore establish their own proof at completion.
 *
 * Better Auth 1.7.3's pinned user/session/account/verification SQLite schema is
 * deliberately accessed here to commit email authority and its user mapping in
 * the SAME transaction. Its full HTTP account API remains unmounted. Upgrade
 * tests must cover this adapter; no password or OAuth cryptography is replaced.
 */
export async function createAccountSecurity({ db, config, accounts, oauth, legacy, mail }) {
  const tx = (fn) => db.sqlite.transaction(fn)()
  const account = (did) => {
    const row = accounts.get(did)
    if (!row || row.did !== did || ['deleted', 'provisioning'].includes(row.status))
      throw fail(404, 'AccountNotFound', 'Account not found')
    return row
  }
  const version = (did) => db.get('security:versions', did) ?? 0
  const identity = (did) => accounts.storage.getVerifiedBinding(did)?.userId
  const userByEmail = (email) =>
    db.sqlite.prepare('SELECT * FROM user WHERE lower(email)=?').get(email)
  const claim = (email) => accounts.storage.getEmailClaim(email)
  const reserve = (email, did, purpose) => {
    const existing = claim(email)
    if (existing && (existing.did !== did || existing.purpose !== purpose))
      throw fail(409, 'EmailNotAvailable', 'This email address cannot be used')
    accounts.storage.reserveEmail(email, did, purpose)
  }
  const assertEmailAvailable = (email, did, { allowOwnBackup = false } = {}) => {
    email = normalizeEmail(email)
    const owner = accounts.get(email)
    let existing = claim(email)
    if (existing?.purpose === 'pending') {
      pendingEmail(existing.did)
      existing = claim(email)
    }
    const user = userByEmail(email)
    if (
      (owner && owner.did !== did) ||
      (existing && (existing.did !== did || (existing.purpose === 'backup' && !allowOwnBackup))) ||
      (user && user.id !== identity(did))
    )
      throw fail(409, 'EmailNotAvailable', 'This email address cannot be used')
    return email
  }
  const principal = (actor, recent = false) => {
    if (!actor || !['better-auth', 'legacy', 'oauth', 'admin'].includes(actor.kind))
      throw fail(401, 'AuthenticationRequired', 'Sign in to continue')
    const row = account(actor.did)
    if (actor.kind === 'better-auth' && (!actor.userId || !actor.sessionId))
      throw fail(401, 'AuthenticationRequired', 'A live account-settings session is required')
    if (actor.kind === 'better-auth' && actor.userId && identity(row.did) !== actor.userId)
      throw fail(403, 'AccountMismatch', 'The authenticated identity does not own this account')
    if (
      actor.kind === 'better-auth' &&
      actor.sessionId &&
      !db.sqlite
        .prepare('SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>?')
        .get(actor.sessionId, identity(row.did), Date.now())
    )
      throw fail(401, 'AuthenticationRequired', 'Sign in again to continue')
    const age = Date.now() - new Date(actor.authenticatedAt).getTime()
    if (
      recent &&
      (actor.kind !== 'better-auth' || !Number.isFinite(age) || age < 0 || age > TEN_MINUTES)
    )
      throw fail(403, 'ReauthenticationRequired', 'Verify your email again before this change')
    return row
  }
  const requireAdmin = (actor) => {
    if (actor?.kind !== 'admin')
      throw fail(403, 'Forbidden', 'Administrator authentication required')
  }
  const bindVerifiedIdentity = ({ did, email, userId }) =>
    tx(() => {
      const row = account(did)
      email = normalizeEmail(email)
      if (row.email !== email)
        throw fail(403, 'AccountMismatch', 'Verified email does not match account')
      // The inherited signup XRPC supplies no userId only after its scoped
      // email proof; this service also calls that path after consuming a local
      // security challenge. New flows must supply an explicit verified ID.
      const linkedUserId = userId
        ? accounts.storage.bindVerifiedIdentity({ did, email, userId })
        : accounts.storage.ensureLegacyVerifiedIdentity({ did, email })
      if (userId && row.emailVerified === false) accounts.save({ ...row, emailVerified: true })
      return linkedUserId
    })
  for (const row of accounts.list()) {
    reserve(row.email, row.did, 'primary')
    const user = userByEmail(row.email)
    if (!['deleted', 'provisioning'].includes(row.status) && user?.emailVerified)
      bindVerifiedIdentity({ did: row.did, email: row.email, userId: user.id })
  }
  const rate = (email, bucket = 'request', maximum = 5, interval = TEN_MINUTES) => {
    const key = `${bucket}/${email}/${Math.floor(Date.now() / interval)}`
    const count = db.get('security:limits', key) ?? 0
    if (count >= maximum) throw fail(429, 'RateLimitExceeded', 'Too many attempts; try again later')
    db.set('security:limits', key, count + 1)
  }
  const digest = (id, purpose, secret) =>
    createHmac('sha256', config.betterAuthSecret)
      .update(`${id}\0${purpose}\0${secret}`)
      .digest('hex')
  const issue = (purpose, row, email, data = {}) => {
    rate(email)
    const id = randomBytes(18).toString('base64url')
    const code = String(randomInt(100_000_000)).padStart(8, '0')
    const record = {
      id,
      purpose,
      did: row.did,
      email,
      hash: digest(id, purpose, code),
      expiresAt: Date.now() + TEN_MINUTES,
      attempts: 0,
      version: version(row.did),
      data,
    }
    // Resending a purpose/address challenge invalidates its predecessor.
    for (const { key, value } of db.list('security:challenges'))
      if (
        value.did === row.did &&
        value.purpose === purpose &&
        value.email === email &&
        !value.consumedAt
      )
        db.set('security:challenges', key, { ...value, consumedAt: Date.now() })
    db.set('security:challenges', id, record)
    return mail.sendProof({ email, token: `${id}.${code}`, purpose }).then(() => ({}))
  }
  const consume = (token, purpose, expected = {}) => {
    const result = tx(() => {
      const [id, code, excess] = String(token ?? '').split('.')
      const row = db.get('security:challenges', id)
      const bad = () => ({ error: fail(400, 'InvalidToken', 'Invalid or already used token') })
      if (!row || excess || row.consumedAt || row.purpose !== purpose) return bad()
      if (row.expiresAt <= Date.now())
        return { error: fail(400, 'ExpiredToken', 'This token has expired') }
      if (row.attempts >= 5 || row.version !== version(row.did)) return bad()
      try {
        rate(row.email, 'failed', 15, 3_600_000)
      } catch (error) {
        return { error }
      }
      row.attempts++
      db.set('security:challenges', id, row)
      const actual = Buffer.from(digest(id, purpose, code ?? ''), 'hex')
      const stored = Buffer.from(row.hash, 'hex')
      if (
        !timingSafeEqual(actual, stored) ||
        (expected.did && row.did !== expected.did) ||
        (expected.email && row.email !== expected.email)
      )
        return bad()
      try {
        account(row.did)
      } catch {
        return bad()
      }
      row.consumedAt = Date.now()
      db.set('security:challenges', id, row)
      return { row }
    })
    if (result.error) throw result.error
    return result.row
  }
  const releasePending = (did) => {
    db.sqlite.prepare("DELETE FROM mini_email_claims WHERE did=? AND purpose='pending'").run(did)
    db.delete('security:pending-email', did)
  }
  const revokeLocal = (did) => {
    const row = accounts.get(did)
    const userId = identity(did)
    if (userId) db.sqlite.prepare('DELETE FROM session WHERE userId=?').run(userId)
    if (row)
      for (const type of ['sign-in', 'email-verification', 'forget-password'])
        db.sqlite
          .prepare('DELETE FROM verification WHERE identifier=?')
          .run(`${type}-otp-${row.email}`)
    for (const { key, value } of db.list('oauth:tokens'))
      if (value.data.did === did) db.delete('oauth:tokens', key)
    for (const { key, value } of db.list('oauth:device-accounts'))
      if (value.did === did) db.delete('oauth:device-accounts', key)
    for (const { key, value } of db.list('oauth:requests'))
      if (value.did === did) db.delete('oauth:requests', key)
    for (const { key, value } of db.list('auth-flows'))
      if (
        value.authDid === did ||
        (row && (value.authEmail === row.email || value.email === row.email))
      )
        db.delete('auth-flows', key)
    db.delete('oauth:grants', did)
    db.set('security:versions', did, version(did) + 1)
    db.set('security:revoked-at', did, Date.now())
    releasePending(did)
  }
  const revokeAccount = async (did, { credentials = false } = {}) => {
    tx(() => revokeLocal(did))
    await legacy.revokeAccount(did, { credentials })
  }
  const swapEmail = (did, email, { recovery = false, verified = true } = {}) =>
    (accounts.serialized ?? ((_did, fn) => fn()))(did, async () => {
      const old = account(did)
      email = assertEmailAvailable(email, did, { allowOwnBackup: recovery })
      // Establish the service-token quarantine and invalidate live browser/AS
      // sessions BEFORE yielding to credential cleanup. Otherwise a queued old
      // full-access request could recreate an app password between those steps.
      tx(() => revokeLocal(did))
      // Credential invalidation precedes the authority commit. A failure is closed:
      // no email change takes place while legacy credentials could remain usable.
      if (recovery) await legacy.removePassword(did)
      await legacy.revokeAccount(did, { credentials: true })
      tx(() => {
        const row = account(did)
        assertEmailAvailable(email, did, { allowOwnBackup: recovery })
        const userId = identity(did) ?? bindVerifiedIdentity({ did, email: row.email })
        revokeLocal(did)
        // Prevent a previously sent old-address sign-in OTP creating an old session.
        for (const address of [row.email, email])
          for (const type of ['sign-in', 'email-verification', 'forget-password'])
            db.sqlite
              .prepare('DELETE FROM verification WHERE identifier=?')
              .run(`${type}-otp-${address}`)
        db.sqlite
          .prepare('UPDATE user SET email=?,emailVerified=?,updatedAt=? WHERE id=?')
          .run(email, verified ? 1 : 0, Date.now(), userId)
        const updated = { ...row, email, emailVerified: verified }
        accounts.save(updated)
        db.sqlite
          .prepare("DELETE FROM mini_email_claims WHERE did=? AND purpose='primary'")
          .run(did)
        db.sqlite.prepare('DELETE FROM mini_backup_emails WHERE email=? AND did=?').run(email, did)
        db.sqlite.prepare('DELETE FROM mini_email_claims WHERE email=? AND did=?').run(email, did)
        reserve(email, did, 'primary')
        db.set('security:events', randomUUID(), {
          type: recovery ? 'recovery' : 'email-change',
          did,
          previousEmail: old.email,
          email,
          at: new Date(),
        })
      })
      return { did, email, reauthenticationRequired: true }
    })
  const pendingEmail = (did) => {
    const value = db.get('security:pending-email', did)
    if (value && value.expiresAt > Date.now() && value.version === version(did)) return value
    if (value) releasePending(did)
    return null
  }
  const beginNewEmail = async (did, email, recovery = false, backupEmail) => {
    const proof = tx(() => {
      const row = account(did)
      email = assertEmailAvailable(email, did, { allowOwnBackup: recovery })
      if (email === row.email) throw fail(400, 'InvalidEmail', 'Choose a different primary email')
      releasePending(did)
      const existing = claim(email)
      if (!existing) reserve(email, did, 'pending')
      db.set('security:pending-email', did, {
        email,
        recovery,
        backupEmail,
        expiresAt: Date.now() + TEN_MINUTES,
        version: version(did),
      })
      return { row, email, purpose: recovery ? 'recovery-new-email' : 'email-new' }
    })
    await issue(proof.purpose, proof.row, proof.email)
    return { pending: true }
  }
  const currentPassword = async (row, password) => {
    if (
      (await legacy.hasPassword(row.did)) &&
      !(await legacy.verifyPassword(row.did, password ?? ''))
    )
      throw fail(403, 'InvalidPassword', 'Current password is required')
  }
  const service = {
    assertEmailAvailable,
    bindVerifiedIdentity,
    revokeAccount,
    assertLoginEmail({ email, userId }) {
      email = normalizeEmail(email)
      const row = accounts.get(email)
      const reservation = claim(email)
      if (reservation?.purpose === 'external' && !row) {
        const owner = accounts.storage.getExternalReservationByEmail(email)
        const verified = accounts.storage.isVerifiedUserEmail({ userId, email })
        if (owner?.userId === userId && verified) return
      }
      if (reservation && (!row || reservation.did !== row.did || reservation.purpose !== 'primary'))
        throw fail(
          409,
          'EmailReserved',
          'This address is reserved for account security. Use the recovery page if needed.',
        )
      if (row && !['deleted', 'provisioning'].includes(row.status))
        bindVerifiedIdentity({ did: row.did, email, userId })
    },
    summary(actor) {
      const row = principal(actor)
      return {
        email: row.email,
        emailVerified: row.emailVerified !== false,
        pendingEmail: pendingEmail(row.did)?.email ?? null,
        passwordEnabled: legacy.hasPassword(row.did),
        backupEmails: db.sqlite
          .prepare(
            'SELECT email,created_at AS createdAt FROM mini_backup_emails WHERE did=? ORDER BY created_at',
          )
          .all(row.did)
          .map((item) => ({ ...item, verified: true })),
      }
    },
    requestEmailConfirmation(actor) {
      const row = principal(actor)
      const pending = pendingEmail(row.did)
      return issue(pending ? 'email-new' : 'email-confirm', row, pending?.email ?? row.email)
    },
    async confirmEmail(actor, { email, token }) {
      const row = principal(actor)
      email = normalizeEmail(email)
      const pending = pendingEmail(row.did)
      if (pending?.email === email && !pending.recovery) {
        consume(token, 'email-new', { did: row.did, email })
        return swapEmail(row.did, email)
      }
      if (row.email !== email) throw fail(400, 'InvalidEmail', 'Email does not match account')
      consume(token, 'email-confirm', { did: row.did, email })
      tx(() => {
        const userId = identity(row.did) ?? bindVerifiedIdentity({ did: row.did, email })
        db.sqlite
          .prepare('UPDATE user SET emailVerified=1,updatedAt=? WHERE id=?')
          .run(Date.now(), userId)
        accounts.save({ ...account(row.did), emailVerified: true })
      })
      return {}
    },
    async requestEmailUpdate(actor) {
      const row = principal(actor)
      await issue('email-old', row, row.email)
      return { tokenRequired: true }
    },
    updateEmail(actor, { email, token, emailAuthFactor }) {
      const row = principal(actor)
      if (emailAuthFactor === false)
        throw fail(
          400,
          'InvalidRequest',
          'Email authentication cannot be disabled for an email-based account',
        )
      if (!token) throw fail(400, 'TokenRequired', 'Verify the current email first')
      email = assertEmailAvailable(email, row.did)
      consume(token, 'email-old', { did: row.did, email: row.email })
      return beginNewEmail(row.did, email)
    },
    requestPasswordReset({ email }) {
      email = normalizeEmail(email)
      const row = accounts.get(email)
      if (!row || ['deleted', 'provisioning'].includes(row.status)) {
        rate(email)
        return {}
      }
      return issue('password-reset', row, email)
    },
    async resetPassword({ token, password }) {
      // Validate before consuming so a typo in password policy does not burn proof.
      if (typeof password !== 'string' || password.length < 12 || password.length > 256)
        throw fail(400, 'InvalidPassword', 'Password must contain 12 to 256 characters')
      const proof = consume(token, 'password-reset')
      await legacy.setPassword(proof.did, password)
      await revokeAccount(proof.did, { credentials: true })
      return {}
    },
    requestAccountDelete(actor) {
      const row = principal(actor)
      return issue('account-delete', row, row.email)
    },
    requestMigrationProof(actor, { pdsId }) {
      const row = principal(actor)
      if (!config.pds.some((pds) => pds.id === pdsId) || row.pdsId === pdsId)
        throw fail(400, 'InvalidPds', 'Choose another configured PDS')
      return issue('account-migrate', row, row.email, { pdsId })
    },
    confirmMigrationProof(actor, { pdsId, token }) {
      const row = principal(actor)
      const proof = consume(token, 'account-migrate', { did: row.did, email: row.email })
      if (proof.data.pdsId !== pdsId)
        throw fail(400, 'InvalidToken', 'Migration proof was issued for a different PDS')
      return { did: row.did, email: row.email, verifiedAt: new Date() }
    },
    async deleteAccount({ did, token, password }) {
      const row = account(did)
      await currentPassword(row, password)
      consume(token, 'account-delete', { did, email: row.email })
      await revokeAccount(did, { credentials: true })
      await accounts.deleteAccount(did)
      db.sqlite.prepare('DELETE FROM mini_backup_emails WHERE did=?').run(did)
      db.sqlite.prepare("DELETE FROM mini_email_claims WHERE did=? AND purpose!='primary'").run(did)
      return {}
    },
    requestBackupEmail(actor, { email }) {
      const row = principal(actor, true)
      email = assertEmailAvailable(email, row.did)
      if (row.email === email)
        throw fail(400, 'InvalidEmail', 'Backup email must differ from primary')
      if (
        db.sqlite.prepare('SELECT count(*) AS n FROM mini_backup_emails WHERE did=?').get(row.did)
          .n >= 3
      )
        throw fail(400, 'BackupLimitExceeded', 'At most three verified backup emails are supported')
      return issue('backup-add', row, email)
    },
    confirmBackupEmail(actor, { email, token }) {
      const row = principal(actor, true)
      email = assertEmailAvailable(email, row.did)
      consume(token, 'backup-add', { did: row.did, email })
      return tx(() => {
        if (
          db.sqlite.prepare('SELECT count(*) AS n FROM mini_backup_emails WHERE did=?').get(row.did)
            .n >= 3
        )
          throw fail(
            400,
            'BackupLimitExceeded',
            'At most three verified backup emails are supported',
          )
        reserve(email, row.did, 'backup')
        db.sqlite
          .prepare('INSERT INTO mini_backup_emails VALUES (?,?,?)')
          .run(email, row.did, new Date().toISOString())
        return {}
      })
    },
    removeBackupEmail(actor, { email }) {
      const row = principal(actor, true)
      email = normalizeEmail(email)
      tx(() => {
        db.sqlite
          .prepare('DELETE FROM mini_backup_emails WHERE did=? AND email=?')
          .run(row.did, email)
        db.sqlite
          .prepare("DELETE FROM mini_email_claims WHERE did=? AND email=? AND purpose='backup'")
          .run(row.did, email)
        // Invalidate recovery proofs for the removed address without invalidating sessions.
        for (const { key, value } of db.list('security:challenges'))
          if (value.did === row.did && value.email === email) db.delete('security:challenges', key)
        if (pendingEmail(row.did)?.backupEmail === email) releasePending(row.did)
      })
      return {}
    },
    requestRecovery({ email }) {
      email = normalizeEmail(email)
      const backup = db.sqlite
        .prepare('SELECT did FROM mini_backup_emails WHERE email=?')
        .get(email)
      if (!backup) {
        rate(email)
        return {}
      }
      const row = accounts.get(backup.did)
      if (!row || ['deleted', 'provisioning'].includes(row.status)) {
        rate(email)
        return {}
      }
      return issue('recovery-backup', row, email)
    },
    completeRecovery({ token, newEmail }) {
      const proof = consume(token, 'recovery-backup')
      const backup = db.sqlite
        .prepare('SELECT did FROM mini_backup_emails WHERE email=?')
        .get(proof.email)
      if (backup?.did !== proof.did)
        throw fail(400, 'InvalidToken', 'Backup email is no longer valid')
      return beginNewEmail(proof.did, newEmail, true, proof.email)
    },
    async completeRecoveryEmail({ token }) {
      const proof = consume(token, 'recovery-new-email')
      const pending = pendingEmail(proof.did)
      if (!pending?.recovery || pending.email !== proof.email)
        throw fail(400, 'InvalidToken', 'Recovery request has expired or changed')
      const backup = db.sqlite
        .prepare('SELECT did FROM mini_backup_emails WHERE email=?')
        .get(pending.backupEmail)
      if (backup?.did !== proof.did)
        throw fail(400, 'InvalidToken', 'Backup email is no longer valid')
      return swapEmail(proof.did, proof.email, { recovery: true })
    },
    async setPassword(actor, { password, currentPassword: previous }) {
      const row = principal(actor, true)
      await currentPassword(row, previous)
      await legacy.setPassword(row.did, password)
      await revokeAccount(row.did, { credentials: true })
      return { reauthenticationRequired: true }
    },
    async removePassword(actor, { currentPassword: previous } = {}) {
      const row = principal(actor, true)
      await currentPassword(row, previous)
      await legacy.removePassword(row.did)
      await revokeAccount(row.did, { credentials: true })
      return { reauthenticationRequired: true }
    },
    async adminUpdateEmail(actor, { did, email }) {
      requireAdmin(actor)
      // Admin control can repair authority, but is not proof of mailbox ownership.
      return swapEmail(did, email, { recovery: true, verified: false })
    },
    async adminUpdatePassword(actor, { did, password }) {
      requireAdmin(actor)
      account(did)
      await legacy.setPassword(did, password)
      await revokeAccount(did, { credentials: true })
      return {}
    },
  }
  // Claims/codes are consumed synchronously. Serialize the full async operation
  // too, so two different valid proofs cannot race through password hashing or
  // external deletion and commit against an authority version that has changed.
  const locks = new Map()
  for (const method of [
    'confirmEmail',
    'resetPassword',
    'deleteAccount',
    'completeRecoveryEmail',
    'setPassword',
    'removePassword',
    'adminUpdateEmail',
    'adminUpdatePassword',
  ]) {
    const perform = service[method]
    service[method] = (...args) => {
      const did =
        args[0]?.did ??
        args[1]?.did ??
        db.get('security:challenges', String(args[0]?.token ?? '').split('.')[0])?.did ??
        'invalid-token'
      const previous = locks.get(did) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => perform(...args))
      locks.set(did, next)
      return next.finally(() => {
        if (locks.get(did) === next) locks.delete(did)
      })
    }
  }
  oauth.setAccountSecurity?.(service)
  return service
}
