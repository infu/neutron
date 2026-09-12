# App Tray

[Back to the documentation index](./index.md)

An app tray is one Kernel-rendered navigation button containing an app-provided,
untrusted manifest icon. It opens a Kernel-owned popover containing a transient
app page. The app's ordinary resident background process owns long-lived state
and may update the Kernel-rendered numeric badge.

The shell's trusted Kernel tray item is a separate implementation. It has no
app manifest declaration, iframe, registered endpoint, or app badge API.
Installed apps cannot control that item or its shell actions. App-provided
labels and icons remain untrusted; Kernel rendering does not endorse them.

## Manifest Contract

Declare one top-level `tray` object next to the required `background`:

```json
{
  "background": {
    "path": "service.html",
    "description": "Resident mailbox service"
  },
  "tray": {
    "title": "Mailbox",
    "path": "tray.html",
    "icon": "static/mailbox-tray.svg"
  }
}
```

`tray` is a singular closed object; unknown fields are rejected. Its fields are:

- `title`: required safe app-provided label;
- `path`: required safe relative HTML path under `dist/web/`;
- `icon`: required safe relative image path under `dist/web/`.

Asset paths use only ASCII letters, digits, `_`, `.`, `/`, and `-`. Absolute
paths, backslashes, empty segments, `.` and `..` are rejected. The package must
contain `web/<path>` and `web/<icon>`; packaging verifies file presence, not
HTML or image content. A tray cannot be declared without an ordinary
`background` declaration. Use the manifest schema and `normalizeManifestTray`
in `packages/neutron-tools/src/schema.ts` for the current field bounds.

