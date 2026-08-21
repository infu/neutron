# Rendezvous hackathon demo

## Two-minute run

1. Show two labeled browser windows: Alice and Bob are different Neutron
   canisters. Open Calendar's week view. Create a private repeating block by
   choosing a date, time, duration, `Weekly`, and a count; show the generated
   occurrences in the real day/week/month calendar.
2. In Alice's Contacts, add Bob with his Neutron address. Select an open range
   in Alice's Calendar and click `Find a time with someone`; Rendezvous opens
   with that exact range prefilled. Search Contacts for Bob and select him by
   name; point out that his exact address and Contact revision are checked again
   before send. Generate suggestions, then explicitly select a few options. Add
   one exact date/time manually and show that Calendar rejects it if Alice is
   busy. Say: “Alice chooses what she offers; Calendar remains the local source
   of truth.”
3. Refresh Bob. Each option is revalidated against Bob's Calendar and labeled
   `Available` or `No longer available`. Select an available option and accept,
   or use `Suggest another time` to counter with an exact locally checked time.
4. If Bob counters, refresh Alice and explicitly accept the alternative. Open
   both Calendars; both show the confirmed Rendezvous meeting while neither
   exposes the other person's private events.
5. Show the two canister principals and the `rendezvous_v1` route. Say: “This
   is a paid, caller-bound canister call. There is no Rendezvous server and no
   shared calendar database.”

## Calendar proof points

- FullCalendar day, week, month, and agenda/list views with navigation.
- Timed and all-day events, Busy/Free, location, color, editing, deletion,
  drag-to-move, and resize with stale-write rollback.
- Daily, weekly, monthly, and yearly wall-clock recurrence with count or end
  date, plus “This event” and “Entire series” edit/delete choices.
- Availability is derived from concrete local occurrences and tentative holds;
  private titles, notes, and busy intervals do not cross the proposal protocol.

## Why this is not Calendly

Calendly centralizes availability and account data. Rendezvous composes two sovereign Calendar apps and exchanges only bounded proposal state. The receiver binds a random capability to the caller principal, filters locally, uses idempotent holds and deduplicates retries.

## Failure beat (optional)

Create a conflicting event after an option is offered, refresh the proposal to
show `No longer available`, and show that it cannot be selected. For uncertain
delivery, explain that “the peer may have committed” and use Safe retry; the
same command ID makes it idempotent.

## Submission checklist

- Architecture: `Calendar A ←internal→ Rendezvous A ←paid ingress→ Rendezvous B ←internal→ Calendar B`.
- Sharing: the primary picker uses a local Contacts label and revalidates the
  bound principal before send. The fallback `RVC1` address wraps only that
  principal; neither is a login secret or the per-negotiation capability.
- Threats: wrong caller, leaked invite capability, replay/reorder, malformed/oversize payload, low cycles, lost reply, mid-flight conflict.
- Privacy proof: grep protocol observations/logs for the two private seed titles; both must be absent.
- Limitations and exact build commands are in each app README.
- Chess transport adaptation is attributed in NOTICE and the implementation log.
- Follow [`SUBMISSION.md`](SUBMISSION.md) for current portal requirements, release hashes, screenshots, and the final upload procedure.

## Five-minute release UAT

Run this after a fresh local deployment in desktop Chromium. Sign in as Alice
at <http://mqrdp-r7777-77775-qaaaq-cai.localhost:8000/> and Bob at
<http://mzsit-hx777-77775-qaaba-cai.localhost:8000/>. Use the authorized local
Internet Identity seeds for those two principals; a seed is an identity, not a
Neutron authorization code.

1. In Alice's Calendar week view, click `Block time`. Create a visibly named
   weekly block with a start, duration, and count of 3. All three occurrences
   must land at the chosen local wall-clock time. Reload, edit only the second
   occurrence, reload again, and verify the override remains while occurrences
   one and three retain the series values.
2. Create a one-off event from 10:00–11:00. Drag it to 11:00–12:00, reload, and
   verify the new range. Resize its end to 13:00, reload, and verify the two-hour
   duration. For stale-write rollback, open Alice's Calendar in two tabs and
   leave the same event visible in both. Edit and save it in tab A, then drag
   the stale copy in tab B. It must snap back, show an actionable stale-change
   message, and display tab A's committed value after refresh.
3. In Alice's Contacts, add or edit Bob with Bob's Neutron canister address.
   Select a free range in Alice's Calendar and choose `Find a time with
   someone`. Confirm that Rendezvous preloads that exact range but sends
   nothing yet. Search for Bob by Contact name, select him, verify the UI says
   his address is checked again before send, add an unusual exact time such as
   13:17, select the options to offer, review them, and send. Repeat once with
   Bob's fallback `RVC1-…` address if time permits.
4. In Bob's Rendezvous, refresh the request. Every offered option must say
   `Available` or `No longer available`; unavailable options must be disabled.
   Choose an available option or explicitly counter with another exact time.
   Alice must explicitly confirm a counter. After confirmation, reload both
   Calendars and verify the same meeting range appears in each without either
   user's unrelated private titles appearing on the other node.
5. Open Calendar and Rendezvous together on Alice, type but do not send Bob's
   address, and reload the shell. Both tiles and saved Calendar events must
   return; the unsent address must not. Narrow the viewport to phone width and
   verify Calendar switches to Agenda without horizontal page overflow.

Stop the release for any silent time change, random candidate, lost recurrence
exception, draggable event that does not persist, stale drag that does not roll
back visibly, selectable busy option, duplicated invitation, private-title
leak, or reload data loss.

Video now uses the reviewed P5 architecture: an ordinary app tile still denies
camera and microphone, while an explicit Join action opens a Kernel-owned,
revocable one-time nonce-origin media surface. The P6 installed two-browser
fake-media path passes. For the demo, describe it as direct browser WebRTC with
Neutron-carried signaling—not production Internet calling—because STUN/TURN and
relay fallback are not configured yet.
