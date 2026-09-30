import { randomBytes, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { fromNodeHeaders } from 'better-auth/node'
import { emailOTP } from 'better-auth/plugins'
import { AuthorizationError, InvalidRequestError } from '@atproto/oauth-provider/errors'
import { ENTRYWAY_BRAND, renderExperiencePage, resolveBrand } from '../../../entryway-web/src/features/access/index.js'

const FLOW_LIFETIME = 15 * 60_000
const RESEND_COOLDOWN = 5_000
export const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
const opaque = () => randomBytes(32).toString('base64url')

class ExpiredFlowError extends Error {
  constructor(flow, browser) {
    super('This sign-in has expired. Restart it to continue.')
    this.flow = flow
    this.browser = browser
    this.status = 410
  }
}

export function page(res, title, body, status = 200, policy = {}, brand = ENTRYWAY_BRAND) {
  const rendered = renderExperiencePage({ title, body, brand, policy })
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': rendered.contentSecurityPolicy,
  })
  return res.status(status).type('html').send(rendered.html)
}

/** Only called with parameters already validated by upstream authorize/requestManager. */
export function authorizationRedirect(res, issuer, parameters, redirect) {
  const destination = new URL(parameters.redirect_uri)
  const values = {
    iss: issuer,
    ...(parameters.state != null ? { state: parameters.state } : {}),
    ...redirect,
  }
  if (parameters.response_mode === 'form_post') {
    const nonce = opaque()
    const body = `<p>Continue back to your application.</p><form id="callback" method="post" action="${escapeHtml(destination.href)}">${Object.entries(
      values,
    )
      .map(([k, v]) => hidden(k, v))
      .join(
        '',
      )}<button>Continue</button></form><script nonce="${nonce}">document.getElementById('callback').submit()</script>`
    return page(res, 'Return to application', body, 200, {
      formOrigin: destination.origin,
      scriptNonce: nonce,
    })
  }
  const params =
    parameters.response_mode === 'fragment' ? new URLSearchParams() : destination.searchParams
  for (const [k, v] of Object.entries(values)) params.set(k, v)
  if (parameters.response_mode === 'fragment') destination.hash = params.toString()
  res.set('Cache-Control', 'no-store').redirect(303, destination.href)
}

