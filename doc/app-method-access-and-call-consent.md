# App Method Access And Call Consent

[Back to documentation index](./index.md)

Neutron has two separate security layers around app backend calls:

1. **Backend method access** determines which principals the generated Motoko
   actor accepts.
2. **Frontend call consent** determines whether the trusted kernel UI will sign
   a call for an isolated app frame and whether it first asks the owner.

These layers must not be treated as the same policy. An `authorized` method is
not necessarily a confirmed call, and a message-bus permission does not change
the method's canister-level access.

## Names To Use

Use these terms consistently:

- **Method access level:** `authorized` or `internal` for ordinary apps;
  reviewed kernel methods may also be `public`.
- **Public protocol route:** a separate `public_ingress` registration with an
  exact protocol/id, mode, query caller class or one of the direct-ingress and
  paid-canister update classes, and admission bounds.
- **Execution mode:** `query` or `update`.
- **Frontend consent route:** preapproved self call, confirmed canister call,
  same-app tool call, cross-app granted tool call, or persistent capability
  request.

In prose, prefer **owner-authorized** when explaining `authorized`. One Neutron
has one owner, but that owner may register multiple equivalent authorized
principals for browsers, recovery identities, or trusted tools.

Do not use `public` to mean merely "exposed" or "installed." In this system,
`public` means callable without Neutron owner authorization, including by an
anonymous Internet caller.

## Backend Method Access Levels

App methods are declared with annotations on functions inside the app's
backend `Init` class:

| Annotation | Registry access | Generated behavior |
| --- | --- | --- |
| `/*query*/` | `authorized` | Public Candid query that requires an authorized owner principal. |
| `/*update*/` | `authorized` | Public Candid update that requires an authorized owner principal, except for a route-only paid public-ingress handler that opts into `public_ingress_cycles`. |
| `/*query:unauthorized*/` | `public` | Kernel package only. Ordinary apps are rejected and declare `capabilities.public_ingress`. |
| `/*internal*/` | `internal` | Private generated wrapper; absent from the public Candid service. |

For an authorized method, the assembler inserts this check into the generated
actor wrapper:

```motoko
assert(NeutronKernel.is_authorized(NeutronCaller));
```

The check is against the caller principal. It does not know which app tile,
background process, or frontend tool caused the call. Every authorized
principal has the same owner authority and can call an authorized method
directly with an IC agent or CLI without using the Neutron UI.

The exception is a synchronous update handler used exclusively by
`caller: "canister"` public-ingress routes and explicitly injected with
`public_ingress_cycles`. When it also needs caller access, the canonical
generated argument order is `["caller", "public_ingress_cycles"]`. The
capability is an exact function argument, never part of the app-wide backend
environment. Opting in suppresses the ordinary owner-authorized wrapper, so an
app that also needs an owner call must expose a separate ordinary method.

Ordinary apps cannot remove authorization from a method to avoid a frontend
dialog. A deliberately public query or update protocol uses
`capabilities.public_ingress`, whose compiler-generated dispatcher enforces an
exact handler, byte bounds, lifecycle/toggle checks, and a query caller policy
or—on updates—either self-authenticating direct ingress with no payment or a
positive canister-paid static floor, plus rate, concurrency, pending-dispatch,
and cycle-reserve admission.

For a paid route, the static floor is accepted and retained before later
payload, reserve, concurrency, or rate admission, so it must cover all work
that can become irreversible. Inside an opting-in handler, `available()` is
the captured still-unaccepted surplus minus amounts already requested, while
`request(amount)` accumulates a request and traps if it exceeds that remainder;
neither accepts cycles directly. After the handler mutation commits, the outer
dispatcher attempts the request only if the route, lease, fingerprint,
authority epoch, and persisted completion are still live. Supplemental
acceptance is best-effort and non-atomic; revocation after dispatch returns
`#revoked_after_dispatch` without accepting the supplement, and unaccepted
surplus is refunded.

## Why App Frames Use The Kernel

Third-party surfaces never receive the Kernel origin. Under the
browser-surface-origin runtime, an ordinary package is eligible for originful
surfaces only after a
selected package proves readiness with the packer-owned
`.neutron/browser-surface-origins.v1.json` marker or the inherently new
`browser_permissions` declaration and the checked install transaction records
the app in the certified surface-origin sidecar. The Kernel combines the app
installation's browser nonce with each surface key to derive a separate exact
origin for each tile ID, tray, and ordinary background. Those surfaces use
credentialless `sandbox="allow-scripts allow-same-origin"` frames; instances
of the same tile ID intentionally share that tile's origin.

