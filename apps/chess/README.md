# Chess

Chess is a backend-authoritative Neutron app. Every open Chess tile is bound to
its own persisted game, so opening several tiles creates several independent
games.

## Game modes

- **Computer** — choose a color and easy, medium, or hard strength. Search runs
  in a dedicated Blob worker embedded in the tile, including inside Neutron's
  opaque-origin sandbox, and never uses backend CPU for thinking.
- **Local players** — one person moves both colors on the same board.
- **Remote player** — create an invite as the host, or paste an invite into a
  separate Neutron that has Chess installed.

The rules engines cover legal movement and king safety, castling, en passant,
all four promotions, check and checkmate, stalemate, the fifty-move rule,
threefold repetition, and insufficient-material draws. The Motoko engine is
authoritative; the TypeScript engine provides immediate UI behavior and powers
the browser computer.

Chess automatically adjudicates the third repetition and 100th reversible
halfmove. This is the common online-play policy; strict FIDE tournament play
instead requires a player claim at those thresholds (and adds automatic
fivefold/75-move thresholds).

## Agent play

The resident Chess tool host lets an approved Neutron agent, including
Agent, play in **Local players** mode. It exposes three tools:

- `chess_local_games` lists live Chess tiles with local games without silently
  selecting one when several boards are open;
- `chess_position` returns the exact board as FEN, a labeled text diagram, the
  complete retained SAN/UCI move history, and the current legal moves; and
- `chess_move` applies one revision-bound move to the selected tile.

Every inspection and move is bound to the kernel-provided live tile instance.
Moves must echo both the game id and revision from the inspected position, so a
new game or concurrent human move fails closed. The backend adds its monotonic
session generation to every browser-random game id, preventing an old id from
being replayed after a tile starts other games. Only local games are eligible.
The existing Motoko rules engine remains authoritative: illegal moves,
promotion errors, terminal games, and stale revisions return coded tool errors
without being presented as successful agent actions. After a successful move,
the tool host notifies open Chess tiles to refresh their authoritative state.

## Remote protocol

An `NC1-…` invite encodes a version, the host Neutron canister principal, and a
random 128-bit game id. The game id is an unguessable invitation capability
until it is claimed. The first joining Neutron canister is permanently bound as
that game's guest; later state, move, draw, and resignation exchanges require
the same caller principal and expected game revision.

The guest asks Neutron for one persistent, exact backend-call reservation:
the host principal plus the physical Candid method
`app_chess__chess_v1_update`. The request selects the
declared `chess_v1:exchange` route, which is compiler-bound to the synchronous
manifest-local handler `chess_remote_exchange_v1`. The shared dispatcher is the
only public Chess update endpoint. Every exchange currently attaches the
400,000,000-cycle required base charge: the kernel traps a below-base call
before the handler and attributes the accepted base to Chess. Attaching cycles
is also the runtime proof that the caller is a canister; the handler then binds
that peer's principal to the individual game. The handler performs no outbound
calls, bounds every input and response, and validates side, turn, revision,
terminal state, and full move legality before mutation. A self-invite is
intentionally unsupported.

Joining does not silently authorize the reverse direction. Once the local host
UI observes the bound guest in its own backend state, it makes one owner-consent
request for the exact guest principal and the same physical method. Approval
applies that reciprocal reservation and invokes `chess_sync_game` in the same
consent operation, so any durable pending push is retried immediately.
Rejection creates no grant and is not re-prompted by the three-second refresh;
the visible **Retry peer push** action is the explicit retry.

Remote Chess is push-paid, not pull-polled. Guest joins, moves, actions, and the
explicit recovery exchange pay the host. After a host move or action, the host
pays the same fee to push a bounded guest view to the guest Neutron. The host
retains its full authoritative history, while the wire/cache view retains the
most recent 128 plies and only the current repetition key. A compiled
near-maximum encoder test proves this remains below the 32 KiB response and
64 KiB request ceilings.
Pushes carry a revision and are idempotent: duplicates and reordered older
pushes acknowledge the newest cached revision without rolling it back. The host
records a pending revision before yielding and clears it only after the guest
acknowledges that revision. A failed push remains pending; the local UI retries
it through an existing reciprocal grant or exposes the consent action if that
grant is missing. If a guest command loses an uncertain reply, the guest makes
one explicit paid recovery exchange and exposes **Retry sync** if recovery also
fails. The three-second UI refresh queries only its own Neutron's cache and
never polls the peer canister.

The static 400,000,000-cycle base is deliberately conservative for the 13-node
schedule. A route request is capped at 64 KiB. Pricing retained state as twice
that wire size allows for decoded record, array, and text overhead: retaining
128 KiB for 180 days costs about 241.1 million cycles at
127,000 cycles/GiB-second. Add 10 million cycles for the two 5 million-cycle
update executions (the public wrapper and its isolated self-dispatch), up to
about 32.8 million cycles for the bounded 32 KiB reply at 1,000 cycles/byte,
and a 75 million-cycle allowance for validation, chess execution, encoding,
and bookkeeping; rounding up gives 400 million.
The outgoing capability permits that exact amount per call and at most
2.304 trillion cycles/day, equal to the route ceiling of 240 calls/hour for
24 hours. Changes to the base payload, retention, or execution bounds must
update the route base, sender constant, both capability ceilings, and this
calculation together.

The guest treats both response layers as hostile bytes. Exact bounded parsers
validate the shared public-ingress result and Chess `GameResult` wire without a
trapping `from_candid`; frozen vectors, malformed-input sweeps, and a compiled
Motoko encoder check keep that parser aligned with the emitted V1 contract.

Chess intentionally does not auto-release these grants: a delayed release
approval could otherwise disconnect a newer game in another tile. Exact grants
remain visible and owner-manageable in Neutron's backend-call permissions.
Unclaimed host invites expire after 30 days. Session storage is bounded; if many
closed tiles accumulate, finished and waiting games are evicted before active
games, ordered by least recent activity.

An invite is a bearer code before first use. Send it only to the intended
opponent; if it is exposed before they join, start a new hosted game to issue a
new code.

## Development

From `apps/chess`:

```sh
npm test
```

The package flow builds a self-contained `main.js` with its embedded browser
worker payload, generates Motoko metadata, validates managed memory and
capabilities, emits method schemas, and writes `chess.v0.3.3.neutron`.
