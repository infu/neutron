# Kernel-App Message Bus

The message bus connects the trusted Kernel shell to isolated app tiles, trays,
and resident backgrounds. Operational traffic uses a private, source-bound
`MessagePort`.

```text
registered iframe Window
    -- ready/probe/connect handshake -->
private MessagePort
    -- requests, replies, progress, state, tools, binary sidecars -->
Kernel or another registered endpoint
```

`window.postMessage` is not an operational fallback.

## Endpoint Model

The registered endpoint itself binds:

- app ID and installation UID;
- app version;
- endpoint role: `tile`, `tray`, or `background`;
- iframe `Window`;
- private port and endpoint session;
- deployment and app runtime generation;
- browser origin, nonce, and authority epoch where applicable; and
- the resident-frame security mode.

The frame lifecycle separately keys the exact declared `src`, and live brokers
enforce the current capability plan and endpoint declaration. Together these
bindings form the runtime authority; the endpoint record does not claim to
store a plan fingerprint or asset path.

An app may have zero or more tiles, at most one tray, and at most one resident
background. A tray requires that background. Headless apps need no frontend
endpoint. The whole Neutron admits at most 32 resident backgrounds.

Updating an app advances its runtime generation and invalidates the old
endpoint even though its `AppScope` is retained. Rotating origin authority,
closing a frame, logging out, or removing the app also invalidates the affected
endpoint. Ending an agent invocation instead revokes that invocation's
authority and cancels its invocation-scoped work; it does not disconnect the
otherwise-current endpoint. A stale Window or port does not inherit new live
authority.

## Handshake

The registered app-runtime Window handshake uses:

- exact closed `neutron:msgbus:probe` and `neutron:msgbus:ready` envelopes; and
- `neutron:msgbus:connect`, which transfers `MessageChannel.port2`.

The Kernel emits `connect` with only its type, version, and session ID. Released
app receivers validate those required fields but accept additional envelope
fields for compatibility, so extensions must not be treated as authority.

Before a dedicated resident background starts, its isolated origin-cleanup
document may send one separate exact `neutron:persistent-origin-policy:v1`
result containing only `type` and `ok`. The Kernel binds that result to the
expected cleanup Window and origin. It carries no app request, authority, or
private port. Apart from this lifecycle result and the handshake, app-runtime
Window messages are not operational transport.

The Kernel checks the registered child Window and exact expected origin before
transferring a port. The app checks its parent Window and derives the exact
Kernel parent origin from its own URL before accepting a connection.

Both sides install listeners on the private port. If no port is connected,
operational calls wait briefly and then fail. State changes are not sent over a
Window path.

## Package Entrypoints

`neutron-tools` exposes four message-bus-facing package boundaries:

| Import                           | Role                                                             |
| -------------------------------- | ---------------------------------------------------------------- |
| `neutron-tools/protocol`         | Pure envelopes, types, schemas, limits, and errors               |
| `neutron-tools/app`              | App client, app listener, self-call API, and exposed-tool API    |
| `neutron-tools/app_attachments`  | Attachment listener, client, and attachment-exposed-tool API     |
| `neutron-tools/kernel`           | Small trusted host-side port helpers                             |

The Kernel imports only protocol and Kernel entries. It does not load the
app-side listener as a side effect. `neutron-tools/app` is the app bootstrap
entry. Schemas are shared through the pure protocol rather than copied.

The attachment entry is intentionally separate and is not re-exported by the
app entry. Apps that use attachments must import it explicitly; doing so
installs its attachment listener on the same transferred private port. Its
`callToolWithAttachments()` API requires an exact target and has its own bounded
connection wait, call timer, `AbortSignal` settlement, and connection-
replacement cleanup. A caller timeout or abort stops that local wait but does
not send the ordinary JSON cancellation envelope or retract work already in
progress.

## Ordinary JSON Wire

Ordinary calls use:

```ts
type ExecEnvelope = {
  type: "exec";
  id: number;
  payload: {
    action: string;
    payload: JsonValue;
    context?: MsgBusTransportContext;
  };
};
```

Replies are:

```ts
type ResponseEnvelope = {
  type: "response";
  id: number;
  ok?: JsonValue;
  error?: JsonValue;
};
```

A valid response owns exactly one of `ok` or `error`. The optional properties
in the TypeScript shape express those two alternatives compactly; a response
with neither or both is invalid.

Progress uses `{ type: "progress", id, value }`.

A caller cancels one exact in-flight request on the same private port with:

```ts
type RequestCancelEnvelope = {
  type: "neutron:msgbus:cancel";
  version: 1;
  id: number;
};
```

The ordinary JSON wire and the API-1 self-call wire share this source-bound
cancellation envelope. The SDK sends it when a request's `AbortSignal` fires or
its caller-selected timeout expires. Replacing or disconnecting the SDK port
sends it for outstanding requests before closing the port. The receiver binds
cancellation to that exact port and id; Kernel-side endpoint retirement aborts
the same request signals.

Cancellation is cooperative, not a promise that every underlying operation can
be retracted. App tool handlers may honor their request signal. Among Kernel
source tools, cancellation propagates through catalog construction, search,
and asset reads; they perform no mutation. Among Kernel canister tools,
`canister.schema_v2` and `canister.call_dialog_v2` propagate it through strict
ICBlast discovery and native fetches. Cancellation before their network
dispatch prevents the call. Cancellation cannot retract a v2 update after
dispatch: the Kernel withholds any late reply and reports that the outcome is
unknown. The SDK retains `canister.call_dialog_v2` for one bounded cancellation-
reply window so the Kernel's pre- or post-dispatch classification wins; if no
reply arrives, it conservatively reports an unknown outcome. The same fence
applies to API-1 self updates, including scoped `updateSelf()` calls made by an
exposed app tool. Self queries can settle immediately after sending their
cancellation because they cannot mutate canister state.

The generic tool-attachment wire retains its own settlement and resource
lifecycle; this envelope does not cancel an attachment request.

The ordinary path uses these wire bounds and SDK defaults:

- maximum request or response payload: 1 MiB;
- maximum input or output schema: 32 KiB;
- maximum progress event: 64 KiB;
- at most 2,000 progress events;
- default call timeout: 300 seconds; and
- default discovery timeout: 10 seconds.

Sender-side hardening additionally enforces at most 64 nested JSON containers,
100,000 aggregate container elements, and 128 characters from the closed action
alphabet. Those are not receive-time limits for the released v1 wire.
Compatibility receivers continue to accept deeper or larger-container v1 JSON
and any nonempty legacy action string when the value remains JSON-compatible
and within its byte ceiling. Dispatch may still reject an action it does not
implement.

The typed external-canister schema and call helpers use those discovery and
call defaults respectively. Generic `callTool()` timeouts are caller-chosen,
including zero for no timer; the defaults are not protocol ceilings. API-1
self-call helpers instead enforce the fixed SDK call-timeout cap. No timeout
makes an already-dispatched update reversible.

Requests have one final result. Progress is informational and cannot replace or
reorder the final response.

## Tool Descriptors

Apps expose tools with:

- a canonical name;
- a required input JSON Schema;
- optional title and description;
- an optional output JSON Schema;
- optional annotations; and
- a handler.

Object schemas are not closed automatically. A descriptor author that needs to
reject undeclared object fields must use `additionalProperties: false` at every
applicable object level.

`tools.list` discovers descriptors from registered endpoints. `tools.call`
validates arguments before dispatch and, when an output schema is present,
validates the returned value before reply. Every call must name an exact target;
there is no implicit provider selection. `tools.list` may omit its target to
discover across live endpoints, but that does not choose a target for a later
call.