Historical packages without readiness evidence, the explicit predecessor
upgrade bridge, and the unsupported-browser fallback retain the released
credentialless opaque frame policy: `sandbox="allow-scripts"` and
`origin: "null"`. Dedicated
backgrounds continue to use the compiled opaque, credentialless-ephemeral, or
persistent mode specified in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).
No mode gives app script the Kernel's origin or access to the Kernel
frontend's Internet Identity credentials.

Browser-feature delegation is separate from frontend call consent. It is
denied by default. An app can declare only the closed V1 `camera` and
`microphone` features for exact tile IDs in `browser_permissions`; the normal
install or update review displays that request. Once accepted, the Kernel
intersects the Host-bound child policy with the exact iframe `allow` policy,
and the tile calls browser APIs such as `getUserMedia()` directly. The browser
or operating system may still prompt or deny access. No media session, lease,
or per-use call passes through the Kernel backend, and V1 delegates neither
feature to tray or background surfaces.

When an app frame needs the authenticated owner identity for a canister call,
it asks the Kernel over the source-bound message bus. The Kernel:

1. Derives the requesting app and endpoint from the registered frame or private
   `MessagePort`.
2. Loads the live installed Candid interface rather than trusting schemas from
   the app package.
3. Validates and normalizes the arguments against that interface, including
   binary leaves where the live Candid type is `blob`/`vec nat8`.
4. Applies the relevant frontend consent route.
5. Uses the currently authenticated owner identity for the canister call.

This is the practical route for app UI, but it is not what makes the method
`authorized`. The generated actor's principal assertion is the backend
authorization boundary.

## Current Frontend Call Routes

| Operation | App API | Owner dialog | Important restrictions |
| --- | --- | --- | --- |
| Run a listed self query | `querySelf(method, args)` | No | Exact method must be listed in `preapproved_self_calls.methods`, owner-authorized, owned by the source app, and a query. Arguments and results follow the method's complete live Candid type, including nested or repeated blobs. |
| Run a listed self update | `updateSelf(method, args)` | No | Exact method must be listed in `preapproved_self_calls.methods`, owner-authorized, owned by the source app, and an update. Arguments and results follow the method's complete live Candid type, including nested or repeated blobs. |
| Make a canister call through the owner identity | `callCanisterDialog({ canister, method, args })` | When the source app has no active invocation | A same-Neutron target uses the private attachment-aware API-1 self-call wire and ordinary owner consent when the source app has no active invocation. While that app has an active invocation, an unscoped request fails with `SCOPED_CONTEXT_REQUIRED`, while a valid scoped request fails with `USER_INTERACTION_REQUIRED`. An eligible external call made through a live invocation-scoped client uses the generic JSON route and agent decision policy. The Kernel validates live input and calls only after the applicable decision. |
| Call a tile, tray, or background tool in the same app | `callTool(...)` | No | Target must be a live endpoint; JSON Schema is checked at the endpoint and kernel. |
| Call another app's live endpoint tool | `callTool(...)` | When the source app has no active invocation: one-call or session grant | Kernel identifies both endpoints. A matching live session grant is honored first; otherwise an invocation-scoped call uses the agent decision policy and an ordinary call uses the owner dialog. |
| Call another app's `provider_once` tool | `callTool(...)`, then target-only `context.requestApproval(review)` | One provider-prepared decision outside Agent Mode | Kernel validates the original tool input before dispatch, ignores exact and wildcard session grants for this route, and gives only that invocation a one-use approval callback. The target prepares and freezes the operation, supplies one bounded inert JSON object, and receives no reusable grant. Direct Agent roots auto-resolve; nested calls send the complete provider review to the root agent. |
| Add or remove backend-call reservations | `requestBackendCallReservations(...)` | When the source app has no active invocation: persistent-access dialog | Scopes must be declared by the app manifest. An invocation-scoped action-only request uses the agent decision policy, and an allowed reservation change persists. An optional same-app post-grant call uses the private attachment-aware API-1 wire and supports nested or repeated blobs; the generic JSON tool accepts actions only. |
| Install package-declared backend-call reservations | `capabilities.backend_calls.install_reservations` | App install dialog | Every exact scope is kernel-normalized, displayed in install review, and applied only after the accepted app installation becomes active. |
| Call from trusted kernel UI or an authorized CLI | Actor or agent API | No app dialog | The caller already possesses an authorized principal; backend authorization still applies. |
| Call a declared public-ingress route externally | Actor or agent API | No | Use the generated app/protocol/mode physical dispatcher and stable V1 wire. Queries obey recipient caller policy. A direct authenticated update requires a self-authenticating user principal and accepts no cycles; a paid update must come from a canister with at least its `required_cycles` floor. The recipient still applies admission. |

All app helper routes above use the same frontend message bus. There is no raw
app-facing action that signs an arbitrary canister call without the kernel's
validation or consent path.

