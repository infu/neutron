# Kernel Frontend Runtime

[Back to the documentation index](./index.md)

Use this reference when changing the trusted browser shell, frame lifecycle,
owner authorization, or installation orchestration. Source owns complete types,
tool inventories, presentation details, and numeric defaults. Keep the
invariants below when editing those implementations; do not infer authority
from visible UI state or app-provided metadata.

## Implementation Facts

### React Entry Point

`apps/kernel/src/index.tsx` calls `bootstrapKernel()` in `bootstrap.ts`.
Bootstrap captures and strips repository and activation handoffs, installs the
same-document handoff listener, and validates `/system/runtime-config.json`
before dynamically importing the application. The runtime configuration binds
the canister, gateway, identity provider, root-key policy, isolated-frame origin
template, and optional local update-source origin. It must be accepted before
identity clients, frames, or update clients initialize. PocketIC test auth is a
conditional dynamic import after deployment validation, not a production login
fallback.

`runtime_deployment.ts` owns `loadRuntimeDeployment()`,
`resolveRuntimeDeployment()`, and `assertRuntimeFrameUrl()`. A local update-source
override applies only to the matching source principal. Frame URLs must match
the certified deployment's isolated-origin template or an explicitly selected
historical Kernel-host compatibility path.

`apps/kernel/src/main.tsx` installs the message bus before rendering React. It
composes the workspace and trusted authentication, consent, install, repository,
connection, and Agent Mode controllers. Zustand stores hold reactive state;
identity clients and other long-lived authority objects have separate lifecycle
management. Use the actual imports for the component inventory.

### Workspace Shell

`workspace/WorkspaceShell.tsx` mounts workspace content only when the owner is
logged in, authorized, and no longer loading. It owns launcher visibility,
workspace selection, app tray presentation, and the trusted Settings view.
The built-in Kernel tray is trusted React and is never an app endpoint.

`workspace/store.ts` is the canonical layout state. A workspace contains a split
tree, tile instances, and its focused tile. Persistent browser layout is
versioned; transient tile expansion is excluded from the stored root. Workspace
capacity and initial layout are defined by `workspace/types.ts` and the store,
not by this document.

The active workspace starts first. Previously visited workspaces remain mounted
in hidden, `aria-hidden`, inert layers for the authorization session. Opening
Settings similarly hides the workspace without destroying started tile frames.
Unvisited workspaces do not all start on login. A replacement frame in a hidden
workspace waits until that workspace becomes active. Authorization loss clears
the visited set even if the next login uses the same principal.

Hiding a started tile does not retire its private port, cancel pending calls,
or erase session grants. Visibility is presentation state, not an authority
boundary. Actual close, endpoint replacement, or loss of committed runtime
authority retires the endpoint. Resident backgrounds remain outside the
workspace/Settings view switch.

Launcher opens create tile instances. Kernel-authorized navigation can instead
focus an exact existing app/tile instance. Already-open tiles retain their own
presentation metadata; runtime reconciliation, rather than a cosmetic registry
refresh, decides whether their authority remains valid.

### Layout And Gestures

`workspace/tree.ts`, `layout.ts`, and `store.ts` own split-tree manipulation.
`WorkspaceView.tsx`, `modifier.ts`, and `WorkspaceShell.tsx` own pointer and
keyboard admission. A parent-owned hit layer captures layout gestures above
cross-origin iframe content. Browser shortcuts cannot be assumed to reach the
parent while an app frame owns focus.

Temporary expansion changes the visible rectangle while retaining the split
tree and live iframe instances. It must not become a separate layout model.
The `workspace.inspect` and `workspace.control` tools use this same canonical
store and helpers; do not implement an Agent-specific shadow workspace.
The retained `workspace.open_tile` tool reaches the shared open-or-focus path.
Role and Agent admission for these tools are described below.

### Launcher

`workspace/Launcher.tsx` uses normalized registry entries through
`launcher_entries.ts`, excluding the Kernel from app tiles. File and URL
installation enter the same checked package workflow. The active empty
workspace reuses the launcher in a nonmodal placement; opening the modal
launcher removes that placement to avoid duplicate controls and DOM ids.