An app learns app/tool behavior from live descriptors and `apps.describe`; the
Kernel and Agent do not carry hardcoded ordinary-app tool schemas.

### Provider-Mediated One-Shot Consent

The closed descriptor annotation
`{"neutron:consent":"provider_once"}` selects a target-mediated one-shot
interaction. It is for a provider which must own the specialized UI and inspect
authoritative state before the owner can make an informed decision. The
annotation does not describe tokens, payments, wallets, or any other app
domain.

On the current provider-UI lane, the Kernel validates the original JSON
arguments against the target descriptor, bypasses the ordinary preliminary
frontend-tool grant, and calls the exact provider endpoint with a private
one-use `presentUserInterface` callback in that handler's context. The callback
is bound to the captured caller object and session, caller AppScope/version,
target object and session, target AppScope/version, exact public tool, request
cancellation signal, and originating live handler call. It never appears in
discovery, public tool arguments, progress, or the response.

The provider invokes the callback before domain-specific preparation:

```ts
return context.presentUserInterface({
  tileId: "wallet",
  tool: "wallet_funding_present_v1",
  arguments: request,
});
```

The SDK accepts a closed `{ tileId, tool, arguments }` object. Its exact private
wire envelope `{ capability, tileId, tool, arguments }` is bounded to 16 KiB in
addition to the ordinary depth and container-element limits. The Kernel opens
or reuses and focuses that exact declared tile of the provider in the active
workspace, waits for its exact registered endpoint, and routes the opaque
`arguments` only to a private tool declaring both
`{"neutron:visibility":"same_app"}` and
`{"neutron:audience":"foreground_tile"}`. The Kernel injects the original
caller context and the attested `foreground_tile` audience; neither value can
be supplied by an app argument. The SDK rejects a missing or mismatched
audience before entering the private handler.

Outside Agent Mode, the original request is admitted only from the focused
source tile with transient user activation. The provider tile, not Kernel, may
use exact preapproved methods to load and freeze non-value-moving review state,
renders its own review UI, and owns the accept/reject decision with concrete
action/cancel labels. Only the affirmative action may dispatch the value-moving
execute method; cancel may persist rejection. Kernel neither renders a dialog
nor interprets the payload. No exact or wildcard session grant is consulted,
and the interaction creates no grant.

The pending capability and presentation binding are ephemeral browser state.
This route adds no Kernel managed-memory schema and no durable permission
record; existing audit projection remains the only persistent generic record.

The public handler must complete exactly one provider interaction; returning
without it is invalid. The SDK gives `requestApproval` and
`presentUserInterface` one shared use, so a handler cannot stack the old and new
paths. A second use, replay, wrong tool or endpoint, source/target replacement,
timeout, abort, or cancellation fails closed. Endpoint and authority bindings
are rechecked after every asynchronous step.

The target provider, not Kernel, is trusted to keep preparation, display,
decision, and execution correctly ordered. Kernel authenticates routing but
cannot prove app-specific ordering without understanding the provider. Current
provider code must feature-detect `context.presentUserInterface` before
preparation or execution. When the SDK withholds it because Kernel supplied no
explicit provider-UI support marker, the provider fails closed rather than
falling back to an ordinary session grant.

`context.requestApproval(review)` is a deprecated generic compatibility
surface. Published providers including Wallet 0.3.6 depend on its
Kernel-rendered inert raw-JSON review, but the runtime does not app- or
version-gate the member. Current providers must use provider-owned UI.

Agent automation uses a separate provider tool declaring both
`{"neutron:visibility":"same_app"}` and
`{"neutron:audience":"agent_root"}`. Kernel hides and rejects that tool for
ordinary app calls and delegated Agent descendants; only the active depth-zero
root invocation is admitted, and it receives an attested `agent_root` audience.
The provider checks that audience, prepares and executes through its own
preapproved authority, and opens no provider or Kernel UI. An Agent invocation
which attempts `presentUserInterface` fails closed instead of opening a tile.

