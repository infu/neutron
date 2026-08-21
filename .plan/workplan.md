# Rendezvous — LLM implementation workplan

Status: active product reset (2026-08-21)  
Target: Neutron format-3 apps, Calendar 0.2.0 (manifest 200) and Rendezvous 0.2.1 (manifest 201)  
Deliverables: contacts.v0.3.1.neutron dependency, calendar.v0.2.0.neutron, and rendezvous.v0.2.1.neutron  
Upstream platform: https://github.com/infu/neutron

## 0. Product reset: from protocol demo to useful calendar

This section supersedes any narrower v1 scope or non-goal below it. The shipped
0.1.0 candidate proved Neutron-to-Neutron transport, but it is not a
submission-quality product: Calendar is a flat agenda, events cannot repeat,
availability is hard to edit, and Rendezvous chooses three hard-coded weekday
times instead of letting the user compose a proposal. Version 0.2.0 must be
judged as a calendar people could actually use, with private scheduling as its
distinctive Neutron-native capability.

The v1 protocol/security sections remain binding unless this reset explicitly
changes them. Never weaken caller binding, bounded wire formats, exact retry,
pre-await journaling, uncertainty, Calendar revalidation, or data minimization
to accelerate the UI.

### 0.1 Product promise

> A real private calendar that can negotiate a meeting directly with another
> person's calendar. You choose the times; neither side uploads a calendar to a
> scheduling service.

The primary demo must feel familiar before it feels novel:

1. Open Calendar into a real week view.
2. Click or drag to create a one-off or recurring busy event.
3. Navigate month/week/day/list, edit by clicking, and move/resize an owner
   event directly on the grid.
4. Open Rendezvous, choose a person, duration and date window, inspect local
   suggestions, and explicitly select the exact times to send.
5. The recipient sees those times in their own time zone with live local
   availability status, chooses one or proposes an exact alternative, and
   confirms.
6. Both calendars show the meeting. Unrelated events never cross the wire.
7. If the platform media gate is complete, both users can explicitly join an
   ephemeral browser-to-browser video room attached to the meeting.

### 0.2 UX foundation and dependency policy

Use FullCalendar's stable v6 standard packages only: `@fullcalendar/react`,
`core`, `daygrid`, `timegrid`, `list`, and `interaction`. These packages are
MIT licensed. Do not use FullCalendar Premium/Scheduler. Pin one exact compatible
version in the root lockfile, preserve its license in third-party notices, and
verify the final `.neutron` archive stays under the hackathon's 1.9 MB package
limit. If it does not, replace the library before cutting functionality.

Use FullCalendar for presentation and pointer/keyboard interaction, not as the
database. Backend managed memory remains authoritative. Every optimistic drag
or resize must revert visibly if the backend rejects a stale revision or
conflict-sensitive hold.

Required views and behaviors:

- desktop: month, week, day, and agenda/list;
- compact/mobile: agenda by default, with usable month and day views;
- Today, previous, next, view switcher, current range heading, now indicator;
- click/drag empty time to create; click an event to inspect/edit;
- drag owner events to move and resize them, with rollback on failure;
- overlapping ordinary events are allowed and render side-by-side;
- `busy` versus `free` controls whether an event blocks availability;
- all-day events use an all-day lane and exclusive end semantics;
- holds are visually tentative and cannot be edited like owner events;
- Rendezvous events are visually distinct and link back to the negotiation;
- all actionable events are keyboard focusable, labelled, and usable without
  drag gestures; reduced motion and narrow frames remain functional.

### 0.3 Calendar v2 domain model

Do not edit `backend/memory/calendar/v1.mo`. Add v2 plus a bounded synchronous
v1-to-v2 migration and advance the manifest/lock lineage.

Calendar v2 separates an event series definition from concrete occurrences.
Concrete occurrences—not prose recurrence rules—are what availability scans.
This makes collision checks deterministic inside Motoko while the browser can
use its IANA time-zone implementation to materialize wall-clock recurrence
across daylight-saving transitions.

`EventSeries` fields:

- stable series ID and monotonic revision;
- title, notes, optional location, color token;
- `#busy | #free` availability and `#timed | #all_day` kind;
- owner or Rendezvous source metadata;
- IANA time-zone ID for owner-created timed series;
- optional bounded `RecurrenceRule`;
- created/updated nanoseconds and tombstone-free active state.

`RecurrenceRule` is a closed RFC-5545-inspired subset:

- frequency: daily, weekly, monthly, yearly;
- interval 1–99;
- weekly day mask; monthly day-of-month uses skip semantics for absent days;
- termination: count 1–730 or inclusive local `until` date; the editor rejects
  an `until` range that would exceed 730 concrete occurrences instead of
  silently truncating it or claiming an unsupported “never” series;
- week starts Monday;
- no arbitrary RRULE text, BYSETPOS, lunar calendars, or unbounded expansion.

`Occurrence` fields:

- series ID plus stable local recurrence key (`YYYYMMDD` for all-day or local
  wall date-time for timed recurrence);
- UTC start/end nanoseconds after time-zone resolution;
- normal, overridden, cancelled, hold, or confirmed status;
- optional per-occurrence title/notes/location/time override;
- external Rendezvous ID where applicable.

Bounds for 0.2.0:

- 2,000 series, 10,000 materialized occurrences total;
- 730 occurrences per recurring series;
- range query at most 366 days and 2,000 returned occurrences;
- title 160 bytes, location 512 bytes, notes 4,096 bytes;
- event duration at most 31 days; proposal duration remains 15–480 minutes;
- recurrence expansion input must be ordered, unique, match the declared local
  keys and exact termination, and include no more than 730 rows.

The frontend owns time-zone conversion but does not get to mutate memory
piecemeal. It submits the bounded rule and every concrete occurrence through
the chosen count/date termination in one CAS mutation. The backend validates
shape/order/bounds and commits atomically. Calendar never silently claims an
infinite or longer recurrence than the finite series actually stored.

Migration rules:

- every v1 owner event becomes one non-recurring busy timed series and one
  normal occurrence;
- every v1 confirmed Rendezvous event becomes a busy Rendezvous series and one
  confirmed occurrence;
- every unexpired v1 hold becomes a hold occurrence; expired holds are dropped;
- preserve IDs where possible, preserve global revision, and derive new next
  IDs above every migrated value;
- test empty, mixed, maximum-bound, expired-hold, and upgrade-install cases.

### 0.4 Calendar v2 API and editor

Add versioned owner methods; keep v1 internal dependency methods compatible:

- `calendar_range_v2({ start_ns, end_ns, cursor, limit })`;
- `calendar_series_get_v2({ series_id })`;
- `calendar_series_create_v2(...)`;
- `calendar_occurrence_update_v2(...)` for “this event” overrides;
- `calendar_series_update_v2(...)` for the whole series and rematerialization;
- `calendar_occurrence_remove_v2(...)` and `calendar_series_remove_v2(...)`;
- `calendar_working_hours_get_v2()` / `set_v2()`;
- retain `calendar_availability_v1`, reserve, confirm, and release with the same
  semantics, implemented against v2 occurrences after migration.

Event editor requirements:

- title, all-day toggle, start/end, IANA time zone, location, notes, color;
- Busy/Free selector with plain-language help;
- Repeat: none, daily, weekdays, weekly, monthly, yearly, custom;
- custom interval/days/end condition with a human-readable summary;
- editing/deleting a recurring occurrence asks “This event” or “Entire series”;
- warn on DST gap/ambiguity and show the resolved instant before saving;
- destructive delete requires confirmation and stale writes preserve the draft;
- a quick `Block time` action opens a minimal busy-event editor;
- working hours use time inputs and weekday toggles—not minute-number fields.

### 0.5 Intuitive Rendezvous proposal composer

Delete `nextWeekdayCandidates()` and the “Propose three times” behavior. No
candidate may be sent merely because the program generated it.

Composer steps:

1. **Who and what:** peer principal/contact label, title, duration, optional
   note, organizer time zone.
2. **When to look:** date range (default seven days, max 31), allowed weekdays,
   earliest/latest local time, and slot increment.
3. **Choose exact options:** Calendar returns locally available suggestions;
   show them grouped by day in both a mini calendar and readable cards. The
   owner explicitly checks, adds, and removes 1–16 exact starts. Preserve
   chronological order because the frozen v1 wire does not encode preference
   ranking.
4. **Review and send:** show peer, expiration, exact options in organizer time
   zone, privacy disclosure, and the paid-delivery action.

Suggestion generation is deterministic and local: enumerate the chosen window
at the chosen increment, ask Calendar to filter it, and rank by proximity to
working hours and spread across days. It may pre-highlight recommendations but
must not send until the user confirms exact selections.

Recipient experience:

- incoming proposal opens as an overlay/list against the recipient's Calendar;
- show every option in recipient local time, with weekday/date/time and source
  time zone; never display opaque epoch values;
- mark options `Available` or `No longer available` after local revalidation;
- radio-select one available option, then confirm in a separate action;
- `Suggest different times` launches the same picker and sends a counter;
- decline and optional bounded message are distinct from cancel;
- state/history use human language (“Waiting for Bob”, “You proposed 4 times”)
  while technical delivery details live behind a disclosure panel;