Keep launcher focus handling in the trusted shell. App iframe keyboard events
are not a reliable global-shortcut channel. Derive current shortcuts, labels,
icon placement, and install controls from the components rather than copying
those details into integration code.

### Kernel Settings

`settings/KernelSettingsPage.tsx` is trusted owner-only UI, with no app iframe or
message-bus endpoint. It reconciles the registry with independently loaded
runtime, capability, usage, package-record, and deployment-integrity data.
Errors in one read must remain distinguishable from empty or absent data.
Uninstall is unavailable when the registry and running actor disagree.

`ui_mode.ts` owns the browser-local normal/developer presentation preference.
Both modes use the same canonical facts and authorization checks. Normal mode
shows material consequences; developer mode exposes more exact implementation
facts. App-provided names, descriptions, purposes, and rationale remain
untrusted text. Presentation mode must never change permissions, enforcement,
or the consequences requiring consent. `appearance.ts` owns browser-local
appearance; a background-image cache is not app or Kernel durable memory.

Installed-app operational data is joined by exact app id and installation uid.
Usage displays an estimate of execution and outgoing cycle costs, not
billing-grade canister burn. Incoming cycles accepted through attributed app
routes are a separate measure and do not reduce that estimate. Generic canister
top-ups are not attributed app revenue. Preserve `bigint` normalization and
reject unsafe JavaScript numbers. Use `settings/model.ts`, the usage components,
and their shared cost helpers for formulas and formatting.

`settings/installed_package_record.ts` validates the fixed package-information
sidecar against its registry row before exposing legal/source actions. It loads
only the bounded record and referenced manifest for initial inspection. License,
notice, and source downloads are explicit actions that check exact lengths and
hashes before producing inert downloads. HTTPS source downloads omit ambient
credentials, reject redirects and transforming encodings, and use the shared
bounds. Archive-only embedded source is not an installed asset. Missing legacy
records and present invalid records are different states; neither proves a
license or publisher identity.

Certified install provenance records acquisition source and exact accepted
package bytes. It is not an endorsement, an update subscription, or proof of
publisher identity. Manual replacement clears stale repository provenance;
uninstall removes the affected record.

`settings/deployment_integrity.ts` and `deployment_build_record.ts` compare the
public canonical deployment record with the live certificate-verified
whole-canister module hash and the same-deployment runtime inventory. Preserve
separate absent, invalid, stale, inconsistent, matching, and mismatching states.
An app row does not have an independent IC module hash. See
[License And Deployment Records](./license-and-deployment-records.md).

Settings starts app deletion through `uninstall_apps()` in `reducer/apps.ts`.
It compiles the retained app set, checks dependency closure and memory effects,
requests one exact confirmation, and commits the result through the shared
checked installation path. Retained consumers block provider deletion;
selecting the provider and its consumers can remove them together. A successful
commit cleans up affected endpoints, residents, tiles, and grants. The Kernel
cannot be uninstalled through this action. Follow
[Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md).

`settings/AccessSettings.tsx` handles owner credentials and IC controllers as
separate authorities. The active principal cannot remove its own owner
authorization. The Neutron's own principal is the Self-Controller, used for
checked in-product upgrades and controller changes, and cannot remove itself
through Settings. Adding another controller requires explicit review of its
management-plane authority. Controllers can replace the complete actor and
remove other authorities; being a controller alone does not grant ordinary
Kernel owner authorization.

#### Independent controller management and Self-Controller recovery

An existing external controller provides a platform recovery path if the
installed Kernel cannot perform its checked upgrade or management operations.
Use the existing controller identity with platform tooling, inspect the full
controller list before and after changes, and preserve all intended entries.
Restoring a missing Self-Controller means adding the Neutron canister principal
back as a controller of that same canister.

Direct actor replacement bypasses Kernel schema, migration, dependency, and
data-loss checks. Recovery requires a reviewed state-compatible complete Wasm;
a clean reinstall is not a production upgrade path.

