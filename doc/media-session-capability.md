# Media session capability v1

Status: approved for implementation on 2026-08-21; runtime work in progress  
Target: a future Kernel release paired atomically with a higher Rendezvous release

## Decision

Neutron must not add `camera` or `microphone` to ordinary application tiles,
trays, or resident backgrounds. A declaring app may request one ephemeral media
surface only from a focused tile during a trusted user gesture. The Kernel
shows a native disclosure, creates a short-lived backend lease, then mounts a
new credentialless iframe on a per-session nonce origin. Only that iframe gets
the requested iframe `allow` features and a matching response policy.

The media app owns its `RTCPeerConnection`, signaling protocol, and meeting UI.
The Kernel owns authority, origin allocation, disclosure, launch, expiry,
revocation, and forced track teardown. A media session is not a background
permission and cannot survive shell reload, sign-out, app update, disable,
uninstall, or loss of focus without an explicitly visible active-call surface.

This design deliberately rejects three simpler approaches:

- widening every app response to `camera=(self), microphone=(self)`;
- adding `allow="camera; microphone"` to an ordinary opaque tile, where
  `getUserMedia` is unavailable and authority would be poorly scoped;
- opening an app-controlled top-level popup on the Kernel or installation
  origin, which would mix app media code with ambient shell credentials or
  durable browser storage.

## Manifest contract

`capabilities.media_sessions` is a closed, declared, API-1 capability:

```json
{
  "capabilities": {
    "media_sessions": {
      "api": 1,
      "entrypoint": "media.html",
      "features": ["camera", "microphone"],
      "max_duration_seconds": 7200
    }
  }
}
```

Rules:

- `entrypoint` is one packaged HTML asset and passes the same safe-relative-path
  validation as tile/background entrypoints;
- `features` contains one or both canonical values, sorted, without duplicates;
- `max_duration_seconds` is 300–14,400 and is an upper bound, not a promise;
- one installed app may declare one media entrypoint and hold at most one live
  media lease; the Kernel admits at most one live media surface globally in v1;
- declaration is disclosed at installation as “Camera and microphone during
  an explicit call” (or the exact feature subset);
- adding a feature or increasing duration is an escalation requiring install
  approval; removing a feature or lowering duration is narrowing;
- `media_sessions` is independent from, and cannot imply,
  `dedicated_resident_origin` or `persistent_browser_storage`.

Capability-catalog semantics:

- delivery: `frontend_endpoint`;
- grant: declaration plus per-session owner approval;
- disable: broker enforced;
- revocation: live recheck plus frame destruction;
- audit: bounded metadata-only open/approve/deny/start/close/expire/failure
  totals and last outcome; never SDP, ICE, peer addresses, device labels, media,
  meeting titles, or capabilities.

## Frontend endpoint

The injected API is intentionally small:

```ts
type MediaFeatureV1 = "camera" | "microphone";

type OpenMediaSessionV1 = {
  api: 1;
  request_id: string;       // canonical 128-bit lowercase hex, app-generated
  features: MediaFeatureV1[];
  purpose: string;          // inert UTF-8, 1–120 bytes, shown in Kernel dialog
};

type OpenMediaSessionResultV1 =
  | { status: "opened"; session_id: string }
  | { status: "denied" | "busy" | "unsupported"; message: string };

capabilities.media_sessions.open(input: OpenMediaSessionV1): Promise<OpenMediaSessionResultV1>;
capabilities.media_sessions.close({ api: 1, session_id: string }): Promise<void>;
```

`open` is accepted only when all of these are true:

1. the request arrives on the private MessagePort of the currently focused
   tile;
2. the call is synchronously attributable to a trusted click/keyboard gesture;
3. the live installed plan declares every requested feature and exact media
   entrypoint;
4. the app installation/version/generation and authority epoch are current;
5. no media surface is already active and runtime capacity is available;
6. the owner approves the Kernel-authored dialog naming the app and features.

The API never returns a camera stream, device ID, origin token, lease token, or
media-frame MessagePort to the ordinary tile. The media entrypoint gets a
separate source-bound endpoint with role `media`, app scope, session ID, current
generation, and a live-authority predicate. It may use only its own declared
same-app calls and capabilities.

## Lease and HTTP binding

The backend keeps a bounded single-slot media lease outside app-owned memory:

- app ID, installation UID, app version and capability-plan fingerprint;
- 128-bit Kernel-generated session ID and independent 128-bit origin nonce;
- requested feature bitset;
- created, activation-deadline, expiry, closed-at, and monotonic authority epoch;
- state: `pending | active | closed | expired`.

Begin and revoke are owner-authorized Kernel updates. Pending activation lasts
at most 120 seconds. Active duration is bounded by the manifest and 14,400
seconds. Reusing a request ID returns the same live outcome; it never creates a
second lease. Starting, closing, expiry, sign-out, capability disable, app
update, app uninstall, or deployment authority rotation increments/revokes the
epoch before a replacement can launch.

