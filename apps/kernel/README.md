The Neutron Kernel is the operating-system package. Its `dist/web` mounts at
the canister root, so opening a Neutron opens the trusted Kernel frontend.

The Kernel hosts declared app browser surfaces in isolated iframes. Headless
apps have no iframe.

It handles app installation.

It assembles all Motoko files and compiles them.

It opens dialogs in which users can allow or deny certain things like an app frontend requesting a call to be signed and allowed.

It stores package and web assets in the canister. Committed package metadata,
the app registry, generated Candid, content-addressed Motoko sources, install
provenance, and ordinary web files use IC HTTP response certification v2. Motoko
modules whose identity-encoded body matches `/mo/<sha256>.mo` receive a one-year
immutable public cache policy. Exact esbuild-hashed JavaScript and CSS outputs
under `/chunks/` receive the same policy; mutable metadata is revalidated with
`no-cache`. The browser and CLI use normal
HTTP fetches for asset bodies, while the authorization-protected
`kernel_static_query` remains a bounded key-list operation used for compiler
module discovery and trusted frontend app-scoped artifact inventory. Every
other `/system/**` path remains HTTP-internal; this includes in-flight install
data under `/system/staging/`.
Package/compiler proofs work across gateway authorities; executable web assets
and app routes remain bound to their exact `Host`.

