# Kernel Frontend Runtime

[Back to the documentation index](./index.md)

This page documents the current React kernel frontend: the tiling workspace
shell, launcher, app tray, authentication and authorization flow, request
dialogs, install dialogs, and UI state.

## Implementation Facts

### React Entry Point

`apps/kernel/src/index.tsx` is the single bootstrap entry. It synchronously
captures and removes repository setup and one-time activation handoffs,
registers a `hashchange` listener, then loads and validates
`/system/runtime-config.json` as certified deployment metadata before
dynamically importing `main.tsx`. The deterministic Playwright helper is
imported only for a certified PocketIC deployment on the exact loopback
canister origin. This guarantees that fragment data, activation bearer data,
and runtime authority are resolved before Internet Identity, agents, frames,
update clients, or React are evaluated. Esbuild ESM splitting preserves those
dynamic import boundaries in the browser.

The closed runtime record also carries the exact target/canister-specific
isolated-frame origin template and an explicit update-source origin. Frame URL
construction fails closed unless the result matches that certified template or
the exact Kernel origin used only by an unadopted historical package's legacy
opaque frame URL. Local
update checks use the certified provision-owned update-source origin when its
principal is selected. An IC deployment normally records `null` because it
needs no override: each package manifest's source principal derives its
standard `https://<source-canister>.icp0.io` origin. The local override is not
an alias and applies only when its embedded canister principal matches the
manifest.

`apps/kernel/src/main.tsx` mounts the React app with `createRoot()` on the
document element with id `root`. There is no Redux `Provider`; visible state is
held in Zustand stores.

The root component includes:

- `WorkspaceShell`, the kernel-owned desktop shell, dynamic workspace tiling
  manager, and full-page Settings view.
- `Auth`, which handles Internet Identity login and authorization checks.
- `Requests`, which renders canister-call approval dialogs.
- `InstallOfferController`, which receives bounded app-install offers.
- `RepositorySetupController`, which owns the optional certified third-party
  setup flow after authentication and registry load.
- `AppDialogs`, which renders package install request/progress dialogs.
- `ConnectionDialogs`, which owns reviewed provider connection flows.
- `AgentGrantDialog`, which owns Agent Mode grants.
- `ToastViewport`, which renders trusted shell notifications.

The old top-right app drawer and hash-route fullscreen app iframe have been
removed. App launch is now owned by the workspace shell.

`main.tsx` still exposes a debugging hook:

```ts
window.install_app = async (): Promise<void> => {
  await install_app();
};
```

### Workspace Shell

`apps/kernel/src/workspace/WorkspaceShell.tsx` is mounted only after the user is
logged in and the auth reducer is no longer loading. It loads
`/system/apps.json` through `getApps()` and certified HTTP, renders
`WorkspaceView`, renders a
top toolbar with a launcher icon button, sequential workspace switcher,
installed app tray icons, and a pinned trusted Kernel tray item, and controls
the launcher. The previous standalone Settings and account-menu buttons are not
rendered in the authorized workspace shell.

The Kernel tray item uses the same kernel-owned popover chrome and placement as
app tray items, but its body is trusted React rather than an app iframe. It
shows the canister, cycle balance, and current heap as `Memory`, and provides
Open Settings and Logout actions. A fixed capacity bar compares that heap value
with the canister's configured Wasm-memory limit; it never substitutes expanded
Wasm allocation or stable memory for the displayed usage. Stable and logical
stable memory are not shown in the tray. It does not repeat the signed-in
principal; that identity is marked in Settings' authorized-principals list. App
tray icons may scroll when space is constrained; the Kernel item remains pinned
at the right edge of the tray.

The shell owns a transient `workspace | settings` view state. Opening Settings
does not unmount the workspace: its surface becomes hidden, `aria-hidden`, and
`inert`, while every mounted tile iframe remains mounted. Resident background
frames remain outside the view switch and continue running. Back, Escape, a
workspace button, or opening the launcher returns to the workspace; closing
Settings restores focus to the Kernel tray button.

The shell starts with three empty workspaces. When every exposed workspace is
occupied, it appends one sequential empty workspace, up to 20 workspaces. It
does not append another while any exposed workspace is empty. Workspace state
is stored in versioned localStorage by `apps/kernel/src/workspace/store.ts`.

The active workspace is mounted first. Another workspace is mounted lazily the
first time it is visited and remains in a hidden, `aria-hidden`, inert layer for
the rest of that authorization session. Returning to a visited workspace
therefore reveals the existing tile iframe and its in-memory state instead of
reloading its HTML, JavaScript, and initialization queries. Inactive tile
frames are disconnected from the Kernel message bus and reconnect only when
their workspace becomes active, so they cannot act as undeclared resident
processes. The Kernel retains only the latest bounded same-app state
invalidation per topic and replays it on reconnect, preventing a resumed tile
from missing a resident update while it was inactive. A retained frame records
which revision it received, so ordinary workspace reconnects do not replay the
same invalidation and trigger another query. If an install replaces a hidden
frame, its new document is deferred until that workspace becomes active; only
a document that successfully started while active is retained. Authorization
loss discards the visited-workspace set even if the next session uses the same
principal. Unvisited persisted workspaces do not all start during login. Only
the active layer installs focus, modifier, and pointer listeners.

Each workspace stores:

- `layout`, a nullable binary split tree;
- `tiles`, the open tile instances in that workspace;
- `focusedTileId`.

Opening a tile always creates a new tile instance. The first tile fills an empty
workspace; later tiles split the focused tile to the right. Closing the final
tile leaves the workspace empty. Open tile instances keep their own app id,
tile id, title, path, and icon, so a later registry refresh does not
immediately delete already-open windows.

### Layout And Gestures

`apps/kernel/src/workspace/layout.ts` and `tree.ts` provide pure split-tree
helpers. Split ratios clamp to `0.15..0.85`, the workspace gap is `8px`, and
the React view computes tile rectangles from the active layout.

