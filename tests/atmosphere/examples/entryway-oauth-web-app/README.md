# Entryway browser OAuth fixture

This separate managed application exercises `@atproto/oauth-client-browser`
against Entryway and its private PDS. Its metadata is served at
`https://browser.atmosbox.internal/oauth-client-metadata.json`; the SDK callback is
`/callback`. The private `.internal` client-ID route satisfies the pinned browser
SDK's hostname validation; it rejects `.test` as a local TLD. The application
uses the sandbox PLC and PDS URLs supplied by its
managed definition. It stores OAuth credentials in the browser SDK's own storage
and makes repository writes directly to the PDS.

The PDS URL is fixed to `https://cluster1.atmosbox.test` in this managed
template. Atmosphere in a Box route URL environment sources can reference only
routes in the same application definition; `cluster1` is owned by the Entryway
application.

The original `entryway-oauth-web-app` managed definition retains a `.test` route
as an unused historical fixture. After it was applied, the browser SDK rejected
that route's client ID, and AiaB's persisted application identity prevented a
route change. The added `entryway-browser-client` definition runs this same
fixture at the private `.internal` URL. It is the client under test, not a
second product component.

The app uses the pinned dependencies and structure of the included vanilla JS
OAuth example, adapted from Bluesky's CC0 cookbook commit
`8eac4b8632a5d128b1df550780a5e2ab30377350`.