The media origin uses a DNS-safe prefix derived from the session origin nonce,
not the installation's resident nonce. Its HTML request must match all of:

- exact nonce Host under the verified canister gateway;
- exact `/app/<app>/<entrypoint>` path;
- exact closed query containing app, role=`media`, installation UID, session
  ID, feature set, and authority epoch;
- `Sec-Fetch-Dest: iframe` exactly once;
- live pending lease, current installation/plan, and unexpired activation
  deadline.

The successful HTML response is non-cacheable and contains:

- `Content-Security-Policy: sandbox allow-scripts allow-same-origin;` with
  `frame-ancestors` restricted to the verified Kernel origin;
- `Permissions-Policy` allowing only the leased features for `self` and denying
  geolocation and every undeclared sensitive feature;
- the existing no-sniff and no-referrer protections.

The parent iframe is `credentialless`, uses
`sandbox="allow-scripts allow-same-origin"`, and sets `allow` to exactly the
leased feature subset with each feature delegated to the exact nonce origin
(iframe `'self'` would name the Kernel parent). The nonce origin differs from the Kernel, tiles,
residents, and every prior media session. It cannot access shell credentials or
another session's storage. HTML top-level, object, embed, frame, missing Fetch
Metadata, stale epoch, wrong Host, wrong app, wrong path, duplicate query, and
expired requests fail closed. Subresources require the same live Host/session
binding; service workers and shared workers are denied in v1.

The trusted Kernel shell response permits camera and microphone delegation so
the browser does not intersect the child policy with an absolute parent denial.
That is only the first gate: the exact-origin iframe `allow` attribute is the
second gate. Ordinary application frames have no device `allow` attribute and
their own responses continue to deny camera and microphone.

## Teardown and revocation

The Kernel media surface always owns a synchronous local teardown routine:

1. tell the media frame to stop every local/remote track and close its peer
   connection;
2. remove the iframe even if the frame is unresponsive;
3. close and unregister its MessagePort;
4. revoke the backend lease and rotate the authority epoch;
5. clear app-local bounded signaling state through the app protocol, where
   delivery is retryable and expiry remains authoritative.

Steps 1–3 happen immediately on Hang up, owner denial, timeout, sign-out, app
disable/update/uninstall, deployment replacement, and browser page teardown.
Backend revocation is reconciled after a lost reply with the same request ID.
No permission is described as revoked merely because a browser-level origin
permission remains in browser settings; the unique origin is never reused.

## Rendezvous signaling boundary

Rendezvous adds a versioned `rendezvous_signal_v1` paid public-ingress route
only after this capability passes its security gate. Signaling records are
separate from negotiation v1 memory and contain only:

- confirmed negotiation ID and exact two peer principals;
- random session capability bound to both peers;
- monotonically increasing sender sequence;
- kind `offer | answer | ice | hangup` and a bounded opaque body;
- created/expiry timestamps and an idempotency command ID.

Bounds: one live call per confirmed negotiation, 64 records per side, 16 KiB
per SDP body, 2 KiB per ICE body, 256 KiB total live signaling bytes, and a
two-hour maximum expiry. The receiver validates confirmation, peer, capability,
sequence, size, expiry, and dedupe before mutation. It pushes through paid
ingress; there is no central signaling server. The app may locally fetch only
its own signaling revision. Media is end-to-end encrypted by WebRTC transport,
but peer IP addresses may be disclosed by ICE and TURN relays can observe
metadata; the UI must say whether the selected pair is direct, STUN-assisted,
or TURN-relayed.

## Threat model

| Threat | Required control |
| --- | --- |
| App silently starts capture | Focused tile, trusted gesture, Kernel dialog, browser prompt |
| Ordinary tile gains media | No tile `allow`; opaque sandbox; denying response policy; regression test |
| Leaked media URL is embedded elsewhere | Live one-shot lease, exact nonce Host/query/destination, Kernel-only frame ancestor |
| Session origin reads Kernel credentials | Per-session cross-origin nonce host plus credentialless partition |
| Old frame survives revoke/update | Generation/epoch live recheck, port close, forced iframe removal, backend lease revoke |
| App requests undeclared feature | Closed manifest subset and runtime intersection; fail closed |
| Hidden/background capture | Kernel-owned always-visible call surface and active indicator; one global session |
| Media/frame data enters audit | Metadata-only fixed outcome counters; hostile-title and SDP sentinels |
| Peer injects/replays signaling | Confirmed-peer/capability binding, sequence, expiry, bounds, dedupe |
| ICE exposes network address | Plain-language disclosure; mDNS where provided; optional TURN policy |
| TURN is falsely called peer-to-peer | UI labels relayed transport and documents relay observability |
| Browser lacks credentialless/media support | Preflight before app HTML; return `unsupported`; never downgrade sandbox |
| Cleanup update is lost | Immediate local teardown plus idempotent backend reconciliation and expiry |