The initial protocol rejects `provider_once` on attachment and control tools.
Same-app calls and every tool without this exact annotation retain their
released routing and grant behavior. Unknown annotation values never select
this path.

Current Kernel tools include:

- `canister.schema`;
- `canister.schema_v2`;
- `canister.call_dialog`;
- `canister.call_dialog_v2`, whose versioned contract is documented in
  [App Method Access And Call Consent](./app-method-access-and-call-consent.md#calling-any-other-app-method);
- `backend_calls.request`;
- `backend_calls.list`;
- `apps.list`;
- `apps.describe`;
- `source.files`;
- `source.search`;
- `source.read`;
- `apps.install_offer`;
- `endpoints.list`;
- `attachments.delegate`;
- `permissions.request`;
- `audit.list`; and
- `workspace.open_tile`.

The raw action aliases `schema` and `call_dialog` do not exist.

The unversioned canister names are universally callable compatibility routes,
not names gated by the age of an installed package. Their exact differences
from the v2 external-call route are documented in
[App Method Access And Call Consent](./app-method-access-and-call-consent.md#calling-any-other-app-method).

### Exact Installed Artifact Inspection

The three `source.*` tools describe a read-only, app-scoped view of catalogued
artifacts in the current committed installation. Their descriptors are
discoverable like other Kernel tools, but calls are accepted only from the
active direct Agent root. An ordinary app call or a delegated child invocation
cannot use them. The trusted Kernel frontend implements the operations over
existing backend primitives and build-generated static package metadata. They
add no app capability, backend method, managed-memory schema, or owner approval
path. Their descriptors declare read and network effects, and Kernel audit
records only bounded metadata rather than raw arguments or returned source. A
direct root may select any currently installed app by exact app ID, one app per
call. All three are marked long-running because any one of them may construct
the bounded catalog on a cold browser cache.

Start with `source.files` using `sourceRevision: null` and `cursor: null`. Keep
the returned `sourceRevision` for later list pages and every `source.search` or
`source.read` call. A non-null continuation cursor must be passed back unchanged
with otherwise-identical arguments. Only `complete: true` together with
`nextCursor: null` proves that a list traversal or text read ended. For search,
that pair proves only that selected-path traversal ended: a positive
`skippedLargeFiles` or `skippedUnavailableFiles` count means an absent match is
not exhaustive. If a deployment commits during the operation or the target
installation changes, the call is cancelled and inspection must restart at
`source.files`.

`source.search` performs bounded literal text search, not regular-expression
evaluation. It returns at most 8 matches per scanned file and reports files
with further omitted matches in `truncatedFiles`; use `source.read` for deeper
inspection. Search counters apply only to their returned page, and
`skippedBinaryFiles` is already included in `scannedFiles`. `source.read`
accepts only an exact path from the bound catalog and returns bounded
strict-UTF-8 chunks. Invalid UTF-8, NUL-containing data, Wasm, and other binary
artifacts return metadata only; their bytes are never placed on the tool wire.
Results and previews are untrusted installed content, not instructions.

The catalog is installed build output, not repository source: frontend bundles
may be minified and retained Motoko modules are transformed and content
addressed. Generated actor glue, unretained files, and compiler binary contents
cannot be recovered. Exact catalog construction and retention rules are in
[Kernel Frontend Runtime](./kernel-frontend-runtime.md#exact-installed-artifact-inspection)
and [Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md#installed-app-assets-under-appid).

## App Client API

The app entry provides:

- `exec`;
- `listTools` and `callTool`;
- `exposeTool` and `removeExposedTool`;
- app and endpoint discovery helpers;
- app-state subscriptions;
- tile-view subscriptions;
- tray-state and private tray actions;
- scoped connection, wallet, vetKey, clipboard, and permission helpers; and
- `querySelf`, `updateSelf`, `callSelfDialog`, and attachment-aware
  `requestBackendCallReservations`.

Every helper ultimately uses the connected private port.

An `exposeTool()` handler's context additionally contains optional
`presentUserInterface({ tileId, tool, arguments })` only while Kernel is
dispatching that exact cross-app `provider_once` invocation. It is invocation
metadata, not a global app helper. Code must feature-detect it before
preparation, must not copy it out of the dynamic handler lifetime, and must
continue to use the same context's `kernel` client for subsequent scoped self
calls or nested tools. Audience-restricted handlers receive the corresponding
Kernel-attested `context.audience`; the SDK rejects missing or mismatched
attestation before invoking the handler. Deprecated `requestApproval(review)`
remains a generic compatibility member and shares the same one-use gate;
current providers must not use it.

## Self Calls With Nested Binary Values

Self calls use a private API-1 wire in parallel with the ordinary JSON
envelopes:

```ts
type SelfCallExecEnvelope = {
  type: "neutron:self-call:exec";
  version: 1;
  id: number;
  tool:
    | "canister.query_self"
    | "canister.update_self"
    | "canister.call_dialog"
    | "backend_calls.request";
  method: string;
  args: JsonValue[];
  blobs: SelfCallWireBlob[];
  // Required only for backend_calls.request.
  actions?: BackendCallReservationAction[];
};

type SelfCallWireBlob = {
  path: (string | number)[];
  byteLength: number;
  data: ArrayBuffer;
};
```

`canister.query_self` and `canister.update_self` are not generic Kernel tool
descriptors. They are private self-call wire helpers. `callSelfDialog` uses the
same binary-capable path while retaining Kernel consent.
`callCanisterDialog` automatically selects this path when its target is the
current Neutron; the generic JSON-only tool rejects that target.

`requestBackendCallReservations` uses this same API-1 envelope when it includes
a post-grant same-app call. The call arguments and result therefore support the
same nested and repeated blobs. An actions-only reservation request remains an
ordinary JSON tool call; the public tool rejects an attached `call`.

The app recursively encodes its values:

- `Uint8Array` is the canonical byte value;
- `ArrayBuffer` is accepted as an input convenience;
- each byte leaf becomes a copied transferable buffer;
- the JSON shadow contains `null` at that exact path; and
- strings and number arrays remain ordinary Candid values.

The Kernel resolves the installed method in live Candid. It must bind every
sidecar exactly once and only to a `vec nat8` leaf, and every present Candid
blob must have a sidecar. A path is a routing hint, never type or authorization
input.

Before dispatch the Kernel:

1. validates the endpoint, scope, method, and preapproval or dialog route;
2. resolves and validates the exact live Candid method and type graph;
3. binds every sidecar exactly to that graph and validates the structural
   value;
4. encodes the arguments through the exact live IDL method;
5. independently scans that raw Candid against the live types for binary,
   allocation, element, and
   depth limits; and
6. rechecks the endpoint and invocation before the signed query/update.

The private self-call path does not apply ICBlast's public JSON Schema shadow.
At a live record position, it may leave a string opaque only for the pinned
encoder's released record shorthand and only with no sidecar at or below that
path. Generated schema does not authorize the exception. Exact live-IDL
encoding and raw-Candid preflight remain mandatory, as does equality between
the encoded raw Candid's blob count and aggregate blob-byte length and the
materialized-sidecar statistics.

The reply is raw-preflighted before decode, projected into the same native
binary model, and transferred back through response sidecars.

Limits are:

| Self-call resource     |     Limit |
| ---------------------- | --------: |
| Aggregate binary bytes | 1,900,000 |
| Binary leaves          |       512 |
| JSON metadata          |    64 KiB |
| Value/Candid depth     |        32 |
| Container elements     |     4,096 |

Additional type-table, non-binary Candid, decoder allocation, in-flight byte,
and concurrency limits apply in the Kernel.

For an interactive review, the Kernel shows only the exact Candid path, byte
length, and transient SHA-256 of each bound binary field. The bytes remain
hidden.

## Generic Tool Attachments

An exposed app tool may declare one binary attachment in each direction through
the `neutron:attachments` descriptor annotation. This is a separate
private-port protocol for tool payloads, not self-call Candid encoding.

Each declaration fixes:

- attachment name;
- allowed media types;
- maximum bytes; and
- the fixed `required: true` marker.

A declared direction therefore requires exactly one attachment. Omit the input
or output declaration to allow no attachment in that direction; optional
attachments are not supported.

Every data buffer is transferred. The Kernel validates descriptor, metadata,
source endpoint, name, type, size, and in-flight capacity. Current ceilings are
16 MiB per attachment, 32 MiB in flight per endpoint, and 64 MiB across one
trusted frontend broker realm/process. That browser limit is not an
actor-global total across separate browsers.

An attachment handler's `context.callTool` carries its invocation binding
directly. An ordinary exposed-tool handler instead bridges its current
invocation into the separate attachment client by requesting a short-lived,
one-use delegation token from `attachments.delegate`; a call cannot combine
that token with direct invocation metadata. Tokens expire after 10 seconds and
are bounded to four per endpoint and 64 globally.

## App State Invalidation

The Kernel can send:

```ts
{
  type: "neutron:app:state";
  version: 1;
  topic: string;
  revision: string;
}
```

State messages are invalidation hints, not authority or durable data. An app
subscribes by topic and performs its own scoped query. The Kernel retains only
bounded recent revisions and sends them only to a current port. Publication is
same-app only and excludes the publishing endpoint, which must update or query
its own state locally.

The SDK does not queue an invalidation for a topic that has no listener when it
arrives. Once the Kernel posts a revision to a connected endpoint it records
that delivery, so adding a listener later or reconnecting the same frame does
not guarantee another copy. A retained latest revision may be replayed to an
eligible endpoint that did not receive it, but this bounded replay is not a
durable subscription log. Register listeners early, query initial authoritative
state, and refresh after reconnect rather than depending on replay.

## Tile Views

`workspace.open_tile` may include a bounded view string. The Kernel sends the
view to the exact opened/reused tile through
`{ type: "neutron:tile:view", version: 1, view }`.

Apps use this for routes such as a selected post or thread. The view does not
grant backend authority.

## Tray Boundary

Tray actions are private to the declaring app and the current tray endpoint.
The Kernel owns opening, focus, close, and state delivery. A tray cannot address
another app, become a resident background, or retain authority after its
session closes.

## Agent Invocations

An Agent root starts only from the granted installed app's focused,
owner-activated tile, targets that app's connected resident background, and
names the exact declared entrypoint. Each root or child invocation binds its
node, parent, and root IDs; unguessable capability; target endpoint and session;
installed app scope, role, and tool; expiry and cancellation state; and bounded
depth, calls, parallel children, consent challenges, and progress.

Every delegated endpoint call creates a child invocation for that exact target
and tool; tray popouts cannot receive one. The Kernel resolves the invocation
before every protected nested action. Delegation never changes the target app's
manifest or bypasses its broker. Completing or cancelling an invocation removes
its scoped authority without retiring the target endpoint. The current stable
error vocabulary includes `AGENT_MODE_REVOKED` and `AGENT_MODE_LIMIT`.

A nested `canister.call_dialog_v2` decision must receive the complete review
value, not only summary counts, and an oversized challenge fails before
signing. The unversioned compatibility route rejects Agent-scoped signed calls
before discovery. The canonical v2 contract is in
[App Method Access And Call Consent](./app-method-access-and-call-consent.md#calling-any-other-app-method).

New provider-owned UI is not an Agent decision surface. A root that needs the
provider's autonomous operation calls the separate `same_app` + `agent_root`
tool. Kernel admits it only for the active depth-zero root and attests that
audience; a descendant or ordinary caller is rejected before target dispatch.
The provider performs no UI on that route and uses only its own declared
preapproved authority. The public `provider_once` path remains the human route.

An exposed-tool handler with `agentMode: true` must use its invocation-bound
`context.kernel` client for nested Agent work. That client propagates invocation
metadata, cancellation, and exposes `callTool`, `querySelf`, and `updateSelf`;
module-level helpers do not inherit the handler context. Attachment handlers
likewise use their invocation-bound `context.callTool` for nested attachment
work.

The scoped client intentionally does not expose `callSelfDialog`. While the
caller app has any active invocation, an unscoped module-level same-Neutron
call-dialog request fails with `SCOPED_CONTEXT_REQUIRED` before Candid
preparation and opens no owner UI. A valid invocation-scoped self-dialog fails
with `USER_INTERACTION_REQUIRED`. Outside an active invocation, ordinary owner
consent remains unchanged.

Agent Mode remains a live invocation model. Enabling one exact agent version
does not start an unattended background root: each root begins from that
agent's focused, owner-activated tile. A provider's separate root-audience tool
can execute without UI only while that bounded depth-zero invocation remains
live.

## Private Broker Actions

Connections, clipboard, browser-wallet, vetKey, backend-reservation, and
background UI actions are private protocol actions rather than ambient browser
globals.

Each action validates:

- endpoint role;
- current port/session;
- exact app declaration;
- owner and focus/user activation when needed;
- argument/result limits; and
- live authority after asynchronous work.

For example, provider connections are background-only, while a browser-wallet
session begins only from a focused owner-activated tile.

## Routing Policy

Tool routing is based on live registered descriptors and exact target
selection. The Kernel never routes by trusting an app-provided Window, origin,
app name, or product-specific method.

For every request the Kernel captures an immutable endpoint binding and
rechecks it against live state. Before effect and reply it verifies that:

- the endpoint still exists;
- its port and session are unchanged;
- its AppScope and app generation are current;
- owner authorization has not changed;
- any invocation is still active; and
- the capability registry still permits the resource.

A `provider_once` request captures both the original call and its one provider
presentation under this same binding. The presentation cannot retarget the
public tool, replace the caller, select another app, manufacture an audience,
or authorize a second request. Its opaque arguments remain app-authored data
which only the provider tile interprets and renders.

Unrecognized envelopes and stale replies are ignored or rejected without
changing callback ownership.

## Background Lifecycle

Resident backgrounds are mounted only for the declared endpoint and admitted
security mode. Startup, readiness retry, authority rotation, app replacement,
capability disablement, and uninstall are Kernel-owned lifecycle events. The
launcher remounts once after a missed readiness deadline; a second missed
deadline blocks further automatic relaunch for that mounted lifecycle instead
of entering a general failure-backoff loop. A late authenticated connection can
still mark that retry ready.

The background does not become a backend cron process. It runs while the
trusted browser shell is open and uses declared broker APIs for durable work.

## Security Invariants

- Registered app-runtime Window messaging is handshake-only; the dedicated
  resident-origin cleanup result is a lifecycle-only exception.
- Operational calls require the exact private port.
- A port belongs to one endpoint session and cannot be reassigned.
- AppScope and plan fingerprint remain authoritative across every route.
- Live Candid, not a sidecar marker or JSON Schema, determines binary type.
- Payloads, progress, attachments, callbacks, and in-flight work are bounded.
- Authority is rechecked after `await`.
- Tool discovery describes live apps; Core code does not encode ordinary app
  behavior.
- Provider presentation is one-use and source/target-bound; ordinary session
  grants cannot satisfy it, and only the provider tile interprets its opaque
  data. Root-agent execution is a separate exact audience-restricted tool.
- Closing or replacing an endpoint cancels its pending authority.
