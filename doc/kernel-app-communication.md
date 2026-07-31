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
closing a frame, logging out, removing the app, or ending an invocation also
invalidates the affected endpoint. A stale Window or port does not inherit the
new live authority.

## Handshake

The only Window messages are exact closed envelopes:

- `neutron:msgbus:probe`;
- `neutron:msgbus:ready`; and
- `neutron:msgbus:connect`, which transfers `MessageChannel.port2`.

The Kernel checks the registered child Window and exact expected origin before
transferring a port. The app checks its parent Window and derives the exact
Kernel parent origin from its own URL before accepting a connection.

Both sides install listeners on the private port. If no port is connected,
operational calls wait briefly and then fail. State changes are not sent over a
Window path.

## Package Entrypoints

`neutron-tools` has three side-effect boundaries:

| Import | Role |
| --- | --- |
| `neutron-tools/protocol` | Pure envelopes, types, schemas, limits, and errors |
| `neutron-tools/app` | App client, app listener, self-call API, and exposed-tool API |
| `neutron-tools/kernel` | Small trusted host-side port helpers |

The Kernel imports only protocol and Kernel entries. It does not load the
app-side listener as a side effect. `app_entry.ts` is the app bootstrap entry.
Schemas are shared through the pure protocol rather than copied.

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

Progress uses `{ type: "progress", id, value }`.

Ordinary payloads are bounded JSON:

- maximum payload: 1 MiB;
- maximum schema: 32 KiB;
- maximum progress event: 64 KiB;
- at most 2,000 progress events;
- default call timeout: 300 seconds; and
- default discovery timeout: 10 seconds.

Requests have one final result. Progress is informational and cannot replace or
reorder the final response.

## Tool Descriptors

Apps expose tools with:

- a canonical name;
- description;
- closed input and output JSON Schemas;
- optional annotations; and
- a handler.

`tools.list` discovers descriptors from registered endpoints. `tools.call`
validates arguments before dispatch and validates the returned value before
reply. The caller can select an exact endpoint or let routing choose an active
declared provider.

An app learns app/tool behavior from live descriptors and `apps.describe`; the
Kernel and Agent do not carry hardcoded ordinary-app tool schemas.

Current Kernel tools include:

- `canister.schema`;
- `canister.call_dialog`;
- `backend_calls.request`;
- `backend_calls.list`;
- `apps.list`;
- `apps.describe`;
- `apps.install_offer`;
- `endpoints.list`;
- `attachments.delegate`;
- `permissions.request`;
- `audit.list`; and
- `workspace.open_tile`.

The raw action aliases `schema` and `call_dialog` do not exist.

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
2. validates the live Candid type graph;
3. binds sidecars and creates a schema-safe validation shadow;
4. encodes exact raw Candid;
5. independently scans that raw Candid for binary, allocation, element, and
   depth limits; and
6. rechecks the endpoint and invocation before the signed query/update.

The reply is raw-preflighted before decode, projected into the same native
binary model, and transferred back through response sidecars.

Limits are:

| Self-call resource | Limit |
| --- | ---: |
| Aggregate binary bytes | 1,900,000 |
| Binary leaves | 512 |
| JSON metadata | 64 KiB |
| Value/Candid depth | 32 |
| Container elements | 4,096 |

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
- whether the attachment is required.

Every data buffer is transferred. The Kernel validates descriptor, metadata,
source endpoint, name, type, size, and in-flight capacity. Current ceilings are
16 MiB per attachment, 32 MiB in flight per endpoint, and 64 MiB across one
trusted frontend broker realm/process. That browser limit is not an
actor-global total across separate browsers.

An invocation-scoped nested attachment call uses a short-lived one-use
delegation token. Tokens expire after 10 seconds and are bounded to four per
endpoint and 64 globally.

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
bounded recent revisions and sends them only to a current port.

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

An agent invocation carries:

- a root ID;
- exact capability/entrypoint path;
- source endpoint and session;
- optional consent registration;
- cancellation state; and
- bounded progress.

The Kernel resolves the invocation before every protected nested action.
Delegation never changes the target app's manifest or bypasses its broker. The
current stable error vocabulary includes `AGENT_MODE_REVOKED` and
`AGENT_MODE_LIMIT`.

Interactive self-call dialogs cannot be executed silently by an agent.

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

Unrecognized envelopes and stale replies are ignored or rejected without
changing callback ownership.

## Background Lifecycle

Resident backgrounds are mounted only for the declared endpoint and admitted
security mode. Startup, restart, failure backoff, authority rotation, app
replacement, capability disablement, and uninstall are Kernel-owned lifecycle
events.

The background does not become a backend cron process. It runs while the
trusted browser shell is open and uses declared broker APIs for durable work.

## Security Invariants

- Window messaging is handshake-only.
- Operational calls require the exact private port.
- A port belongs to one endpoint session and cannot be reassigned.
- AppScope and plan fingerprint remain authoritative across every route.
- Live Candid, not a sidecar marker or JSON Schema, determines binary type.
- Payloads, progress, attachments, callbacks, and in-flight work are bounded.
- Authority is rechecked after `await`.
- Tool discovery describes live apps; Core code does not encode ordinary app
  behavior.
- Closing or replacing an endpoint cancels its pending authority.