`settings/VetKeysSettings.tsx` loads lifecycle administration separately. Exact
slot managers can perform the transitions allowed by current slot state,
including cleanup after declaration removal. Audit projection must not contain
key or transport material. See [App-Isolated vetKeys](./app-isolated-vetkeys.md)
for manager, reader, generation, and retirement semantics.

### Registry Shape

`/system/apps.json` is a certified structural projection, not arbitrary manifest
JSON. `AppRegistryEntry`, `normalizeAppRegistry()`, and
`normalizeAppRegistryEntry()` in `packages/neutron-compiler/src/install.ts` own
the closed format-3 schema. Read those types for fields rather than maintaining
a second interface definition here.

Each row carries one canonical capability-plan wire and its fingerprint.
Normalization validates the plan, fingerprint, identity, and derived entries
against the structural row. It recomputes physical Candid names for exported
functions; internal functions and route-only paid handlers have their specified
exceptions. A paid handler opting into `public_ingress_cycles` must not acquire
an ordinary actor wrapper through a fabricated `candid_name`.

`getApps()` in `reducer/apps.ts` replaces the frontend registry only after
certified reads and committed-runtime reconciliation. Missing files, malformed
rows, unsupported formats, unknown fields, bad fingerprints, or mismatched
inventories are errors, not an empty registry. The Kernel row remains part of
package/compiler state but is not a launchable app tile.

### Authentication And Authorization Flow

One Neutron has one owner with potentially several equivalent authentication
credentials. Kernel authorization is not a multi-user workspace account model.
`reducer/auth.ts` owns reactive auth state plus separately generation-bound
bootstrap and dynamic actors. Changing identity invalidates older asynchronous
loads; an old actor must never publish into the replacement session.

Login uses the checked-in bootstrap IDL to call `kernel_check_authorized` before
requiring the combined app Candid. If the caller is unauthorized and bootstrap
captured a valid activation handoff, `reducer/activation.ts` consumes that
same-tab bearer once through `kernel_activation`. An uncertain response is
reconciled by checking authorization, not by replaying the bearer. The owner
must be confirmed authorized before the workspace or app frames mount.

`activation_handoff.ts` owns the closed fragment format, temporary storage, and
address-bar cleanup. Reserved query-string handoffs are erased and rejected.
Storage or cleanup failure cannot silently proceed with retained bearer data.
A same-document activation handoff reloads the cleaned URL into the normal
login path. Logout, identity replacement, and committed runtime replacement
clear the relevant actor caches and in-flight loads.

The dynamic actor is prepared lazily from the certified live Candid interface;
concurrent callers share one generation-bound preparation. Registry, package,
compiler, and provenance assets use certified HTTP. There is no fallback that
turns a failed asset response into an empty registry or reads a static body
through an actor query. Actor upgrades do not require globally recertifying
existing assets; checked installation certifies promoted package assets against
the state being committed.

`polling_update_agent.ts` and `self_call_transport.ts` preserve one signed
request identity per logical update and follow certified request-status polling
through the asynchronous IC endpoint. A transport retry may resend the same
envelope; it must not create a fresh mutation merely because the terminal
reply is delayed. Bootstrap, dynamic actor, raw self-call, and installation
updates share this transport contract. Queries and certified asset reads have
their own unchanged semantics.

### Repository Setup Workflow

`repository/RepositorySetupController.tsx` waits for authorization and the
verified registry before presenting a captured setup reference. The reference
is short-lived and same-tab; logout, identity replacement, dismissal, expiry,
and completion retire it. Bootstrap also captures later setup fragments.

Before the owner chooses **Load setup**, `RepositorySetupDialog.tsx` uses
`useRepositoryAccessApprovals()` to query certified public source-access pricing
anonymously. This preliminary lookup does not buy a grant or spend Neutron
cycles, but it does contact the source. Do not promise zero repository contact
before approval.

The load decision permits manifest/package retrieval and any disclosed source
access preparation. Public metadata is anonymous; private downloads may use an
access grant identifying the Neutron. Neither path promises anonymity from
network metadata or uniquely chosen manifest identifiers. The outer setup-page
URL is only a carrier for the pinned repository reference, not a fetched group
manifest.