- reusable peer sharing uses canonical `RVC1` addresses containing only the
  host Neutron principal and a copy button; the resolved/raw principal stays
  under Advanced. Keep this public address distinct from the private random
  capability in each `rv1` negotiation.

### 0.6 Availability and privacy semantics

- Ordinary owner events may overlap; each busy occurrence independently blocks
  a slot, while free occurrences do not.
- Working hours are weekly windows used for suggestions, not an inability to
  create events outside them.
- Explicit block events are ordinary busy events and can repeat.
- Availability responses remain only the filtered subset of caller-supplied
  starts. Never return busy intervals, event count, titles, recurrence rules,
  work hours, or rejection reasons to Rendezvous or a peer.
- A proposal note/title is intentionally shared and must be labelled as such.
  Private Calendar title/location/notes never enter diagnostics or wire data.

### 0.7 Browser-to-browser video feasibility and design gate

WebRTC can carry encrypted media directly between browsers, but it does not
define signaling and a reliable Internet connection commonly needs STUN and
sometimes TURN. Do not market “serverless video” or guaranteed direct routing.
The accurate promise is “peer-to-peer when ICE can establish it; optional relay
fallback only if the owner accepts a disclosed TURN service.” TURN relays
encrypted media and observes connection metadata.

Current Neutron ordinary tiles cannot capture media:

- tile iframe is `sandbox="allow-scripts"` without `allow-same-origin`;
- app responses set `Permissions-Policy: camera=(), microphone=()`;
- browsers reject `getUserMedia()` in that combination.

Therefore video is gated on an upstream-quality Neutron capability, not an app
workaround. Specify and test a `media_session` frontend capability that:

- is declared per exact tile and separately requests audio/video/screen share;
- appears in install disclosure and the capability fingerprint;
- uses a kernel-created ephemeral dedicated media origin/surface, never the
  kernel origin and never a generic relaxation for every app frame;
- requires focused, visible UI plus a fresh user gesture to open;
- applies the minimum `allow`/Permissions-Policy and origin sandbox necessary
  for `getUserMedia`, with no owner signing identity or ambient credentials;
- loses its session on tile close, logout, app update, uninstall, or revocation;
- has automated policy, spoofing, stale-session, navigation, and permission-
  denial tests before any camera code lands in Rendezvous.

If that kernel gate is accepted, implement a bounded `rendezvous_signal_v1`:

- only confirmed peers with the meeting capability may signal;
- offer/answer SDP and trickle ICE candidates are size-bounded, sequenced,
  deduplicated, expire within two hours, and are deleted on hang-up;
- each browser writes signaling to its own Neutron; its Rendezvous backend
  pushes paid messages to the peer Neutron; an open call surface may poll only
  its own Neutron revision, never the peer;
- explicit Join call button precedes device permission and reveals that ICE
  candidates can expose network addresses;
- controls: preflight camera/mic choice, mute, camera off, device failure,
  reconnect, hang up, remote-ended, and connection-quality state;
- default experiment is direct+STUN. TURN is a separately configured/disclosed
  reliability option; no hard-coded secret or undocumented third-party relay;
- E2E uses Chromium fake media on two contexts and asserts tracks stop on close.

Until the kernel media gate passes, ship a disabled “Video (platform support
required)” design prototype only if it helps explain the roadmap. Do not expose
a button that predictably fails or ask judges to weaken browser security.

### 0.8 Execution milestones and discrete todos

#### P0 — Product baseline and dependency qualification

- [x] Audit v1 model/UI and identify flat agenda, overlap rejection, numeric
  preferences, hard-coded candidate generation, and missing media authority.
- [x] Research RFC 5545 recurrence, FullCalendar standard interactions/time
  zones/accessibility, WebRTC signaling/ICE, and browser media policy.
- [x] Install pinned FullCalendar v6 standard packages and record MIT notice.
- [x] Add bundle/archive size test with a hard failure below the portal limit.
- [x] Preserve before-state evidence through the released v1 archive and its
  installed-canister migration regression. Historical screenshots are not a
  release gate; executable preservation evidence is stronger and reproducible.

#### P1 — Real calendar shell (first vertical slice)

- [x] Replace agenda layout with month/week/day/list views and responsive
  toolbar using backend range data.
- [x] Add click/drag creation and a keyboard-focused responsive event editor.
  The wide layout uses an inline sidebar; compact layouts scroll and focus the
  title field rather than hiding state in a modal.
- [x] Add event inspection, edit, delete, drag move, and resize with CAS rollback.
- [x] Replace minute-number preferences with weekday/time working-hours UI.
- [x] Allow ordinary owner-event overlap while keeping tentative hold conflict
  semantics, with a domain regression test.
- [x] Add Busy/Free, all-day, location, and color fields.
- [x] Finish installed-browser pointer coverage for drag/resize and visible
  rollback. Native Chromium mouse gestures now move and resize an isolated
  owner event, survive full workspace reloads, and clean up their fixture. A
  two-tab test creates a newer occurrence revision in tab A, attempts a stale
  native drag in tab B, verifies the visible error and snap-back, then reloads
  to prove tab A's value won. Backend regressions additionally prove metadata
  override and recurrence-exception preservation.

#### P2 — Calendar v2 persistence and recurrence

- [x] Freeze `calendar/v2.mo`, add the bounded v1-to-v2 migration, advance the
  manifest/lock lineage to 200, and add executable migration fixtures.
- [x] Add an installed-canister upgrade test from the preserved 0.1.0 package to
  0.2.0; clean installation is covered by the two-node browser suite.
- [x] Implement bounded sorted range queries, series CRUD, occurrence override/
  delete, atomic materialization validation, and lazy expired-hold filtering.
- [x] Implement the daily/weekly/monthly/yearly recurrence editor and browser
  wall-time materializer with count/until termination.
- [x] Test daily/weekly/monthly/yearly, interval, weekdays, count/until, missing
  month day, leap day, DST gap/fold, this-event overrides, whole-series edits,
  exact bounded termination, max bounds, and migration.

Verified 2026-08-21: `npm --workspace neutron-calendar test` passes the package,
TypeScript recurrence, memory-release, Calendar domain, v2 series, and migration
suites. A fresh two-node PocketIC/Internet Identity run passes independent-user
smoke, recurring create/whole-series edit/single-occurrence delete, native
drag/resize persistence and stale rollback, manual exact proposal selection,
single-time counter/organizer confirmation, confirmed Rendezvous persistence/
privacy, Contacts-bound delivery, stopped-peer recovery, stale-slot rejection,
navigation beyond the initial year, Calendar-to-Rendezvous selected-range
handoff, and an empty-availability/recovery path (15 passed in 2.5 minutes,
including the compact mobile Calendar path; diagnostic-only test skipped).
An isolated upgrade fleet now clean-installs the exact preserved v0.1.0
archive, creates owner data through the v1 browser tile, selects v0.2.0 through
Neutron's local-package review dialog, waits for the checked in-place actor
upgrade, and proves the event survived with Calendar app version 200 and memory
schema version 2 (`npm run test:e2e:calendar-upgrade:fresh`, 1 passed).
The recurrence suite also proves wall-clock stability across DST, detects a
spring gap, and warns on a fall fold. Calendar range loading follows the active
view with a bounded 366-day buffer and ignores late responses from older rapid
navigation requests. The desktop grid has a bounded internally scrolling height
so `scrollTime` opens near working hours; compact Agenda remains auto-height.
`calendar.v0.2.0.neutron` is 734,302 bytes,
below the last-observed 1.9 MB portal gate.

#### P3 — User-controlled proposals

- [x] Replace hard-coded proposal form with the four-step composer.
- [x] Implement deterministic local suggestion enumeration and explicit 1–16
  option selection/removal.
- [x] Add manual date/time addition with local availability validation. Keep
  options chronological because the v1 wire contract is an equal, ordered set;
  do not imply unsupported preference ranking with cosmetic reordering.
- [x] Build recipient availability status, explicit choice confirmation, and a
  locally validated exact-time counter picker. A multi-option counter would
  require a protocol-v2 state/memory migration and is recorded as post-release
  scope rather than leaving the v1 acceptance criterion ambiguously open.
- [x] Add canonical `RVC1` address sharing as the primary peer flow and place
  resolved/raw principals under Advanced. Address codes are explicitly not
  credentials and remain distinct from private `rv1` negotiation capabilities.
- [x] Rewrite negotiation cards, states, actions, and backend errors for normal
  users; keep raw state/delivery only under Technical delivery. The v1 memory
  model has current state rather than an event-history log, so the UI does not
  invent a timeline it cannot prove.
- [x] Test exact selected values on wire, local time-zone rendering, empty/no-
  availability recovery, counter flow, stale options, and private-title absence.
- [x] Add installed-browser delivery fault injection. The test stops the peer
  canister after the outbound draft is durably created, proves the app explains
  that the proposal is saved, restarts the peer, drives the visible Safe retry,
  and proves the recipient receives exactly one invitation. Because the failed
  update is rolled back by the platform, an `idle` outbound draft is also a
  valid recoverable state; retryable/uncertain markers, deterministic command
  reuse, timeout classification, and pre-await journaling remain covered by
  package/backend tests.