export async function createAuthentication({ app, db, config, accounts, provider, stores, mail }) {
  let accountSecurity
  const origin = new URL(config.issuer).origin
  const brandClients = {
    primary: `${new URL(config.clientUrl).origin}/client-metadata.json`,
    secondary: `${new URL(config.clientUrl).origin}/client-metadata-secondary.json`,
  }
  const pageForFlow = (res, title, body, flow, status = 200, policy = {}) =>
    page(res, title, body, status, policy, resolveBrand(flow?.clientId, brandClients))
  const authOptions = {
    secret: config.betterAuthSecret,
    database: db.sqlite,
    baseURL: config.issuer,
    basePath: '/api/auth',
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    advanced: { useSecureCookies: new URL(config.issuer).protocol === 'https:' },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          await mail.sendOtp({ email, otp, type })
        },
      }),
    ],
  }
  // Better Auth 1.7 eagerly validates its schema during construction.
  // Finish startup migrations before that validation can inspect a partial schema.
  const migration = await getMigrations(authOptions)
  await migration.runMigrations()
  const auth = betterAuth(authOptions)
  const requireSession = (req) => auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
  const loadBrowser = async (req, res, rotate = false) => {
    const device = await provider.deviceManager.load(req, res, rotate)
    let browser = db.get('browser', device.deviceId)
    if (!browser) {
      browser = { csrf: opaque(), createdAt: new Date() }
      db.set('browser', device.deviceId, browser)
    }
    return { ...device, csrf: browser.csrf }
  }
  const checkCsrf = (req, browser) => {
    const a = Buffer.from(String(req.body?.csrf ?? ''))
    const b = Buffer.from(browser.csrf)
    if (req.headers.origin !== origin || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidRequestError('Invalid form origin or CSRF token')
    }
  }
  const fields = (flow, browser) => hidden('flow', flow.id) + hidden('csrf', browser.csrf)
  const save = (flow) => db.set('auth-flows', flow.id, flow)
  const newFlow = (browser, extra = {}) => {
    const flow = { id: opaque(), deviceId: browser.deviceId, createdAt: new Date(), ...extra }
    save(flow)
    return flow
  }
  const getFlow = async (req, res) => {
    const browser = await loadBrowser(req, res)
    checkCsrf(req, browser)
    const flow = db.get('auth-flows', String(req.body?.flow ?? ''))
    if (!flow || flow.deviceId !== browser.deviceId) {
      throw new InvalidRequestError('This sign-in has expired. Start again from your application.')
    }
    const createdAt = new Date(flow.createdAt).getTime()
    if (!Number.isFinite(createdAt) || createdAt > Date.now() || Date.now() - createdAt > FLOW_LIFETIME)
      throw new ExpiredFlowError(flow, browser)
    if (flow.requestUri)
      await provider.requestManager.get(flow.requestUri, browser.deviceId, flow.clientId)
    return { flow, browser }
  }
  const loginForm = (flow, browser) =>
    `<form method="post" action="/auth/email">${fields(flow, browser)}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required><button>Send sign-in code</button></form>`
  const otpForm = (flow, browser, error = '', changeEmail = flow.email) =>
    `${error ? `<p id="otp-error" role="alert" aria-live="polite">${escapeHtml(error)}</p>` : ''}<p id="otp-help" role="status" aria-live="polite">Enter the code sent to <strong>${escapeHtml(flow.email)}</strong>. Codes expire after ten minutes.</p><form method="post" action="/auth/verify">${fields(flow, browser)}<label for="otp">Sign-in code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" minlength="8" maxlength="8" aria-describedby="${error ? 'otp-error ' : ''}otp-help" required><button>Verify code</button></form><div class="account"><form method="post" action="/auth/resend">${fields(flow, browser)}<button class="secondary">Send a new code</button></form><p class="muted">Wait five seconds between code requests. Each email address has a ten-minute request limit.</p><form method="post" action="/auth/email">${fields(flow, browser)}<label for="change-email">Use a different email address</label><input id="change-email" name="email" type="email" autocomplete="email" value="${escapeHtml(changeEmail)}" required><button class="secondary">Change email and send a new code</button></form></div>`
  const sendCode = async (res, flow, browser, emailValue) => {
    const email = String(emailValue ?? '').trim().toLowerCase()
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new InvalidRequestError('Enter a valid email address')
    const now = Date.now()
    if (flow.otpRequestCount >= 5)
      return pageForFlow(
        res,
        'Code request limit reached',
        otpForm(flow, browser, 'Too many code requests for this sign-in. Start again later.', email),
        flow,
        429,
      )
    if (flow.lastOtpSentAt && now - flow.lastOtpSentAt < RESEND_COOLDOWN)
      return pageForFlow(
        res,
        'Wait before requesting another code',
        otpForm(flow, browser, 'Wait five seconds before requesting another code.', email),
        flow,
        429,
      )
    const limitKey = `${email}/${Math.floor(now / 600_000)}`
    const count = db.get('otp-limits', limitKey) ?? 0
    if (count >= 5)
      return pageForFlow(
        res,
        'Try again later',
        otpForm(flow, browser, 'Too many codes were requested for this email. Wait ten minutes.', email),
        flow,
        429,
      )
    if (flow.email && flow.email !== email)
      mail.supersedeOtp({ email: flow.email, type: 'sign-in' })
    db.set('otp-limits', limitKey, count + 1)
    flow.email = email
    flow.otpRequestCount = (flow.otpRequestCount ?? 0) + 1
    flow.lastOtpSentAt = now
    delete flow.authDid
    delete flow.authEmail
    save(flow)
    try {
      await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    } catch {
      return pageForFlow(
        res,
        'Code not delivered',
        otpForm(flow, browser, 'The email service could not deliver your code. Wait five seconds and try again.', email),
        flow,
        503,
      )
    }
    return pageForFlow(res, 'Check your email', otpForm(flow, browser), flow)
  }
  const signupForm = (flow, browser) => {
    const pending = flow.authEmail ? accounts.get(flow.authEmail) : null
    const retry = pending?.status === 'provisioning'
    const available = config.publicHandles?.filter((handle) => !accounts.get(handle))
    const initialHandle = retry ? pending.handle : (available?.[0] ?? '')
    const handleHelp = config.publicHandles
      ? `Available public test handles: ${available?.map(escapeHtml).join(', ') || 'all current handles are reserved; sign in to an existing account'}.`
      : `Use a name ending in ${escapeHtml(config.handleDomains?.[0] ?? '.entryway.test')}.`
    const suggestions = config.publicHandles
      ? `<datalist id="public-handles">${available?.map((handle) => `<option value="${escapeHtml(handle)}">`).join('') ?? ''}</datalist>`
      : ''
    const reservedInvite = flow.authEmail
      ? db.get('entryway:invite-reservations', flow.authEmail)?.code
      : undefined
    const inviteInput =
      config.inviteCodeRequired || config.invites || db.list('entryway:invites').length
        ? `<label for="inviteCode">Invite code${config.inviteCodeRequired ? '' : ' (optional)'}</label><input id="inviteCode" name="inviteCode" value="${escapeHtml(reservedInvite ?? '')}" ${config.inviteCodeRequired ? 'required' : ''} ${reservedInvite ? 'readonly' : ''}>`
        : ''
    return `<p>${retry ? 'Your account setup is unfinished. Retry the saved handle and data server.' : 'Your email is verified. Choose where your data will live.'}</p><form method="post" action="/auth/account">${fields(flow, browser)}<label for="handle">Handle</label><input id="handle" name="handle" placeholder="${escapeHtml(config.publicHandles?.[0] ?? 'alice.entryway.test')}" value="${escapeHtml(initialHandle)}" ${retry ? 'readonly' : ''} ${config.publicHandles ? 'list="public-handles"' : ''} required>${suggestions}<small>${handleHelp}</small><label for="pdsId">Personal data server</label><select id="pdsId" name="pdsId" ${retry ? 'disabled' : ''}>${config.pds.map((p) => `<option value="${escapeHtml(p.id)}"${retry && p.id === pending.pdsId ? ' selected' : ''}>${escapeHtml(p.id)} — ${escapeHtml(p.url)}</option>`).join('')}</select>${inviteInput}<button>${retry ? 'Retry account setup' : 'Create account'}</button></form>`
  }
  const consentForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small></div><p><strong>${escapeHtml(flow.clientName ?? 'Your application')}</strong> requests access:</p><p><code>${escapeHtml(flow.parameters?.scope)}</code></p><form method="post" action="/auth/consent">${fields(flow, browser)}${hidden('did', account.did)}<button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Cancel</button></form>`
  const authenticated = async (req, res, flow, browser, row) => {
    if (row.status !== 'active')
      return pageForFlow(
        res,
        'Account unavailable',
        '<p>This account is deactivated. <a href="/account">Open account settings</a> to reactivate it.</p>',
        flow,
        403,
      )
    await provider.accountManager.upsertDeviceAccount(browser.deviceId, row.did)
    flow.authDid = row.did
    save(flow)
    if (!flow.requestUri) {
      db.delete('auth-flows', flow.id)
      return res.redirect(303, '/account')
    }
    return pageForFlow(
      res,
      'Authorize application',
      consentForm(flow, browser, stores.account(row.did)),
      flow,
      200,
      { formOrigin: new URL(flow.parameters.redirect_uri).origin },
    )
  }
  const guarded = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next)
    } catch (err) {
      if (res.headersSent) return next(err)
      if (err instanceof AuthorizationError)
        return authorizationRedirect(res, config.issuer, err.parameters, err.toJSON())
      if (err instanceof ExpiredFlowError) {
        const restartForm = err.flow.requestUri
          ? `<p>Your sign-in expired. Restart it to continue the same verified application request.</p><form method="post" action="/auth/restart">${fields(err.flow, err.browser)}<button>Restart sign-in</button></form>`
          : '<p>Your sign-in expired. Start again to request a new code.</p><a href="/login">Start a new sign-in</a>'
        return pageForFlow(res, 'Sign-in expired', restartForm, err.flow, 410)
      }
      page(
        res,
        'Unable to continue',
        `<p role="alert">${escapeHtml(err.message)}</p><a href="/login">Start a new sign-in</a>`,
        err.status >= 400 && err.status < 600 ? err.status : 400,
      )
    }
  }
  const form = express.urlencoded({ extended: false, limit: '16kb' })

  app.get(
    '/login',
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res)
      const flow = newFlow(browser)
      page(res, 'Sign in', loginForm(flow, browser))
    }),
  )
  app.get(
    '/oauth/authorize',
    guarded(async (req, res) => {
      const params = new URL(req.originalUrl, config.issuer).searchParams
      if (
        !params.get('client_id') ||
        !params.get('request_uri') ||
        params.getAll('client_id').length !== 1 ||
        params.getAll('request_uri').length !== 1
      ) {
        throw new InvalidRequestError(
          'A pushed authorization request and client identifier are required',
        )
      }
      // Pass only the PAR reference. Redirect URI, scope, state and client data
      // are obtained from the validated provider store, never from browser input.
      const query = { client_id: params.get('client_id'), request_uri: params.get('request_uri') }
      const browser = await loadBrowser(req, res)
      const result = await provider.authorize(query, browser)
      if ('redirect' in result)
        return authorizationRedirect(res, result.issuer, result.parameters, result.redirect)
      const flow = newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
      })
      const sessions =
        result.parameters.prompt === 'create'
          ? []
          : result.sessions.filter((s) => !s.loginRequired && !s.account.deactivated)
      const choices = sessions.map(({ account }) => consentForm(flow, browser, account)).join('')
      pageForFlow(
        res,
        'Sign in to authorize',
        `${choices}${choices ? '<p>Or use another account:</p>' : ''}${loginForm(flow, browser)}`,
        flow,
        200,
        { formOrigin: new URL(flow.parameters.redirect_uri).origin },
      )
    }),
  )
  app.post(
    '/auth/email',
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res)
      await sendCode(res, flow, browser, req.body.email)
    }),
  )
  app.post(
    '/auth/resend',
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res)
      if (!flow.email) throw new InvalidRequestError('Request a sign-in code first')
      await sendCode(res, flow, browser, flow.email)
    }),
  )
  app.post(
    '/auth/restart',
    form,
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res)
      checkCsrf(req, browser)
      const expired = db.get('auth-flows', String(req.body?.flow ?? ''))
      if (!expired || expired.deviceId !== browser.deviceId || !expired.requestUri)
        throw new InvalidRequestError('This sign-in cannot be restarted. Return to your application.')
      const createdAt = new Date(expired.createdAt).getTime()
      if (Number.isFinite(createdAt) && createdAt <= Date.now() && Date.now() - createdAt <= FLOW_LIFETIME)
        throw new InvalidRequestError('This sign-in is still active. Continue with the current page.')
      const result = await provider.authorize(
        { client_id: expired.clientId, request_uri: expired.requestUri },
        browser,
      )
      if ('redirect' in result)
        return authorizationRedirect(res, result.issuer, result.parameters, result.redirect)
      const flow = newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
      })
      db.delete('auth-flows', expired.id)
      const sessions = result.parameters.prompt === 'create'
        ? []
        : result.sessions.filter((session) => !session.loginRequired && !session.account.deactivated)
      const choices = sessions.map(({ account }) => consentForm(flow, browser, account)).join('')
      return pageForFlow(
        res,
        'Sign in to authorize',
        `${choices}${choices ? '<p>Or use another account:</p>' : ''}${loginForm(flow, browser)}`,
        flow,
        200,
        { formOrigin: new URL(flow.parameters.redirect_uri).origin },
      )
    }),
  )
  app.post(
    '/auth/verify',
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res)
      if (!flow.email) throw new InvalidRequestError('Request a sign-in code first')
      const response = await auth.api.signInEmailOTP({
        body: { email: flow.email, otp: String(req.body.otp ?? '').trim() },
        asResponse: true,
      })
      if (!response.ok)
        return pageForFlow(
          res,
          'Check your email',
          otpForm(flow, browser, 'Invalid or expired code. Please try again.'),
          flow,
          400,
        )
      const result = await response.json()
      if (!result.user?.emailVerified || result.user.email.toLowerCase() !== flow.email)
        throw new InvalidRequestError('Email verification did not complete')
      accountSecurity?.assertLoginEmail({ email: flow.email, userId: result.user.id })
      for (const value of response.headers.getSetCookie()) res.append('Set-Cookie', value)
      // Rotate the provider's browser session after successful identity verification.
      const rotated = await loadBrowser(req, res, true)
      flow.authEmail = result.user.email.toLowerCase()
      save(flow)
      const row = accounts.get(flow.authEmail)
      if (!row || row.status === 'provisioning')
        return pageForFlow(res, 'Create your account', signupForm(flow, rotated), flow)
      await authenticated(req, res, flow, rotated, row)
    }),
  )
  app.post(
    '/auth/account',
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res)
      if (!flow.authEmail)
        throw new InvalidRequestError('Verify your email before creating an account')
      const session = await requireSession(req)
      if (session?.user?.email.toLowerCase() !== flow.authEmail || !session.user.emailVerified)
        throw new InvalidRequestError('Sign-in session expired')
      const existing = accounts.get(flow.authEmail)
      let row = existing
      if (!existing || existing.status === 'provisioning') {
        try {
          row = await accounts.create(
            existing
              ? {
                  email: existing.email,
                  handle: existing.handle,
                  pdsId: existing.pdsId,
                  inviteCode:
                    db.get('entryway:invite-reservations', existing.email)?.code ??
                    req.body.inviteCode,
                }
              : {
                  email: flow.authEmail,
                  handle: String(req.body.handle ?? '')
                    .trim()
                    .toLowerCase(),
                  pdsId: String(req.body.pdsId ?? ''),
                  inviteCode: req.body.inviteCode,
                },
          )
        } catch (error) {
          return pageForFlow(
            res,
            'Create your account',
            `<p role="alert">${escapeHtml(error.message)}</p>${signupForm(flow, browser)}`,
            flow,
            error.status >= 400 && error.status < 600 ? error.status : 503,
          )
        }
      }
      accountSecurity?.bindVerifiedIdentity({
        did: row.did,
        email: session.user.email.toLowerCase(),
        userId: session.user.id,
      })
      await authenticated(req, res, flow, browser, row)
    }),
  )
  app.post(
    '/auth/consent',
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res)
      if (!flow.requestUri) throw new InvalidRequestError('No pending authorization')
      const request = await provider.requestManager.get(
        flow.requestUri,
        browser.deviceId,
        flow.clientId,
      )
      if (req.body.decision === 'deny') {
        await provider.requestManager.delete(flow.requestUri)
        db.delete('auth-flows', flow.id)
        return authorizationRedirect(res, config.issuer, request.parameters, {
          error: 'access_denied',
          error_description: 'The user declined access',
        })
      }
      if (req.body.decision !== 'approve')
        throw new InvalidRequestError('Choose whether to allow access')
      const did = String(req.body.did ?? '')
      const session = await provider.accountManager.getDeviceAccount(browser.deviceId, did)
      if (
        !session ||
        provider.checkLoginRequired(session) ||
        (request.parameters.prompt === 'login' && flow.authDid !== did)
      )
        throw new InvalidRequestError('Sign in to this account first')
      const client = await provider.clientManager.getClient(flow.clientId)
      const code = await provider.requestManager.setAuthorized(
        flow.requestUri,
        client,
        session.account,
        browser.deviceId,
        browser.deviceMetadata,
      )
      const granted = new Set(session.authorizedClients.get(flow.clientId)?.authorizedScopes ?? [])
      for (const scope of request.parameters.scope?.split(' ') ?? []) granted.add(scope)
      await provider.accountManager.setAuthorizedClient(session.account, client, {
        authorizedScopes: [...granted],
      })
      db.delete('auth-flows', flow.id)
      authorizationRedirect(res, config.issuer, request.parameters, { code })
    }),
  )
  app.post(
    '/auth/logout',
    form,
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res)
      checkCsrf(req, browser)
      for (const entry of await provider.accountManager.listDeviceAccounts(browser.deviceId)) {
        await provider.accountManager.removeDeviceAccount(browser.deviceId, entry.account.did)
      }
      const response = await auth.api.signOut({
        headers: fromNodeHeaders(req.headers),
        asResponse: true,
      })
      for (const value of response.headers.getSetCookie()) res.append('Set-Cookie', value)
      res.redirect(303, '/login')
    }),
  )
  // Better-auth is used through the public server API. Exposing its entire HTTP
  // API would also expose OTP sending outside this form's CSRF and rate limits.
  return {
    auth,
    requireSession,
    loadBrowser,
    checkCsrf,
    page,
    escapeHtml,
    setAccountSecurity(service) {
      accountSecurity = service
    },
  }
}