Declaring a tray adds no install or runtime permission. It does not imply
either dedicated background-origin capability; if the background independently
requests credentialless-ephemeral or persistent dedicated mode, that
background-origin install disclosure still applies. In a current marked app
package the tray receives its own installation origin when credentialless
framing is supported; historical packages and unsupported browsers use the
opaque compatibility path described below. See
[Installation-Owned Ordinary App Origins](./kernel-http-v2-and-certified-assets.md#installation-owned-ordinary-app-origins).

## Background-Owned Badge

Only the exact registered background endpoint for the currently installed app
version may change its own badge:

```ts
import { setTrayState } from "neutron-tools/app";

await setTrayState({ badge: 4 });
await setTrayState({ badge: 0 }); // clear; null also clears
```

`setTrayState()` accepts exactly the one-key object `{ badge }`; callers cannot
name an app or add decoration fields. `badge` must be a nonnegative safe integer
within `MAX_TRAY_BADGE` in `apps/kernel/src/tray/service.ts`, or `null`.
The Kernel derives the app id from the source-bound endpoint and rejects stale
backgrounds or apps without the matching resident and tray declarations.

Badge changes have no time-window gate. Residents should still coalesce noisy
updates because only the latest bounded number is useful and every message
consumes browser work. Source binding, schema bounds, endpoint liveness, and
installed-version checks remain authoritative.

Large values are visually abbreviated while the button's accessible label
retains the exact count. Zero and `null` hide the badge but do not remove the
tray button. If the manifest image
fails to load, the kernel renders its generic notification glyph. The kernel
orders tray buttons by app id. Apps cannot use a badge call to change the icon,
title, order, color, animation, sound, or popover geometry.

A badge update is state only. It never opens the popover, focuses UI, raises a
notification, plays a sound, or moves the icon. Badge state is an in-memory
kernel hint, not app data. Install/update and uninstall processing clear the
affected app's state. Registry reconciliation retains it only while the app
version, background path/storage, and tray title/path/icon still match. Identity
activation, logout, and shell reload clear all badge state. The resident must
therefore publish its initial badge whenever it starts.

## Popover And Endpoint Lifecycle

The Kernel owns the navigation button, badge, popover chrome, close control,
placement, and native popover behavior. Geometry adapts to navigation layout
and available viewport space. Tray pages must handle narrow or vertically
constrained frames and provide their own internal scrolling; do not depend on
fixed shell pixel dimensions.

The button identifies the app and exact unread count to assistive technology,
advertises a dialog, and reflects expanded state. The popover header shows the
tray title once, then any app id or installed app name that is meaningfully
different from that title. Its close button receives initial focus; native
popover behavior supplies light-dismiss and returns focus to the invoking
control.

Use the [Neutron Design System](./design-system.md) inside the app frame; those
styles do not cross into kernel-owned chrome.

The app page is mounted only while its popover is open. Every opening creates a
fresh source-bound endpoint:

```text
app:<appId>:tray:instance:<instanceId>
```

Closing the popover unregisters the endpoint and destroys the iframe. Keep
durable or continuously changing state in the resident background or backend,
not in the tray page. Fetch a fresh snapshot when the page mounts.

For a current marked app package in a browser that proves credentialless
framing support, the tray frame uses:

```html
<iframe sandbox="allow-scripts allow-same-origin" credentialless="true"></iframe>
```

Its hostname is derived generically from the installation's browser-origin
nonce and the `tray` surface key, independently of the app's name or version.
The backend binds that hostname to only the app's asset subtree, permits it to
be framed only by the Kernel, and rejects top-level document navigation. The
Kernel binds the private `MessagePort` handshake to both this exact origin and
the registered `contentWindow`.

An unadopted historical package keeps its released URL with
`sandbox="allow-scripts"` and an opaque origin. A browser that cannot prove
credentialless originful framing also falls back to that script-only sandbox
and receives no browser-feature delegation. The iframe requests credentialless
mode in both cases, but an unsupported browser cannot guarantee that property.
The opaque sandbox still prevents origin-backed storage access; neither path
inherits a storage-enabled background's origin or persistent storage authority.

Opaque framing does not provide the exact-origin handshake guarantee above:
an unrelated document reached by navigating the existing iframe can receive a
new message port under that app endpoint. The compatibility path is planned
for removal; new apps must use installation-owned surface origins. See
[Deprecated Compatibility Paths](./deprecated.md#opaque-app-frame-compatibility).
App code cannot style or replace the trusted toolbar button and popover chrome.

A tray page may close its own currently open popover without gaining shell
control. The host always supplies an explicit close button and light-dismiss.
Because the parent cannot observe keyboard events while the cross-origin iframe
owns focus, the tray page should handle Escape itself:

```ts
import { dismissTray } from "neutron-tools/app";

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void dismissTray();
});
```

Opening or focusing a tile does not implicitly close the tray. After a
successful `openAppTile()` call, call `dismissTray()` as a separate step if that
is the intended interaction.

## Synchronizing App State

The badge is not a data channel. Keep the authoritative model in the resident
background or backend, expose snapshot/mutation tools there, and use revision
events only as invalidations:

```ts
import {
  onAppStateChange,
  publishAppStateChange,
  setTrayState,
} from "neutron-tools/app";

// Resident, after committing the authoritative mutation.
await setTrayState({ badge: unread });
await publishAppStateChange("mailbox", revision);

// Tray, after fetching an initial snapshot on every mount.
const unsubscribe = onAppStateChange("mailbox", ({ revision }) => {
  void refreshFromResident(revision);
});
```

Any registered endpoint of the app may publish a bounded revision event, but
the resident or backend should remain authoritative. The kernel derives the app
namespace, sends no application payload, and forwards the event only to the
other live endpoints of that app. Subscribers must compare revisions, reject
stale asynchronous results, and re-fetch after initial mount or reconnection;
polling may be retained as recovery.

## Communication And Privileges

The tray page uses the normal kernel-regulated message bus. Calling its own
background is a same-app call and needs no permission:

```ts
import { callTool } from "neutron-tools/app";

const snapshot = await callTool({
  target: "app:mailbox:background",
  name: "mailbox_snapshot",
  arguments: {},
});
```

While open, a tray may also use `exposeTool()`. Generic `endpoints.list` reports
its exact live instance, and ordinary direct same-app callers may list or call
its tools without approval. Ordinary direct cross-app discovery and calls
retain normal one-call or session approval. A cross-app `provider_once` call
may ask the provider to open its exact decision tile; the tray receives no
effect authority, and the provider's private `foreground_tile` decision tool
runs only in that exact provider tile, never its tray. A tray cannot receive an
Agent invocation. All admitted routes preserve the tray instance as caller
provenance. Grants and pending requests are
endpoint/session-bound; closing or reopening the tray prevents reuse. A
transient tray is therefore not a durable integration target.

Exact methods declared in `capabilities.preapproved_self_calls.methods` remain
available through `querySelf()` and `updateSelf()`. A tray may also use the
confirmed `callCanisterDialog()` route. Neither is granted merely by declaring
a tray. Endpoint ids and roles are kernel-attested; query parameters are
display context only.

| Capability | Tray behavior |
| --- | --- |
| Set the kernel badge | No. Only the exact current background may call `setTrayState()`. |
| Dismiss UI | May call `dismissTray()` only for its own current live instance. |
| Same-app tools and revision events | May expose, list, call, publish, and subscribe while open. Same-app routing needs no consent. |
| Cross-app tools | Uses the normal one-call or session approval policy. A `provider_once` target may open its provider-owned decision UI from a live tray without a preliminary Kernel grant; the source gains no effect authority, and the exact provider tile owns the decision. |
| Preapproved or confirmed self calls | Available under the same manifest and owner-consent rules as other app endpoints. |
| Open a tile | A live direct tray may open or reuse any installed app tile without a Kernel dialog. Navigation stays in the active workspace and always reuses an exact existing app/tile before opening one; callers cannot force a duplicate or switch workspace. The broader `workspace.inspect` / `workspace.control` surface is resident-agent-only and does not expand tray authority. |
| Backend reservations | May read its app's reservation list when `backend_calls` is declared, but cannot request, add, or remove reservations. |
| Connections and raw resident credentials | Unavailable; these actions are exact-background-only. |
| Clipboard and browser Ethereum provider | Unavailable; these are focused, transiently activated tile operations. |
| Camera and microphone | Unavailable. `browser_permissions` delegates these features only to exact declared tile ids. |
| Agent Mode | Cannot enable or initiate a turn and cannot receive delegated calls. Same-app status inspection and disabling remain available. Delegated app-tool discovery omits trays entirely. |
| Persistent browser storage | No persistent storage authority. Supported originful frames use credentialless storage; the compatibility sandbox has an opaque origin. Neither inherits a persistent background's authority. |

Private `tray.set_state` and `tray.dismiss` actions are transport helpers, not
discoverable kernel tools. Delegated invocations cannot inspect tool schemas on
or call a tray endpoint, although generic endpoint inventories may show that the
transient surface is present. Put durable and agent-capable work behind tools on
the app's resident background, and open a normal tile when the user needs a
tile-only flow.

## Source Map

- `packages/neutron-tools/src/schema.ts`: manifest schema and
  `normalizeManifestTray`.
- `packages/neutron-tools/src/app.ts`: `setTrayState`, `dismissTray`, and app
  revision-event helpers.
- `apps/kernel/src/tray/service.ts`: badge validation, registry reconciliation,
  and source-bound dismissal.
- `apps/kernel/src/workspace/AppTray.tsx` and
  `apps/kernel/src/workspace/TrayPopover.tsx`: frame lifetime, accessible shell
  presentation, and positioning.
- `apps/kernel/src/app_frame_security.ts` and `apps/kernel/src/frame_context.ts`:
  frame policy and endpoint handshake; `apps/kernel/src/expose.ts` enforces tool
  admission.

See [App Package Format](./app-package-format.md),
[Kernel-App Message Bus](./kernel-app-communication.md), and
[Security Model](./security-model.md) for the surrounding contracts.