The browser frontend also provides direct-Agent-only, read-only inspection of
catalogued installed artifacts without adding a backend API or state schema.
See [Kernel-App Communication](../../doc/kernel-app-communication.md#exact-installed-artifact-inspection)
and [Kernel Frontend Runtime](../../doc/kernel-frontend-runtime.md#exact-installed-artifact-inspection).

The frontend message bus also supports the generic
`{"neutron:consent":"provider_once"}` tool annotation. On the current provider-UI
lane, it lets an exact target app ask once for its own foreground UI during the
live public handler call. Kernel derives the provider and original caller from
the one-use capability, opens or reuses and focuses the provider's exact tile,
and routes the opaque request only to a private tool annotated with
`"neutron:visibility":"same_app"` and
`"neutron:audience":"foreground_tile"`. Kernel attests that audience and the
caller but neither renders a decision dialog nor interprets provider-specific
fields. The provider tile may use exact preapproved methods to prepare review
state or persist rejection, owns the single user decision, and may dispatch a
value-moving execute method only after acceptance. Ordinary session grants
cannot bypass this path.

A separate private tool annotated with
`"neutron:visibility":"same_app"` and
`"neutron:audience":"agent_root"` may be routed without UI only to the incoming
live depth-zero Agent root. Human and nested-agent calls are rejected before
target dispatch. The deprecated provider `requestApproval` callback and its
raw Kernel JSON dialog remain as a generic compatibility surface for released
providers, while current provider code uses `context.presentUserInterface`. See
[App Method Access And Call Consent](../../doc/app-method-access-and-call-consent.md#provider-mediated-one-shot-tools).

Kernel-authorized principals are never request-rate-limited or counted. Fixed-
hour request windows protect only callers outside that set on declared public-
ingress updates and anonymous HTTP gateway POST handlers; route caller-policy
checks still apply. Backend capabilities have no temporal request-rate budgets
and instead keep their byte/storage quotas, CAS, concurrency, per-invocation,
per-call cost, replay/capacity, and low-cycle safety boundaries. Raw
`backend_calls` additionally declares financial cycle ceilings per call and per
UTC day; this does not limit the number of zero-cycle calls.

## App tray

The kernel shows one top-right tray button for every installed app that declares
a singular `tray`. A tray requires the app to also declare a resident
`background`; the manifest supplies the title, HTML entrypoint, and static icon,
while the kernel owns the toolbar button, badge, accessible label, ordering,
popover chrome, placement, focus restoration, close control, and light-dismiss.
Declaring a tray does not add an install permission.

Only the exact current-version background endpoint may update its own badge with
`setTrayState({ badge })`. A badge is `null` or a safe integer from `0` through
`9999`; `null` and `0` clear it. Counts above 99 are shown visually as
`99+`, but assistive technology receives the exact count. Badge state lives in
the kernel session. It is cleared during install/update or uninstall processing,
when the app version, background path/storage, or tray title/path/icon changes,
on identity activation or logout, and on shell reload. The resident should
republish its initial badge whenever it starts.

Opening the button creates a new transient endpoint and a credentialless iframe
with `sandbox="allow-scripts"`; closing it destroys both. The popout should fetch
fresh state from its background on mount, may call that same-app background
without a consent prompt, and may close only its own live instance with
`dismissTray()`. Cross-app calls retain normal consent. A tray is not a tile or
resident process: it cannot use tile-only clipboard or browser-wallet actions,
enable or initiate Agent Mode, receive delegated calls, access resident
credentials/connections, or add/remove backend reservations. It may read its
app's declared backend-reservation status. Generic endpoint summaries may show
the live tray, but delegated invocations cannot inspect its tool schemas or call
it; delegated app-tool discovery filters trays entirely. Agent-capable work
belongs in tools on the resident background (or a normal tile), which the tray
may also call.

See the full [app tray contract](../../doc/app-tray.md), including the manifest,
responsive popover requirements, communication examples, and security model.

## App-isolated vetKeys

The kernel provides a generic vetKD capability for installed apps that declare
`capabilities.vetkeys`. Each reserved slot is namespaced by the Neutron
canister, installed app, slot id, a fresh random install-instance nonce, and
generation. The unified kernel memory V3 stores lifecycle/public/accounting metadata, not a
raw derived key. An optional compiler-injected app backend handle can read only
its own slot summaries and public encryption material.

Private recovery is source-bound browser work: a live tile or resident starts
a 60-second challenge with an ephemeral transport public key, then that exact
originating endpoint confirms its own challenge without a focus requirement,
user gesture, or second app-owned consent. The encrypted result returns only to
the original live endpoint and exact requesting principal. Recovery remains a
private, non-discoverable kernel action and may run while the app handles a
delegated Agent tool call; the kernel's cross-app tool permission is the user
consent boundary. Every principal currently authorized for this Neutron may
recover the same retained app key generations. The reserving principal remains
the lifecycle key manager; Settings exposes manager-bound enable, disable,
rotate, previous-generation retirement, transfer, permanent slot retirement, and a bounded
coarse audit. Tray surfaces and the Neutron canister itself cannot complete
private recovery.

Production provisioning compiles with `key_1`; the PocketIC provision target selects
`test_key_1`, with no fallback. Current limits also bound slots, generations,
pending requests, concurrency, attached cycles, audit, and
tombstones. Disable/retirement cannot erase keys, backups, or snapshots already
held elsewhere, and an active controller, compromised browser, malicious app
version, or failure of threshold-cryptography assumptions remains outside the
capability's isolation guarantee. See
[App-Isolated vetKeys](../../doc/app-isolated-vetkeys.md) for the manifest, SDK,
lifecycle, restore, environment, and threat contracts.

Kernel Settings keeps per-app operational information in the **Installed
Apps** table rather than separate usage and update sections. Each row shows the
app name and one-line description, cycles used, cycles in, update state or
action from the latest Settings refresh, installed semantic version, details
control, and app-selection control. Selecting rows replaces the bulk update
control with **Delete selected** and **Update selected**; deletion and selected
updates each compile, review, and commit the complete selected set atomically.
The launcher never exposes app deletion. Opening Settings checks update sources
automatically; its global refresh action refreshes them again. With no rows
selected, **Upgrade all** remains available for the complete verified update
set. The cycles-used cell is a
low-side 13-node pricing estimate: installation-lifetime instructions cost one
cycle each, each measured update execution adds the 5,000,000-cycle execution
base, authorized and direct-authenticated-ingress updates add the
1,200,000-cycle ingress-reception base, each actually dispatched brokered call
and measured timer/handler self-call adds the 260,000-cycle request/response
base, and the same base is counted for zero-attachment `raw_rand` and uncached
management public-key calls. Net
explicit outgoing transfers are added after refunds. Outgoing reservation
books only gross explicit attachments and the intended call count; a dispatch
commit adds the fixed base, a known pre-dispatch cancellation unwinds the
reservation without a base, and post-dispatch finalization records the retained
explicit amount. Instruction and execution totals use saturating `Nat64`;
outgoing gross/refund and accepted incoming-cycle totals use exact unbounded
`Nat` arithmetic. Paid canister public updates do not add the ingress fee
because the sender pays it; direct authenticated ingress does. The result is
formatted to four decimal places in trillion cycles (`TC`). Variable ingress
and inter-canister byte fees, response-callback bases, storage, and compute
allocation remain unattributed. At the current IC rate table for a 13-node
subnet, one Wasm instruction really costs one cycle; this is IC platform
pricing, not a Neutron product convention, and remains subnet- and
rate-table-dependent. Each CDK scheduled-task self-call contributes both the
260,000-cycle request/response base and the callback's 5,000,000-cycle measured
update-execution base. The shared Motoko global-timer dispatch remains omitted.
These omissions, unwrapped work, and trapped final samples keep Neutron's
attribution low-side and non-billing-grade. Queries are excluded and nested
canister work is independently metered where wrapped. The cycles-in cell shows
the installation-lifetime cycles accepted through the app's paid public
ingress routes. It is attributed revenue, not a generic canister-balance top-up,
and does not reduce the cycles-used estimate. In normal mode, expanding a row
shows a compact,
kernel-written view of material external access, autonomous/background
behavior, live capability switches, approved backend targets with revoke
actions, install-source status, and dependency blockers. Namespaced compiler
plumbing, hashes, raw counters, methods, paths, schemas, and quotas stay out of
that view. Developer mode retains the exact capability plan, raw 30-day and
installation usage totals, integrity records, memory roots, and backend method
inventory. Methods available through preapproved same-app calls are marked
`preapproved` only in that developer Backend functions inventory.

The authorized shell also pins one trusted Kernel item after the scrollable app
tray items. Its kernel-owned panel shows cycle balance and the current heap as
`Memory`, with a capacity scale against the canister's configured Wasm-memory
limit, and contains the shell's Settings and Logout actions. Stable-memory
diagnostics are not repeated in the tray. The active principal is marked
`(current)` in Settings' authorized-principals list instead of being repeated
in the tray panel or Settings overview. The Kernel item is not an app tray
endpoint and cannot be declared, styled, badged, or controlled by an installed
app. The standalone Settings gear and account hamburger are not rendered in the
authorized workspace; the hamburger remains only on the
authenticated-but-unauthorized screen so that principal and Logout stay
available there.

## Local install

Install dependencies once, then use the repository provisioner from the
repository root:

```sh
npm install
npm run local:start
npm run local:deploy
npm run local:status
```

`local:start` serves or attaches to the supervised PocketIC runtime described
by the current format-3 `local.ndeploy.json`. Its `minimal` profile starts the
platform, local Internet Identity, update source, and installation
infrastructure; it does not start optional chain, ledger, index, minter, or
funding fixtures. Use a separate format-3 config with
`full_protocol_fixtures` when those app-neutral fixtures are needed.

`local:deploy` destructively reinstalls the configured fleet. PocketIC inline
archive records contain only paths; the provisioner derives package identity,
hashes, and sizes when reinstall starts. It compiles the complete actor once,
initializes and seeds each fresh Kernel, authorizes configured principals,
verifies the results, and records the labeled browser URLs. The provisioner
does not build app workspaces or run app-specific initialization.

There is no separate `icp` network, canister-ID lookup, asset deploy, or
ledger-setup command. Grant an additional browser principal to the live fleet
with `npm run local:authorize -- PRINCIPAL`. Add it to
`target.authorized_principals` in the config when the next reinstall must
restore it.