The workspace implements Hyprland-style pointer behavior:

- dragging a split gap resizes that split;
- dragging the tile header grip moves the tile;
- holding a layout modifier over a tile body starts tile move;
- holding a layout modifier over a tile corner starts corner resize;
- dropping a moved tile over another tile inserts it on the target side;
- dropping a moved tile on an exposed workspace button transfers that exact
  tile and switches to the target workspace.

The layout modifier includes browser-delivered Meta/Super/OS/Hyper states and
Alt. Because iframe content consumes pointer events, the workspace renders a
parent-owned hit layer over iframe content while a layout modifier is held or a
drag is active.

Keyboard workspace commands use only browser-delivered Meta/Super/OS/Hyper
states, not plain Alt:

- Meta/Super+1..9 switches to an exposed workspace;
- Meta/Super+Shift+1..9 moves the focused tile to an exposed workspace and
  switches there;
- Meta/Super+Q closes the focused tile.

### Launcher

The launcher opens from the top-left launcher icon button. The button is the
reliable path after focus has moved into an app iframe, because the parent page
does not receive keyboard events while a cross-origin iframe owns focus.

The launcher also opens with the global shortcuts implemented in
`WorkspaceShell` when focus is in the parent page:

- Ctrl+K / Cmd+K;
- Meta/Super+D where the browser delivers it;
- Ctrl+Space.

Global shortcuts are ignored while focus is in an input, textarea, select, or
contenteditable element. Escape closes the launcher.

The launcher flattens normalized `/system/apps.json` entries into app tile
entries, excluding the `kernel` registry entry. It also exposes system actions
for installing an app and resetting the current workspace. The compact
`Install app` group keeps equal File and URL buttons on one row. File opens the
browser picker; URL opens one labelled inline address field with Install and
Cancel. Both sources run the same package review and install flow and open the
installed package's first tile when the install produces a launchable app tile.

An active empty workspace renders this same launcher component centered in the
workspace instead of a separate empty-state implementation. Its workspace
placement is a non-modal region: it does not add a backdrop, trap or move
focus, or offer the redundant reset action. Opening the top-left launcher
temporarily unmounts that inline placement and renders the component's modal
placement, so retained hidden workspaces never create duplicate launcher
controls or DOM ids.

### Kernel Settings

`apps/kernel/src/settings/KernelSettingsPage.tsx` is trusted kernel UI, not an
app, tile, iframe, route, or message-bus endpoint. It is available only to the
authenticated owner. The page shows the canister, cycle balance, current heap,
generated deployment/compiler identity, and every registry app, including the
kernel and apps without launcher tiles. Normal mode labels the heap as
`Memory`; developer mode additionally exposes stable memory and logical stable
memory. Canister/Wasm memory is not presented as user memory.

The Kernel has one browser-local presentation mode shared by Settings and all
kernel-owned prompts. `normal` is the strict default and is intended to show
the essential consequence and choice with low cognitive load. `developer` is
intended to add exact permissions, identifiers, hashes, and runtime details.
Consent prompts use one shared consequence projection in normal mode and keep
the complete exact disclosure in a collapsed technical-details section.
Developer mode opens that same section by default; it does not maintain a
second approval flow or a separate permission interpretation.
The expandable Interface section beside Runtime provides an `Enable developer
mode` switch and writes the validated preference to
`neutron-kernel-ui-mode-v1`; unavailable or malformed storage falls back to
`normal`. The global Zustand store is independent of the current principal and
is not exposed to app frames. This mode is presentation-only: it must never
change authorization, permission enforcement, risk classification, or the
material consequences required for informed consent.

Settings refreshes the app registry, `kernel_runtime_info`,
`kernel_settings_snapshot`, and `kernel_app_usage_snapshot`
independently. Existing values remain visible while
refreshing. App uninstall is disabled unless registry ids and versions match
the running actor. Candid `Nat` values are normalized to `bigint`; unsafe
JavaScript numbers are rejected before formatting.

All per-app operational information lives in the **Installed Apps** table;
Settings has no separate instructions, usage, or updates section. The overview
columns are app, cycles used, cycles in, updates, installed version, details,
and uninstall. The app cell shows the app name with a one-line, ellipsized
app-provided description. The version uses the packed manifest version rendered
as a semantic version. The details and uninstall controls remain separate
keyboard-reachable cells, and the kernel row cannot be uninstalled.

The cycles-used cell joins telemetry by exact app id and installation uid. It
uses a low-side 13-node estimate:
`lifetime_instructions + lifetime_executions * 5_000_000 +
lifetime_outgoing_cycles`. The last field contains
non-instruction message costs: a 1,200,000-cycle ingress-reception base for each
authorized update, a 260,000-cycle base per brokered call and measured
timer/handler self-call, and net explicit transfers. Public update entrypoints
from paid canisters do not add the ingress base because their sender owns the
inter-canister call fee; direct authenticated ingress does add it. The
sum is formatted to four decimal places in trillion cycles and labeled `TC`.
A missing usage row renders as zero measured use for that active installation,
not as a load failure. The backend snapshot continues to expose separately
typed instruction, execution, and compatibility-named outgoing-cycle fields
and rolling daily buckets. The estimate omits variable message-byte charges,
response-callback bases, shared global-timer dispatch, storage, and compute
allocation, so it is not billing-grade canister burn.

The cycles-in cell joins the same exact installation scope and shows
`lifetime_incoming_cycles_accepted`, formatted in trillion cycles. It counts
cycles accepted through the app's paid public-ingress routes, not generic
canister top-ups or balance changes. This attributed revenue remains separate
from and does not reduce the cycles-used estimate. Both cycle totals remain
visible in normal and developer modes.

