# App Method Access And Call Consent

[Back to documentation index](./index.md)

Use this contract when implementing or reviewing app calls. Resolve exact tool
descriptors, capability bounds, and app-specific method inventories from source;
do not infer them from an older package or an example in this document.

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

Paid public ingress has a separate admission and cycle-acceptance contract; a
frontend grant cannot substitute for it. Use
[Compiler And Actor Assembly](./compiler-and-actor-assembly.md) for generated
wrappers and the public-ingress dispatcher.

## Why App Frames Use The Kernel

App frames do not receive the Kernel origin or its Internet Identity
credentials. Installation-owned browser-surface origins use credentialless
`sandbox="allow-scripts allow-same-origin"` framing and an exact per-surface
origin. Historical packages, the predecessor upgrade bridge, and browsers
without the required credentialless support retain opaque
`sandbox="allow-scripts"` framing. Dedicated backgrounds have their own declared
origin mode. The readiness evidence, URL construction, and browser-feature
delegation contract are defined in
[Kernel HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).

Opaque framing has a separate message-bus limitation: a document that replaces
an app by navigating within its existing iframe still reports `origin: "null"`
and may receive a new port under that app's registered endpoint. Exact-origin
mode rejects a replacement document on another origin. Kernel-origin storage
remains isolated. New apps must target installation-owned origins; unsupported
browser fallback and Kernel-host app serving are planned for removal in
[Deprecated Compatibility Paths](./deprecated.md). App migration alone does not
remove the browser fallback, and the removal plan has not changed runtime behavior.

Browser-feature delegation is independent of call consent. Install-approved
`browser_permissions` grants for exact tiles intersect the HTTP and iframe
policies; the app calls browser APIs directly. Browser or operating-system
permission may still be required. A media permission grants no owner identity
or backend authority.

When an app frame needs the authenticated owner identity for a canister call,
it asks the Kernel over the source-bound message bus. For its current self-call
and v2 external-call routes, the Kernel:

1. Derives the requesting app and endpoint from the registered frame or private
   `MessagePort`.
2. Loads live Candid from the installed service for self calls or anonymous
   discovery for external calls, rather than trusting an app-supplied schema.
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
| Call another app's live endpoint tool | `callTool(...)` | No new dialog for an install-declared exact tool; otherwise one-call or session consent outside Agent Mode | Kernel identifies both endpoints and checks the live descriptor. Ordinary calls honor a matching live session grant before asking the owner; invocation-scoped calls honor exact install declarations but otherwise use the agent decision policy instead of session grants. |
| Request session access to an exact set of another app's tools | Kernel `permissions.request` with `target` and `tools` | One session-access dialog for the missing tools | Kernel discovers and validates every requested live descriptor, displays their titles and descriptions, and records a separate grant for each approved name, bound to both endpoint sessions. Existing valid grants require no new owner dialog. |
| Open or focus an installed app tile | `openAppTile(...)` | No for a live direct app endpoint | The retained compatibility route confines navigation to the active workspace, forces exact app/tile reuse, and applies workspace capacity. This grants visible navigation only and has no navigation cooldown. |
| Inspect or arrange the visual workspace | Kernel `workspace.inspect` / `workspace.control` tools | No | Source must be a live resident background whose installed app declares `agent_entrypoints`. Invocation-free resident calls and live direct roots are admitted; delegated descendants are rejected. Control applies one open/focus/close/place/resize/move/switch/expand/restore operation through the canonical workspace store and grants no target-app effect authority. |
| Call another app's `provider_once` tool on the current provider-UI lane | `callTool(...)`, then target-only `context.presentUserInterface(...)` | One decision in the provider's tile | Kernel validates the public tool input, ignores session grants, and gives that invocation one callback which can open or focus only the provider's exact tile and route opaque arguments to a private `same_app` + `foreground_tile` tool. The provider tile may use exact preapproved methods to prepare non-value-moving review state and persist cancellation; only the affirmative action may dispatch value-moving execution. Kernel opens no dialog and learns no app-domain semantics. |
| Call a provider's root-agent tool | `callTool(...)` from the invocation-scoped root client | No | The exact target tool must declare `same_app` visibility and the `agent_root` audience. Kernel admits only the active depth-zero root, attests that audience, and rejects ordinary callers and delegated descendants before target dispatch. |
| Add or remove backend-call reservations | `requestBackendCallReservations(...)` | When the source app has no active invocation: persistent-access dialog | Requests originate from a tile or background and use manifest-declared scopes. An invocation-scoped action-only request uses the agent decision policy, and an allowed reservation change persists. An optional same-app post-grant call uses the private attachment-aware API-1 wire and supports nested or repeated blobs; the generic JSON tool accepts actions only. |
| Install package-declared backend-call reservations | `capabilities.backend_calls.install_reservations` | App install dialog | Every exact scope is kernel-normalized, displayed in install review, and applied only after the accepted app installation becomes active. |
| Request a one-time cycle-bearing backend call | Kernel `backend_calls.cycles_request` | Owner approval before first execution, including Agent callers | Requires the app's backend-call declaration and a tile or background source for the decision. The exact call and cycle amount are reviewed and durably journaled; status recovery with the same request ID does not execute again. This creates no standing reservation or larger recurring budget. |
| Offer or prepare app installation | Kernel `apps.install_offer` / `apps.install_prepared` | Owner-controlled installation review | These routes present installation work, not deployment authority. Prepared installation requires exact install-declared access to `kernel/apps.install_prepared`; offer admission depends on focused owner interaction or a live Agent invocation. Neither lets an Agent approve installation. |
| Call from trusted kernel UI or an authorized CLI | Actor or agent API | No app dialog | The caller already possesses an authorized principal; backend authorization still applies. |
| Call a declared public-ingress route externally | Actor or agent API | No | Use the generated app/protocol/mode physical dispatcher and stable V1 wire. Queries obey recipient caller policy. A direct authenticated update requires a self-authenticating user principal and accepts no cycles; a paid update must come from a canister with at least its `required_cycles` floor. The recipient still applies admission. |