`repository/service.ts` holds the shared app-operation mutex, verifies the
pinned manifest, and fetches every advertised package under the shared bounds.
Installed app state does not change that package request set. Selection and
missing dependency closure are resolved locally after retrieval. Present or
inconsistent apps are skipped; this setup path cannot replace installed apps
or the Kernel.

Final review freezes the selected verified packages and permissions, compiles
the target set, and requires exact owner approval. One checked journal and
atomic registry/provenance commit perform installation. Journal creation checks
the expected predecessor deployment so a concurrent tab cannot turn an
install-only selection into an update. Package/source prose remains separate
from Kernel-derived facts. See
[Repository Setup Manifests](./repository-setup-manifests.md) and
[App And Agent Install Offers](./app-install-offers.md).

### Isolated App Iframes

`app_frame_security.ts`, `workspace/AppTileFrame.tsx`,
`workspace/AppBackgroundFrames.tsx`, and `workspace/AppTray.tsx` own app frames.
Use URL helpers in `packages/neutron-tools/src/runtime.ts`; query parameters
are display context, never app identity or authority.

The packer marks adopted packages for installation-derived browser surface
origins. `browser_permissions` also requires that contract. The compiler records
adoption in the certified `/system/browser-surface-origins.json` sidecar.
Each installation nonce and declared surface key determines an isolated origin.
Different tile declarations, the tray, and background receive distinct origins;
instances of the same tile declaration share one installation origin. Normal
updates preserve the nonce; uninstall/reinstall changes installation scope.
Never special-case an app name or release version when constructing origins.

For supported ordinary frames, `prepareOrdinaryAppFrame()` verifies iframe and
initial Window credentialless support before selecting
`sandbox="allow-scripts allow-same-origin"`. HTTP policy binds the surface host
to the app asset subtree, restricts document/subresource admission, and permits
framing only by the Kernel. Originful message-port bootstrap checks the exact
registered source Window and origin.

Two compatibility paths remain: historical unadopted package URLs, and
script-only opaque framing when the browser does not prove credentialless
support. The latter also applies to newly packed apps. The iframe still has a
credentialless attribute, but an unsupported browser cannot be described as
guaranteeing that feature. The fallback removes `allow-same-origin` and browser
feature delegation; its opaque origin prevents Kernel-origin storage access.

Opaque framing has a separate message-bus limitation: after navigation inside
the same iframe, `markFrameEndpointLoaded()` can reconnect a replacement document
under the original app endpoint. Source Window plus `origin: null` does not
identify the original document. Exact-origin framing rejects the foreign
origin. Do not describe the opaque fallback as equivalent protection or as
already removed. Kernel-host app HTTP serving also remains compatible under
sandbox headers. New apps must adopt the replacements and avoid relying on
these paths; planned removals are tracked in [Deprecated](./deprecated.md).

`kernel_runtime_info` provides the installation scope, version, capability-plan
fingerprint, deployment identity, browser-origin authority, and resident mode
used for frontend authority. `reducer/apps.ts` accepts that projection only when
the installation journal is absent on both sides of the runtime read and the
committed registry agrees. A staged actor inventory must never become browser
authority before commit.

`appFrameEndpointAuthority()` and `appFrameAuthorityCurrent()` bind endpoint
liveness to the complete projection and frontend generation, not just app id or
version. A committed actor change or observed capability-authority revision
change fences old frames, sessions, pending requests, and delegated authority.
Installation failure after activation retains a recovery journal or uncertainty
fence. Closing a progress dialog must not revive predecessor authority.

`runtime_authority_signal.ts` uses a Kernel-origin channel, with a same-origin
storage-event fallback, to signal journal creation and commit across tabs.
`runtime_authority_monitor.ts` also observes canister state on focus,
visibility changes, and a coalesced interval, including while the tab is hidden.
Receivers fence authority before asynchronous reconciliation. Observation failure
remains closed until committed authority is proven again. External deployments
may require a full shell reload; do not assume replacing only app frames is
always sufficient.

