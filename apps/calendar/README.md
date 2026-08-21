# Calendar

Calendar is one owner's private scheduling authority. It stores event titles,
notes, location, display color, Busy/Free state, recurrence, confirmed Rendezvous
meetings, and tentative holds in its own managed `calendar` memory roots. No
consumer receives that memory.

The owner tile provides real day, week, month, and list views. Owners can create,
inspect, edit, move, resize, and delete timed or all-day events. Daily, weekly,
monthly, and yearly recurrence is materialized as bounded local occurrences;
individual occurrences or entire series can be changed or removed. UTC
nanoseconds remain authoritative while recurrence is generated in the owner's
local wall time, including explicit DST gap/fold warnings. Count and inclusive
end-date termination are exact up to 730 occurrences; larger series are
explained and rejected instead of silently truncated.

A fresh timed selection or existing owner event can open Rendezvous with that
exact range prefilled. The handoff contains only the bounded start/end
timestamps: no title, notes, location, or attendee crosses app boundaries.
Rendezvous still requires the owner to choose a peer and review the proposal.
Confirmed Rendezvous events are read-only in Calendar and link back to the
matching local negotiation.

Installed apps receive exactly four synchronous `internal:apps` functions:
`calendar_availability_v1`, `calendar_reserve_v1`, `calendar_confirm_v1`, and
`calendar_release_v1`. Availability filters caller-supplied starts; it never
returns busy intervals or private event metadata. Reservations are idempotent by
a 16-byte external ID. The owner UI uses v2 source-bound self calls for sorted
range queries and series/occurrence CRUD; bounded migration converts v1 events
to non-recurring v2 series.

V1 bounds: 2,000 events, 100 events/page, 32 candidates/request, 15–480 minute meetings, a 31-day search horizon, 160-byte titles, and 4,096-byte notes. UTC nanoseconds are authoritative; the display time zone is presentation metadata.

From the repository root:

```sh
npm --workspace neutron-calendar test
```

The package pipeline validates, builds, locks managed memory, creates method
schemas, runs recurrence/domain/migration suites, and produces
`apps/calendar/calendar.v0.2.0.neutron`.