## Declare Preapproved Self Calls

An app may declare up to 32 exact owner-authorized query or update methods that
its own registered tile, tray, and background endpoints may call without a
per-call dialog:

```json
{
  "capabilities": {
    "preapproved_self_calls": {
      "api": 1,
      "methods": [
        "wallet_snapshot",
        "wallet_catalog",
        "wallet_contact_destinations",
        "wallet_refresh_metadata",
        "wallet_refresh_balances",
        "wallet_transfer",
        "wallet_funding_prepare_v1",
        "wallet_funding_execute_v1",
        "wallet_allowances_page_v1"
      ]
    }
  }
}
```

The `methods` array must be non-empty, unique, and contain exact method names. Wildcards
are not supported. During packaging and registry normalization, every name must
resolve to a function owned by the declaring app with `access: "authorized"`
and type `query` or `update`. Public, internal, missing, malformed, and duplicate
entries are rejected.

Installation discloses the general no-dialog capability plus every exact method
and its query/update type. Updates are identified as state-changing. Method
names remain app-selected identifiers and do not attest behavior. Descriptions
are not part of this declaration; the normalized method inventory is the
authority. Adding, removing, or changing a method or type on upgrade changes the
requested installation disclosure.

This is a frontend capability only. It is stored in the installed capability plan
and does not create a field in the app's exact Motoko
`AppBackendEnvironment.capabilities` group. The backend method remains
owner-authorized in the generated actor.

There is one `preapproved_self_calls` protocol: API 1. It does not declare
attachment directions, attachment positions, media types, or per-method binary
limits. Binary data is ordinary Candid application data. A method may use one
or many `Blob` values directly or inside records, options, variants, and
vectors:

```motoko
type SaveProfileRequest = {
  display_name : Text;
  avatar : ?{
    bytes : Blob;
    content_type : Text;
  };
};
```

The canonical browser representation of a Candid blob is a `Uint8Array`;
`ArrayBuffer` is accepted as an input convenience and results normalize to
`Uint8Array`. The SDK snapshots each binary leaf and may transfer the copied
backing buffer over the already-authenticated private `MessagePort`; caller
buffers remain usable. This is an internal transport optimization. It does not
create another capability, another app-visible API, or a positional argument
outside the method's Candid signature. Generic app-tool attachments remain a
separate cross-endpoint facility and do not change self-call Candid.

Before dispatch, the kernel loads the trusted live Candid service, recursively
matches the value to that type, rejects binary at non-binary positions, and
retains an immutable normalized snapshot. It enforces finite Candid metadata,
encoded-message, binary-leaf count, aggregate binary-byte, value-depth,
container-element, decoder-allocation, per-endpoint in-flight, and global
in-flight limits. Replies receive equivalent raw-Candid preflight before a
decoder can allocate their nested values.

One direction may contain at most 512 binary leaves but still only 1,900,000
aggregate binary bytes. The leaf-count ceiling preserves bounded Mail list and
Wallet history responses with hundreds of small blobs; it is not an increase
to the byte budget.

When a trusted approval or inspection surface displays such a value, it never
renders, hex-encodes, or truncates the bytes as text. For every live binary
leaf it derives a stable field/index path from Candid and displays the byte
length and a SHA-256 digest of the exact immutable bytes:

```text
args[0].avatar[0].bytes
Blob · 184,221 bytes
SHA-256 · 6f21…9a04
```

The digest is transient review information, not app-supplied metadata.
Persistent generic audit retains method/outcome and bounded aggregate binary
counts and sizes, not bytes, base64, hex, field values, or content hashes.
Persisting a content hash could reveal equality or permit guesses against
low-entropy private data.

## Calling An App Query

Use `querySelf()` for a query listed by the requesting app:

```ts
import { querySelf } from "neutron-tools/app";

const snapshot = await querySelf("wallet_snapshot", [null]);
```

The kernel verifies that:

- the source is a registered endpoint;
- `wallet_snapshot` belongs to that endpoint's installed app;
- the installed capability plan lists it in `preapproved_self_calls.methods`;
- its registry access remains `authorized`;
- the registry declares it as a query rather than an update or internal
  method; and
- `[null]` matches the live Candid input.

The call uses the authenticated kernel identity, so an authorized query still
passes the generated principal check. It does not need a mutation dialog
because an IC query cannot commit state or make update calls.

`querySelf()` cannot read another app's backend method. Cross-app integration
should normally use a declared live endpoint tool. That endpoint can read its
own backend and return a schema-validated result.

An authorized query that is not listed cannot use `querySelf()`. It may use the
confirmed call route instead.

## Calling A Preapproved App Update

Use `updateSelf()` for an update listed by the requesting app:

```ts
import { updateSelf } from "neutron-tools/app";

const report = await updateSelf("wallet_refresh_metadata", [null]);
```

The kernel applies the same source-app ownership, exact manifest list, live
Candid validation, and owner-authorization checks as `querySelf()`, while also
requiring the registry method type to be `update`. It fixes the destination to
the current Neutron canister and signs with the current owner identity without
opening a per-call dialog.

The method may carry any finite binary shape admitted by its live Candid type.
The SDK does not split a final blob from the request, and the kernel does not
rewrite the physical method signature.

Preapproval does not grant the backend any additional external authority. For
example, Wallet refresh still reaches only ledger canisters covered by its
separately approved persistent backend-call reservations.

## Provider-Mediated One-Shot Tools

An app which is itself trusted to interpret and execute a specialized operation
may expose an exact tool with the closed annotation:

```json
{
  "annotations": {
    "neutron:consent": "provider_once"
  }
}
```

This route exists for cases where the target provider must derive authoritative
facts before anyone can make an informed decision. Wallet, for example, must
load ledger metadata, decimals, fees, and current allowance state; Kernel must
not learn token standards or ask the untrusted calling Swap app to provide
those facts.

For a cross-app call, Kernel first validates the original arguments against the
target's live JSON Schema. It then dispatches the exact target handler without
the ordinary preliminary frontend-tool prompt and provides a private optional
callback on that invocation:

```ts
await context.requestApproval(review);
```

The callback is available only to the live `provider_once` handler. It is not a
discoverable Kernel tool, not a transferable token, and not data in the public
tool arguments. Before calling it, the provider must prepare and freeze the
exact operation. `review` is a JSON object bounded to 16 KiB plus the ordinary
depth/element limits and rendered as inert text in fixed Kernel chrome. Kernel
derives and displays the requesting app and target provider identities and
labels the review as supplied by that provider; it does not interpret review
field names or values.

Outside Agent Mode, the original call must come from the focused source tile
with transient user activation; a background, tray, or unfocused caller fails
before provider preparation. `requestApproval()` then creates exactly one owner
decision for that invocation. Existing exact or wildcard tool-session grants
are ignored, the dialog offers no session option, and approval creates no
grant. The handler must consume the callback exactly once; returning without a
completed approval is an invalid request. Reject, Escape, timeout, source or
target replacement, cancellation, invocation end, a second callback, or replay
fails closed. Kernel rechecks the original caller, target, sessions, AppScopes,
versions, tool, validated-argument digest, invocation, and cancellation state
after every await.

During Agent Mode, a direct root request resolves without owner UI. A request
from a descendant suspends at this callback and sends the complete bounded
provider-authored review to the root agent for one allow or deny decision. It
never opens an owner dialog and never reduces the operation to only argument
counts. A provider handler must still use its scoped
`context.kernel.updateSelf()` for any exact preapproved backend call after the
decision.

The annotation deliberately trusts the target provider to call
`requestApproval()` before its own preapproved effect. Kernel cannot prove that
ordering without understanding the provider or gating every possible app
effect. This does not promote the provider into Kernel's trusted computing
base: Kernel still isolates it and treats its review as untrusted app content.
The owner instead makes an app-level trust decision when installing and
updating that exact provider package. A provider which does not receive the
optional callback, including on an older Kernel, must reject before preparation
or execution; it must not fall back to an ordinary session grant.

| Runtime combination | Required compatibility behavior |
| --- | --- |
| New Kernel + old app | Every valid released ordinary tool, grant, self-call, attachment, control, and Agent route behaves as before. Malformed tool input fails before permission UI. |
| New Kernel + old provider | Existing provider features work; no annotated tool is invented. |
| Old Kernel + new provider | Existing features work; the annotated handler finds no callback and performs no new provider operation. |
| New Kernel + new provider | The provider-prepared one-shot route is available. |

Ordinary tools retain their existing one-call/session-grant behavior. The first
version rejects `provider_once` on attachment and control tools so the new path
cannot become an alternate binary or cancellation protocol.

## Calling Any Other App Method

The current general route for an app frame to invoke an unlisted method is
`callCanisterDialog()`:

```ts
import {
  callCanisterDialog,
  loadNeutronCanisterId,
} from "neutron-tools/app";

const result = await callCanisterDialog({
  canister: await loadNeutronCanisterId(),
  method: "save_profile",
  args: [["Ada", "ada@example.test", "Notes", true]],
});
```

When the source app has no active invocation, the kernel shows an owner
signature-approval dialog containing the kernel-attested source endpoint, target
canister, method, and arguments. An eligible external call carrying a live agent
invocation follows the nested-agent decision policy instead. A rejection
prevents dispatch. An approval or agent allow causes the kernel to sign and
execute the external call with the authenticated owner identity. Same-Neutron
calls use the separate self-call consent behavior below.

