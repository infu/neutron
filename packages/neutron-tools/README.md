These are tools designed to be imported and used by apps.

The package entrypoint is `src/tools.ts` and is run directly by Bun/modern Node
during local development. It exports the app-kernel `exec`/`expose` bridge and
typed guards for the JSON message envelopes used by that bridge.

Apps that declare `capabilities.vetkeys` use the source-bound helpers
`requestVetKeys`, `listVetKeys`, `getVetKeyPublicKey`, `deriveVetKey`, and
`approveVetKeyDerivation`. These helpers deliberately have no `appId`, key
name, context, derivation-input, cycle, or management-canister parameter. The
kernel derives app authority from the live endpoint; `deriveVetKey` reports its
single-use challenge through `onChallenge`. That exact endpoint immediately
calls `approveVetKeyDerivation` as an automatic protocol confirmation, without
focus, transient activation, or another consent decision. The encrypted key
resolves only to the endpoint that began the request.

Apps that need bounded binary transfer between live tile/background endpoints
use `neutron-tools/app_attachments`. `exposeAttachmentTool` declares the exact
input/output name, media type, required flag, and byte cap in the tool metadata;
`callToolWithAttachments` transfers the `ArrayBuffer` on the existing
source-bound private `MessagePort`. Ordinary tool JSON and progress carry no
attachment bytes. The kernel authenticates both endpoints, validates the
declaration before routing, and applies its global per-endpoint byte/count
limits. Callers must still use app-specific media types and validate the binary
payload after receipt.

`preapproved_self_calls` is API 1 only. `querySelf` and `updateSelf` accept
`SelfCallValue`: ordinary structural data plus `Uint8Array` (`ArrayBuffer` as
an input convenience) at positions proven by the trusted live Candid type to
be `blob`/`vec nat8`. Binary may be nested or repeated. The SDK snapshots and
transfers copied buffers over the source-bound private port; it never adds a
positional body or exposes an attachment-direction plan. The generic
`app_attachments` module remains the separate app-to-app endpoint tool
protocol. Self calls permit at most 512 binary leaves in either direction
while retaining the independent 1,900,000-byte aggregate ceiling.

Certified app publication is API 2 only. A manifest selects the
`certified_assets` backend interface at API 2, declares one full scoped store
and its closed collections, and binds each collection to an API-2 shared-path
HTTP mount. Collection templates own path, mutation, body-source, cache/CORS,
Host-authority, and response-profile policy; Certified Assets V1 is not
accepted.

Resident backgrounds have an explicit canonical frame-security mode. Ordinary
backgrounds are credentialless opaque, persistent browser storage uses a
persistent dedicated origin, and `dedicated_resident_origin` selects the
credentialless ephemeral dedicated origin. The two dedicated capabilities are
mutually exclusive.

Tool descriptors may opt into sensitive audit projection only with the closed
annotation `"neutron:audit": "metadata_only"`. Other values are rejected.

An exact cross-app provider tool may declare the closed annotation
`"neutron:consent": "provider_once"`. Its handler receives optional
`context.presentUserInterface({ tileId, tool, arguments })` only for that live
invocation. The provider must feature-detect the callback before preparing or
mutating state. Kernel consumes the capability once, derives the installed
provider and original caller, opens or focuses the provider's exact tile, and
routes the opaque arguments only to a private tool annotated with both
`"neutron:visibility": "same_app"` and
`"neutron:audience": "foreground_tile"`. The private handler verifies
`context.audience`, owns the user-visible decision, and uses its scoped Kernel
client for any accepted self call. Kernel does not render or interpret the
provider's review.

The presentation callback is a one-use invocation capability, not a global
helper, session grant, or discoverable tool. Returning without consuming it
fails the invocation. An old Kernel supplies no presentation callback, so new
provider code must fail closed before preparation instead of falling back to
ordinary tool consent. `context.requestApproval(review)` is deprecated and
retained only for compatibility with already-published Wallet 0.3.6 and its raw
Kernel JSON dialog; new providers must not use it.

An automation tool may instead combine
`"neutron:visibility": "same_app"` with
`"neutron:audience": "agent_root"`. Kernel exposes and routes it only to the
incoming live depth-zero Agent root and attests that audience to the handler;
human and nested-agent calls fail before target dispatch. This is a separate
UI-free tool contract, not a bypass for the foreground presentation path.

Run the package tests with:

```sh
bun test
```