Verified 2026-08-21: the clean two-user suite proves the manually selected exact
time survives the paid wire unchanged at the recipient, single-time
counter/organizer confirmation, peer-local revalidation,
stale-option disabling, an actionable no-availability state with recovery,
confirmed event persistence, and private-title absence.

#### P4 — Cohesive Calendar/Rendezvous experience

- [x] From a selected Calendar range, launch a prefilled Rendezvous without
  transmitting private Calendar content. The owner still chooses the peer and
  explicitly reviews proposal details/options before anything is sent.
- [x] From an existing timed Calendar event, launch a prefilled Rendezvous using
  only its time range; do not copy title, notes, or location into the proposal.
- [x] From a confirmed Calendar event, open and highlight its matching local
  negotiation. Confirmed Rendezvous events are read-only in Calendar instead of
  exposing edit/delete controls that the backend must reject.
- [x] Add an actionable tray count/badge with `Review requests`; its projection
  contains only aggregate counts and never meeting titles, candidates, or peer
  identifiers. Opening reuses the Rendezvous tile and dismisses the tray.
- [x] Add Contacts as a bounded v2 composition dependency while retaining raw
  `RVC1`/principal fallback. Search returns only Contact ID/revision/name and a
  Neutron principal; creation re-resolves the exact contact and book revisions
  immediately before send. Renamed, removed, or rebound Contacts reject with
  `contact_changed` before any negotiation is created. Contact names/notes do
  not cross the peer protocol. Package/Motoko tests cover stale bindings and an
  installed two-Neutron browser test proves Alice selects Bob by name and Bob
  receives the proposal.
- [x] Test cross-app navigation, multiple tiles, reload, and compact workspace.
  The installed-browser suite opens Calendar and Rendezvous together, persists
  an owner block, reloads the authenticated shell, proves both tiles and the
  event restore, verifies unsent recipient text is discarded, and reruns both
  surfaces' basic accessibility audit. Compact Calendar has separate 390 px
  Agenda/focused-editor and horizontal-overflow coverage.

#### P5 — Neutron media capability gate

- [x] Write the concrete capability schema, lifecycle, origin/HTTP binding,
  revocation model, signaling boundary, threat matrix, and adversarial test
  order in `doc/media-session-capability.md`. The document also maps each step
  to the current manifest/catalog, compiler, consent, frame registry, stable
  memory, certified HTTP, broker, and test files so implementation does not
  begin with another architecture-discovery pass.
- [x] Obtain project-owner agreement on that security contract before changing
  kernel frame/header policy. The key decision is a Kernel-brokered ephemeral
  nonce-origin media iframe, never ambient media access in an ordinary tile.
  Approved explicitly by the project owner on 2026-08-21. This is a Neutron
  core extension and will be developed locally before choosing a publication
  fork/PR path; ordinary tile policy remains unchanged.
- [x] Implement compiler/manifest validation, disclosure, runtime registry,
  ephemeral media surface, revocation, and policy headers. `media_sessions`
  is now a closed API-1 manifest capability; the compiler installs an exact
  entrypoint/device/duration declaration and owner-runtime registry grant.
  Kernel memory V4 migrates V3 without mutating the frozen schema and starts
  with no lease. A focused tile request opens a Kernel confirmation, then one
  globally exclusive, expiring, certified nonce-host iframe with only the
  confirmed camera/microphone tokens. Close, expiry, disable, auth change,
  reinstall, or authority drift removes the iframe and revokes the lease;
  ordinary tile/background headers remain denied.
- [x] Add security fixtures and installed-browser permission tests. Motoko
  fixtures cover lease authority/exclusivity/expiry and exact certified HTTP
  host/path/fetch-destination gating; TypeScript suites cover closed schema,
  compiler/runtime registration, and origin construction. The installed
  two-owner Chromium flow now confirms the Kernel-owned purpose/device/duration
  disclosure, proves the ordinary tile has no media delegation, checks the
  media iframe's distinct 96-bit nonce host, exact `allow`, sandbox, and
  credentialless attributes, loads the self-contained device surface, and
  proves Kernel End removes both overlay and iframe.
- [x] Confirm the pre-implementation platform boundary: ordinary Neutron tiles are
  explicitly denied camera/microphone by the sandbox policy, and there is no
  existing media capability to request them. Do not weaken ordinary frame
  headers while implementing the now-approved dedicated media surface.
  The installed multi-tile/reload regression also asserts that the active
  iframe grants neither feature and that the document policy denies both.

#### P6 — WebRTC meeting experiment (only after P5)

- [x] Add bounded/expiring signaling memory and paid caller-bound wire route.
- [ ] Implement perfect-negotiation peer connection, trickle ICE, device
  preflight, controls, cleanup, direct/STUN status, and optional TURN config.
  Perfect negotiation, serialized trickle ICE with pre-description candidate
  queuing, explicit device start, mute/camera/leave, direct status, physical
  close cleanup, and expiry are implemented. STUN/TURN configuration,
  reconnect, device selection, and quality UI remain.
- [ ] Test fake-media two-browser call, glare, duplicates/reorder, reload,
  denial/no-device, failed ICE, hang-up, expiry, revocation, and data cleanup.
  The installed Alice/Bob fake-media happy path passes; backend tests cover
  wrong caller, duplicate signal IDs, close cleanup, and V1→V2 migration.
  The rest of this adversarial matrix remains open.
- [x] Document exactly when media is direct, relayed, encrypted, and observable.

#### P7 — Submission gate

- [ ] Rerun package, migration, kernel, complete two-node II, accessibility,
  responsive, privacy, and adversarial suites from a fresh fleet against the
  final media-capable artifacts. The targeted installed Alice/Bob scheduling,
  consent, fake-media connection, remote-video, and teardown scenario passes;
  the complete pre-media release suite still needs its final regression run.
- [ ] User acceptance: a new user can create a recurring block and schedule a
  chosen meeting without instruction or unexplained numeric fields. Run the
  exact recurrence, pointer persistence/rollback, proposal-choice, privacy,
  reload, and responsive checklist in `DEMO.md` with someone who did not build
  the product; record observed friction before checking this item.
- [x] Regenerate six screenshots from the final Calendar 0.2.0 / Rendezvous
  0.2.1 packages with the Contacts picker as the primary composition path,
  including Contact-selected proposal/receipt, both confirmed Calendar week grids,
  read-only meeting detail, and highlighted cross-app negotiation. All six were
  visually inspected at 1280×720 and are individually below 80 KB. Video
  capture remains a human submission task.
- [x] Recheck portal static size/rules, artifact hashes, README, notices,
  limitations, and Contacts-before-Calendar-before-Rendezvous install order.
- [x] Complete a kernel-only reviewed browser File install of Contacts 0.3.1,
  Calendar 0.2.0, then Rendezvous 0.2.1 and verify all runtime versions.
- [ ] Immediately before upload, confirm the live portal countdown.

### 0.9 Stop-ship product criteria

Do not call the app submission-ready unless all are true:

- Calendar visually and behaviorally supports month/week/day/list workflows.
- A user can block one-off and repeating time, edit it, and remove one instance
  or the series without understanding Motoko or epoch timestamps.
- No proposal uses randomly or invisibly chosen times; sender and recipient
  explicitly choose the options they send/accept.
- Time zones and DST have executable tests and plain-language display.
- Availability never exposes unrelated calendar data.
- A failed drag/update visibly rolls back and preserves user input.
- Package install/upgrade from 0.1.0 is tested and archive sizes fit the portal.
- Video is either fully capability-gated and tested or clearly excluded from
  the release; a fake or unreliable “Join” button is a stop-ship defect.

## 1. Mission

Build a peer-to-peer scheduling system in which each person runs the same Calendar and Rendezvous packages inside a separately owned Neutron canister.

Calendar retains the owner's event details and computes availability locally. Rendezvous exchanges only bounded meeting proposals and outcomes with the peer's Rendezvous through Neutron's paid public-ingress protocol.

The final demo must prove:

- Alice and Bob use two distinct Neutron canisters, not accounts in one dapp.
- Both install identical Calendar and Rendezvous packages.
- Each has different private events and preferences.
- Alice addresses Bob by his Neutron principal or a Contacts Neutron address.
- Each node computes availability locally.
- Existing event titles, notes, attendees, and full busy calendars never cross nodes.
- The sending node pays the receiving node's declared public-ingress cycle floor.
- Commands are bounded, caller-bound, revisioned, idempotent, and safely retryable.
- A confirmed meeting appears in both local calendars.
- No central database, account service, scheduling server, relayer, or peer polling exists.

Pitch:

> Rendezvous lets personal computers negotiate commitments directly: your calendar stays in your Neutron, and only proposals and outcomes cross the network.

## 2. Release 0.2 non-goals

The two-node MVP has passed. Keep these outside the 0.2 release unless a later
section explicitly defines and gates them:

- Google, Apple, or Outlook integration.
- More than two participants and group availability negotiation.
- Natural-language parsing in Motoko.
- A time-zone rules database; the protocol uses UTC nanoseconds.
- Zero-knowledge proofs or claims of general confidentiality. Neutron state is replicated; v1 uses access control and data minimization.
- Anonymous discovery, public directories, or a centralized registry.
- Payments, deposits, email invitations, or ICS.
- Video in ordinary app tiles. P5/P6 define the only acceptable path: a reviewed
  Neutron media capability followed by a security and fake-media test matrix.