The v2 external route uses anonymous live discovery, a fresh owner-bound actor,
and ICBlast's closed method registry, with numeric principal shorthand disabled.
It converts the arguments once into an immutable prepared Candid snapshot. The
review shows the method as quoted, escape-safe JSON and the complete prepared
argument array as canonical JSON; approval dispatches that exact snapshot. The
Kernel rechecks source, installation, invocation, and owner authority before
network dispatch. A change after dispatch withholds the reply and reports an
unknown outcome.

An unknown outcome means the call may have executed and an update may have
committed. Do not retry a mutating call merely because its reply was cancelled,
withheld, or lost. Use a protocol-level idempotency key where the remote
canister supports one, or reconcile against authoritative remote state before
deciding whether another attempt is safe.

For a nested Agent Mode request through `canister.call_dialog_v2`, the Kernel
challenge carries that complete review value, not only counts. It must fit the
ordinary bounded JSON contract or fail before the decision and signature.

`canister.schema_v2` performs its own fresh anonymous discovery. Its result is
informative; `canister.call_dialog_v2` always rediscovers and prepares the
actual call rather than trusting an earlier schema response.

`canister.call_dialog_v2` does not accept or enforce an expected method mode,
and its result does not attest the live mode. A caller therefore cannot use an
earlier scan or schema response to prove that a later signed call is still a
query or update; the interface can change between those operations.

If application safety depends on a method remaining a query or update, do not
use an earlier schema result as authorization for this generic route. Use a
purpose-built protocol or trusted tool that enforces the required mode at
dispatch, or conservatively treat the signed call as state-changing.

The unversioned `canister.schema` and `canister.call_dialog` tools are
universally callable compatibility routes, not privileges gated to historical
installations. They retain owner-authenticated discovery and pre-conversion
ICBlast JSON handling, including numbered-principal conveniences. Their dialog
therefore labels the displayed values as pre-conversion JSON. Both route
families share Kernel consent, audit, authority, dispatch, and reply fencing.
The compatibility routes lack v2's anonymous discovery, closed method lookup,
phase-aware request cancellation, and complete prepared-argument review in an
Agent Mode challenge. An Agent-scoped signed call through the compatibility
route is rejected before live discovery; use the v2 route for nested Agent
signed calls.

Ordinary global SDK helpers prefer v2 and select an unversioned route only when
the connected Kernel does not advertise its v2 counterpart. An
invocation-scoped client does not negotiate down to the compatibility route;
it must discover and call the v2 tool or report that the operation is
unsupported.

For a call back into the Neutron canister, the trusted registry must resolve
the target as a non-internal method owned by the live source app. An app cannot
use this dialog to call a kernel method or another installed app's method. The
SDK automatically sends this target through the private attachment-aware API-1
self-call wire; the generic JSON-only call tool rejects it.

When the source app has no active invocation, that private route retains
ordinary owner consent. While the source app has an active invocation, an
unscoped module-level same-Neutron call dialog fails with
`SCOPED_CONTEXT_REQUIRED` before call preparation and creates no owner approval
UI. A valid invocation-scoped self-dialog instead fails with
`USER_INTERACTION_REQUIRED`; Agent Mode cannot invoke the same-canister route.
The management canister is always rejected. External-canister calls retain the
ordinary consent policy.

`callCanisterDialog()` consent is a property of that frontend tool. It is not
inferred from the method being `authorized`. When the source app has no active
invocation it opens the owner dialog; an eligible external call carrying a live
agent invocation follows the nested-agent policy. A same-Neutron call while the
source app has an active invocation follows the scoped-context and
owner-interaction failures described above rather than opening that dialog or
entering the agent decision flow.

An app avoids per-call consent for its own exact listed methods by using
`querySelf()` or `updateSelf()` instead.

## Wallet Example

Wallet demonstrates all three relevant routes:

- `wallet_snapshot` and `wallet_catalog` are authorized queries read through
  `querySelf()` and listed in `preapproved_self_calls.methods`, so loading the
  tile does not prompt.
- `wallet_contact_destinations` is a preapproved Wallet query that uses its
  installed, typed Contacts backend dependency. It receives only the read-only
  discovery function and never Contacts memory or mutation authority.
- `wallet_refresh_metadata` and `wallet_refresh_balances` are authorized
  updates listed in the same capability and called through `updateSelf()`, so
  refreshes do not prompt.
- The released contact-bound `wallet_transfer` method is also listed exactly.
  Wallet's own Send/Withdraw confirmation is the one trusted decision, then
  `updateSelf()` executes without a second generic backend-call dialog. Its
  signature and contact/revision semantics remain unchanged.