Each installed-app row has a collapsed details control. In normal mode its
expanded view is consequence-oriented: it shows concise kernel-written copy
for material external, public, signing, key, data, connection, and autonomous
background access; every live capability switch; persistent backend grants
with their exact scope and revoke action; a non-authoritative source/integrity
status; and app relationships that block uninstall. A capability that only
uses compiler-enforced app/installation namespaces is omitted or reduced to a
single plain-language control. Normal mode does not render plan fingerprints,
digests, API/delivery policy, quota/audit prose, operation counters, internal
methods and paths, memory schemas, or raw usage-unit breakdowns.

Developer mode retains the complete strict registry projection and canonical
capability Settings wire with active runtime data: manifest/package/runtime
versions, tiles, resident process, declared and derived capabilities, exact
resource identifiers and counters, active memory roots and schemas, generated
backend functions, raw 30-day and installation usage totals, and full
provenance digests. Switching mode while a row is open replaces the rendered
details; the presentation mode does not alter capability enforcement or live
state. There is no separate global usage ranking or chart; the combined cycle
totals and update control remain visible in the overview row.

The kernel does not fetch or render arbitrary manifest JSON in Settings. This
keeps the view bounded and avoids treating third-party manifest text as trusted
markup; all displayed app metadata remains untrusted plain text.

Settings also reads the optional certified
`/system/install-provenance.json`. Normal mode turns it into a source kind and
package-integrity status without implying publisher trust. For an app installed
through a repository setup, developer mode shows the repository principal,
manifest id, pinned manifest SHA-256, and package SHA-256 recorded by the
kernel in the same install journal. It is a source/integrity record, not an
update link, subscription, private record, or provider endorsement. Manual
package replacement clears a stale repository entry and uninstall removes it.

Settings independently inspects the fixed package-information sidecar for
every registry row: `/pkg/legal/package-record.v1.json` for the Kernel and
`/app/<id>/pkg/legal/package-record.v1.json` for an app. It first reads the
bounded record and referenced manifest only, then verifies the record's
manifest ID, version, dependencies, and memory declaration against that row.
It does not fetch license texts, notices, memory locks, embedded source, or an
HTTPS source offer merely to render the table. In normal mode, an explicit
download action fetches an installed license or notice and verifies its exact
size and SHA-256 before exposing an inert Blob download. **Download and verify**
does the same for an HTTPS source offer: it sends no credentials, accepts no
redirect or transforming HTTP content encoding, enforces the shared 17 MiB
ceiling and the recorded byte length, verifies SHA-256, and only then starts the
download.
Archive-only embedded source remains in the original package and is not offered
as an installed asset. Developer mode may show the direct source URL, but labels
that link as unverified. A missing record is labelled legacy/undeclared; a
present invalid record remains an error and is never treated as a license.

The Runtime section also reads the one public certified deployment record at
`/system/deployment-build-record.json` and the live certificate-verified IC
module hash. It validates the record's target canister and same-deployment
runtime identity/inventories before comparing the live whole-canister hash
with the record's deterministic gzip transport SHA-256. It exposes the
canonical JSON for copy/download and keeps missing, unreadable, invalid, stale,
inconsistent, match, and mismatch states distinct. No installed-app row is
given its own module hash. The exact record contracts and GPL bridge behavior
are in [License And Deployment Records](./license-and-deployment-records.md).

Launcher and Settings share one kernel-owned uninstall confirmation and one
global app-operation state. The confirmation lists owned memory roots when
known. Verified uninstall performs message-bus cleanup, removes tiles from all
workspaces, updates the registry, and unmounts the resident through the shared
reducer path. The kernel row never receives an executable uninstall action.

The final `Access & recovery` disclosure is collapsed by default and does not
call the management canister until opened. It lists equivalent authorized owner
principals separately from IC controllers, validates and canonicalizes principal
text, and supports adding or removing either authority. Removing an entry uses
a destructive confirmation. The active browser principal cannot remove its own
authorization and is marked `(current)` in the authorized-principals list; the
same identity is not repeated in the Settings overview. The Neutron canister
cannot remove itself as controller and is visibly identified as the
`Self-Controller`. The Self-Controller performs checked in-product upgrades and
controller-list changes only after an authorized owner action.

Controller Authority is separate from Kernel owner authorization. Every other
IC controller has equal management-plane power: it can replace the complete
Wasm, change or remove controllers, change settings, stop or delete the
canister, and potentially remove the owner's authority. Entering a controller
principal therefore opens a default-cancel alert dialog. The Kernel makes no
controller change until the owner reviews that warning and explicitly selects
`Add controller`. Every non-Self-Controller entry remains removable through
the same Settings surface.

#### Independent controller management and Self-Controller recovery

An owner can add a principal they directly control as an external controller.
That controller provides an independent platform path if the installed Kernel
cannot perform its checked upgrade path. It is not an additional Neutron user,
and merely being an IC controller does not grant ordinary Kernel authorization.

Settings is the ordinary way to inspect, add, and remove controllers. A user
who controls an external controller can also use the platform tooling directly:

```sh
dfx canister status <neutron-canister-id> --network ic
dfx canister update-settings <neutron-canister-id> --network ic \
  --add-controller <principal>
dfx canister update-settings <neutron-canister-id> --network ic \
  --remove-controller <principal>
```

Run those commands with the `dfx` identity for an existing external controller.
Inspect the controller list before and after every change. Avoid
`--set-controller` unless replacing the complete list is deliberate: it removes
controllers not named in that command.

If an external action removes the Self-Controller, Settings can still inspect
the controller list but cannot change it. Restore checked in-product upgrades
by using an existing external controller to add the Neutron canister principal
back to that same canister:

```sh
dfx canister update-settings <neutron-canister-id> --network ic \
  --add-controller <neutron-canister-id>
```

Direct controller replacement bypasses the Kernel's schema, migration,
dependency, and data-loss checks. Use it only with a reviewed complete Wasm and
an explicit understanding of the state risk.