- Multi-option counterproposals, which require a versioned protocol and memory
  migration; 0.2 supports an exact single-time counter.
- A generic negotiation framework.

## 3. Mandatory reading before coding

Read the current versions in the Neutron checkout. Platform docs override this plan if contracts changed.

Platform:

- doc/app-developer-guide.md — packaging, public ingress, backend calls, self calls.
- doc/backend-app-dependencies.md — internal app exports and app_calls injection.
- doc/app-package-format.md — closed format-3 manifest.
- doc/app-method-access-and-call-consent.md — owner methods versus public routes.
- doc/kernel-app-communication.md — tools, residents, audit, consent.
- doc/bootstrap-local-development-and-deployment.md.
- doc/provisioning-system.md — multi-node PocketIC fleets.
- doc/testing-and-verification.md.
- doc/open-questions-and-design-gaps.md.

Reference apps:

- apps/chess/README.md, neutron.json, backend/main.mo, PublicIngressWire.mo, RemoteGameResultWire.mo, invite_code.ts, remote_connection.ts, and their tests. Chess is the primary model for invitations, peer binding, paid push, revisions, idempotency, uncertain outcomes, and retries.
- apps/mail/README.md and neutron.json. Mail is the model for Contacts integration, method-scoped install reservations, command journaling, and push-paid delivery.
- apps/contacts/README.md, neutron.json, and exported lookup types.
- apps/kitchensink for small public-ingress and dependency examples.
- apps/hello for package scaffolding.
- apps/wagyu/README.md and spec.md only when solving a specific delivery problem. Do not copy Wagyu's overall complexity.

Reuse established patterns where licensing permits. Preserve NOTICE and attribution. Never invent raw actor calls, cycle primitives, public methods, or package metadata that bypass Neutron brokers.

## 4. Frozen v1 architecture

### 4.1 Topology

    Alice Neutron                         Bob Neutron
    ┌────────────────────┐               ┌────────────────────┐
    │ kernel             │               │ kernel             │
    │ contacts optional  │               │ contacts optional  │
    │ calendar           │               │ calendar           │
    │ rendezvous         │ <-----------> │ rendezvous         │
    │ agent optional     │ paid ingress  │ agent optional     │
    └────────────────────┘               └────────────────────┘

Calendar and Rendezvous are packages compiled into each person's single Neutron actor. They retain separate app-scoped managed memory. Calls between Calendar and Rendezvous on one node are typed local dependency calls. Calls between Alice and Bob are inter-canister messages.

### 4.2 Ownership

Calendar owns:

- Private events and preferences.
- UTC availability computation.
- Tentative holds and confirmed peer-created events.
- Collision checks.
- A narrow monotonic backend API exported to installed apps.

Calendar does not own peers, remote messages, negotiation history, or outbound canister authority.

Rendezvous owns:

- Invite codes and peer canister principals.
- Negotiation state machines.
- Outbound exact-request journal and retries.
- Authenticated peer binding.
- Translation between wire commands and local Calendar calls.
- Public-ingress admission and app-level dedupe/bounds.
- Proposal/counter/accept/cancel UI.

Rendezvous never accesses Calendar memory. It gets only exact functions declared under dependencies.calendar.functions.

### 4.3 Wire privacy boundary

Allowed:

- Protocol version, negotiation ID, command ID, expected revision.
- Duration and bounded UTC search window.
- At most 32 candidate UTC start times.
- Selected UTC start time.
- An optional owner-chosen meeting label of at most 160 UTF-8 bytes.
- Closed transition and result codes.

Forbidden:

- Unrelated event titles, descriptions, notes, attendees, or local event IDs.
- Complete calendars or raw busy intervals.
- Local scheduling preferences or reasons for rejection.
- Contacts names/notes or authorization credentials.

### 4.4 Time and size bounds

- Wire/backend timestamp: Nat64 Unix epoch nanoseconds UTC.
- Duration: Nat32 minutes, 15 through 480.
- Search horizon: at most 31 days.
- Candidate starts: at most 32, unique and ordered.
- Browser presentation: Intl.DateTimeFormat; optional local IANA zone is display metadata only.
- Active negotiations: at most 1,000 plus bounded terminal history.
- Dedupe receipts: newest 2,048 or a documented equivalent bound.
- Invite capability: 128 random bits, single claimant, seven-day expiry.

Validate ordering, overflow, duration, alignment, horizon, text bytes, and collection sizes before mutation.

### 4.5 Push, do not poll

The initiator of a transition pushes it and pays. Tiles/residents may query their own Neutron for refresh. They must not periodically poll a peer. Manual recovery may send an explicit paid exchange/status command.

### 4.6 Public protocol

Use one public update dispatcher:

    app_rendezvous__rendezvous_v1_update

One initial route:

- protocol: rendezvous_v1
- id: exchange
- handler: rendezvous_remote_exchange_v1
- mode: update
- caller: canister

Declare positive required_cycles, request/response bounds, shared hourly rate, and per-caller rate. Early development may use a documented provisional floor. Before submission, calculate a conservative floor and keep it identical in:

- public_ingress.required_cycles;
- outbound attached-cycle constant;
- backend_calls.max_cycles_per_call;
- daily ceiling calculation;
- tests and wire fixtures.

All outbound calls use injected BackendCallsV1. App Motoko must not construct actors or use raw cycle/management primitives.

Recommended hackathon consent policy: reservation_scopes ["method"] with an install reservation for app_rendezvous__rendezvous_v1_update, matching Mail. If review rejects method-wide access, use Chess-style exact per-peer reservations and record the change.

Attached cycles prove immediate canister-mediated transport, not official Neutron software or human identity. Invite capability plus caller binding establishes the relationship.

### 4.7 Calendar dependency API

Prefer synchronous internal exports so the synchronous ingress handler can consult/mutate Calendar without await:

- calendar_availability_v1(request) -> AvailabilityResultV1
- calendar_reserve_v1(request) -> ReserveResultV1
- calendar_confirm_v1(request) -> ConfirmResultV1
- calendar_release_v1(request) -> ReleaseResultV1

Provisional request concepts:

    AvailabilityRequestV1 {
      window_start_ns;
      window_end_ns;
      duration_minutes;
      candidate_starts_ns;
    }

    ReserveRequestV1 {
      source = rendezvous;
      external_id;
      expected_calendar_revision;
      start_ns;
      duration_minutes;
      label;
      hold_expires_at_ns;
    }

Calendar filters caller-provided candidate starts. It does not return a complete busy calendar.

Mark exports internal:apps and let mogen generate manifest func metadata. Later versions must preserve v1 name, type, semantics, and authorization. Breaking APIs get new names.

### 4.8 Protocol state machine

Centralize transitions in Protocol.mo:

    draft -> outbound_pending -> awaiting_peer
    awaiting_peer -> peer_countered | accepting | declined
    inbound_received -> counter_pending | accept_pending | declined
    accepting/accept_pending -> awaiting_confirmation -> confirmed
    any nonterminal -> cancel_pending -> cancelled
    outbound transition -> retryable | uncertain

Each command carries protocol version, random negotiation ID, unique command ID, expected revision, closed command variant, and bounded payload.

Receiver invariants:

- First valid invite claim binds exact caller Principal.
- All later mutations require that caller.
- Reject self-invites.
- Validate bounds and legal transition before mutation.
- Deduplicate caller + negotiation ID + command ID.
- A duplicate returns the same semantic receipt.
- Reordered/old messages never roll state backward.
- Peer display text is untrusted metadata.

Sender invariants:

- Commit outbound intent and exact encoded bytes before await.
- Retry the exact command bytes/idempotency key.
- Distinguish definite rejection, retryable failure, and uncertain outcome.
- Unknown outcome never becomes false success or a replacement command.
- Validate outer PublicIngressResultV1 and inner peer reply as hostile bounded bytes, following Chess.

### 4.9 Two-phase confirmation

1. Initiator asks its Calendar for candidate availability and sends offer.
2. Receiver filters candidates through its Calendar.
3. Receiver owner or explicitly enabled agent selects one and creates a short local hold before sending accept_intent.
4. Initiator receives accept_intent, rechecks and reserves locally, then returns/pushes confirm.
5. Receiver confirms its hold.
6. Initiator confirms its hold.
7. Both Calendar events store the same negotiation ID and UTC slot.

Exact retries resolve uncertain steps. Holds expire and are released on rejection/cancellation. Lazy bounded hold cleanup is sufficient for MVP.

Never auto-accept merely because a peer proposed a slot.

