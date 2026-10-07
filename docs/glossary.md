# Entryway terminology and protocol references

## Terms

| Term | Meaning in this project |
| --- | --- |
| Entryway | Account authority and OAuth authorization server for multiple PDS instances. |
| ePDS parity | Matching the agreed email OTP login behaviour and account experience, without carrying over PDS overrides. |
| PDS | Personal Data Server. Hosts repositories, blobs and repository signing keys. |
| PDS fleet | Domain that manages host registration, placement, transfers, draining and retirement. |
| Account | An Entryway-managed ATProto identity, keyed by its DID. |
| DID | Stable decentralized identifier. Changing hosts does not create a new account identity. |
| Handle | Human-readable account name that resolves to a DID. |
| PLC | Identity directory used for `did:plc` documents and their signed operation history. |
| Custody | Who can use a key or authorize an identity change, transfer or recovery. |
| Rotation key | Key authorized to sign PLC identity operations, subject to the directory's rules. |
| Repository key | PDS-held private key that signs repository commits; distinct from PLC authority. |
| Better Auth | Library supplying email proof and browser authentication. It is not the ATProto authorization server. |
| OTP | One-time email code used to prove control of an email address. |
| Browser session | Login state used by Entryway's browser pages. Separate from client OAuth authorization. |
| Device membership | Association between a remembered device and an account DID. |
| Grant | Permissions approved for an OAuth client and account. |
| XRPC | ATProto HTTP API method convention, with contracts defined by lexicons. |
| Lexicon | Schema defining an ATProto method, record or related data structure. |
| PAR | Pushed Authorization Request; submits authorization parameters before browser authorization. |
| PKCE | Proof Key for Code Exchange. A secret created by the client protects the authorization code from use by another client. |
| DPoP | Demonstrating Proof of Possession. The client signs requests to prove it holds the key associated with its token. |
| Port / adapter | A port defines an interface required by a domain. An adapter connects that interface to a database, network service or library. |
| Placement | The committed hosting PDS for an account, with any pending transfer tracked separately. |
| Drain / retire | Stop new placements and move accounts / remove a host from service after all retirement checks pass. |
| Journal / checkpoint | Durable operation history / recorded progress used to resume or reconcile an operation. |
| Reconciliation | Compare recorded intent with observed external state and finish or safely stop an operation. |
| AiaB | Atmosphere in a Box; the isolated local ATProto test environment. |
| Test service | Local service that creates or controls test accounts. A successful test with private APIs does not establish compatibility with public migration tools. |
| Acceptance criterion | Observable result required to complete an issue or milestone. |
| Contract | Agreed inputs, outputs, errors and permission rules for an interface. |
| Domain | A part of the system with one business responsibility, such as Accounts or Identity. |
| Atomic transaction | Related database changes that either all succeed or all fail. |
| Baseline | Recorded behaviour and test results for the starting code revision. |
| Acceptance matrix | Table of required behaviours, their tests, owners and results. |
| Source proof | Evidence that the caller controls the DID being moved from another PDS. |
| Public / confidential client | An app that cannot keep a client credential secret / an app that can, usually on a server. |
| CID | Content identifier used to identify a particular encoded record or blob. |
| Cutover | The point when the account identity starts referring to the destination PDS. |
| CSRF | A browser attack that causes unwanted requests; request checks protect account actions. |
| CSP | Content Security Policy; browser rules that restrict which scripts and content may run. |

## Protocol documentation

Specifications define protocol requirements; guides explain implementation approaches. They do not prove that the spike meets those requirements. Pin the PDS and client versions in acceptance reports.

| Reference | Purpose |
| --- | --- |
| [OAuth specification](https://atproto.com/specs/oauth) | Protocol requirements for client authorization and tokens. |
| [XRPC specification](https://atproto.com/specs/xrpc) | HTTP methods, errors and service authentication. |
| [Account hosting specification](https://atproto.com/specs/account) | Account status, hosting and migration requirements. |
| [Account migration guide](https://atproto.com/guides/account-migration) | Transfer steps and existing tools; these detailed mechanisms are guidance and may evolve. |
| [DID specification](https://atproto.com/specs/did) | Account identity, public keys and the current PDS address. |
| [Account recovery guide](https://atproto.com/guides/account-recovery) | Rotation keys and recovery when a host is unavailable. |
| [Repository specification](https://atproto.com/specs/repository) | Signed data and repository commits. |
| [OAuth client implementation guide](https://docs.bsky.app/docs/advanced-guides/oauth-client) | Independent client discovery, authorization and identity checks. |
