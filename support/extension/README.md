# Neutron Browser Bridge

An optional Chrome Manifest V3 extension for direct browser HTTP requests. It
connects to the Neutron Kernel; the Kernel authorizes individual apps. Ordinary
Neutron features continue working without this extension.

The extension is a generic network route. It contains no OpenAI integration,
model configuration, app allowlist, API credentials, or canister HTTP proxy.

## Install for development

From the repository root:

```sh
npm --workspace neutron-extension run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select `support/extension/dist`. Reload a Neutron page that was already open.
Chrome 116 or newer is required. The initial Chrome installation grants HTTP and
HTTPS host access; destinations do not produce repeated Chrome prompts.

In Neutron, connect the browser extension in Settings or open a feature that uses
it. The extension shows the exact Neutron origin in its own confirmation window.
Accept once. This pairing remains in this browser profile across page refreshes,
browser restarts, and service-worker suspension, with no expiration. Neutron's
Settings manages persistent per-app route grants. The extension's own Settings
can revoke the entire Neutron connection. Revocation cancels its active requests.

The built directory is ready to load unpacked; this repository does not claim a
Chrome Web Store listing or publish the extension automatically. Removing the
extension or its browser-profile storage removes its saved pairings.

To make a downloadable archive, run:

```sh
npm --workspace neutron-extension run package
```

This creates `support/extension/neutron-extension.v0.1.0.zip` and a SHA-256
sidecar. Extract the ZIP and select the folder containing `manifest.json` when
loading unpacked. The archive includes its exact corresponding source, license,
build scripts, root configuration and lockfile in `source/`, together with a
SHA-256 inventory and standalone build instructions. With Bun installed, the
included source builds without downloading source or dependencies:

```sh
cd source/support/extension
bun scripts/build.ts
```

## Architecture

```text
App → Kernel → top-level content-script bridge → extension service worker
                                                     ↓
                                   offscreen document + network worker
                                                     ↓
                                              HTTP(S) service
```

The content script accepts a connection only from its own top-level window.
Chrome supplies the top-level sender's origin to the service worker, which
checks the persistent pairing before routing. App frames cannot connect directly
or select an origin in their request. The Kernel binds each app's requests to its
verified endpoint and app permission; the extension trusts the paired Kernel.
Custom Neutron domains and local development origins use the same mechanism.
Discovery does not depend on a fixed extension ID.

Fetches run in a dedicated worker created by an offscreen extension document
using Chrome's `WORKERS` reason. This avoids the extension service worker's
deadline for fetching response headers. Active requests send local keepalive
messages to keep the routing service worker available. There is no request
timeout, grant timeout, concurrency quota, or total transfer-size cap. Streaming
uses pull-based reads; each reply frames at most 256 KiB of response bytes so
large responses do not exceed Chrome or Kernel message envelopes. Uploads use
the same framing. Browser implementation limits still apply.

Native HTTP status codes, headers, redirects and response bytes are forwarded.
Requests use `credentials: "omit"`: authorization belongs in the request rather
than inheriting the user's website cookies. Normal Fetch restrictions on HTTP
methods and forbidden headers still apply. This route does not make a remote
service accept unsupported authentication or bypass its server-side policies.

Closing a Neutron page, revoking its pairing, cancelling a request, or losing the
extension connection aborts related network work. Interrupted requests are never
replayed automatically, because the remote server may already have processed
them. The Kernel can rediscover the extension for a later request without
repeating approval. Extensions cannot guarantee that aborting a request undoes
its remote side effects.

## Browser bridge protocol v1

The top-level Kernel creates a `MessageChannel` and transfers one port:

```js
window.postMessage(
  { channel: "neutron.extension.v1", type: "connect" },
  location.origin,
  [channel.port2],
);
```

The extension replies `{ type: "ready", version: 1, extensionVersion: "0.1.0" }`.
RPC messages have a caller-chosen `id` and `op`. Replies are
`{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }`.

| Operation | Additional fields | Result |
| --- | --- | --- |
| `status` | — | `{ version, extensionVersion, origin, paired }` |
| `pair` | — | Status after approval; immediately returns if already paired |
| `revoke` | — | Status after revocation |
| `upload` | `requestId`, `chunkBase64` | `{}`; stages body bytes |
| `fetch` | `requestId`, `request` | `{ requestId, status, statusText, headers, url, type, redirected }` |
| `read` | `requestId` | `{ done: false, chunkBase64 }` or `{ done: true }` |
| `cancel` | `requestId` | `{}`; also cancels uploads and pending headers |

`request` is `{ url, method?, headers?: [string, string][], bodyBase64?,
hasBody?: boolean, redirect?: "follow" | "error" | "manual" }`. Uploaded body
chunks and `bodyBase64` are alternatives. `hasBody: true` preserves an explicitly
empty request body. A stream ID belongs to its own bridge connection; another
connection cannot read or cancel it. Each stream has one pending read at a time.
Manual redirects retain the browser's opaque redirect response metadata
(`status: 0`, `type: "opaqueredirect"`) and empty body.

The extension also sends `keepalive`, `revoked`, and `disconnected` events. The
last includes `{ error: { code, message } }`; callers must reject pending work
instead of waiting indefinitely. The Kernel owns its short discovery timeout
when the extension is not installed. This is not a request or permission expiry.
To close a bridge, send `{ type: "disconnect" }` before closing the page port.

## Verification

```sh
npm --workspace neutron-extension run check
```

Unit tests cover browser-attested origins, request validation, binary framing,
uploads, empty bodies, cancellation and read sequencing. The actual Chromium
qualification loads the packaged extension, demonstrates a browser CORS failure
and successful routed request, accepts the real pairing UI, streams and cancels
requests, rejects iframe access, persists pairing through a browser restart,
revokes access in Settings, and receives headers delayed beyond 30 seconds.
Browser profiles and temporary fixtures are created outside the repository.

Official Chrome contracts: [cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
[content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
[offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
and [service-worker lifetime](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