## 5. Expected file layout

    apps/calendar/
      README.md, NOTICE, package.json, mops.toml, neutron.json
      neutron.lock.json
      build.ts
      backend/main.mo
      backend/Availability.mo
      backend/Validation.mo
      backend/memory/calendar/v1.mo
      public/index.html, public/static/icon.svg
      src/index.tsx, calendar_api.ts, model.ts, style.scss
      test/availability.test.mo
      test/main_compile.test.mo
      test/memory_release.test.ts
      test/package.test.ts
      test/calendar_api.test.ts

    apps/rendezvous/
      README.md, NOTICE, package.json, mops.toml, neutron.json
      neutron.lock.json
      build.ts
      backend/main.mo
      backend/Protocol.mo
      backend/PublicIngressWire.mo
      backend/RendezvousResultWire.mo
      backend/Validation.mo
      backend/Outbox.mo
      backend/memory/rendezvous/v1.mo
      public/index.html, service.html, tray.html, static/icon.svg
      src/index.tsx, rendezvous_api.ts, invite_code.ts
      src/remote_connection.ts, service.ts, agent_tools.ts, style.scss
      test/protocol.test.mo
      test/public_ingress_wire.test.mo
      test/result_wire.test.mo
      test/main_compile.test.mo
      test/memory_release.test.ts
      test/package.test.ts
      test/invite_code.test.ts
      test/remote_connection.test.ts
      test/state_machine.test.ts

    rendezvous-local.ndeploy.json

Copy current Hello/Chess tooling rather than creating new build infrastructure. Use unique workspace names neutron-calendar and neutron-rendezvous. Run root npm install after adding workspaces.

## 6. Memory contracts

Calendar memory v1 should contain:

- schema version and monotonic revision;
- next event ID;
- bounded ordered events;
- external Rendezvous ID index;
- preferences;
- confirmed and expiring hold states.

An event contains ID/revision, start/end UTC ns, bounded title/notes, source owner or Rendezvous ID, and confirmed/hold status.

Rendezvous memory v1 should contain:

- schema version and monotonic revision;
- bounded negotiations;
- peer binding;
- outbound exact encoded request, attempt, and status;
- bounded command receipts for dedupe;
- direct indexes needed to avoid global scans.

Memory rules:

- Update indexes atomically with primary records.
- Increment revision on every semantic mutation.
- Use deterministic bounded pruning.
- Reject capacity rather than silently evict active negotiations or confirmed events.
- Released schema v1 is immutable. Type changes require v2 and migration.
- Generate/commit neutron.lock.json only after intentional v1 types exist.

## 7. Manifest targets

Calendar:

- id calendar, name Calendar, version 100.
- Managed root calendar v1.
- One tile and exact preapproved self calls.
- Four internal app exports generated by mogen.
- No public ingress, backend calls, HTTPS, signing, VetKeys, or certified assets in v1.

Provisional owner methods:

- calendar_status, calendar_list, calendar_create, calendar_update, calendar_remove.
- calendar_preferences_get, calendar_preferences_set.

Rendezvous:

- id rendezvous, name Rendezvous, version 100.
- Required Calendar dependency, min_version 100, exactly four exports.
- Managed root rendezvous v1.
- Main tile; resident/tray only when notification phase begins.
- Paid rendezvous_v1:exchange public route.
- Backend selects backend_calls API 1.
- Bounded backend-call declaration and exact preapproved self calls.
- Defer Contacts until raw-principal flow works.

Provisional owner methods:

- rendezvous_status, rendezvous_list, rendezvous_get.
- rendezvous_create_offer, rendezvous_send_offer.
- rendezvous_counter, rendezvous_accept, rendezvous_decline.
- rendezvous_cancel, rendezvous_retry.

Route-only handler:

- rendezvous_remote_exchange_v1.
- Synchronous, receives caller and optionally public_ingress_cycles using documented annotations, performs no outbound call.

## 8. Discrete todos

Do not mark a todo complete until its acceptance checks pass.

### Phase A — Bootstrap

- [x] A01 Establish current Neutron monorepo.
  - Clone/copy upstream into this workspace without incorrect nesting.
  - Record upstream SHA in Implementation Log.
  - Check Node/npm/Bun/Mops.
  - Accept: npm install and unchanged Hello validation/tests succeed.

- [x] A02 Capture reference decisions.
  - Read all section 3 sources.
  - Identify Chess files to adapt and NOTICE obligations.
  - Freeze reservation policy, wire parser strategy, provisional cycle floor.
  - Accept: decisions are recorded in Rendezvous README or log.

- [x] A03 Scaffold both apps.
  - Copy Hello twice; remove copied .mops, dist, node_modules, archives, tsbuildinfo, lock.
  - Rename IDs, roots, packages, UI, tests; remove Hello update_source.
  - Run root npm install.
  - Accept: both skeletal 0.1.0 apps validate independently.

### Phase B — Calendar

- [x] B01 Freeze types/bounds.
  - Define event, preferences, availability, hold, and result types.
  - Test minimum, maximum, adjacent invalid, and overflow cases.

- [x] B02 Implement managed memory v1.
  - Defaults, revisions, indexes, events, holds, bounded expired-hold cleanup.
  - Accept: memory/release tests survive harness upgrade and indexes remain consistent.

- [x] B03 Implement owner CRUD.
  - Status, paginated list, create/update/remove, preferences.
  - Require expected revision on stale-sensitive changes.
  - Accept: CRUD, stale, overlap, bounds, pagination tests pass.

- [x] B04 Implement availability.
  - Filter supplied candidates using weekdays/hours, events, holds, buffers, duration, increment.
  - Deterministic unique ordering.
  - Accept: boundary, buffer, expiry, UTC, duplicate, maximum tests pass.

- [x] B05 Export dependency API.
  - Mark only four functions internal:apps.
  - Reserve/confirm/release are external-ID idempotent.
  - Run mogen; do not hand-edit func.
  - Accept: compile fixture receives exactly four functions and no memory.

- [x] B06 Build Calendar tile.
  - Simple agenda/week display, CRUD, preferences.
  - Visually distinguish owner event, tentative hold, confirmed Rendezvous meeting.
  - Use design system and source-bound self calls.
  - Accept: UI tests cover CRUD and state rendering.

- [x] B07 Package Calendar.
  - README: API, data boundary, limits, build/test.
  - Review and commit generated memory lock.
  - Accept: standard test/package produces calendar.v0.1.0.neutron.

### Phase C — Rendezvous core

- [x] C01 Freeze protocol types.
  - Define IDs, states, commands, replies, receipts, errors, transition matrix.
  - Accept: every allowed transition and representative forbidden transitions tested.

- [x] C02 Implement memory v1.
  - Negotiations, peer, exact outbound bytes, attempts, uncertainty, dedupe.
  - Bounded terminal pruning; never silently evict active state.
  - Accept: memory/release and index tests pass.

- [x] C03 Implement invites.
  - Adapt Chess versioned format: protocol, host principal, random 128-bit capability.
  - Strict canonical decode and malformed corpus.
  - Accept: vectors, round trips, truncation, oversize, version, principal, self-invite pass.

- [x] C04 Implement local state machine with mock Calendar.
  - Draft/offer, inbound filter, counter, accept-intent, confirm, decline, cancel, expire.
  - Accept: compiled fixture covers happy path, conflict, stale, invalid transitions.

### Phase D — Network protocol

- [x] D01 Implement bounded wire codec.
  - Adapt Chess PublicIngressRequest/Result and hostile reply parsing.
  - Freeze canonical vectors.
  - Accept: near-max legal payload fits manifest; malformed/truncated/noncanonical/oversize fail closed.

- [x] D02 Implement synchronous receiver.
  - Add route/handler, bind caller, reject self, validate invite/state/revision/dedupe.
  - Call local Calendar synchronously; no await/outbound work.
  - Accept: tests cover claim, wrong peer, replay, reorder, conflict, duplicate.

- [x] D03 Configure backend broker.
  - Add backend capability and chosen reservation.
  - Use official physical method helper/convention.
  - Accept: manifest passes and non-Rendezvous targets fail.

- [x] D04 Implement durable outbound exchange.
  - Commit exact request before await; attach exact floor; validate both reply layers.
  - Track reject/retryable/uncertain distinctly.
  - Accept: success, protocol error, broker error, malformed, timeout, duplicate, revoked-after-dispatch, late callback tests pass.

- [x] D05 Complete distributed confirmation.
  - Offer -> accept-intent -> confirm with local holds.
  - Revalidate immediately before reserve/confirm; release/expire safely.
  - Accept: intervening event cannot double-book; retries converge.

- [x] D06 Calculate economics.
  - Estimate bounded execution, response, and retained state.
  - Synchronize all constants and document calculation.
  - Accept: underfloor traps, exact floor succeeds, constants match.

### Phase E — Product UI

- [x] E01 Build main tile/API adapter.
  - Lists: inbound, outbound, countered, confirmed, cancelled, delivery problems.
  - Actions: invite/offer, paste invite, counter, accept, decline, cancel, safe retry.
  - Accept: state/action and stale-response UI tests pass.

- [x] E02 Make errors explicit.
  - Distinguish missing permission, unreachable, app missing, low cycles, conflict, stale, rejected, retryable, uncertain.
  - Uncertain copy says peer may have committed.
  - Accept: every error code maps to tested copy/action.

- [x] E03 Add resident/tray.
  - Poll only local revision; badge actionable inbound proposals.
  - Accept: local inbound change updates badge; no remote polling exists.

- [x] E04 Add Contacts after raw principal flow passes.
  - Mirror Mail's exact Contacts v2 lookup/search dependency.
  - Re-resolve revisions before send; labels are not identity proof.
  - Accept: stale/renamed/removed contact cannot redirect silently.

- [ ] E05 Add agent tools only as stretch.
  - list/get/propose/counter/accept/decline/retry.
  - Mutations use revision-bound opaque targets returned by reads.
  - Label peer content external_untrusted.
  - Accept: stale target/session misuse fails; manual UI works without agent.