- The resident exposes exact `wallet_fund_v1` with
  `{"neutron:consent":"provider_once"}`. It requires the scoped callback,
  prepares an ICRC-1 transfer or short-lived ICRC-2 allowance through
  `wallet_funding_prepare_v1`, requests one Wallet-authored review, and executes
  only the returned command key through `wallet_funding_execute_v1`.
- `wallet_allowances_page_v1` obtains bounded live approval pages for the
  Wallet UI. It is an update rather than a query because it makes remote ledger
  query calls during replicated execution.
- Ledger setup uses `requestBackendCallReservations()` to add and remove all
  selected ledger reservations atomically. The same approval request includes
  the same-app `wallet_set_ledgers` update, avoiding a second dialog after the
  reservation batch succeeds.

Reviewed preset ledgers use a whole-principal reservation plus exact scopes for
their reviewed history index and any native minter route. A custom ledger id
receives only exact `icrc1_metadata`, `icrc1_balance_of`, `icrc1_fee`,
`icrc1_transfer`, and `icrc3_get_blocks` scopes for existing Wallet behavior.
Allowance support additionally requires exact `icrc2_allowance`,
`icrc2_approve`, and `icrc103_get_allowances` scopes. Existing custom-ledger
installations keep their old functionality and show **permission required**
until the owner adds those scopes through the existing ledger-settings batch;
neither Swap nor Approvals creates a surprise reservation prompt.

`wallet_set_ledgers` is intentionally not preapproved. It runs only as the
same-app operation attached to the owner-approved reservation batch. The
persistent ledger reservations control which remote principals the Wallet
backend may call; the preapproved self-call list controls which Wallet methods
its isolated frontend may ask the kernel to sign without another dialog.

Before a reservation decision is created, an attached same-app operation is
resolved against the installed app and its arguments are validated against the
live Candid interface. The owner dialog displays the exact method and complete
normalized argument value retained by the kernel as type-aware canonical JSON.
Strings and keys are quoted, and control, bidi-formatting, zero-width, and other
default-ignorable code points are shown as visible Unicode escapes without
changing the value that will execute. Approval applies to that immutable value;
invalid arguments fail before any dialog or reservation mutation. The kernel
repeats the authorization and Candid checks at execution time after the
reservation batch succeeds.

For direct Swap funding, Wallet's prepared review binds the exact ICRC account,
amount, current transfer fee, maximum debit, optional memo, command id, and
freshness deadline before one `icrc1_transfer`.
For a pull-based Swap, it binds the exact spender account, short expiration,
swap amount, transfer-from fee, current-to-replacement absolute allowance and
expiration, separate approval fee, and maximum source-account debit before one
`icrc2_approve`. That approval is not itself one-use: the spender may make
multiple pulls and choose destinations within the remaining allowance. Swap
performs its own quote-bound DEX action after Wallet returns; Wallet accepts no
caller-selected canister method.

Wallet rechecks review-sensitive ledger metadata, fee, freshness, and current
allowance state before first dispatch. A change rejects the prepared command
and requires a fresh request and review instead of silently increasing the
approved fee, debit, or allowance.

Wallet enumerates ICRC approvals with the draft
`icrc103_get_allowances` route, filters to its exact default source account,
and revokes through `icrc2_approve(amount = 0, expected_allowance = current)`.
ICP uses its separate paginated `get_allowances` and `remove_approval` API and
displays its exact account-identifier spender. A custom ledger without a
complete enumeration API is reported as unsupported; history is not presented
as a complete allowance registry.

That legacy ICP adapter is for listing and revocation. The first
`wallet_fund_v1` contract does not create a new ICP approval; a pull-based
funding request requires ICRC-2.

Funding and revoke retries use Wallet-owned durable command identity. The
backend freezes exact ledger arguments and `created_at_time` before the first
value-moving await, accepts an exact ledger `Duplicate` as the receipt for that
command, and reconciles ambiguous outcomes instead of rebuilding and blindly
retrying them. Kernel's generic approval and audit are not the financial
transaction journal.

A `pending` result means the call may have committed. The same caller and
request id must reach the same durable command and protocol-safe recovery path;
a new id is not a retry. Expiry stops a new dispatch but does not turn an
already-dispatched command into a rejection or make that pending record
evictable.

Kitchen Sink provides a bounded reference declaration: ordinary data methods
such as `read_profile`, `read_counter`, and `bump_counter`, plus the exact
capability-lab bridge methods such as `random_bytes`,
`chain_key_public_key`, and `chain_key_sign_receipt`, are preapproved same-app
calls. Its undeclared methods, including the reviewed `echo` example, continue
to use the confirmation dialog.

