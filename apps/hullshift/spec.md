# Hullshift implementation contract

Hullshift is a local cargo-and-machinery puzzle game. New games use procedural
`g6` decks with pressure plates, toggle relays, reactor docking, powered bridges,
collapsing floors, and disposal chutes, alongside Sokoban cargo delivery.
Earlier `g5` cargo games and `g4` escape games retain their released behavior.

## Gameplay and generation

The frozen `cargo_puzzles.ts` generator creates connected floor graphs with several architectural
families, chooses goals, and reverse-plays legal pulls from solved arrangements.
Push-space A* searches each candidate using reachable walking regions and
indistinguishable crates. Static reverse distances and goal assignment provide
an admissible heuristic; static dead squares and frozen 2×2 groups prune dead
positions. Production simulation replays the selected forward solution.

Candidate selection considers actual solution pushes, box lines (changes of
pod or pushing direction), turning, returning to a pod, detours away from the
minimum goal-assignment distance, and search difficulty. Scramble length alone
is not a difficulty measure. All difficulty bands draw new geometry and
placements from the seed; they do not select among completed puzzle templates.
Difficulty is a gameplay target, not a claim that every random puzzle is equally
hard. Higher bands add pods, space, and planning demands.

`freight_puzzles.ts` builds on a seeded cargo layout and embeds machinery at
positions used by its solution. It varies control locations, consumer routes,
reactor/chute approaches, and one-way floor placements. Sources start off and
power passages crossed in the route. Complete cuts around bays are preferred
where compatible with the cargo plan. Reactor cells and surplus obstructions
share the cargo passages. Fractures must actually collapse. Every requested
mechanism must participate in a fully replayed solution; failed placements
retry another generated layout instead of dropping the mechanism or choosing
a fixed catalog puzzle. Participation is checked on that route; it is not a
claim that every alternative solution needs every mechanism.

Difficulty increases cargo planning demands and the number of systems, from
one system to all six. Lower bands vary their combinations, rather than
repeating a fixed sequence of tutorial rooms. Use `FREIGHT_DIFFICULTIES` as
the authoritative progression and `SYSTEM_GUIDE` for the player-facing rules.

Generation and off-route hint search run in the resident's embedded Web Worker.
Search work budgets bound candidate evaluation; they do not limit players.
A partial search is neither proof of a deadlock nor an optimal solution. A
candidate is playable only after finding and replaying a complete solution.
There is no timer, lives system, or unlocking requirement.

The generation algorithm is deterministic, including candidate iteration,
search ordering, and seed mixing. Scheduling yields must not affect its result.
Generator identities include the full UInt64 seed and difficulty. Once published,
changes that alter these identities require a successor generator label and
preservation of the released behavior; update the frozen identity tests only
for a new generator version. Rendering and presentation do not affect hashes.

## Engine and saved games

`LevelDefinition.objective === "freight"` uses independent `bay` fixtures.
Cargo must occupy every bay to win; reactor cells and the droid do not count.
Pressure plates remain momentary circuit sources, distinct from parking goals.
Extra cargo may be discarded, but enough must remain for every bay. Reactor
docking is permanent, relays toggle only on droid entry, and bridge/floor losses
use the production engine's existing rules and cascades.

The released `objective === "cargo"` rules remain restricted to plain Sokoban
with `plate` fixtures interpreted as parking bays. Do not reinterpret old
levels using the new bay fixture. The player cannot pull or push a chain.
A dead end remains ordinary play; undo and restart stay available. Both cargo
and freight search use replayed solutions, not an exhaustive winning-state set.

An absent objective retains the released escape rules and canonical level
bytes. Keep old catalog data, share-code formats, analysis, training fixtures,
and circuit mechanics intact. Explicit `g4` generation retains its original
catalog validation. Explicit `g5` generation reproduces the published cargo
algorithm. The home screen and generation tool pass the version from an
imported code through to the worker. Saved games always resume their stored
full level definitions.

The background resident owns commands, revisions, statistics, snapshots,
checkpoints, tile bindings, settings, and completion records. UI and agent tools
use the same resident API. Keep its optimistic revision checks around async
operations. Directional input changes only through the simulation.

The app has no managed Motoko memory roots. Browser state remains in the
existing IndexedDB database and envelope schema. The optional objective and
cargo/freight analysis fields are additive; old saves must restore without rewriting
identity, history, or settings. Never regenerate an old save using the current
generator. Retain old save fixtures as immutable compatibility evidence.

## Hints and presentation

Hints first reuse a remaining known route when the current state matches it;
otherwise they solve the current arrangement. Freight search receives the
complete current snapshot, including relay parity, installed cells, removed
objects, and collapsed floors. Never rebuild it from just player/box positions.
The general search can rejoin a verified route; its weighted ordering does
not establish shortest solutions. Apply the existing work budget to queued
as well as expanded states.

The first hint identifies an approach; the second shows the next meaningful
action with a coordinate-labelled map. Do not skip a switch, power change,
or collapsing floor to suggest a later push.
Recommend undo only after proving the current arrangement unsolvable. Search
exhaustion must say that no route was found yet. Hints never mutate the board.

Three.js renders a shallow diorama, with floor/wall silhouettes, orange pods,
mint bay outlines, and a white droid. Parked pods change appearance and the HUD
counts occupied bays. Gameplay meaning must remain readable beyond color alone.
Camera fitting, pointer coordinate mapping, reduced motion, WebGL recovery,
and disposal belong to presentation, not simulation.

Use arrow keys, WASD, or the direction pad. Preserve focus and keyboard access
to controls and dialogs. The home screen explains pushing, parking, and undo;
the play screen exposes undo, hints, a clickable guide for the systems present,
and live circuit status. Rendered pip counts and the textual circuit legend
must share the same channel ordering. Hint maps distinguish machinery and
current hazards from parking bays. Victory offers another random puzzle or
a harder band. Avoid displaying internal certificate, solver, or pipeline data
as player-facing achievements.

## Verification and release

Run `npm --workspace neutron-hullshift test` for the procedural corpus,
independent exhaustive-solver comparison, deterministic identities, hints,
legacy saves, mixed-system participation and state restoration, and frozen
catalog tests. The corpus checks architecture diversity
even after rotations/reflections, replays every solution, and measures aggregate
progression. It is regression evidence, not a substitute for playing puzzles.

Run `npm --workspace neutron-hullshift run test:browser` for real Web Worker,
IndexedDB, resident tools, input, undo, hints, reload, victory, and responsive
screens. Its test-only transport replaces the enclosing Kernel message bus;
it is never included in production entry points. Screenshot evidence goes in
root `tmp/`. Use the repository's Playwright executable environment variables
when a system browser is required.

The g4 save fixture was produced by unmodified release source at commit
`5500eea`, with an unfinished run. Its test restores, undoes, and completes that
run. The g5 fixture was produced by unmodified release source at commit
`2cf113a` and exercises the same restoration path for published cargo games.
Historical package fixtures also verify that installation has no managed
memory root to reset or migrate.

Follow root `AGENTS.md` and `doc/package-updates.md` for versioning, complete
packaging, offered source, publication, and the required no-op postflight.
Retain the existing app license terms. The Dispenser starter is a separate
release decision.

Generation research: Taylor and Parberry, [Procedural Generation of Sokoban
Levels](https://ianparberry.com/techreports/LARC-2011-01.pdf), particularly reverse
construction and box lines as a measure beyond raw push length.