### Phase F — Integration and submission

- [x] F01 Create two-node PocketIC config.
  - Format 3; target.nodes ["alice", "bob"].
  - Include Kernel, Calendar, Rendezvous, optionally Contacts/Agent in dependency order.
  - Accept: serve/reinstall/status report two distinct canister IDs/URLs with apps active.

- [x] F02 Automate happy path.
  - [x] Playwright local-II harness: two isolated browser contexts create passkeys, authorize their origin-derived principals on Alice/Bob, and open Calendar plus Rendezvous on both nodes; cleanup revokes both principals.
  - [x] Resolve apparent local-II update stall: instrumentation proved Chromium blocked native form submission because Neutron app frames omit `allow-forms`; Calendar and Rendezvous now use direct button actions.
  - [x] Add privacy-preserving self-call diagnostics: record browser errors, IC API timing/status, self-call method/ID, and response key/type shapes without logging arguments, payload values, principals, or event data; attach JSON to Playwright results.
  - [x] Assert the private seed titles are absent from captured diagnostics; redact principals from HTTP origins/paths and identity lifecycle markers.
  - [x] Match Neutron's decoded Candid result contract: successful single-payload variants arrive as their payload object, so proposal creation consumes the returned negotiation directly before sending it.
  - [x] Fix accept-intent revision synchronization: retain the incremented local revision for retry/idempotency while sending the peer's pre-intent expected revision to the remote exchange.
  - [x] Verify the complete two-user flow on non-empty local nodes: private events remain isolated, proposal delivery succeeds, Bob accepts, both negotiations confirm, and the shared event appears in both Calendars.
  - Seed different private events/preferences.
  - Alice proposes; Bob filters/accepts; both confirm.
  - Assert observations never contain private seed titles/details.
  - Accept: repeatable from clean reinstall.

- [x] F03 Automate adversarial paths.
  - [x] Mid-flight Calendar conflict: a slot booked after delivery cannot be accepted, remains unconfirmed on both peers, and leaks no private event title.
  - [x] Accept revision regression: local `accept_intent` revision 2 targets the peer's pre-intent revision 1; offer/counter revisions remain unchanged.
  - [x] Expanded clean-baseline suite passes with smoke, happy path, conflict safety, and diagnostic privacy checks (`3 passed`, opt-in diagnostic skipped).
  - [x] Retry invariants: deterministic retries retain the same command ID, new revisions/commands receive different IDs, timeout is uncertain, definite transport failure is retryable, and package tests enforce journaling before broker dispatch.
  - [x] Fix command-ID domain separation: the original truncation accidentally discarded revision/command bytes, so every transition shared one dedupe ID; IDs now mix negotiation identity with revision and command and are regression-tested.
  - [x] Receiver authorization/state machine: self-offer rejection, wrong caller, wrong capability, exact replay, future revision, and reordered stale delivery.
  - [x] Hostile wire inputs: malformed prefix, truncation, trailing bytes, non-canonical ULEB encoding, and oversized input fail closed.
  - [x] Transport admission: Neutron kernel tests prove below-floor calls do not dispatch and live authority loss after commit reports `revoked_after_dispatch`; Rendezvous maps timeout/lost reply to uncertain and definite unavailable-peer failures to safe exact retry.
  - [x] Wrong caller, replay, reorder, underfund, malformed/oversize, mid-flight conflict, unavailable peer, lost reply/recovery, and capability revocation all have executable or kernel-bound evidence.
  - Accept: documented safe state, no double-booking/leakage.

- [x] F04 Verify packages/upgrades.
  - Validate/build/package/test/typecheck both.
  - Compile Kernel + Calendar + Rendezvous.
  - If version advances, test upgrade from 0.1.0 fixture.
  - Accept: all pass and locked schemas change only via migration.

- [x] F05 Prepare 90-second demo.
  - Two labeled browser windows, memorable private event titles.
  - Show proposal, negotiation, confirmation, both calendars.
  - Then show two principals, paid ingress, no server.
  - Accept: observer explains why this is not Calendly and what crossed wire.

- [x] F06 Prepare submission.
  - Diagram, protocol/threat model, clean build/run, video, limitations, attribution.
  - Accept: independent developer reproduces demo without hidden backend edits.

## 9. Test matrix

Calendar:

- Timestamp/duration overflow and bounds.
- Exact overlap boundaries, weekdays/hours, buffers.
- Active versus expired holds.
- Stale Calendar revision and external-ID idempotency.
- Duplicate/max candidates; CRUD pagination/order.

Rendezvous:

- Every legal and forbidden transition.
- Invite claim/expiry, exact caller binding, self rejection.
- Dedupe receipt, reordered revision, bounded pruning.
- Active state never silently evicted.

Wire:

- Canonical vectors and maximum legal sizes.
- Truncation at structural boundaries.
- Invalid tags/lengths and hostile equivalent Candid.
- Malformed peer reply and underfunded ingress.
- Payment never bypasses invite/caller authorization.

Distributed:

- Offer/accept/confirm, counter, decline, cancel.
- Concurrent local Calendar mutation.
- Duplicate delivery, lost response, exact retry.
- Revocation before dispatch and after remote commit.
- Missing/disabled peer app.
- Convergence without polling.

## 10. Stop-ship invariants

1. Calendar memory is never injected into Rendezvous.
2. Existing event details never enter wire payload, log, tool result, or error.
3. Remote mutations use only declared public ingress.
4. Post-claim mutations require exact peer principal.
5. Cycles are payment evidence, not identity.
6. Validate size, state, caller, revision, dedupe before mutation.
7. Commit durable outbound intent before await.
8. Unknown outcome never becomes false success or blind replacement.
9. Retries are exact and idempotent.
10. Revalidate Calendar before reserve/confirm.
11. Peer cannot force auto-acceptance.
12. Peer text is bounded/inert/untrusted for agents.
13. No peer polling; initiator pushes/pays.
14. Broker authority is minimum, visible, revocable.
15. No raw actor, cycles, stable memory, or unauthorized escape.
16. Never edit a released memory schema in place.

## 11. Scope gates

- Gates 1–2 are satisfied: Calendar package tests pass and the state machine
  plus wire vectors are frozen.
- Gate 3: Contacts integration is complete and required by the 0.2.1 manifest;
  agent tools remain optional and cannot displace release UAT.
- Gate 4: groups, external calendars, multi-option counters, encryption, and a
  generic negotiation framework require separately versioned protocols.
  Recurrence is already implemented locally and does not alter the v1 wire.
- Gate 5: no video implementation before P5's capability agreement and no
  production video claim before every P6 security/media test passes.
- Gate 6: no submission-ready claim until the human UAT and live portal check
  in P7 are complete.

Cut optional post-0.2 work under schedule pressure in this order:

1. Agent tools.
2. Multi-option counterproposal; retain the tested exact-time counter.
3. Video; retain the explicit capability-gate documentation.

Never cut the real calendar views/recurrence, explicit proposal choice, caller
binding, idempotency, revisions, pre-await journal, uncertainty handling,
Calendar revalidation, bounds, privacy checks, or two-node tests.

## 12. Definition of done

- Standard commands produce the exact valid Contacts 0.3.1, Calendar 0.2.0,
  and Rendezvous 0.2.1 archives recorded in `SUBMISSION.md`, within the portal
  size limit.
- Clean two-node PocketIC deployment and reviewed File installation both install
  Calendar before Rendezvous for Alice and Bob; Calendar v1 data survives the
  reviewed v2 upgrade.
- Calendar supports persisted day/week/month/list, one-off and bounded recurring
  events, occurrence/series edits, Busy/Free, all-day, and working hours.
- The owner explicitly selects every offered time; the recipient revalidates,
  explicitly accepts or counters, and no random or invisible candidate is sent.
- Confirmation creates matching local events without unrelated details crossing.
- Caller-bound paid delivery, retry/reorder, stopped-peer recovery, stale
  Calendar writes, and intervening conflicts converge without double-booking.
- Package, migration, kernel, two-node browser, accessibility, responsive,
  privacy, and adversarial suites pass against the exact release artifacts.
- A new user passes the `DEMO.md` release UAT, including native pointer
  persistence and visible stale rollback.
- READMEs and `SUBMISSION.md` accurately document permissions, cycles, threats,
  build, limits, hashes, screenshots, and install order.
- Demo proves two owned canisters and no central backend. Video is absent unless
  the P5/P6 gates are fully implemented and tested.

## 13. Implementation log

Append dated entries for upstream SHA and decisions that alter frozen v1 contracts. Include reason, affected files, and tests. Do not use log entries instead of completing todos.