## App-Isolated Key Lifecycle Consent Is Separate

A `capabilities.vetkeys` declaration creates neither a key nor a standing
lifecycle grant. Installation discloses the requested slots and risks. Later,
`requestVetKeys()` from the focused app tile opens a dedicated kernel-owned
decision for the exact reserve, enable, disable, rotate, retire-generation,
manager-transfer, or retire-slot action. The app-authored description and slot
purpose are unverified context; the kernel derives app id, slot declaration,
current authorized principal, and lifecycle warnings.

Private derivation does not add another user consent layer. A live tile or
resident starts one 60-second challenge with an ephemeral browser transport
key, then the exact originating endpoint immediately confirms its own challenge
through `approveVetKeyDerivation()`. The API name is historical: confirmation
requires no focus, transient user activation, or prompt and returns the
encrypted result only to that still-live endpoint. Tray endpoints cannot use
the flow. Every currently authorized Neutron principal may derive enabled
retained generations; `key_holder` denotes only the lifecycle manager.

Kernel Settings exposes that manager-bound lifecycle with destructive
confirmations. An app invoked through an approved cross-app tool call may derive
internally without a second vetKeys or model-provider permission. Disable and
retirement stop future supported recovery but cannot erase keys already held by
a browser or restored snapshot. See [App-Isolated vetKeys](./app-isolated-vetkeys.md).

## Chain-Key Assertion Consent Is Install-Bounded

`capabilities.chain_key_signing` has a different lifetime from vetKey lifecycle
actions. Installing it grants the backend autonomous use of the exact declared
assertion slots within their byte, rate, cycle, concurrency, namespace, and
runtime-toggle bounds. The install dialog and Settings show kernel-derived slot
and algorithm facts while keeping `purpose` visibly untrusted. There is no
second prompt for each assertion, and a preapproved same-app bridge method does
not widen the injected signing leaf.

A verifier can still interpret a signed assertion as authority for a
high-impact operation. Apps must constrain assertion semantics; install
approval is standing bounded signing authority, not one-shot transaction
consent.

That standing authority is assertion-only. It exposes no raw digest,
transaction encoder, threshold key name, derivation path, attached cycle amount,
or retry control. A future Kernel-provided raw threshold-transaction signing
adapter for Bitcoin/EVM/Solana must be a separate capability and require
one-shot, transaction-shaped owner presence immediately before signing;
neither this assertion install grant nor an ordinary agent/tool grant may
satisfy that raw-signing decision. This stricter rule does not describe a
separately installed, owner-trusted Wallet which interprets its own asset
protocol, prepares a bounded `provider_once` review, and executes through its
own preapproved backend method. See [App-Isolated Chain-Key Assertion Signing
V1](./app-isolated-chain-key-signing.md).

## Frontend Tool Permissions Are Separate

The message bus allows calls between UI endpoints:

- calls among tile, tray, and background endpoints belonging to the same app
  are allowed by default;
- outside a validated Agent Mode invocation, calls to another app require a
  one-call or session grant unless the exact target tool declares
  `provider_once`; and
- each endpoint publishes JSON Schema tool descriptors used for discovery and
  validation.

These permissions govern frontend endpoint routing only. A same-app tool can
perform local browser work without a prompt, but if it then requests an
  authorized backend update, the preapproved self-call list or canister-call
  dialog still applies.

Likewise, granting one app permission to call another app's frontend tool does
not grant either app an authorized principal or bypass a backend wrapper. A
matching live session grant keeps its normal meaning inside an agent invocation
and is checked before the Kernel asks for a new agent decision for an ordinary
tool. A `provider_once` invocation deliberately ignores exact and wildcard
session grants, both for the owner route and the nested Agent route. Its target
provider must ask through the invocation-scoped approval callback, and the
result authorizes only that suspended request.

## Agent Mode Calls

Agent Mode changes who answers a frontend permission decision, not backend
method authorization. The owner first enables one exact installed agent app
version and resident entrypoint. A turn must start from that app's focused tile
with transient user activation.

During a live invocation, a direct agent-selected app tool or delegable kernel
action does not show an owner dialog. This policy follows invocation provenance;
it does not replace the consent path of every unrelated request merely because
an agent turn is active. When a called app reaches a new permission boundary,
authority is not inherited. The kernel suspends that exact request and asks the
root agent for one allow or deny decision using a bounded, kernel-produced
challenge. V2 signed-call challenges follow the complete review-value rule
above; the compatibility route rejects an Agent-scoped signed call instead of
creating a reduced challenge. An allow for a frontend tool resumes only that
request and creates no one-call or session grant. A denial closes further
permission requests from that invocation node.