The separate `App-isolated keys` disclosure is also collapsed by default and
loads `kernel_vetkeys_admin_snapshot` only when opened. It groups slots by app
and shows lifecycle manager (`key_holder`), enabled/disabled/suspended state, current and previous
generations, shortened public fingerprints, production/local key name,
timestamps, last use, lifetime derivations, and approximate cycle spend. Exact-manager
actions provide enable, disable, rotate, previous-generation retirement, holder transfer,
and permanent slot retirement with kernel-owned confirmations. Suspended or
removed declarations keep only the transitions that remain safe, including
permanent holder-authorized cleanup. The bounded audit view shows coarse
action/outcome/app/slot/actor/generation/time fields and never key or transport
material.

### Registry Shape

The app registry is stored at `/system/apps.json`. Each entry is a strict
format-3 structural projection plus the exact canonical capability plan:

```ts
type AppRegistryEntry = {
  link: string;
  name: string;
  version: number;
  format: 3;
  update_source?: string;
  description?: string;
  icon: string;
  tiles: Array<{
    id: string;
    title: string;
    path: string;
    icon: string;
    description?: string;
  }>;
  background?: {
    path: string;
    description?: string;
  };
  tray?: {
    title: string;
    path: string;
    icon: string;
  };
  capability_plan: CapabilityPlanWireV1;
  capability_plan_fingerprint: string;
  dependencies?: Record<string, {
    app: string;
    min_version: number;
    functions: string[];
  }>;
  functions: Array<{
    name: string;
    // Exact physical actor method; absent for internal functions and
    // route-only paid handlers opting into public_ingress_cycles.
    candid_name?: string;
    type: "update" | "query" | "internal";
    access: "authorized" | "public" | "internal";
    async: "sync" | "async" | "async*";
    args: string[];
    expose?: "apps";
  }>;
};
```

`getApps()` treats the proof-verified registry as authoritative and replaces
the Zustand app list with `normalizeAppRegistry()` output. Every row is closed,
its plan is independently parsed, its SHA-256 fingerprint is verified, and
plan identity/derived entries are cross-checked against the structural row.
For every non-internal function except a route-only paid handler opting into
`public_ingress_cycles`, it also recomputes the exact kernel/logical or
ordinary-app/mangled Candid name and rejects a missing or substituted mapping.
For that handler-scoped opt-in, it instead rejects any `candid_name`, because
the compiler emits no ordinary actor wrapper.
It reports proven absence or any authorization, certificate, hash, decode,
transport, version, or fingerprint failure instead of silently substituting an
empty registry. The special `kernel` entry is kept for package/compiler state
but has `tiles: []` and is not launchable.

The registry preserves normalized discovery/structural metadata and one plan
wire rather than the complete manifest or duplicate raw capability fields.
Only current format-3 rows are accepted; missing fields, unknown properties,
malformed plan entries, and fingerprint mismatches fail closed.

### Authentication And Authorization Flow

One Neutron canister has one human owner. The frontend's authenticated
principal is one credential for that owner, not one account in a multi-user
workspace. Settings can manage additional owner/recovery principals, but kernel
and app UI must not expose users, roles, invites, or per-principal app data.

`useAuthStore()` owns the visible auth state:

- `logged`
- `authorized`
- `principal`
- `loading`
- `authError`

Long-lived runtime values stay in module scope in
`apps/kernel/src/reducer/auth.ts`, including the current icblast client, the
checked-in bootstrap actor, and cached dynamic kernel bindings.

After Internet Identity login, the frontend creates the bootstrap actor from a
small checked-in IDL and calls `kernel_check_authorized(null)`. This keeps the
login screen independent of the combined Candid. If that caller is not
authorized and bootstrap captured a pending 32-byte activation code, the
frontend removes its same-tab copy and calls
`kernel_activation(#use(code))` exactly once. A successful use authorizes the
actual signed caller. If the update response is lost, the frontend queries
`kernel_check_authorized` instead of replaying a possibly consumed bearer. It
checks authorization again before mounting the runtime.

The first dynamic app-method call after authorization fetches
`/pkg/neutron.did` through certified HTTP and creates the dynamic actor.
Concurrent callers share that one fetch and compilation promise, and later
self-calls reuse the resulting actor. The same HTTP helper reads registry,
package, compiler, and provenance assets; browser caching applies normally.
Logout, identity replacement, or a committed runtime replacement clears all
bootstrap and dynamic-actor caches, including an in-flight older-generation
load. The workspace shell, launcher, and app iframes mount only when both
`logged` and `authorized` are true.

Activation links use `#activate=<canonical-base64url>` and may carry all three
repository fields in that same fragment. Bootstrap validates exact fields and
sizes, stores activation in `sessionStorage`, and removes the fragment before
auth startup. Query-string handoff fields are erased and rejected. Storage or
address-bar cleanup failure fails closed and rolls back retained handoffs.
Same-document activation navigation reloads the clean URL so the normal login
path performs the one attempt.

Existing authorized owners can still add another owner credential through
Settings, and verified controllers retain the explicit recovery path.

The frontend has no static-body actor-query fallback. Missing and unsuccessful
HTTP asset responses remain errors at their callers rather than silently
becoming an empty registry or package state. Certified HTTP state survives
actor upgrades. Neither actor initialization nor normal app installation
globally recertifies existing package or app-owned assets. Newly promoted
package files are certified once against the capability state being committed.

If the user is authenticated but not authorized in that Neutron canister, the
frontend records `logged: true`, `authorized: false`, and an `authError`. The UI
shows a blank kernel screen with a vertically centered authorization error,
the current principal with an adjacent Copy action, and a quiet Logout button.
It does not mount a separate account menu. The browser stays on that screen
when there is no activation handoff, when the code is invalid or already used
by another identity, or when activation cannot be confirmed. Provision-created
production Neutrons can still use their already-authorized deployment identity
for manual authorization. Fresh dispenser-created Neutrons use the one-time
activation link instead.