Backend-call reservations remain bound to the exact installed `AppScope`.
A principal reservation is exclusive: only its owner may call any method on
that canister, including read methods. Another app's exact or method-wide
grant cannot override it, including grants retained from an earlier Kernel.
Installing or requesting an exact grant on another app's reserved principal
fails; acquiring a principal already covered by another app's exact grant also
fails. Method-wide grants remain usable on other, unreserved principals.
Without a principal reservation, a matching method or exact grant authorizes
its owner. Duplicate ownership within one tier fails closed. Wallet-reserved
ledgers must be accessed through Wallet's declared tools or exposed backend
functions; there is no direct fee-read exception.

All app helper routes above use the same frontend message bus. There is no raw
app-facing action that signs an arbitrary canister call without the kernel's
validation or consent path.

## Declare Preapproved Self Calls

An app may declare exact owner-authorized query or update methods that
its own registered tile, tray, and background endpoints may call without a
per-call dialog:

```json
{
  "capabilities": {
    "preapproved_self_calls": {
      "api": 1,
      "methods": [
        "read_counter",
        "bump_counter"
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

Use the private transport's exact live Candid graph, not ICBlast's public JSON
Schema projection, as the authority for binary positions and encoded values.
Resolve enforced bounds and encoder compatibility from the implementation when
changing a payload shape; binary leaf count and aggregate byte size are
independent limits. The detailed wire contract is in
[Self Calls With Nested Binary Values](./kernel-app-communication.md#self-calls-with-nested-binary-values).

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

const counter = await querySelf("read_counter", []);
```

The kernel verifies that:

- the source is a registered endpoint;
- `read_counter` belongs to that endpoint's installed app;
- the installed capability plan lists it in `preapproved_self_calls.methods`;
- its registry access remains `authorized`;
- the registry declares it as a query rather than an update or internal
  method; and
- `[]` matches the live Candid input.

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