- 2026-08-20: imported upstream commit decb271bab65c3fb95f961040f909d37a7fe7690. Node 24.2.0, npm 11.3.0, Mops 2.13.2, isolated Bun 1.4.0. Baseline Hello tests pass.
- 2026-08-20: scaffolded Calendar and Rendezvous as unique 0.1.0 workspaces using the use-only application license. Both standard package pipelines generate archives, memory locks, method schemas, offered-source metadata, and pass Bun plus browser-Motoko tests. The initial memory roots are scaffolds and are not released; B01/B02 must intentionally replace/freeze them before publication.
- 2026-08-20: froze Calendar v1 at 2,000 events, 32 candidates, 15–480 minute meetings, and a 31-day horizon. Calendar exposes exactly four synchronous installed-app functions; event metadata remains private. CRUD, availability, hold/idempotency, UI-source-call, package, and managed-memory tests pass.
- 2026-08-20: adapted Chess's BackendCallsV1/public-ingress wrapper strategy (see app NOTICE). Rendezvous uses a method reservation for `app_rendezvous__rendezvous_v1_update`, 16 KiB request/response caps, and a provisional conservative 250,000,000-cycle floor. The same value is used by ingress, outbound calls, and the per-call ceiling; the 60,000,000,000 daily ceiling permits 240 full-floor calls.
- 2026-08-20: froze Rendezvous v1 memory/protocol at 64 negotiations, 16 ordered candidates, 128 dedupe receipts, 128-bit IDs/capabilities, durable exact outbound bytes, explicit uncertainty, and hold-first confirmation. Canonical invite, state/peer/replay, package, UI, and managed-memory tests pass.
- 2026-08-21: retry audit found command IDs were truncated before revision/command bytes, collapsing every transition in a negotiation onto one dedupe key. Command IDs now domain-separate negotiation, revision, and command; pure retry invariants, pre-await journal ordering, the full package suite, and clean two-node Playwright flows pass.
- 2026-08-21: completed the adversarial matrix. Rendezvous receiver tests cover caller/capability binding, replay, future/reordered revisions and self-offers; wire tests cover malformed, non-canonical, truncated, trailing and oversized payloads. The Neutron kernel's focused public-ingress/backend-call tests pass for cycle-floor admission and revocation-after-dispatch semantics. Timeout remains explicitly uncertain and exact retry remains idempotent.
- 2026-08-21: final release verification rebuilt both 0.1.0 packages, passed both complete workspace suites, passed focused kernel public-ingress/backend-call tests, and passed a destructive fresh two-node local-II browser run (`3 passed`, diagnostic-only test skipped). Added `SUBMISSION.md` with current official portal fields/limits, release hashes, evidence, demo assets, and upload procedure.
- 2026-08-21: advanced Calendar and Rendezvous to 0.2.0. Calendar now provides real day/week/month/list views, Busy/Free and all-day metadata, CAS-safe edits and drag/resize, and bounded daily/weekly/monthly/yearly recurrence with occurrence overrides and DST warnings. Rendezvous now provides a four-step explicit option picker, exact-time local validation, recipient revalidation with stale-slot disabling, and a locally validated single-time counter that the organizer explicitly confirms. Video remains gated on an upstream reviewed media capability because ordinary Neutron tiles cannot request camera or microphone under the current sandbox policy.
- 2026-08-21: rebuilt and destructively reinstalled the final v0.2.0 packages on the two-node local-II fleet. All eight product browser scenarios pass, including compact Agenda layout, focused block-time creation, horizontal-overflow protection at 390 px, and loading an event after navigating beyond the initial year; the ninth diagnostic-only scenario remains intentionally skipped. Final artifacts are 729,548 bytes (Calendar) and 794,109 bytes (Rendezvous).
- 2026-08-21: added canonical reusable `RVC1` sharing addresses, copy/manual-copy UX, strict damaged/noncanonical input rejection, inline resolution, and raw-principal fallback under Advanced. Kept public addresses separate from private per-negotiation `rv1` capabilities. A clean two-node run passes all eight product scenarios, including an encoded-address proposal. Rendezvous is 797,456 bytes.
- 2026-08-21: replaced wire-state badges and duplicate actions with role-aware product language (`Needs your response`, `Waiting for them`, `They suggested another time`, `Scheduled`), contextual accept/decline/cancel labels, a prominent confirmed time, and safe backend-message extraction. Raw state and delivery remain available under Technical delivery.
- 2026-08-21: clean-installed the humanized release candidate and passed all eight product browser scenarios in 1.2 minutes (diagnostic-only ninth skipped). Final artifacts at this checkpoint are 729,548 bytes (Calendar) and 798,397 bytes (Rendezvous).
- 2026-08-21: bounded the desktop calendar height so working-hour scroll position and events are visible instead of an all-24-hour page, retained auto-height compact Agenda, navigated screenshot fixtures to the confirmed week, and visually inspected the four regenerated 1280×720 JPEGs. All are below 74 KB. The exact installed candidate again passes 8/8 product browser cases; final hashes/sizes are recorded in `SUBMISSION.md`.
- 2026-08-21: added a dedicated isolated upgrade fleet and browser regression. It installs the exact Calendar v0.1.0 archive, creates an owner event, exercises Neutron's reviewed local-package update UI with v0.2.0, and verifies the preserved event plus runtime app version 200 and managed-memory schema 2. A clean `npm run test:e2e:calendar-upgrade:fresh` passes in 31 seconds.
- 2026-08-21: added a bounded `workspace.open_tile` Calendar-to-Rendezvous handoff. A fresh timed selection encodes only its future same-day start/end in the tile view; Rendezvous strictly parses it, preloads the exact range as an explicit option, and leaves peer selection and sending under owner control. Unit/package suites pass and the clean two-user browser suite now passes all 9 product cases (diagnostic-only test skipped). Current artifacts are 730,912 bytes (Calendar) and 799,841 bytes (Rendezvous).
- 2026-08-21: completed both existing-event paths. Owner events can start a new explicitly reviewed proposal from their time range. Confirmed Rendezvous events render read-only and open the locally matching confirmed negotiation by exact start/end, with no negotiation capability or Calendar metadata in the tile view. The exact clean-installed artifacts pass all 9 product browser cases in 1.4 minutes. Current artifacts are 731,961 bytes (Calendar) and 801,014 bytes (Rendezvous).
- 2026-08-21: regenerated and visually inspected all six 1280×720 submission JPEGs from a freshly reinstalled exact release candidate. They cover sent/received proposals, each owner's confirmed Calendar, the read-only Calendar meeting view, and the matching highlighted Rendezvous negotiation; every file is below 80 KB and the focused browser flow passes.
- 2026-08-21: reran the isolated browser upgrade against the final 731,961-byte Calendar archive; v0.1 owner data again survives the reviewed v0.2 update with runtime version 200/schema 2. The repository TypeScript project build also passes without diagnostics.
- 2026-08-21: recurrence audit removed two silent truncation bugs: yearly/count series were capped at 18 months and weekly series at roughly 78 weeks. Calendar now materializes the exact count or inclusive-until termination up to 730 rows, rejects larger series with an inline error, uses Monday-anchored interval weeks, reaches the next valid leap day, and preserves exclusive all-day dates across DST. The 19-test Calendar package suite, clean 9-case two-user browser suite, TypeScript build, and exact v0.1→v0.2 installed upgrade all pass. Calendar is 733,316 bytes.
- 2026-08-21: made the existing Rendezvous tray genuinely actionable. It reports only aggregate actionable/total counts, opens or reuses the main tile through a trusted click, and dismisses itself; package and installed-browser checks prove the received meeting title is absent from the tray. The exact-time browser flow now sends Alice's manually chosen 13:17 option and proves Bob receives the identical timestamp. Rendezvous is 801,541 bytes.
- 2026-08-21: clean-installed the exact 733,316-byte Calendar and 801,541-byte Rendezvous release artifacts, passed all 9 product browser scenarios in 1.4 minutes (diagnostic-only test skipped), and regenerated the six submission screenshots from that same build. The installed fleet remains available at the documented Alice and Bob URLs for hands-on review.
- 2026-08-21: added installed-browser coverage for a completely blocked search: Rendezvous explains that no times matched, prevents a zero-option review, lets the owner change the window, and returns concrete selectable options. The exact unchanged release artifacts then passed all 10 product scenarios from a destructive fresh fleet in 1.7 minutes; TypeScript also passes.
- 2026-08-21: promoted availability failure guidance into the workflow: an empty sender search now renders an in-context recovery panel, while a recipient whose entire offer became busy sees that none are open and can immediately suggest another time or decline. The 801,908-byte Rendezvous package passes its complete package/Motoko suites; the exact clean-installed Calendar/Rendezvous pair passes all 10 browser scenarios in 1.7 minutes, and all six screenshots were regenerated from that hash.
- 2026-08-21: re-audited the official live hackathon client bundle. Current gates remain one package up to 1.9 MB, one icon up to 100 KB, up to six screenshots at 400 KB each, and up to six links; Hacker role, wallet, consent, moderator review, and the last-hour content freeze still apply. Both archives, the 80,955-byte icon, and all six sub-79-KB screenshots fit. The live portal countdown remains the authoritative deadline and the final account/upload actions remain human-owned.
- 2026-08-21: added a separate kernel-only release fleet and browser test for the real reviewed File-install path. It installs Calendar first, then Rendezvous from the exact local archives, waits for each in-browser compile and checked upgrade, opens both tiles, and verifies both runtime versions are 200. The destructive fresh run passes in 44.1 seconds.
- 2026-08-21: direct-manipulation integrity audit found two recurrence defects: a drag-style occurrence update with omitted metadata cleared prior overrides, and whole-series rematerialization reset exceptions, including resurrecting cancelled dates. Calendar now preserves existing optional overrides on time-only updates and preserves overridden/cancelled/hold/confirmed occurrence state while refreshing only normal generated occurrences. The expanded Motoko regression proves override retention, cancellation retention, normal-occurrence inheritance, and stale-revision rejection. The rebuilt 734,302-byte Calendar (`9fce191e78effbe62588154e511faf2d9768dd50d40e04fd4787825941df5242`) passes its complete workspace suite, TypeScript, exact v0.1→v0.2 reviewed upgrade, all 10 fresh two-user product browser scenarios in 1.5 minutes, and the clean reviewed Calendar-then-Rendezvous File install. Six screenshots were regenerated; every image is below 80 KB. Synthetic installed-browser pointer drag remains explicitly open because Playwright did not enter FullCalendar's native drag state reliably; backend mutation and CAS rollback semantics are deterministic and covered.
- 2026-08-21: completed installed-browser delivery fault injection without a production test hook. The suite stops Bob through the IC management interface after Alice's draft commits, verifies a clear saved-proposal recovery message and visible Safe retry, restarts Bob, and proves the deterministic retry creates exactly one inbound invitation. The audit exposed that a failed cross-canister update can roll back before a delivery marker commits, so the product now correctly treats an outbound `draft`/`idle` record as recoverable and keeps a conservative backend exception boundary. A unique manual candidate isolates transport recovery from earlier calendar-conflict tests. The complete fresh suite passes 11 product scenarios in 1.7 minutes (diagnostic-only test skipped); clean reviewed File installation passes in 42.7 seconds. Final Rendezvous is 802,353 bytes with SHA-256 `133de9f78e776232708818303ee4b678a6cd0f10a38ab2385d8884cd0a45557e`; all six regenerated screenshots are below 79 KB.
- 2026-08-21: added installed-browser multi-tile reload coverage. Calendar and Rendezvous open side by side, a private busy block persists across a full authenticated shell reload, both app tiles restore, unsent peer-address input is intentionally absent after reload, and both restored surfaces pass the basic accessibility audit. A renewed native-gesture investigation proved FullCalendar renders draggable/resizable classes and enters its real drag mirror under headless Chromium, but both top-frame CDP and frame-local mouse releases resolved to the original hit; the experimental failing case was removed rather than converted into false evidence. Backend move/resize, override preservation, stale rejection, and rollback semantics remain deterministic and green; a human pointer UAT or a reliable upstream interaction harness remains required.
- 2026-08-21: the exact unchanged release artifacts pass the expanded destructive fresh two-user suite with all 12 product scenarios in 1.9 minutes (diagnostic-only test skipped). This validates reload continuity alongside compact Calendar, recurrence, long-range navigation, Calendar/Rendezvous handoffs, exact selection, counters, confirmation/privacy, stale-conflict rejection, and stopped-peer recovery. TypeScript and patch hygiene remain clean.
- 2026-08-21: turned the remaining hardware-shaped and human-comprehension gates into a reproducible five-minute release UAT in `DEMO.md`, including recurrence exceptions, persisted native move/resize, two-tab stale-drag rollback, exact option selection/countering, two-node privacy, reload, and compact layout. The installed reload test now also locks the current security boundary by asserting that an ordinary app iframe grants neither camera nor microphone and that its document policy denies both; this is negative gate evidence, not a claim that video is implemented.
- 2026-08-21: advanced Rendezvous to 0.2.1 and made Contacts 0.3.1 a narrowly scoped composition dependency. Alice can search/select Bob by local name; the backend immediately re-looks up the exact Contact ID, contact revision, book revision, and Neutron principal before creating an offer, while raw `RVC1` remains a fallback. Motoko tests prove a stale/rebound contact creates no negotiation, the installed two-Neutron flow proves Bob receives a Contact-selected proposal, and the dedicated kernel-only browser fixture successfully reviews and installs Contacts → Calendar → Rendezvous with runtime versions 301/200/201. The final responsive-polish archive is 808,243 bytes (`9058aa9a9132f3f8a55cc00b68d874c22413ddfa8de3bff8e5957582be86392c`).
- 2026-08-21: exact-byte 0.2.1 release verification passed the complete destructive fresh two-Neutron suite (`13 passed`, diagnostic-only case skipped) in 2.1 minutes and the kernel-only reviewed Contacts → Calendar → Rendezvous File-install fixture in 58.4 seconds. The screenshot happy path now selects Bob through Contacts, all six 1280×720 JPEGs were regenerated from the same archive, and visual inspection caught/fixed a squeezed Contact-card action before the final rebuild.
- 2026-08-21: closed the installed-browser pointer gap with real Chromium mouse gestures. One clean-state scenario drags and resizes an owner event, reloads after each operation, verifies persisted quarter-hour values, and deletes its fixture; a second uses two tabs to create an occurrence CAS conflict, verifies the stale drag returns to its exact rendered pre-drag time with no drag state, proves the newer value survives refresh, and deletes its fixture. Pointer helpers now foreground multi-tab pages, scroll iframe-owned targets before measuring viewport coordinates, and isolate fixtures from genuine overlapping events. The final destructive two-Neutron run passes all 15 product scenarios in 2.5 minutes (diagnostic-only case skipped); the hardened rollback/cleanup scenario also passes independently afterward. TypeScript and patch hygiene pass. The confirmation/privacy scenario now navigates to each owner's private event month instead of relying on the six-item Upcoming projection, making the persistence proof independent of suite-created event counts. The media design now includes a verified file-by-file implementation map while the authority-changing work remains gated on explicit owner approval.
- 2026-08-21: implemented the approved Neutron core media gate through its
  first compiled vertical slice. Closed manifest/compiler/consent support,
  capability registry authority, Kernel memory V4 and V3→V4 migration, bounded
  single-lease service, certified exact nonce-host media document, focused-tile
  broker, Kernel-owned confirmation, visible device surface, SDK open/close,
  and forced teardown now compile together. Focused TypeScript/SDK/origin tests
  pass, as do the new Motoko lease, V4 schema, and HTTP-origin fixtures. Release
  metadata/evidence and installed-browser permission tests remain before P5 is
  submission-ready; P6 signaling/WebRTC has not started.