### Repository Setup Workflow

`RepositorySetupController` waits until the owner is logged in, authorized, and
the proof-verified app registry is ready. It then reads only the short-lived
same-tab setup reference captured by `bootstrap.ts`. Logging out, changing the
authenticated owner, dismissing, expiry, or successful completion clears that
reference. A later setup fragment in the same running tab is captured through
`hashchange`.

The first modal shows the canonical repository canister, manifest id, and
pinned digest. It explains that the browser will make public anonymous IC query
calls, that gateways/network infrastructure can still see request metadata,
and that a unique manifest identifier may be correlatable. No repository call
occurs before the owner clicks `Load setup`.

After that decision, the service holds the ordinary app-operation mutex while
it creates a separate anonymous agent, verifies certified repository
information and the pinned setup-manifest bytes, and downloads every manifest
package by certified content digest. Transport omits credentials and referrer
and disables caching. Every package is fetched and bounded-prepared even if its
app id is already installed; installed state therefore does not change the
package request set.

Presence is reconciled across the locally loaded registry, installed compiler
configs, and running actor inventory. Any present or inconsistent app is shown
as `Installed — skipped` and cannot be updated through this path. Missing apps
start unchecked. Selecting an app locally selects and locks any missing
dependency closure; an incompatible installed provider blocks the selection.
No selection change sends another repository request.

`Review N applications` shows unverified repository/provider prose separately
from package identity and kernel-derived permission facts, freezes the selected
closure, and compiles the packages once. `Install N applications` is the only
mutating repository action. It rechecks the authenticated baseline and then
uses one checked install journal, one actor activation, and one registry and
provenance commit. The checked journal begin compares the expected running
deployment id atomically so another tab cannot turn a missing-app install into
an accidental replacement.

The dialog remains distinct from the existing `AppDialogs` progress owner, so
the repository review is hidden before the shared install progress modal
appears. It traps focus, supports Escape/cancel before mutation, restores focus,
and reports retryable verification or compile failures without blocking the
workspace. Repository setup rejects `kernel`; the separate manual file picker
still permits deliberate kernel replacement. See
[Repository Setup Manifests](./repository-setup-manifests.md).

### Isolated App Iframes

Every app tile, tray page, and ordinary resident background runs in an
untrusted iframe. The paths are stable:

```text
/app/<app-id>/<tile.path>?app=<app-id>&tile=<tile-id>&instance=<instance-id>&workspace=<1-20>
/app/<app-id>/<background.path>?app=<app-id>&role=background
/app/<app-id>/<tray.path>?app=<app-id>&role=tray&instance=<instance-id>
```

Ordinary app packages produced by the current packer are marked as compatible
with the browser-surface-origin contract. A package that declares
`capabilities.browser_permissions` also inherently requires that contract. The
compiler records adopted installations in the certified
`/system/browser-surface-origins.json` sidecar; this is generic package
metadata, not an app-name or app-version exception.

Each adopted surface receives a distinct hostname derived from the app
installation's 128-bit browser-origin nonce and its surface key: `tile:<id>`,
`tray`, or `background`. Production uses an `i<24-hex>--<canister-id>.icp0.io`
hostname and local development uses the corresponding `.localhost:8000`
hostname. Different tile declarations therefore have different origins, while
instances of the same declared tile share its installation-scoped origin. A
normal app upgrade retains the installation nonce; uninstall and reinstall
creates a new one. Dedicated resident background capabilities retain their
specialized nonce-hosted background contract, while that app's adopted tile
and tray surfaces still use their own installation-derived origins.

An adopted ordinary frame is credentialless and uses
`sandbox="allow-scripts allow-same-origin"`. The backend binds each exact
surface hostname to only the corresponding app asset subtree, admits only the
bounded subresource destinations, rejects top-level or other document loads,
and limits `frame-ancestors` to the Kernel origin. If the browser cannot prove
credentialless originful framing, the frontend removes `allow-same-origin` and
any browser-feature delegation before navigation, so the frame falls back to
an opaque origin.

Unadopted historical packages keep their released opaque compatibility path.
Their ordinary surfaces use the app-id-prefixed hostname; a historical package
with a dedicated resident background may use the unprefixed Kernel hostname
for its tile and tray URLs. In either case the container and response sandbox
are `allow-scripts` only, so the document origin is opaque. Upgrading such an
app with a current marked package adopts the installation-surface contract
without changing its backend state. Raw and custom-proxy frame origins are
rejected. Query parameters are convenience context for the app UI only; they
are not trusted as security identity.

These URLs request Kernel-certified static responses. The bounded
gateway/browser qualification boundary is shared with certified HTTP and is
recorded in
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md#qualification-status).

The backend `kernel_runtime_info` inventory gives the frontend each committed
app's kernel-assigned `(app_id, installation_uid)`, plan fingerprint, deployment
id, and 128-bit browser-origin nonce. The frontend accepts that projection only
after the install journal is absent both before and after the runtime read.
Although the running target actor can report its staged inventory between
activation and commit, that inventory never becomes browser authority.

Frontend authority is bound to that complete app-instance projection, including
the actor deployment id, rather than only to version or installation uid. Every
committed actor change therefore advances the frontend generation and retires
the prior frames, endpoint sessions, transient tool grants, agent roots, wallet
sessions, and pending broker requests, even when an app was rebuilt at the same
version with the same declared capabilities. A failed deploy after activation
retains either the exact pending-journal recovery record or an uncertainty
fence; clearing the progress UI never restores stale authority. Pending
journals appear in a nonmodal Installed Apps recovery panel. The panel can
inspect status without waiting for activation, while an explicit retry is
reserved for a confirmed running target. Other Settings remain usable, but
install, update, uninstall, and app-specific Settings mutations stay disabled
until recovery completes or a safely undispatched journal is discarded.