const counter = await updateSelf("bump_counter", [1]);
```

The kernel applies the same source-app ownership, exact manifest list, live
Candid validation, and owner-authorization checks as `querySelf()`, while also
requiring the registry method type to be `update`. It fixes the destination to
the current Neutron canister and signs with the current owner identity without
opening a per-call dialog.

The method may carry any finite binary shape admitted by its live Candid type.
The SDK does not split a final blob from the request, and the kernel does not
rewrite the physical method signature.

Preapproval does not grant the backend any additional external authority.
Remote backend calls still require the app's separately approved reservations
or other explicitly injected capability.

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

This route exists for cases where the target provider must own a specialized
decision surface and derive authoritative facts before anyone can make an
informed decision. Wallet, for example, must load ledger metadata, decimals,
fees, and current allowance state; Kernel must not learn token standards or ask
the untrusted calling Swap app to provide those facts.

On the current provider-UI lane, Kernel first validates the original arguments
against the target's live JSON Schema. It then dispatches the exact target
handler without the ordinary preliminary frontend-tool prompt and provides a
private optional callback on that invocation:

```ts
return context.presentUserInterface({
  tileId: "main",
  tool: "operation_review_v1",
  arguments: request,
});
```

The callback is available only to the live `provider_once` handler. It is not a
discoverable Kernel tool or transferable token. The provider must invoke it
before backend preparation or execution. Its closed request names one declared
provider tile, one tool, and bounded opaque JSON arguments. Kernel derives the
provider app from the suspended public invocation, opens or reuses and focuses
that exact tile in the active workspace, waits for its registered endpoint, and
requires the private tool to declare both
`{"neutron:visibility":"same_app"}` and
`{"neutron:audience":"foreground_tile"}`.

Kernel validates the private tool's input and output schemas and injects the
original caller plus the attested `foreground_tile` audience. It does not
interpret or render the arguments. The provider tile verifies the audience,
may use exact preapproved methods to load and freeze non-value-moving review
state, and renders its own review and concrete action/cancel controls. Only the
affirmative action may dispatch the value-moving execute method; cancel may
persist a provider-owned terminal rejection. A caller therefore makes one
decision in the trusted provider UI, not one app-tool decision plus one transfer
decision.

Outside Agent Mode, any exact live app endpoint may ask the provider to present
the request. A background, tray, or unfocused tile gains no financial authority:
the provider's own visible action remains the user decision. Existing exact or
wildcard tool-session grants are ignored, and the interaction creates no grant.
The handler must consume the callback exactly once; returning without a
completed presentation is invalid.
Timeout, source or target replacement, cancellation, a second use, or replay
fails closed. Kernel binds the callback to the selected tool's originating live
handler call and rechecks the original caller, target, sessions, AppScopes,
versions, and cancellation state after asynchronous steps.

Opening the provider UI programmatically focuses its exact iframe as ordinary
navigation. The `foreground_tile` audience attests that Kernel selected and
routed to that exact provider tile; it is not a continuing browser-focus
capability. Moving focus or workspace selection while the dialog is open does
not cancel the request while the bound endpoint/session remains live, but
closing the provider tile before private dispatch does. Kernel does not blur
the provider or restore the caller when the interaction settles; normal
workspace interaction owns focus state.

The annotation deliberately trusts the target provider to call
`presentUserInterface()` before its own preapproved effect and trusts the
provider tile to keep preparation, display, decision, and execution correctly
ordered. Kernel cannot prove that ordering without understanding the provider
or gating every possible app effect. This does not promote the provider into
Kernel's trusted computing base: Kernel still isolates it and treats all app
messages as untrusted input. The owner instead makes an app-level trust decision
when installing and updating that exact provider package. A provider which
does not receive the optional callback—for example, because Kernel omitted the
support marker required by its SDK—must reject before preparation or execution;
it must not fall back to an ordinary session grant.

During an active Agent invocation, the same public `provider_once` tool receives
`context.requestApproval(review)` instead of `presentUserInterface`. The provider
prepares an exact operation, submits its bounded review, and executes only after
the root Agent allows that review. The callback preserves the immediate caller
and the exact provider invocation, and creates no standing transaction or signing
grant. Normal users continue to review actions in the provider's own tile.

Providers may also retain direct-root tools with both
`{"neutron:visibility":"same_app"}` and `{"neutron:audience":"agent_root"}`.
Kernel hides those tools from ordinary calls, admits only the active depth-zero
root, and injects `context.audience` as `agent_root`. The SDK rejects missing or
mismatched attestation before the handler, and delegated descendants cannot use
these tools. Existing direct-root integrations remain compatible.

Both provider callbacks share one use, so a handler cannot stack the two paths.
For ordinary callers, the legacy `requestApproval(review)` path remains supported
and renders the bounded review as inert raw JSON. For an Agent invocation, that
same callback sends a fresh, one-operation review to the root permission judge;
provider presentation arguments and results remain opaque to Kernel.

Ordinary tools retain their one-call/session-grant behavior. `provider_once`
is rejected on attachment and control tools; it is not an alternate binary or
cancellation protocol. Malformed tool input fails before permission UI.

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
Discovery may disclose the owner's principal to the target before operation
approval, and cancellation can leave the old owner dialog active for later
approval. The compatibility routes lack v2's anonymous discovery, closed method
lookup, phase-aware cancellation, and complete prepared-argument review. An Agent-scoped signed call through the compatibility
route is rejected before live discovery; use the v2 route for nested Agent
signed calls.

Ordinary global SDK helpers prefer v2 and select an unversioned route only when
the connected Kernel does not advertise its v2 counterpart. An
invocation-scoped client does not negotiate down to the compatibility route;
it must discover and call the v2 tool or report that the operation is
unsupported. New external integrations must require v2; both the unversioned
tools and ordinary SDK fallback are planned for removal. See
[Deprecated Compatibility Paths](./deprecated.md#unversioned-external-canister-tools).

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

## Backend Reservations And Post-Grant Calls

Persistent backend-call reservations control which remote scopes an app's
backend can call. Preapproved self calls control which of that app's methods
its frontend can ask the Kernel to sign without another dialog. Neither grants
the other.

`requestBackendCallReservations()` can batch declared reservation changes and
attach a same-app operation to run after approval. Resolve that operation
against the installed app and validate its arguments against live Candid before
creating a decision or mutating reservations. The owner reviews the exact
method and complete normalized value retained by the Kernel. Review renders
strings and keys as quoted JSON, visibly escaping control and formatting code
points without changing the value that will execute. Binary values follow the
self-call review contract above.

Approval applies only to that immutable value. Kernel rechecks authorization
and Candid before execution after the reservation batch succeeds. Do not treat
reservation mutation and the following application operation as an atomic
transaction; design recovery for an operation that fails after access changes.

For financial integrations, a provider must own authoritative preparation,
review, execution, and a durable transaction journal. An unknown result can mean
the operation committed. Retain the same operation identity across retries and
reconcile through the provider's recovery protocol; a new request ID is a new
operation. Kernel routing and generic audit do not provide financial
idempotency. Use the Wallet integration contract in
[`apps/wallet/README.md`](../apps/wallet/README.md) for its current tools and
recovery APIs. New integrations must use the durable transfer APIs identified
in [Deprecated Compatibility Paths](./deprecated.md#legacy-wallet-transfers).

## App-Isolated Key Lifecycle Consent Is Separate

A `capabilities.vetkeys` declaration creates neither a key nor a standing
lifecycle grant. Installation discloses the requested slots and risks. Later,
`requestVetKeys()` from the focused app tile opens a dedicated kernel-owned
decision for the exact reserve, enable, disable, rotate, retire-generation,
manager-transfer, or retire-slot action. The app-authored description and slot
purpose are unverified context; the kernel derives app id, slot declaration,
current authorized principal, and lifecycle warnings.

Private derivation does not add another user consent layer. A live tile or
resident starts a short-lived challenge with an ephemeral browser transport
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

`capabilities.wallet_custody_signing` is an independent explicit installation
grant to an owner-trusted wallet app. It authorizes that app's backend to sign
exact 32-byte digests using its own custody namespace. Kernel does not decode
transaction effects or enforce the wallet's UI against its digest; the installed
wallet owns protocol validation, provider decisions, and durable command replay.
Human callers use wallet-owned provider presentation. Agent callers can use
the public provider tool with a fresh root-reviewed operation or the existing
separate attested direct-root tools. An assertion grant never implies
custody authority. See the [wallet custody contract](./app-isolated-chain-key-signing.md#wallet-custody-signing-v1).

`capabilities.chain_key_signing` has a different lifetime from vetKey lifecycle
actions. Installing it grants the backend autonomous use of the exact declared
assertion slots within their byte, cycle, concurrency, namespace, and
runtime-toggle bounds. The install dialog and Settings show kernel-derived slot
and algorithm facts while keeping `purpose` visibly untrusted. There is no
second prompt for each assertion, and a preapproved same-app bridge method does
not widen the injected signing leaf.

A verifier can still interpret a signed assertion as authority for a
high-impact operation. Apps must constrain assertion semantics; install
approval is standing bounded signing authority, not one-shot transaction
consent.

The assertion capability does not expose a raw-digest signing operation or let
the app choose a threshold key name, derivation path, cycle attachment, or retry
policy. Keep that interface separate from the explicit wallet-custody capability.
See [App-Isolated Chain-Key Assertion Signing](./app-isolated-chain-key-signing.md)
for their respective injected APIs and authority boundaries.

## Frontend Tool Permissions Are Separate

The message bus allows calls between UI endpoints:

- calls among tile, tray, and background endpoints belonging to the same app
  are allowed by default;
- outside a validated Agent Mode invocation, calls to another app require a
  matching install-declared `frontend_tools` grant, a one-call or session grant,
  or the exact target tool's `provider_once` confirmation; and
- each endpoint publishes JSON Schema tool descriptors used for discovery and
  validation.

These permissions govern frontend endpoint routing only. A same-app tool can
perform local browser work without a prompt, but if it then requests an
authorized backend update, the preapproved self-call list or canister-call
dialog still applies.

Likewise, granting one app permission to call another app's frontend tool does
not grant either app an authorized principal or bypass a backend wrapper. A
live Agent invocation honors its calling app's install-declared exact tool
access; other nested calls use the invocation decision policy rather than an
ordinary session grant. A `provider_once` invocation deliberately ignores
install-declared, exact, and wildcard session grants for its fresh decision.
Its target provider must use the appropriate scoped callback: human presentation
or Agent review. The result completes only that suspended request.
The private `foreground_tile` tool cannot be called through ordinary routing.
The separate `agent_root` tool is visible and callable only from the active
depth-zero root.

An existing install-declared route remains available to ordinary UI requests
while another invocation uses the same app or resident. Checking that exact
route with `permissions.request` also creates no new grant and needs no new
decision. Ordinary tile-to-Wallet reads and tile-to-resident-to-Wallet reads
therefore do not inherit an unrelated Agent invocation or pause behind it.
Agent handlers still use `context.kernel` to preserve their own invocation and
cancellation; undeclared access and provider-owned confirmation retain their
existing decision requirements.

### Declare Exact App Tools At Installation

A Kernel that does not support a capability rejects it during checked
installation. Use the supported package-update workflow for compatible Kernel
and app successors; do not add a permissive parser fallback or replace an
installed capability plan to force acceptance. See
[Package Updates](./package-updates.md).

An app with known integrations can declare the tools it uses in `neutron.json`:

```json
{
  "capabilities": {
    "frontend_tools": {
      "api": 1,
      "targets": [
        {
          "app": "evm_wallet",
          "tools": ["evm_accounts_v1", "evm_balances_v1"]
        }
      ]
    }
  }
}
```

`apps.install_prepared` separately consumes an exact declaration targeting
`app: "kernel"`. That declaration authorizes preparation and presentation of
installation review, not installation itself. Declaring a Kernel tool name
does not bypass that tool's own admission or owner-consent requirements.

Installation and upgrade review list the exact apps and tool names. Approval
activates those calls for every surface of the consumer installation, including
its invocation-scoped Agent handlers. A consumer can call a declared tool directly;
it does not need a Connect button or `permissions.request` to establish the same
access. Calling the grouped permission API for already declared tools also returns
immediately after checking the live descriptors. The normal runtime permission
API remains available for integrations selected later by the owner.

Target app IDs and tool names are exact, with no wildcard declarations. Duplicate
targets and tool names are rejected; the capability plan sorts both inventories
before fingerprinting them. The live target descriptor controls tool visibility,
audience, argument validation, and provider confirmation. Declaring a private or root-only
tool never makes it callable from another audience. Declaring a provider-confirmed
transaction tool permits using that integration, while the provider must still
obtain a fresh decision about each actual transaction.

The declaration is part of the existing persisted app capability plan, like
`preapproved_self_calls`; it creates no additional session cache or managed-memory
root. Every dispatch checks the current caller plan and both live AppScopes,
versions, generations, and endpoint sessions. Reconnecting an approved app does
not discard its install declaration. Removing the declaration takes away that
authority, and replacing the consumer installation cannot inherit its predecessor's
plan. Targets refer to the currently owner-installed app with that ID, as app
dependencies do; installing or replacing a target app is a separate owner-reviewed
installation. This capability grants frontend routing only and does not grant
backend method authorization or wallet signing authority.

### Request An Exact Group Of Session Tools

An ordinary consumer without an install declaration can establish access to
exact discovered tools before concurrent calls. The following names are
illustrative; use the target's current live descriptors:

```ts
import { callTool } from "neutron-tools/app";

