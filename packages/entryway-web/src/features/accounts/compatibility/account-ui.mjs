import express from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { page, escapeHtml as esc } from '../../../../../entryway-service/src/compatibility/auth.mjs'
import { HttpError } from '../../../../../entryway-service/src/compatibility/accounts.mjs'

const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`
const field = (name, label, type = 'text', attributes = '') =>
  `<label>${esc(label)}<input name="${esc(name)}" type="${type}" ${attributes} required></label>`
const form = (action, csrf, contents, button, extra = '') =>
  `<form method="post" action="${action.startsWith('/') ? action : `/account/${action}`}" ${extra}>${hidden('csrf', csrf)}${contents}<button>${esc(button)}</button></form>`
const stamp = (value) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : 'Unknown'
}
const section = (id, title, contents) =>
  `<section id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${esc(title)}</h2>${contents}</section>`
const requireRecent = (session) => {
  const at = new Date(session.session.createdAt).getTime()
  if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 10 * 60_000)
    throw new HttpError(
      403,
      'ReauthenticationRequired',
      'Sign in again before changing account security or identity settings.',
    )
}

export function mountAccountUi({ app, db, accounts, oauth, config, security, legacy, migration }) {
  const guarded = (handler) => async (req, res, next) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) return next(error)
      const status = Number(error.status ?? error.statusCode ?? 400)
      page(
        res,
        'Account operation could not be completed',
        `<p role="alert">${esc(error.message)}</p><p><a href="/account">Return to account settings</a> · <a href="/login">Sign in again</a></p>`,
        status >= 400 && status < 600 ? status : 400,
      )
    }
  }
  const authenticated = async (req, res) => {
    const session = await oauth.requireSession(req)
    if (!session?.user?.emailVerified) {
      res.redirect(303, '/login')
      return null
    }
    const account = accounts.get(session.user.email.toLowerCase())
    if (!account || account.status === 'deleted') {
      page(
        res,
        'No account',
        '<p>No active account is linked to this email.</p><a href="/login">Sign in to another account</a>',
        404,
      )
      return null
    }
    const browser = await oauth.loadBrowser(req, res)
    return {
      session,
      account,
      browser,
      principal: {
        did: account.did,
        userId: session.user.id,
        sessionId: session.session.id,
        authenticatedAt: new Date(session.session.createdAt),
        kind: 'better-auth',
      },
    }
  }
  const revokeApps = async (did) => {
    for (const token of oauth.stores.listAccountTokens(did))
      await oauth.stores.deleteToken(token.id)
    db.delete('oauth:grants', did)
    await legacy?.revokeAllSessions(did)
  }
  const forgetDevices = async (did) => {
    for (const device of await oauth.stores.listDeviceAccounts({ did }))
      await oauth.stores.removeDeviceAccount(device.deviceId, did)
  }
  const browserSessions = (req) =>
    oauth.auth.api.listSessions({ headers: fromNodeHeaders(req.headers) })
  const needed = () => {
    if (!security || !legacy)
      throw new HttpError(
        503,
        'NotAvailable',
        'Account security is not available yet. Try again shortly.',
      )
  }
  const nextStep = (res, title, csrf, action, contents, button, message) =>
    page(
      res,
      title,
      `<p role="status">${esc(message)}</p>${form(action, csrf, contents, button)}<a href="/account">Return to account settings</a>`,
    )

  app.get(
    '/account',
    guarded(async (req, res) => {
      const ctx = await authenticated(req, res)
      if (!ctx) return
      const { account: a, browser: b, principal, session } = ctx
      const state = security
        ? await security.summary(principal)
        : { backupEmails: [], passwordEnabled: false }
      const [baSessions, appPasswords, legacySessions] = await Promise.all([
        browserSessions(req),
        legacy ? legacy.listAppPasswords(a.did) : { passwords: [] },
        legacy ? legacy.listSessions(a.did) : [],
      ])
      const tokens = oauth.stores.listAccountTokens(a.did)
      const grants = db.get('oauth:grants', a.did) ?? []
      const devices = await oauth.stores.listDeviceAccounts({ did: a.did })
      const migrationState = migration ? await migration.status(principal, { did: a.did }) : null
      const csrf = b.csrf
      const rows = (items, render, empty) =>
        items.length
          ? `<ul class="settings-list">${items.map((item) => `<li>${render(item)}</li>`).join('')}</ul>`
          : `<p class="muted">${empty}</p>`
      const passwordInput = state.passwordEnabled
        ? field(
            'currentPassword',
            'Current password',
            'password',
            'autocomplete="current-password" maxlength="256"',
          )
        : ''
      const identity = section(
        'identity',
        'Identity and email',
        `
      <div class="account-context" aria-label="Current account and data host"><strong data-testid="account-handle">${esc(a.handle)}</strong><span>Signed in as ${esc(a.email)}</span><span>Repository hosted at ${esc(a.pdsUrl)}</span><span>Account DID <code data-testid="account-did">${esc(a.did)}</code></span></div>
      <dl class="identity"><dt>Handle</dt><dd>${esc(a.handle)}</dd><dt>Account DID</dt><dd><code>${esc(a.did)}</code></dd><dt>Personal data server</dt><dd>${esc(a.pdsUrl)}</dd><dt>Primary email</dt><dd data-testid="primary-email">${esc(a.email)} (verified)</dd><dt>Created</dt><dd>${esc(stamp(a.createdAt))}</dd><dt>Account status</dt><dd>Status: ${esc(a.status)}</dd></dl>
      <p class="muted">These settings belong to the email identity shown here. Choosing another account in an application does not switch this console.</p>
      ${form('handle', csrf, field('handle', 'New handle', 'text', `value="${esc(a.handle)}" maxlength="253"`), 'Update handle')}
      ${security ? `<h3>Change primary email</h3><p>Verify your current email, then your new email. Existing browser and application sessions will end after the change.</p>${form('email-request', csrf, '', 'Start email change')}${state.pendingEmail ? `<p>Awaiting verification of ${esc(typeof state.pendingEmail === 'string' ? state.pendingEmail : state.pendingEmail.email)}.</p>${form('email-confirm', csrf, hidden('email', typeof state.pendingEmail === 'string' ? state.pendingEmail : state.pendingEmail.email) + field('token', 'New email verification code', 'text', 'autocomplete="one-time-code" maxlength="256"'), 'Confirm new email')}` : ''}` : ''}
    `,
      )
      const backup = section(
        'recovery',
        'Recovery email',
        security
          ? `
      <p>Add an email you can still access if your primary mailbox is lost. Each recovery address must be verified before it can restore access.</p>
      ${rows(state.backupEmails ?? [], (item) => `<strong>${esc(item.email)}</strong><span>${item.verified ? 'Verified' : 'Awaiting verification'}</span>${form('backup-remove', csrf, hidden('email', item.email), 'Remove recovery email')}`, 'No verified recovery email.')}
      ${form('backup-request', csrf, field('email', 'Recovery email address', 'email', 'autocomplete="email" maxlength="320"'), 'Send recovery verification')}
      <p><a href="/recover">Recover an account using a verified recovery email</a></p>
    `
          : '<p>Recovery email setup is not available yet.</p>',
      )
      const passwords = section(
        'passwords',
        'Passwords',
        security && legacy
          ? `
      <p>${state.passwordEnabled ? 'Optional account password is enabled.' : 'This account has no account password. Email sign-in remains available.'} Passwords here support apps that use the legacy AT Protocol sign-in API. Changing or removing a password ends all sessions and removes existing app passwords.</p>
      ${form('password-set', csrf, passwordInput + field('password', 'New account password', 'password', 'autocomplete="new-password" minlength="12" maxlength="256"'), state.passwordEnabled ? 'Change account password' : 'Set account password')}
      ${state.passwordEnabled ? form('password-remove', csrf, passwordInput, 'Remove account password') : ''}
      <h3>App passwords</h3><p>Give each legacy application its own password. The generated password is shown once; removing it also ends its legacy sessions.</p>
      ${rows(appPasswords.passwords ?? [], (item) => `<strong>${esc(item.name)}</strong><span>Created ${esc(stamp(item.createdAt))}${item.privileged ? ' · Direct-message access' : ''}</span>${form('app-password-revoke', csrf, hidden('name', item.name), 'Revoke app password')}`, 'No app passwords.')}
      ${form('app-password-create', csrf, field('name', 'App password name', 'text', 'maxlength="64"') + '<label class="check"><input type="checkbox" name="privileged" value="true">Allow direct-message access</label>', 'Create app password')}
    `
          : '<p>Password management is not available yet.</p>',
      )
      const sessions = section(
        'sessions',
        'Applications and sessions',
        `
      <p>OAuth grants: ${grants.length}. Revocation prevents new refreshes; existing signed access tokens can remain valid until they expire, up to five minutes.</p>
      <h3>Application permissions</h3>${rows(grants, ([clientId, grant]) => `<strong>${esc(clientId)}</strong><span>${esc((grant.authorizedScopes ?? []).join(' '))}</span>${form('grant-revoke', csrf, hidden('clientId', clientId), 'Revoke application access')}`, 'No remembered application permissions.')}
      <h3>OAuth sessions</h3>${rows(tokens, (token) => `<strong>${esc(token.data.clientId)}</strong><span>Created ${esc(stamp(token.data.createdAt))}</span>${form('oauth-session-revoke', csrf, hidden('sessionId', token.id), 'Revoke OAuth session')}`, 'No active OAuth refresh sessions.')}
      <h3>Legacy application sessions</h3>${rows(legacySessions, (item) => `<strong>${esc(item.appPasswordName ?? 'Account password')}</strong><span>Created ${esc(stamp(item.createdAt))} · Expires ${esc(stamp(item.expiresAt))}</span>${form('legacy-session-revoke', csrf, hidden('sessionId', item.id), 'Revoke legacy session')}`, 'No legacy application sessions.')}
      ${form('revoke', csrf, '', 'Revoke all app sessions')}
      <h3>Account-settings sessions</h3><p>These sessions permit access to this console. OAuth device sign-ins and app permissions are listed separately.</p>
      ${rows(baSessions, (item) => `<strong>${item.id === session.session.id ? 'This browser' : 'Another browser'}</strong><span>${esc(item.userAgent ?? 'Browser details unavailable')} · Created ${esc(stamp(item.createdAt))}</span>${form('browser-session-revoke', csrf, hidden('sessionId', item.id), 'End account-settings session')}`, 'No browser sessions.')}
      <h3>Remembered OAuth devices</h3>${rows(devices, (item) => `<strong>${item.deviceId === b.deviceId ? 'This device' : 'Another device'}</strong><span>Last used ${esc(stamp(item.updatedAt))}</span>${form('device-revoke', csrf, hidden('deviceId', item.deviceId), 'Forget OAuth device')}`, 'No remembered OAuth devices.')}
      ${form('browsers-revoke', csrf, '', 'Sign out all browsers')}
    `,
      )
      const lifecycle = section(
        'lifecycle',
        'Account lifecycle',
        `
      <p>Deactivation pauses repository writes. Reactivation restores them. Deleting the account removes the repository and blobs; the DID history remains.</p>
      ${form('status', csrf, hidden('status', a.status === 'active' ? 'deactivated' : 'active'), a.status === 'active' ? 'Deactivate account' : 'Reactivate account')}
      ${form('delete', csrf, field('confirm', 'Type your handle to delete this test account', 'text', 'autocomplete="off"'), 'Delete test account')}
    `,
      )
      const destinations = config.pds.filter((pds) => pds.id !== a.pdsId)
      const migrationPending = migrationState && migrationState.phase !== 'complete'
      const migrationTarget = migrationState
        ? config.pds.find((pds) => pds.id === migrationState.targetPdsId)
        : null
      const migrationPanel = migration
        ? section(
            'migration',
            'Move your data server',
            `<p>Move this account's repository and blobs to another enrolled data server while keeping its DID and handle. Writes pause during the transfer, and all browser and application sessions and app passwords are revoked. The old server retains a deactivated copy.</p>${migrationState ? `<p role="status">${migrationPending ? `Your migration to ${esc(migrationTarget?.url ?? migrationState.targetPdsId)} is unfinished. Sign in again before resuming; keep repository writes paused until it completes.` : `Last migration completed to ${esc(migrationTarget?.url ?? migrationState.targetPdsId)}.`} Last updated ${esc(stamp(migrationState.updatedAt))}.</p>` : ''}${migrationPending ? form('migration-confirm', csrf, hidden('pdsId', migrationState.targetPdsId), 'Resume data server migration') : destinations.length ? form('migration-request', csrf, `<label>Destination data server<select name="pdsId" required>${destinations.map((pds) => `<option value="${esc(pds.id)}">${esc(pds.id)} — ${esc(pds.url)}</option>`).join('')}</select></label>`, 'Start data server migration') : '<p>No other data server is enrolled.</p>'}`,
          )
        : ''
      page(
        res,
        'Account settings',
        `<p>Manage your sign-in, recovery options, and connected applications.</p><nav class="section-nav" aria-label="Account sections"><a href="#identity">Identity</a><a href="#recovery">Recovery</a><a href="#passwords">Passwords</a><a href="#sessions">Sessions</a><a href="#lifecycle">Lifecycle</a>${migration ? '<a href="#migration">Data server</a>' : ''}</nav>${identity}${backup}${passwords}${sessions}${lifecycle}${migrationPanel}${form('/auth/logout', csrf, '', 'Sign out', 'class="signout"')}<p><a href="${esc(config.clientUrl)}/client">Open test application</a></p>`,
      )
    }),
  )

  app.post(
    '/account/:action',
    express.urlencoded({ extended: false, limit: '16kb' }),
    guarded(async (req, res) => {
      const ctx = await authenticated(req, res)
      if (!ctx) return
      const { session, account, browser, principal } = ctx
      oauth.checkCsrf(req, browser)
      // Browser loading can yield after Better Auth authenticated the request.
      // Recheck the live identity/session before a synchronous credential change.
      if (security) security.summary(principal)
      const action = req.params.action
      const value = (name) => String(req.body[name] ?? '').trim()
      const token = () => value('token')
      // Revoking access does not need recent login; changes to credentials,
      // recovery, identity or lifecycle do. No body DID is used anywhere here.
      if (
        ![
          'revoke',
          'grant-revoke',
          'oauth-session-revoke',
          'legacy-session-revoke',
          'browser-session-revoke',
          'browsers-revoke',
          'device-revoke',
        ].includes(action)
      )
        requireRecent(session)
      if (action === 'migration-request' || action === 'migration-confirm') {
        needed()
        if (!migration)
          throw new HttpError(503, 'NotAvailable', 'Data server migration is not available')
        const target = config.pds.find((pds) => pds.id === value('pdsId'))
        if (!target)
          throw new HttpError(400, 'InvalidPds', 'Choose an enrolled destination data server')
        if (action === 'migration-request') {
          await migration.requestMigration(principal, { pdsId: target.id })
          return nextStep(
            res,
            'Confirm data server migration',
            browser.csrf,
            'migration-confirm',
            hidden('pdsId', target.id) +
              field(
                'token',
                'Migration code',
                'text',
                'autocomplete="one-time-code" maxlength="256"',
              ),
            'Move to destination data server',
            `A migration code was sent to your primary email. Confirm to move your repository and blobs to ${target.url}. Writes will pause and existing sessions and app passwords will end.`,
          )
        }
        await migration.importAccount(principal, {
          did: account.did,
          pdsId: target.id,
          token: token(),
        })
        return page(
          res,
          'Data server migration complete',
          `<p>Your DID and handle are unchanged. Your repository is now on ${esc(target.url)}; the old server retains a deactivated copy. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again to your moved account</a>`,
        )
      }
      if (action === 'handle') await accounts.updateHandle(account.did, value('handle'))
      else if (action === 'status') {
        await accounts.setStatus(account.did, value('status'))
        if (value('status') === 'deactivated') await revokeApps(account.did)
      } else if (action === 'revoke') await revokeApps(account.did)
      else if (action === 'grant-revoke') {
        const id = value('clientId')
        const grants = new Map(db.get('oauth:grants', account.did) ?? [])
        if (!grants.has(id))
          throw new HttpError(404, 'NotFound', 'Application permission not found')
        for (const item of oauth.stores.listAccountTokens(account.did))
          if (item.data.clientId === id) await oauth.stores.deleteToken(item.id)
        grants.delete(id)
        db.set('oauth:grants', account.did, [...grants])
      } else if (action === 'oauth-session-revoke') {
        const item = oauth.stores
          .listAccountTokens(account.did)
          .find((s) => s.id === value('sessionId'))
        if (!item) throw new HttpError(404, 'NotFound', 'OAuth session not found')
        await oauth.stores.deleteToken(item.id)
      } else if (action === 'legacy-session-revoke') {
        needed()
        const item = (await legacy.listSessions(account.did)).find(
          (s) => s.id === value('sessionId'),
        )
        if (!item) throw new HttpError(404, 'NotFound', 'Legacy session not found')
        await legacy.revokeSession(account.did, item.id)
      } else if (action === 'browser-session-revoke') {
        const item = (await browserSessions(req)).find((s) => s.id === value('sessionId'))
        if (!item) throw new HttpError(404, 'NotFound', 'Browser session not found')
        await oauth.auth.api.revokeSession({
          headers: fromNodeHeaders(req.headers),
          body: { token: item.token },
        })
        if (item.id === session.session.id) return res.redirect(303, '/login')
      } else if (action === 'browsers-revoke') {
        await forgetDevices(account.did)
        await oauth.auth.api.revokeSessions({ headers: fromNodeHeaders(req.headers) })
        return res.redirect(303, '/login')
      } else if (action === 'device-revoke') {
        const item = (await oauth.stores.listDeviceAccounts({ did: account.did })).find(
          (s) => s.deviceId === value('deviceId'),
        )
        if (!item) throw new HttpError(404, 'NotFound', 'OAuth device not found')
        await oauth.stores.removeDeviceAccount(item.deviceId, account.did)
      } else {
        needed()
        if (action === 'backup-request') {
          await security.requestBackupEmail(principal, { email: value('email') })
          return nextStep(
            res,
            'Verify recovery email',
            browser.csrf,
            'backup-confirm',
            hidden('email', value('email')) +
              field(
                'token',
                'Recovery email verification code',
                'text',
                'autocomplete="one-time-code" maxlength="256"',
              ),
            'Verify recovery email',
            'Enter the verification code sent to your recovery email.',
          )
        } else if (action === 'backup-confirm')
          await security.confirmBackupEmail(principal, { email: value('email'), token: token() })
        else if (action === 'backup-remove')
          await security.removeBackupEmail(principal, { email: value('email') })
        else if (action === 'email-request') {
          await security.requestEmailUpdate(principal)
          return nextStep(
            res,
            'Verify current email',
            browser.csrf,
            'email-update',
            field(
              'token',
              'Current email verification code',
              'text',
              'autocomplete="one-time-code" maxlength="256"',
            ) + field('email', 'New primary email', 'email', 'maxlength="320"'),
            'Verify current email and continue',
            'A verification code was sent to your current primary email.',
          )
        } else if (action === 'email-update') {
          await security.updateEmail(principal, { email: value('email'), token: token() })
          return nextStep(
            res,
            'Verify new email',
            browser.csrf,
            'email-confirm',
            hidden('email', value('email')) +
              field(
                'token',
                'New email verification code',
                'text',
                'autocomplete="one-time-code" maxlength="256"',
              ),
            'Confirm new email',
            'Verify the code sent to your new primary email to complete the change.',
          )
        } else if (action === 'email-confirm') {
          await security.confirmEmail(principal, { email: value('email'), token: token() })
          return page(
            res,
            'Primary email updated',
            '<p>Your email was changed and existing sessions were ended.</p><a href="/login">Sign in with your new email</a>',
          )
        } else if (action === 'password-set') {
          await security.setPassword(principal, {
            password: String(req.body.password ?? ''),
            currentPassword: String(req.body.currentPassword ?? '') || undefined,
          })
          return page(
            res,
            'Account password updated',
            '<p>Your password was updated. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a>',
          )
        } else if (action === 'password-remove') {
          await security.removePassword(principal, {
            currentPassword: String(req.body.currentPassword ?? '') || undefined,
          })
          return page(
            res,
            'Account password removed',
            '<p>Email sign-in remains available. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a>',
          )
        } else if (action === 'app-password-create') {
          const item = await legacy.createAppPassword(account.did, {
            name: value('name'),
            privileged: req.body.privileged === 'true',
          })
          return page(
            res,
            'App password created',
            `<p>Copy this password into ${esc(item.name)} now. It will not be shown again.</p><code data-testid="app-password">${esc(item.password)}</code><p><a href="/account#passwords">Return to account settings</a></p>`,
          )
        } else if (action === 'app-password-revoke')
          await legacy.revokeAppPassword(account.did, value('name'))
        else if (action === 'delete') {
          if (value('confirm') !== account.handle)
            throw new HttpError(400, 'ConfirmationRequired', 'Handle confirmation did not match')
          await security.requestAccountDelete(principal)
          const state = await security.summary(principal)
          return nextStep(
            res,
            'Confirm account deletion',
            browser.csrf,
            'delete-confirm',
            hidden('confirm', account.handle) +
              field(
                'token',
                'Deletion code',
                'text',
                'autocomplete="one-time-code" maxlength="256"',
              ) +
              (state.passwordEnabled
                ? field(
                    'password',
                    'Current password',
                    'password',
                    'autocomplete="current-password" maxlength="256"',
                  )
                : ''),
            'Permanently delete account',
            'A deletion code was sent to your primary email. This deletes your repository and blobs.',
          )
        } else if (action === 'delete-confirm') {
          if (value('confirm') !== account.handle)
            throw new HttpError(400, 'ConfirmationRequired', 'Handle confirmation did not match')
          await security.deleteAccount({
            did: account.did,
            token: token(),
            password: String(req.body.password ?? '') || undefined,
          })
          return page(
            res,
            'Test account deleted',
            '<p>The PDS repository and account were deleted. The DID history remains available in the PLC directory.</p><a href="/login">Return to sign in</a>',
          )
        } else throw new HttpError(404, 'NotFound', 'Unknown account operation')
      }
      res.redirect(303, '/account')
    }),
  )

  app.get(
    '/recover',
    guarded(async (req, res) => {
      needed()
      const browser = await oauth.loadBrowser(req, res)
      page(
        res,
        'Recover your account',
        `<p>Use a recovery email you verified before losing access to your primary mailbox.</p><form method="post" action="/recover/request">${hidden('csrf', browser.csrf)}${field('email', 'Verified recovery email', 'email', 'autocomplete="email" maxlength="320"')}<button>Send recovery code</button></form><a href="/login">Return to sign in</a>`,
      )
    }),
  )
  app.post(
    '/recover/:action',
    express.urlencoded({ extended: false, limit: '16kb' }),
    guarded(async (req, res) => {
      needed()
      const browser = await oauth.loadBrowser(req, res)
      oauth.checkCsrf(req, browser)
      const value = (name) => String(req.body[name] ?? '').trim()
      if (req.params.action === 'request') {
        await security.requestRecovery({ email: value('email') })
        return page(
          res,
          'Check your recovery email',
          `<p>If this is a verified recovery email, a code has been sent. Enter it and choose a new primary email.</p><form method="post" action="/recover/verify">${hidden('csrf', browser.csrf)}${field('token', 'Recovery code', 'text', 'autocomplete="one-time-code" maxlength="256"')}${field('newEmail', 'New primary email', 'email', 'maxlength="320"')}<button>Verify recovery code</button></form><a href="/recover">Start again</a>`,
        )
      }
      if (req.params.action === 'verify') {
        await security.completeRecovery({ token: value('token'), newEmail: value('newEmail') })
        return page(
          res,
          'Verify your new primary email',
          `<p>Enter the verification code sent to the new primary email. Existing sessions will end after recovery.</p><form method="post" action="/recover/complete">${hidden('csrf', browser.csrf)}${field('token', 'New primary email verification code', 'text', 'autocomplete="one-time-code" maxlength="256"')}<button>Complete account recovery</button></form>`,
        )
      }
      if (req.params.action === 'complete') {
        await security.completeRecoveryEmail({ token: value('token') })
        return page(
          res,
          'Account recovered',
          '<p>Your primary email was updated and existing sessions were ended.</p><a href="/login">Sign in with your recovered account</a>',
        )
      }
      throw new HttpError(404, 'NotFound', 'Unknown recovery operation')
    }),
  )
}