The runtime query also returns the actor-local capability-authority revision
when the selected assembler supports it. Each successful runtime capability
toggle advances that revision. The observation loop compares it alongside the
assembler, deployment, and app-instance inventory; any change fences current
authority, resets the actor binding, increments every app generation, and
removes all frame and transient runtime state before reloading the certified
registry. The deployment ID distinguishes a replacement actor whose local
revision counter starts again.

Open tabs coordinate this boundary on a kernel-origin-only
`BroadcastChannel`, with a same-origin `storage` event fallback. The initiating
tab signals once after checked journal creation and again after commit; a safe
abort signals the still-current committed deployment. Receivers synchronously
fence and unmount tile, tray, and background frames before querying the
canister. Opaque ordinary frames and nonce-hosted persistent backgrounds cannot
open the kernel-origin channel. Neither can installation-origin app frames. A
coalesced visible-tab observation checks
journal status and runtime identity every 20 seconds for other devices or
missed signals. It performs the larger registry/assets reconciliation only
after a change or uncertainty, so ordinary polling remains two small queries
and hidden tabs do not poll. Observation failure stays fail closed until a
later focus, signal, or interval proves and reloads committed authority.

Ordinary `/app/<id>/**` web paths and the committed
`/app/<id>/pkg/**` metadata subtree are anonymously HTTP-readable. Certified
HTTP protects their integrity but does not hide app HTML, JavaScript, icons,
workers, lazy assets, or installed-package inventory.

Adopted tiles, trays, and ordinary backgrounds use the credentialless
installation origins above; only unadopted historical surfaces retain opaque
compatibility framing. A background may instead use one of the two mutually exclusive
dedicated resident modes: credentialless-ephemeral or persistent. Their exact
initial iframe request, Host/query binding, origin rotation, subresource
destinations, and browser preflight rules are specified in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).
WebGPU-capable apps detect `navigator.gpu` inside the frame. `AppTileFrame`
registers `iframe.contentWindow` in `frame_context.ts` with the
kernel-owned `{ appId, tileId, instanceId, workspace }` context, installed app
version, installation uid, and frontend registry generation, and unregisters
it on unmount. The registration also stores the exact installation origin for
an adopted frame. Both the registered source window and that origin must match
before the Kernel transfers its private `MessagePort`; a legacy opaque frame
is retained only on the historical source-window plus `origin: null` path.
This registration is the trusted app identity for kernel request handling.
A trusted local same-version development redeploy retains the installation uid
but changes the deployment-bound projection and advances the generation; the
owner-facing browser installer requires a strictly higher release version. An
uninstall and later reinstall also receives a new uid. In both cases the old
endpoint and every retained session fail closed.

`AppBackgroundFrames` is mounted outside `WorkspaceView`. It creates one hidden
iframe for every installed app declaring `background`, keyed by app id, version,
frontend registry generation, and background path. The resident container is
ordered after the visible workspace content so a restored visible tile gets
the first opportunity to start its asset requests. Switching workspaces hides
visited tile layers without unmounting their iframe DOM, but disconnects the
inactive tiles' Kernel endpoints; resident frames remain connected.
Logout, authorization loss, registry removal, or package replacement unmounts
or reloads the corresponding background process. Resident frames are also
unmounted while an activated install is pending and are not mounted at all
until a committed app-instance record matches the registry.

For a resident that requires an authenticated MessagePort, the kernel starts a
15-second readiness deadline for the current installation/deployment authority.
If no valid endpoint is ready, it remounts that exact resident once. A second
timeout marks the resident blocked in kernel diagnostic state instead of
creating a reload loop.
A later valid handshake for the current authority recovers it; a stale or
cross-deployment handshake cannot. This is a liveness bound around the existing
source/origin/authority checks, not a second app-defined readiness protocol.

An installed top-level `tray` declaration adds one button containing the app's
icon to the top-right toolbar and requires that resident background. The app
supplies the untrusted icon/title metadata; the kernel owns the button, numeric
badge, popover chrome, close behavior, native popover behavior, placement, and
size caps. It mounts the declared tray page only while the popover is open,
using a fresh
`app:<appId>:tray:instance:<instanceId>` endpoint for every opening. The frame
always remains credentialless. An adopted tray uses its installation-derived
origin with `sandbox="allow-scripts allow-same-origin"`; an unadopted historical
tray retains `sandbox="allow-scripts"` and an opaque origin. Neither inherits a
persistent background's storage authority. Closing the popover unregisters and
destroys the frame. The host supplies an explicit close button and
light-dismiss; a tray page handles Escape with `dismissTray()` while its
cross-origin frame owns focus. See [App Tray](./app-tray.md).

The built-in Kernel tray item is separate from this app contract. It reuses the
trusted popover primitive but never registers an app endpoint, mounts an iframe,
accepts app-provided metadata, or exposes badge control.

### Kernel-App Request Boundary

`index.tsx` imports `./expose`, which installs the unified frontend message bus.
The exact registered `contentWindow` participates in a closed
probe/ready/connect handshake, after which the Kernel transfers a private
`MessagePort`. All requests, replies, progress, state changes, tools, and
binary sidecars use that port. There is no operational Window-message
fallback. For an originful app frame the ready message and every connection
probe are bound to the exact registered app origin as well as the exact source
window. Inside an app frame, the SDK derives the valid Kernel parent origin
from the canister-bound frame URL before accepting the connection; referrer
text cannot nominate a different parent.