await callTool({
  target: "kernel",
  name: "permissions.request",
  arguments: {
    target: providerEndpoint,
    tools: ["read_items", "read_status"],
  },
});
```

The request accepts exactly one of `tool: string` or `tools: string[]`, plus
the target endpoint. The existing single-tool form, optional `arguments`
review, and legacy `tool: "*"` form retain their behavior. The grouped form
requires a nonempty list of exact tool names, deduplicates repeats, and never
creates a wildcard grant. Kernel discovers the target's current descriptors
and rejects an unknown or caller-inaccessible tool before presenting consent.

The dialog lists each requested tool that lacks a matching grant, using the
target's live title and description. These descriptions are app-supplied and
unverified; they do not establish that a tool is safe or read-only. The dialog
offers **Allow session** and **Reject**, explains that access can be reused
only by that exact source surface, and shows the exact endpoint and names in
technical details. It does not offer or describe an **Allow once** decision
for a session-only request.

Approval returns `{ granted: true }` and creates the same individual session
grants used by ordinary tool calls. Those grants bind the requesting app and
endpoint, its live session, and the target endpoint and its live session.
Reopening or reconnecting either surface requires access to be established
again; no grant is saved to managed memory. Repeating the request while every
grant is still valid returns without another owner dialog. Cancellation,
rejection, or endpoint replacement while consent is pending creates no new grants.

A session grant may authorize state-changing tools; do not infer safety from
`neutron:effects`, tool names, or descriptions. Kernel has no global read bypass.
`provider_once` tools still require their own fresh provider decision. Within
Agent Mode, an undeclared grouped permission request follows the invocation
decision policy and creates no standing session grants.

## Agent Mode Calls

Agent Mode changes who answers a frontend permission decision, not backend
method authorization. The owner first enables one exact installed agent app
version and resident entrypoint. A turn starts through a live tile in that app
installation and the exact granted entrypoint; after the grant, starting it
requires no browser-focus check, transient user activation, or repeated owner
decision.

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

Public `provider_once` tools support both direct and nested Agent callers. The
provider receives a private `context.requestApproval(review)` callback scoped to
its exact active invocation and immediate caller. The Kernel sends the full
bounded provider review to the root judge as a fresh, high-risk frontend-tool
decision with no persistence. The provider executes only after that decision
succeeds. No generic routing prompt precedes this provider review, and neither an
install-declared tool nor a session grant can substitute for the review. Dropped,
sibling, expired, and cancelled invocation contexts cannot consume the callback.

`presentUserInterface` remains the ordinary human presentation path and is not
exposed during an Agent invocation. Providers can retain separate `same_app` +
`agent_root` tools for direct-root integrations. Kernel admits those tools only
for the active depth-zero root and rejects a descendant before target dispatch.
All these handlers use the Kernel-derived caller and invocation-scoped
`context.kernel` for their preapproved self calls.

Nested handlers must issue invocation-dependent work through the
`context.kernel` client supplied to their `exposeTool()` handler. It preserves
private invocation provenance and cancellation. Top-level helpers and clients
do not implicitly inherit the invocation of the handler that calls them.
Ordinary requests can continue using existing install-declared routes while
Agent work is active. A call that needs a fresh protected decision from an app
participating in the active turn without that scope fails with
`SCOPED_CONTEXT_REQUIRED` rather than opening a surprise owner dialog.

For backend access, a nested handler can make an action-only reservation request
through its invocation-scoped Kernel client. The top-level
`requestBackendCallReservations()` helper, including its attachment-aware
post-grant call form, does not inherit invocation provenance. An agent allow for
a reservation mutation is different from an ephemeral frontend-tool allow: it
deliberately applies the requested persistent reservation, still bounded by the
installed manifest declaration.

An Agent decision cannot replace owner consent for Neutron administration,
installation or uninstall, owner/controller changes, one-time cycle spending,
or external provider login. Generic calls cannot target the management canister.
Some owner-controlled flows have app-facing preparation routes: an Agent may
offer or prepare installation for the owner's final review, or request the
owner's one-time cycle-call decision. Other routes reject with `OWNER_REQUIRED`
or `USER_INTERACTION_REQUIRED`. Handle each tool's actual contract rather than
assuming every owner-only effect rejects before presenting UI.

Workspace inspection and control, including switching, have the separate
declared-resident/direct-root admission in the route table. They grant visual
workspace control without granting authority to execute the target app's effects.

Preapproved self calls and existing backend reservations retain their normal
meaning. Matching live frontend session grants are checked before a new
permission decision only for ordinary tools; `provider_once` explicitly omits
that shortcut. An `agent_root` audience is a direct-root routing attestation,
not a reusable grant. Agent decisions do not broaden any declaration or bypass
the generated Motoko owner check.

Agent Mode does not currently create an unattended background principal. The
owner first enables one exact agent app version and entrypoint, and each root
turn begins through a live tile in that Agent installation and the exact granted
entrypoint without a per-turn browser-focus or transient-activation gate. Within
that live turn, a trusted Wallet can fund an active direct root without another
owner prompt. A delegated child cannot call the root-only tool.
Standing autonomous roots, per-agent budgets, and background spending after
the invocation ends are separate future authority designs.

## Security Rules

1. Do not use public ingress merely to remove an owner approval dialog; it is a
   deliberate externally callable protocol surface.
2. Treat every `caller: "any"` public-ingress query result as intentionally
   available to anonymous Internet callers.
3. List only exact, owner-authorized methods whose no-dialog behavior is
   appropriate for every live endpoint of that app.
4. Use `provider_once` only when the owner deliberately trusts the target app
   to own preparation, review, decision, and execution. Human flows invoke
   `presentUserInterface` before preparation; Agent flows submit the prepared
   operation through `requestApproval` before execution. Never let an installed
   tool declaration or session grant substitute for the scoped callback.
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

## Source Map

Use these implementation entrypoints to verify behavior without relying on
release numbers, copied inventories, or line references:

| Contract | Authoritative implementation |
| --- | --- |
| Capability declarations and normalization | `packages/neutron-tools/src/capabilities/` |
| Generated method authorization and public ingress | `packages/neutron-compiler/src/assemble.ts`, `packages/neutron-compiler/src/install.ts` |
| Routing, self calls, reservations, grants, provider callbacks, workspace admission | `apps/kernel/src/expose.ts` |
| External discovery identities and actor construction | `apps/kernel/src/reducer/auth.ts` |
| Frame policy and message-port lifecycle | `apps/kernel/src/app_frame_security.ts`, `apps/kernel/src/frame_context.ts` |
| App helpers, scoped clients, and callback consumption | `packages/neutron-tools/src/app.ts` |
| Wire types and resource-safety bounds | `packages/neutron-tools/src/protocol.ts` |

## Related Documentation

- [App Developer Guide](./app-developer-guide.md)
- [App-Isolated vetKeys](./app-isolated-vetkeys.md)
- [App Tray](./app-tray.md)
- [Kernel-App Message Bus](./kernel-app-communication.md)
- [Security Model](./security-model.md)
- [Compiler And Actor Assembly](./compiler-and-actor-assembly.md)