## Current implementation map

Verified against the 2026-08-21 worktree. This is the concrete change surface.
The project owner approved the Kernel-brokered ephemeral nonce-origin media
iframe architecture on 2026-08-21. That approval covers the bounded core
changes described here; it does not authorize ambient tile media access or a
weaker fallback.

- Manifest parsing and the closed capability catalog live in
  `packages/neutron-tools/src/schema.ts` and
  `packages/neutron-tools/src/capabilities/catalog.ts`. Add the normalized
  media declaration there, including safe-relative entrypoint validation,
  canonical feature ordering, duration bounds, and JSON-schema fixtures.
- Capability projection, fingerprints, and runtime wire parsing live in
  `packages/neutron-tools/src/capabilities/plan.ts`, `wire.ts`, and `runtime.ts`.
  `media_sessions` must participate in the plan fingerprint; it must never be
  inferred from tile, background, resident-origin, or storage declarations.
- Package preparation and deployment consistency checks live in
  `packages/neutron-compiler/src/install.ts` and `compile.ts`. Capability
  escalation/narrowing disclosure belongs beside the existing consent flow in
  `apps/kernel/src/consent/CapabilityChangeSummary.tsx` and
  `PermissionConsequences.tsx`.
- Ordinary tiles are intentionally opaque, credentialless frames without an
  `allow` attribute in `apps/kernel/src/workspace/AppTileFrame.tsx`; preserve
  that invariant. The dedicated-origin precedent and browser preflight are in
  `AppBackgroundFrames.tsx`, but media needs a separate Kernel-owned overlay
  and must not reuse resident authority or storage semantics.
- Add `media` as a distinct source-bound frame role in
  `apps/kernel/src/frame_context.ts`, with session ID, generation, scope,
  exact nonce origin, and live lease predicate in its endpoint registration.
  The owner-gesture broker and its two small frontend tools belong in
  `apps/kernel/src/expose.ts`; the media overlay owns frame removal and track-
  stop teardown even when the child is unresponsive.
- The released stable layout is `apps/kernel/backend/memory/kernel/v3.mo` and
  must remain unchanged. Add the next schema plus a bounded migration and a
  separate media-lease service/memory module. Wire owner-only begin/revoke and
  expiry reconciliation through `apps/kernel/backend/main.mo`.
- Existing app responses are deliberately emitted with
  `Permissions-Policy: camera=(), geolocation=(), microphone=()` in
  `apps/kernel/backend/main.mo` and `certified_http_v2.mo`. Keep those variants
  unchanged and add destination-aware, nonce-host-bound media HTML/subresource
  variants instead. The dedicated resident Host/query/`Sec-Fetch-Dest`
  validation in `main.mo` is a structural precedent, not reusable authority.
- Extend `packages/neutron-tools/test/capabilities.test.ts`, compiler install/
  capability tests, Kernel frame-origin/consent/runtime tests, Motoko HTTP and
  memory-schema fixtures, and installed Playwright coverage. A release is not
  evidence until the negative ordinary-tile tests and positive fake-media
  frame tests pass against the same packaged Kernel artifact.

## Required implementation order and tests

1. Add the closed catalog/schema/plan/wire entry, install disclosure, capability
   diff semantics, composition checks, and malformed/unknown-field fixtures.
2. Add a new Kernel memory schema and bounded migration for media leases; never
   edit released v3 memory in place.
3. Add begin/activate/revoke/expire service methods, runtime registry binding,
   app-update/uninstall/sign-out cleanup, and metadata-only audit.
4. Add the media URL constructor/parser, nonce-origin policy, destination-aware
   certified HTTP variants, exact response headers, and stale-authority denial.
5. Add the focused-gesture broker, Kernel disclosure, media overlay, frame
   preflight/registration, active indicator, timeout, and forced teardown.
6. Pass unit/adversarial fixtures for unknown fields, escalation/narrowing,
   wrong app/version/plan/host/path/query/destination, replay, duplicate open,
   expiry, disable, update, uninstall, sign-out, frame crash, and lost revoke.
7. Pass installed Chromium tests proving ordinary tiles remain denied; approved
   fake camera/microphone tracks exist only in the media frame; denial and close
   stop every track; reload invalidates the old surface; a second session gets
   a different origin; no sensitive sentinel appears in logs/settings/audit.
8. Only then add Rendezvous signaling, perfect negotiation, trickle ICE,
   controls, direct/relayed status, and two-browser fake-media tests.

No Rendezvous Join button ships until steps 1–7 pass against the exact Kernel
release candidate and step 8 passes against the paired app artifacts.