Camera and microphone delegation is default-deny. A manifest may declare the
closed `capabilities.browser_permissions` v1 object, mapping exact tile ids to
`camera`, `microphone`, or both. The Kernel gives only those adopted tile
iframes an exact-origin `allow` value; the Kernel document's Permissions Policy
is only the parent ceiling, and the app document's certified policy limits the
delegated feature to itself. Trays, backgrounds, undeclared tiles, legacy
opaque fallbacks, and every other browser feature receive no delegation. The
tile calls `navigator.mediaDevices.getUserMedia()` directly and the browser
owns its prompt, indicators, and site-level denial. There is no Kernel backend
media session, lease, stream proxy, or capture API.

The kernel is a bus endpoint exposing canister schema/call tools, installed-app
discovery, live endpoint discovery, permission requests, and per-app audit
history. The canonical actions are `canister.schema` and
`canister.call_dialog`; the raw `schema` and `call_dialog` aliases do not
exist. Endpoint tools are discovered live and called only through Kernel
routing.

The private `app.state.publish` action is part of this same bus. The kernel
binds it to the registered source app, accepts only a bounded topic and decimal
revision, and forwards the event only
to the app's other live endpoints, including an open tray. It does not open UI,
cross app boundaries, or carry application data. Resident apps use it to
invalidate tile and tray projections without making polling their primary
synchronization mechanism.

The private `tray.set_state` action accepts only `{ badge }` from the exact
registered background of an installed app with a tray. `badge` is `null` or a
safe integer from `0` through `9999`; zero and null clear it. There is no
time-window gate; the service short-circuits an unchanged value, and residents
should still coalesce noisy updates. The action cannot
open, focus, notify, reorder, or restyle shell UI. Values over 99 display as
`99+`, while the accessible label retains the exact count. The private
`tray.dismiss` action lets only the exact live tray endpoint close its own
popover. Neither action is a discoverable kernel tool or permission.

Five private `vetkeys.*` actions implement app-isolated key lifecycle, listing,
public-key lookup, and the begin/confirm recovery handshake. They derive the
app from the registered endpoint and are not offered through endpoint tool
discovery or Agent Mode. Lifecycle requests require the focused source tile and
render dedicated kernel copy for the exact action. Recovery creates a bounded
60-second challenge for a tile or resident requester. That same endpoint
immediately confirms its own challenge as protocol plumbing; no focus,
transient user activation, or extra consent is required. Tray provenance and a
different confirming endpoint are rejected. Endpoint object/id/session,
installed version, currently authorized principal, declaration,
slot uid/id/generation, request nonce, transport-key hash, concurrency, and
challenge binding are rechecked across asynchronous work; the encrypted
response goes only to the original endpoint. The slot holder remains the
lifecycle manager and is not the only reader.
See [App-Isolated vetKeys](./app-isolated-vetkeys.md).

The private `ethereum_provider.begin`, `request`, and `end` actions broker
EIP-1193 access for apps that declare exact chains and methods. The extension
provider remains in the trusted top-level page. Begin requires an authorized
owner, the focused source tile, and transient user activation; backgrounds and
Agent Mode are rejected. The resulting random session is source-, owner-, and
app-version-bound, short lived, concurrency bounded, and method validated. It is never
listed as a kernel tool or delivered as a provider object to the iframe.

Apps do not provide Candid text or package-provided schemas. For calls to the
Neutron canister, the kernel fetches `/pkg/neutron.did` through certified HTTP
and uses icblast to derive method JSON Schema and validate JSON arguments. The
previous direct `call` action remains unavailable.

### Request Approval Dialogs

`useRequestStore()` stores pending call approvals under `calls`, keyed by an
incrementing `cid`. Each request now includes the iframe-derived frame context.

`Requests` renders the first pending canister request. It shows:

- requesting app and exact tile, tray, or background surface;
- destination canister principal;
- operation/method name;
- arguments converted with icblast `toState()`;
- Approve and Reject buttons.

Approving resolves the pending Promise and then the exposed action performs the
canister call. Rejecting rejects the app's request with `User rejected`.

The same component renders cross-app frontend tool requests. It shows caller
app/role, exact target endpoint, tool name, and JSON arguments. The user can
allow one call, allow that endpoint/tool for the current session, or reject.

All app-originated frontend tool, signed call, backend access, Connections,
workspace navigation, and Agent Mode grant prompts first pass through the
shared UI-attention policy in `src/ui_attention/owner.ts`. Only one may be
active globally and there is no hidden queue. Rolling source-app and global
limits reject excess attempts with structured errors. Requests expire, and
rejecting, pressing Escape, or closing a backdrop applies a short recovery
pause. Prompt controls can pause that source app for two minutes, ten minutes,
or the browser session.

### Agent Mode Runtime

`src/ui_attention/agent.ts` owns session-only Agent Mode grants, root turns,
invocation nodes, one-shot agent decisions, hard budgets, cancellation, and a
bounded redacted audit. A grant is bound to the current owner principal, app
id, installed version, and exact declared resident entrypoint. One grant and
one root may be active. Reload, logout, authorization loss, update, uninstall,
endpoint replacement, expiry, stop, or disable invalidates the affected tree.

Invocation capabilities are random private transport metadata bound to one
endpoint session and dynamic call lifetime. `expose.ts` resolves this metadata
before every routed action and gives each child a fresh capability. Direct root
actions can cross delegable boundaries without an owner modal. New permissions
requested by descendants are suspended and sent to the root through the
reserved consent action on the existing message bus. Invalid, stale, unscoped,
late, or replayed authority fails closed.

The topbar indicator remains kernel-owned while a grant is active. It shows
idle or running state, elapsed turn time, stop, and disable controls. Settings
shows every eligible entrypoint, the exact active grant, remaining root
budgets, and recent allow or deny summaries. These surfaces never display
capabilities, challenge ids, credentials, or raw arguments.

App-driven tile navigation remains in the current workspace, always reuses an
exact existing app/tile instance first, and observes timing and capacity
limits. Agent roots may navigate without a fresh click; descendants require a
one-shot agent decision. Neither path can switch, close, move, resize, or reset
another app's workspace UI. Tray endpoints cannot start Agent Mode or receive
delegated agent calls.