- 2026-08-21: closed P5 with Kernel 0.3.13 and Rendezvous 0.2.2 release
  artifacts. The full Rendezvous package and Motoko suite passes (18 frontend
  assertions plus memory/state/retry/wire programs), and the installed
  two-Neutron Chromium confirmation flow passes with exact consent disclosure,
  a distinct certified nonce origin, least-privilege camera/microphone iframe
  delegation, and immediate Kernel teardown. The media page intentionally says
  “Local preview — no peer connected yet”; P6 signaling and WebRTC remain the
  next product milestone.
- 2026-08-21: delivered the first end-to-end P6 direct-call slice in
  Rendezvous 0.3.0. Memory V2 preserves V1 negotiations/receipts and adds a
  bounded 64-signal/128-receipt queue with ten-minute expiry, caller + meeting
  capability binding, duplicate-ID idempotence, paid peer delivery, polling,
  and physical close cleanup. The media client implements perfect negotiation,
  serialized trickle ICE, pre-description candidate queuing, camera/microphone
  start, mute, camera off, leave, remote video, and direct status. Browser
  traces exposed and fixed the parent Permissions-Policy intersection, early
  ICE delivery, and signaling concurrency overflow. The installed Alice/Bob
  scenario now passes in Chromium (28.6 seconds): exact Kernel consent and
  nonce-origin delegation, live fake devices, direct peer connection, remote
  video, privacy assertions, and forced teardown. Final local artifacts are
  Kernel 0.3.13 `ebf85969442a9b38ceaf423aa1a16837b275fa09ae567c5c43b04df979c42dc7`
  and Rendezvous 0.3.0 `96d7ba23dc081deb94800543baba2c7411c7634e0ef90f6bfe4f50060943dc81`.
  STUN/TURN and the remaining adversarial media matrix are explicitly open.
- 2026-08-21: replaced anonymous negotiation labels with locally trusted peer
  identity. Each card reverse-resolves its authenticated peer Neutron principal
  through the owner's Contacts book, shows `From/To <local contact name>` on an
  integrity-checked exact match, and always exposes the full principal beneath
  the name; unknown peers fall back to the full principal. No sender-asserted
  display name or local Contact metadata crosses the protocol. Package, frontend,
  memory/migration, state-machine, retry, hostile-wire, and signaling suites pass.
  The freshly reinstalled two-browser flow also proves Bob sees Alice's local
  Contact name and exact principal and never sees `From another Neutron`
  (`1 passed`, 29.8 seconds). The installed 860,138-byte Rendezvous 0.3.0 archive
  is `0a44ea53936f6de57ce48b6a482b25d3ababf6639762896e7c1d51d645bc2720`.
- 2026-08-20: packaged Kernel 0.3.12, Calendar 0.1.0, and Rendezvous 0.1.0; compiled and installed the complete actor on a two-node PocketIC fleet. Verified Alice `mqrdp-r7777-77775-qaaaq-cai` and Bob `mzsit-hx777-77775-qaaba-cai` healthy at the local gateway. Contacts, agent tools, resident tray, full hostile-wire corpus, and automated browser happy/adversarial flows remain explicitly deferred.
