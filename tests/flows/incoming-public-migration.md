# Test an independent account moving into Entryway

## Prerequisites

Contributors: run `./tests/local.sh fresh-group incoming-public-journey` for a disposable Atmosphere in a Box project. After `prepare` and `up` in an owned project, use `./tests/local.sh incoming-public-journey` instead. Follow the [testing guide](../../docs/testing.md#public-incoming-journey) for setup and cleanup. The journey uses public pages and XRPC, not private fixture commands.

## Inputs

- The project's access projection identifies the standalone stock source, PLC directory and Mailpit; service configuration supplies the Entryway issuer, service DID and destination handle domain.
- Use separate fresh source and destination emails, different handles, generated passwords and a client-held recovery key. The destination email proof is not evidence of source authority.
- If the deployment requires invitations, an administrator issues one separately. The migrant supplies the invite code, not administrator credentials.

## Steps and assertions

1. Create the standalone account, upload a PNG and write a profile referencing it. Keep the original source session for the cutover checks.
2. Verify the destination email by OTP. Present a **fresh** code, the source DID and the new handle on the incoming page. Expect a 200 `no-store` preparation and a one-time 32-character arrival code absent from the URL. Retain the handoff and prepared destination endpoint.
3. Obtain PLC confirmation at the source email and sign the prepared operation on the source. Submit to Entryway with a source service JWT bound to `submitPlcOperation`: a wrong arrival code gets 409 `ArrivalExpired`; the correct code with a JWT bound to `createAccount` gets 403. With both correct, expect 200 `no-store`. Before creation, read the PLC head and compare the whole signed operation, including the signature. Abandoning the move here does not remove Entryway's rotation key.
4. Mint a fresh `createAccount` service JWT and send the arrival header, destination handle, password, recovery key and any required invite. Expect 200 `no-store`, the original DID, new handle and `active: false`. Exact replay gets 409 `OperationConflict`; Entryway refuses ordinary `getSession` while paused.
5. Export the CAR and list/download blobs at the source; import and upload directly to the prepared destination using tracked credentials. Check that a repository commit exists but the destination is inactive. Refresh at Entryway (200), activate at the stock destination with the refreshed credential, then verify activated status.
6. Read the chosen profile and byte-identical blob there. The PLC document must name the prepared endpoint and destination handle; the recovery key must lead the rotation list, followed by the approved handoff keys in order. Password `createSession` at Entryway succeeds with either handle or DID and returns the source DID. Deactivate the source; the tracked destination refresh still returns 200 and the original DID.
7. Sign in by destination OTP in a fresh browser context and check the original DID. Authorize the independent SDK by destination handle with visible consent and check the verified DID and Entryway issuer. Read back its DPoP write via the SDK audience-derived link at the prepared PDS. Reload, verify the DID again, refresh successfully and read back another write made with a different access token. Revoke the client session and verify its refresh session disappears from the server's account page, not just from the client. Separately authorize the confidential client and verify its subject, destination audience and write URI.
8. On the standalone deactivated source, the original access token's write gets 401 `AccountDeactivated`. The original refresh token still gets 200 for the source DID with `active: false` and `status: deactivated`. The rotated access token also gets 401 `AccountDeactivated` on write.

The client chooses what to transfer and when to activate. This flow checks the chosen state, not an exhaustive inventory or writes after export. The [synthetic migration](external-migration.md) exercises restart boundaries separately.