### App Install Request And Progress Dialogs

`install_app()` in `apps/kernel/src/reducer/apps.ts` still drives the browser
package install workflow:

1. Bind the Neutron canister through `getNeutronCan()`.
2. Acquire exact `.neutron` bytes from either the browser file picker or a
   user-entered package URL. URL downloads require HTTPS except local loopback,
   omit credentials and referrers, bypass caches, reject redirects, require
   CORS, and stream under a 32 MiB ceiling.
3. Retain those exact bytes for the complete attempt; there is no refetch after
   review.
4. Unpack and validate the package through shared install helpers. If
   `legal/package-record.v1.json` is present, validate it; absence retains the
   documented legacy/undeclared state rather than making the archive invalid.
5. Compute package size and an immutable structured disclosure snapshot from
   the normalized manifest.
6. Read a consistency-fenced predecessor, compile the complete combined actor,
   and create the canonical deployment build record and exact deterministic
   gzip transport. Expose that sealed record for inspection, copy, or download
   before install-code dispatch.
7. After approval of the reviewed result, revalidate the record against the
   exact package, compiler, predecessor, and transport facts. Upload immutable
   modules, stage the record with all mutable files, record the journal, and
   signal sibling tabs to fence their app authority. A compressed
   actor that fits the 2 MiB ingress budget uses `kernel_install_code`;
   otherwise the same compiler path clears the self-controller's management
   chunk store, uploads sequential 1 MiB journal-bound chunks, and calls
   `kernel_install_code_chunked` with only their hashes. It then verifies
   runtime identity, clears temporary chunks, and commits.
8. Commit the same canonical record atomically with the target registry and
   package assets after the expected runtime responds. Re-read the runtime
   inventory with an absent journal on both sides of the
   read, reconcile it exactly with the committed registry, and only then replace
   the local registry and app-instance stores. A second signal lets sibling
   tabs perform the same committed reconciliation immediately.
9. Return the installed app id and registry to the launcher, which opens the
   first launchable tile when one exists.

Direct URL installs are manual installs, not certified repository installs.
The URL is neither persisted nor treated as publisher provenance, and an
update through File or URL clears stale repository provenance through the same
manual-install path. A URL can still deliver a deliberate kernel replacement;
the existing kernel-replacement warning and owner approval remain authoritative.

Kernel replacement packages remain allowed. A package with id `kernel` updates
the kernel registry entry and root assets, but it is not opened as a normal app
tile because `kernel.tiles` is empty.

### Settings App Update Checks

Settings owns one ephemeral update service under `src/updates/`. It checks
update sources after the initial Settings snapshot loads and again whenever the
authorized owner presses the global **Refresh settings** action. There is no
separate Installed Apps check button. During a check each eligible app row
shows a spinner; settled rows show **Up to date**, **Update**, or the relevant
unavailable, regressed, or failed state. Apps without an update source remain
manual-only.
The service snapshots installed app versions and sources, groups and sorts app
IDs per source, and reads fixed certified release assets in waves of at most
20. It sends neither installed versions nor credentials and aborts if the
registry changes or Settings unmounts.

Selecting a row's **Update** action re-fetches and reconciles that candidate
against the observed release tuple. The existing installer prepares that app,
compiles the proposed final app set, displays the normal package review, and
deploys through one checked journal. Candidate state and package bytes remain
browser-ephemeral; successful registry, source metadata, and provenance writes
commit together. Details are in [App Package Updates](./package-updates.md).

The disclosure snapshot contains closed kernel-fact records rather than display
strings. Kernel-owned renderers derive authoritative wording, risk, groups,
persistence warnings, and action labels from their machine fields. Optional app
rationale uses a separate unverified type and visual section. The dialog keeps
all exact facts keyboard- and screen-reader-reachable in one discoverable
scroll area, labels its modal relationship and headings, and retains the same
snapshot until approval or rejection. Settings projects the same normalized
capability fields instead of reinterpreting app prose. App names, tile titles
and descriptions, background descriptions, and Agent Mode names remain visibly
labelled app-provided and unverified next to kernel-bound app, tile, and tray
identifiers.

A `vetkeys` declaration adds a structured install fact rather than silently
creating a key. The dialog lists declared slot ids/purposes and explains that a
focused lifecycle decision is still required to reserve a slot, browser
recovery spends cycles, compatible updates inherit access, disabling cannot
erase a recovered key, and the app may disclose its own slot key. Derivation's
source confirmation is automatic and does not open another dialog. The
description and purpose remain visibly unverified app text. Runtime
reserve/enable/disable/rotate/retire/transfer requests use a second dedicated
lifecycle dialog with default-cancel destructive confirmations where
appropriate.

## Open Questions And Gaps

- Repository protocol, reconciliation, setup handoff, authorization separation,
  and package bounds have unit/Motoko coverage. A Playwright scenario defines the complete local
  dispenser-to-repository-to-kernel setup, overlap skip, and tampered-digest
  path, but fresh cross-canister execution is still pending and invalid
  certificate/witness cases are not yet covered there.
- Tray positioning uses the layout viewport horizontally and the visible
  viewport bottom vertically; pinch-zoom offsets and zero available vertical
  space are not fully clamped. Native open/light-dismiss/focus behavior, fresh
  instance creation, iframe teardown, and icon fallback also lack browser-level
  regression coverage.
- Resident launch checks the iframe and Window credentialless state required by
  the compiled mode and fails closed on a mismatch. Cross-browser evidence
  remains part of the shared certified-HTTP qualification boundary.
- Persistent cross-app grants, resource quotas, and a grant-management screen
  are not implemented.
- Compiler danger findings hard-block ordinary app installation.
- A pending journal is recovered on the next authorized app-registry load;
  active metadata is not advanced before runtime verification.