Visited tile frames remain live when hidden. Residents mount independently of
workspace selection, but only from a committed installation binding. Dedicated
resident modes have stricter preflight and storage contracts than ordinary
frame fallback. Persistent residents first run the isolated-origin policy
cleanup document, validate its exact result, and then mount the resident.
Cleanup removes Service Worker registrations without erasing IndexedDB; it
cannot synchronously terminate every predecessor worker in another live
document. Read the complete constraints in
[Dedicated Resident Origins](./kernel-http-v2-and-certified-assets.md#dedicated-resident-origins).

`advanceResidentFrameReadiness()` in `workspace/AppBackgroundFrames.tsx` bounds
resident readiness: timeout allows the implemented recovery attempt and then
diagnostic blocking instead of an unbounded reload loop. A later valid
current-authority handshake may recover it. Use the source for deadline values
and retry behavior.

Tray pages exist only while their popover is open, receive a fresh endpoint
instance on each opening, and lose that endpoint on close. They do not inherit
a persistent background's storage authority. The trusted Kernel tray has no
app endpoint. See [App Tray](./app-tray.md) for the tray tool and badge contract.

### Kernel-App Request Boundary

`frame_context.ts` registers the trusted app context and transfers a private
`MessagePort` through the bootstrap handshake. Operational requests, replies,
progress, state events, tools, and binary sidecars use that port; there is no
operational Window-message fallback. Source/origin checks have the opaque-frame
limitation above. The app SDK derives the Kernel parent origin from its
canister-bound frame URL; referrer text cannot nominate a different parent.

`expose.ts` owns routing, declaration checks, caller provenance, session grants,
and Agent admission. Never expose compiler or deployment helpers directly as
app authority. Read tool descriptors and SDK types from source; the contracts
are documented in [Kernel-App Message Bus](./kernel-app-communication.md) and
[App Method Access And Call Consent](./app-method-access-and-call-consent.md).
New external-canister callers must use the v2 discovery and consent tools;
unversioned compatibility tools still exist and have weaker behavior described
in [Deprecated](./deprecated.md).

Browser feature delegation is default-deny. The closed `browser_permissions`
capability applies only to exact adopted tile ids and declared features. The
Kernel iframe policy and certified app document policy constrain the browser's
own media prompt. Trays, backgrounds, and opaque fallbacks receive no such
delegation. There is no Kernel media-stream proxy.

Same-app state events are bounded revision invalidations, not payload channels.
The Kernel derives the app namespace, forwards events only to other live
endpoints of that app, and retains the latest bounded topic invalidation for
reconnection. Consumers still fetch authoritative snapshots and reject stale
asynchronous results. Tray badge and dismiss actions remain private transport
helpers with exact background/tray role checks.

App-isolated vetKeys, browser Ethereum-provider sessions, and optional extension
transport each retain their own declaration, role, identity, and lifecycle
checks. They are not ambient powers of every endpoint. Follow
[App-Isolated vetKeys](./app-isolated-vetkeys.md) and the relevant SDK contracts;
do not copy a transient helper inventory or session bound into another caller.
Extension grants are browser-local and owner/installation-bound; in-flight
requests remain endpoint-session-bound and are cancelled on revocation or
endpoint removal. A missing extension disables the dependent feature rather
than preventing app installation.

### Request Approval Dialogs

`Requests.tsx` renders Kernel-owned requests from `useRequestStore()` and the
frontend permission store. The requesting surface comes from the registered
endpoint. Canister review retains the exact destination, escaped method name,
and arguments required by the selected consent contract; approving resolves
that request before dispatch. Cross-app tool grants are exact to their source,
target, tool, and applicable endpoint session. App text is never authoritative
review wording.

For a cross-app `provider_once` call outside Agent Mode, the provider instead
receives a one-use `presentUserInterface({ tileId, tool, arguments })` callback.
The Kernel opens or focuses the exact provider tile in the active workspace and
dispatches to a private `same_app` tool with the `foreground_tile` audience. The
provider owns its domain review and explicit accept/reject action. It must
freeze reviewed state and dispatch a value-moving operation only after
affirmative acceptance. Caller and audience are Kernel-attested, not accepted
from app arguments.

The selected tile must remain live until private dispatch. The audience is an
exact endpoint binding, not a continuous browser-focus gate. Reusable grants
cannot bypass the one-use interaction, and cancellation, replacement, replay,
or an incomplete handler fails closed.

`requestApproval(review)` still exists and shares the one-use decision capability
with provider presentation. New human provider flows should use their exact
provider tile instead of raw-JSON Kernel review. Do not remove the callback as
if it were wholly unused compatibility code: Agent-invocation decision paths
also use it. Follow the message-bus contract when changing either path.

`ui_attention/owner.ts` admits one Kernel-owned app attention request at a time,
without a hidden queue. Expiry and explicit app pausing are separate from
rejection; dismissing a prompt does not itself impose a cooldown. Provider
modals are app UI and do not become Kernel attention grants.

### Agent Mode Runtime

The Agent runtime owns session grants, root turns, invocation nodes, nested
permission decisions, cancellation, and redacted audit. Grants bind the owner,
installation, installed version, and exact declared resident entrypoint.
Runtime or endpoint replacement, logout, stop, or disable invalidates affected
authority. Root turns have no aggregate time or call-count cap; individual
operation, envelope, nesting, and simultaneous-child bounds still apply.

Private invocation metadata binds one endpoint session and dynamic call
lifetime. Each child gets fresh authority. Direct root calls can cross eligible
boundaries without an owner modal; descendant requests suspend for a scoped
root decision. Unscoped, stale, replayed, and late capabilities fail closed.
Enabling an entrypoint does not let a resident originate roots by itself: each
root begins through a live tile in that granted installation.

Human provider presentation is rejected from Agent invocations. Public
cross-app `provider_once` calls still support Agent work through
`requestApproval(review)`: the provider submits its exact review for a fresh,
one-use root Agent decision, including when a descendant initiated the call.
Existing grants cannot substitute for that decision.

A provider may additionally expose a private tool with the `agent_root`
audience, available only to the live depth-zero root. Ordinary calls and
descendants do not acquire that audience. This is a separate restricted path;
it does not replace every public Agent provider interaction. The provider
checks attested provenance and uses its own declared preapproved authority.

Nested `canister.call_dialog_v2` review must fit the ordinary message-bus
envelope before a decision or signature. The unversioned signed-call route
rejects Agent-scoped calls before discovery.

`workspace.inspect` and `workspace.control` require a live resident background
whose app declares `agent_entrypoints`. Direct resident use can occur without
Agent Mode; invocation-scoped use admits only the live depth-zero root.
`workspace.open_tile` remains available to ordinary live tile, tray, and
background callers through the bounded active-workspace open-or-focus path.
Neither path requires a hardcoded Agent app id. Trays cannot start Agent Mode
or receive delegated Agent tool calls.

Hidden started tiles keep their sessions, so workspace movement alone does not
cancel an Agent root. Endpoint closure or authority replacement does. The
trusted Agent indicator and Settings projection must never display private
capabilities, credentials, challenges, or raw call arguments.

### Exact Installed Artifact Inspection

`source_inspection/runtime.ts` and `InstalledArtifactInspector` in
`source_inspection/installed_artifacts.ts` implement `source.files`,
`source.search`, and `source.read`. `expose.ts` admits only a direct Agent root.
These tools inspect committed installed artifacts through authorized static-key
listing and certified HTTP; they do not reconstruct the workspace source tree.

Ordinary apps are limited to their asset subtree and verified backend import
closure. Kernel inspection uses a package-generated closed inventory instead
of treating every root static key as current Kernel code. Runtime additions
are a closed path set. The shared `/mo/` namespace is not assigned wholesale to
every app. See [Asset Storage And HTTP Serving](./asset-storage-and-http-serving.md).

The first listing returns a target-local source revision. Continuations,
searches, and reads carry that revision and opaque cursors. Async work rechecks
installation/deployment binding and integrity anchors; a concurrent deployment
cancels stale work. An unrelated later deployment can retain the same target
revision when its catalog is unchanged.

For ordinary static assets, the revision fences installation and path catalog,
not an atomic digest of every body. Reads and matches include hashes of the
exact observed bytes. An authorized direct static mutation outside checked
installation can change a body without changing the catalog revision; restart
traversal when comparing across such mutations.

Output is inert untrusted data. Bundled JavaScript, transformed Motoko, and
binary metadata must not be evaluated or treated as instructions. Strict UTF-8
and NUL checks decide text eligibility. Search completion measures traversal;
skipped or truncated content limits negative conclusions. Legacy static-key
listing can fail on extreme catalogs; failure must not silently become a
partial inventory or broader inspection scope.

### App Install Request And Progress Dialogs

`install_app()` in `reducer/apps.ts` drives File/URL installation through shared
compiler and checked-deployment primitives:

1. Acquire and retain exact package bytes under the source-specific download
   and decode limits. URL fetches omit ambient browser credentials/referrer,
   reject redirects, and require readable bounded responses. Private repository
   download grants use their separately approved access path.
2. Normalize the manifest, capability plan, memory lineage, and optional legal
   record. A missing historical record differs from a malformed present record.
   Build the immutable Kernel-fact disclosure from those exact bytes.
3. Reconcile the predecessor and compile the complete target actor. Seal the
   canonical deployment build record and deterministic transport bytes for
   review. Deployment is unavailable until compilation and owner approval.
4. Revalidate the exact package, predecessor, compiler, record, and transport
   before staging modules/assets and beginning the checked journal. Use the
   ordinary or management-chunked install transport selected by the shared
   compiler, without independently rebuilding or resigning uncertain mutations.
5. Verify the expected running actor, commit its registry/assets/provenance
   atomically, and re-read committed authority with no journal on either side.
   Only then replace frontend registry and app-instance stores.

Pending or uncertain activation stays fenced and recoverable through the
shared recovery path; clearing progress is not evidence of commit. Approved
bytes are not re-fetched. Manual URL acquisition is not publisher identity and
clears stale repository provenance on replacement. Deliberate manual Kernel
replacement remains supported under its existing warning and review, while
app offers and repository setup remain install-only.

For release and migration requirements, use
[App Package Updates](./package-updates.md),
[Memory Migrations And Uninstall](./memory-migrations-and-uninstall.md), and
[License And Deployment Records](./license-and-deployment-records.md).

### Settings App Update Checks

`updates/` owns ephemeral update discovery and preparation. Settings checks
configured sources after loading its snapshot and on refresh, grouping
requested app ids by source without sending installed versions or ambient
credentials. Registry changes and Settings teardown cancel stale work.

Single, selected, and all-app updates use the same candidate reconciliation,
combined compilation, exact package review, and checked commit. Successful
registry, source metadata, and provenance changes commit together; discovery
state and package bytes remain browser-ephemeral. Read current source transport,
certification, and publication requirements in
[App Package Updates](./package-updates.md). The jointly hidden certification
header compatibility exception still exists; its planned removal is tracked in
[Deprecated](./deprecated.md).

Install/update renderers and Settings consume shared machine facts, not
app-authored permission explanations. Package integrity does not establish
publisher trust. A vetKeys declaration describes future slot access; it does
not create a slot or bypass lifecycle consent by itself.

## Open Questions And Gaps

Use [Deprecated](./deprecated.md) for planned compatibility removals and
[Open Questions And Design Gaps](./open-questions-and-design-gaps.md) for
unresolved design boundaries. Do not use a historical test count or release
snapshot as evidence that a browser/runtime boundary is qualified.

For a change, locate the focused tests alongside the relevant source symbol
and the browser scenarios under `test/e2e/`. In particular, frame lifecycle
changes require evidence about origin checks, replacement documents, hidden
workspaces, and authority loss, not just a rendered iframe. Repository and
installation changes require cancellation, predecessor-race, and recovery
coverage. Verify current browser/gateway qualification through
[Certified HTTP And Certified Assets](./kernel-http-v2-and-certified-assets.md).
