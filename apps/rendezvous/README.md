# Rendezvous

Rendezvous negotiates meeting starts between two independently owned Neutron canisters without a central scheduling service. Each side installs Calendar and Rendezvous; only candidate timestamps, duration, a bounded meeting label, protocol IDs and state cross the wire. Calendar event titles, notes and busy intervals never do.

## Protocol and safety

`rendezvous_v1:exchange` is a synchronous, canister-caller-only public ingress route. Every negotiation uses 128-bit negotiation/capability/command IDs and becomes bound to the first peer principal. Requests are capped at 16 KiB and deduplicated with bounded receipts. The receiver performs no outbound call. Outbound requests persist their exact Candid bytes before `await`; failures distinguish rejected, retryable and uncertain (the peer may have committed).

Confirmation is hold-first: the accepting side reserves locally, sends accept intent, the peer reserves and confirms, then the sender confirms. Conflict closes safely. Cancel releases the local hold. V1 admits at most 64 negotiations, 16 ordered candidate starts per negotiation and 128 receipts; active negotiations are never silently evicted.

The attached cycle floor is 250,000,000 per exchange. It is identical in the public route, backend call constant and per-call declaration. The 60,000,000,000 daily ceiling permits at most 240 full-floor sends/day. Cycles prove canister-mediated delivery, not identity or endorsement.

The backend depends on Calendar 0.2.0's four privacy-preserving internal
functions and Contacts 0.3.1's bounded v2 lookup/search/revision API. A person
can be selected by local Contact name; immediately before creating an offer,
Rendezvous re-resolves the exact contact ID, contact revision, book revision,
and Neutron principal so a stale edit cannot silently redirect the proposal.
Contact names and notes never enter the peer protocol. Backend-call consent uses a method reservation for
`app_rendezvous__rendezvous_v1_update`; the owner still selects the peer
principal. The browser UI requires no agent app, and raw `RVC1`/principal input
remains an explicit fallback.

Incoming and outgoing negotiation cards resolve the authenticated peer Neutron
principal against the owner's local Contacts book. When it matches, the card
shows the local Contact name and the full principal beneath it; otherwise it
shows the full principal as the identity fallback. Display names are never
accepted from the sender, so a peer cannot choose a trusted-looking name for
itself, and local Contact names are never transmitted.

The proposal composer asks for peer, meeting details, date range, and preferred
weekdays/hours, then shows deterministic local suggestions. Nothing is sent
until the owner explicitly selects 1–16 options. An exact date/time can also be
added after Calendar validates it locally. The recipient's options are
revalidated and labeled `Available` or `No longer available`; a stale option
cannot be accepted. A recipient may counter with one exact, locally validated
alternative, which the organizer must explicitly accept or decline.

The resident maintains an aggregate actionable badge. Its tray shows only
actionable/total counts and a `Review requests` action that opens Rendezvous;
meeting titles, times, candidates, and peer identifiers are not projected into
the tray surface.

Calendar can open Rendezvous with a fresh selected time range. Rendezvous shows
the imported range, preloads it as an exact option, and leaves the peer and
final proposal under the owner's explicit control. The handoff contains no
Calendar title, notes, location, or existing event identifier.
Confirmed Calendar meeting entries can also reopen and highlight their matching
local negotiation by exact start/end time; no capability is placed in the tile
view.

## Browser meeting experiment

A confirmed pair can explicitly open a Kernel-owned media surface. The Kernel
asks for consent, leases a one-time nonce origin, and delegates camera and
microphone only to that exact iframe. Rendezvous then exchanges bounded SDP and
trickle-ICE messages through the two owners' Neutrons. Signal IDs are
deduplicated, queues are bounded, records expire after ten minutes, and an
explicit Leave physically removes that meeting's queued signals and receipts.

The current `RTCPeerConnection` has no STUN or TURN servers configured. It can
connect directly when host ICE candidates are mutually reachable (including
the local two-browser test), but it is not a general Internet-NAT solution and
has no relay fallback. WebRTC encrypts media on the browser-to-browser path;
the Neutron canisters carry signaling, not audio/video packets. Each canister
can observe the bounded SDP/ICE signaling it stores, and ICE candidates may
disclose network-address metadata to the peer. A future TURN option must be
owner-configured and disclosed because the relay would observe connection
metadata even though the relayed media remains encrypted.

## Build and demo

```sh
npm --workspace neutron-calendar test
npm --workspace neutron-rendezvous test
npm run provision -- rendezvous-local.ndeploy.json serve
npm run provision -- rendezvous-local.ndeploy.json reinstall
npm run provision -- rendezvous-local.ndeploy.json status
```

Open the Alice and Bob URLs reported by status. Add different private Calendar
events, add Bob's Neutron address to Alice's Contacts, choose Bob by name in Rendezvous, choose proposed times,
accept or counter on Bob, and show the confirmed meeting in both Calendars. See
[`DEMO.md`](../../DEMO.md) for the two-minute script and threat-model talking
points. `npm run test:e2e:rendezvous:fresh` performs the same workflow against a
fresh two-node local-II fleet.

## Limitations

The primary UI selects a locally stored Contact whose exact Neutron address and
revision are revalidated before send. The reusable canonical `RVC1` sharing
address contains only the peer Neutron principal and remains a fallback; it is
not a credential. Raw principals stay under Advanced. Per-negotiation `rv1`
capabilities remain random, private, caller-bound protocol material. Candidate
options are an equal ordered set, not preference
ranking, and counters currently contain one exact alternative; richer counters
require a protocol revision. Calendar recurrence is local; Rendezvous does not
yet negotiate a repeating meeting series. There is no external calendar sync,
email notification, or human-identity claim. Delivery recovery is owner-triggered
safe retry. Browser meetings are currently a direct-connect experiment: no
STUN/TURN, reconnect flow, device picker, or multi-party support is included.