For a `provider_once` child, target dispatch occurs before the decision so the
provider can prepare authoritative facts. Its one-use `requestApproval()` is
the permission boundary: direct roots resolve it automatically, while a
descendant sends the complete provider review to the root agent. A prior
ordinary tool grant cannot bypass it. The provider sees `context.agentMode`
and the Kernel-derived immediate caller, but receives no owner identity claim
from tool arguments. It must use `context.kernel` for the later preapproved
self update.

Nested handlers must issue invocation-dependent work through the
`context.kernel` client supplied to their `exposeTool()` handler. It preserves
private invocation provenance and cancellation. Top-level helpers and clients
are still correct for ordinary work when the source app has no active
invocation, but they do not implicitly inherit the invocation of the handler
that calls them. A generic protected call from an app participating in the
active turn without that scope fails with `SCOPED_CONTEXT_REQUIRED` rather than
opening a surprise owner dialog.

For backend access, a nested handler can make an action-only reservation request
through its invocation-scoped Kernel client. The top-level
`requestBackendCallReservations()` helper, including its attachment-aware
post-grant call form, does not inherit invocation provenance. An agent allow for
a reservation mutation is different from an ephemeral frontend-tool allow: it
deliberately applies the requested persistent reservation, still bounded by the
installed manifest declaration.

Owner-only operations are never sent to the agent judge. This includes
management-canister and Neutron administration calls, install or uninstall,
owner and controller changes, workspace switching, cycle administration, and
external provider login. The app receives `OWNER_REQUIRED` or
`USER_INTERACTION_REQUIRED` and must let the owner perform the operation in
kernel UI.

Preapproved self calls and existing backend reservations retain their normal
meaning. Matching live frontend session grants are checked before a new
permission decision only for ordinary tools; `provider_once` explicitly omits
that shortcut. Agent decisions do not broaden any declaration or bypass the
generated Motoko owner check.

Agent Mode does not currently create an unattended background principal. The
owner first enables one exact agent app version and entrypoint, and each root
turn begins from that agent's focused tile with transient user activation.
Within that live turn, a trusted Wallet can fund direct-root or root-approved
nested work without another owner prompt. Standing autonomous roots, per-agent
budgets, and background spending after the invocation ends are separate future
authority designs.

## Security Rules

1. Do not use public ingress merely to remove an owner approval dialog; it is a
   deliberate externally callable protocol surface.
2. Treat every `caller: "any"` public-ingress query result as intentionally
   available to anonymous Internet callers.
3. List only exact, owner-authorized methods whose no-dialog behavior is
   appropriate for every live endpoint of that app.
4. Use `provider_once` only when the owner deliberately trusts the target app
   to prepare the review before exercising its own preapproved authority. Never
   let a session grant substitute for its scoped callback.
5. Use frontend tools for app-to-app integration instead of coupling callers
   to globally named backend methods.
6. Use `querySelf()` and `updateSelf()` only for exact declared self calls; use
   `callCanisterDialog()` for unlisted methods.
7. Use `requestBackendCallReservations()` for persistent authority to call
   external canisters; do not confuse it with permission to call app methods.
8. Never trust app-reported app ids, Candid, schemas, identities, or caller
   context. The kernel must derive them from installed state and registered
   endpoints.
9. Do not rely on an earlier external schema response to prove method mode at a
   later signed call. Use a dispatch-time mode-enforcing contract when mode is a
   security condition.
10. Treat an unknown update outcome as potentially committed. Reconcile or use
   remote idempotency before retrying.

## Enforcement Summary

`querySelf()` and `updateSelf()` use the private API-1 self-call wire rather
than generic Kernel tools. The Kernel derives the app from the registered
source, reads only the installed registry capability, enforces the expected
method type and owner-authorized access, validates against the live Candid
interface, fixes the destination to the current Neutron canister, uses the
authenticated owner identity, and passes through the normal message-bus
concurrency and audit path. Same-Neutron `callCanisterDialog()` and post-grant
calls in `requestBackendCallReservations()` use that same wire with their
respective consent policy.

The app cannot provide an authoritative app id, target canister, schema,
identity, access level, binary-field path, digest, or Candid type in either
request.

For `provider_once`, the Kernel similarly derives the original caller and
target endpoint bindings and never accepts caller, provider, owner, or Agent
identity from the provider review. The review is an immutable bounded display
value, not backend arguments or an authority token. Approval resumes only the
same still-live provider handler; that handler remains responsible for binding
its frozen command key to its later exact preapproved self update.

## Related Documentation

- [App Developer Guide](./app-developer-guide.md)
- [App-Isolated vetKeys](./app-isolated-vetkeys.md)
- [App Tray](./app-tray.md)
- [Kernel-App Message Bus](./kernel-app-communication.md)
- [Security Model](./security-model.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
