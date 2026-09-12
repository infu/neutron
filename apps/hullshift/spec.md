# Hullshift implementation contract

Hullshift is a local Sokoban game: push every cargo pod onto a bay. New games
use procedural `g5` layouts. The earlier escape/circuit game remains available
through its saved runs; its catalog is compatibility data, not new content.

## Gameplay and generation

`cargo_puzzles.ts` creates connected floor graphs with several architectural
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

Generation and off-route hint search run in the resident's embedded Web Worker.
Search work budgets bound candidate evaluation; they do not limit players.
A partial search is neither proof of a deadlock nor an optimal solution. A
candidate is playable only after finding and replaying a complete solution.
There is no timer, lives system, or unlocking requirement.

The generation algorithm is deterministic, including candidate iteration,
search ordering, and seed mixing. Scheduling yields must not affect its result.
`g5` identities include the full UInt64 seed and difficulty. Once published,
changes that alter these identities require a successor generator label and
preservation of the released behavior; update the frozen identity tests only
for a new generator version. Rendering and presentation do not affect hashes.

## Engine and saved games

`LevelDefinition.objective === "cargo"` enables the cargo rules: only cargo
activates a bay, and occupying all bays wins. The player cannot pull or push a
chain. A dead end remains ordinary play; undo and restart stay available.
New cargo games never use a purported complete winning-state set.

An absent objective retains the released escape rules and canonical level
bytes. Keep old catalog data, share-code formats, analysis, training fixtures,
and circuit mechanics intact. Explicit `g4` generation retains its original
catalog validation. The home screen accepts new cargo puzzle codes; existing
saved escape games resume from their stored full level definitions.

The background resident owns commands, revisions, statistics, snapshots,
checkpoints, tile bindings, settings, and completion records. UI and agent tools
use the same resident API. Keep its optimistic revision checks around async
operations. Directional input changes only through the simulation.

The app has no managed Motoko memory roots. Browser state remains in the
existing IndexedDB database and envelope schema. The optional objective and
cargo analysis fields are additive; old saves must restore without rewriting
identity, history, or settings. Never regenerate an old save using the current
generator. Retain old save fixtures as immutable compatibility evidence.

## Hints and presentation

Hints first reuse a remaining known route when the current state matches it;
otherwise they solve the current arrangement. The first hint identifies an
approach; the second shows the next push with a coordinate-labelled map.
Recommend undo only after proving the current arrangement unsolvable. Search
exhaustion must say that no route was found yet. Hints never mutate the board.

Three.js renders a shallow diorama, with floor/wall silhouettes, orange pods,
mint bay outlines, and a white droid. Parked pods change appearance and the HUD
counts occupied bays. Gameplay meaning must remain readable beyond color alone.
Camera fitting, pointer coordinate mapping, reduced motion, WebGL recovery,
and disposal belong to presentation, not simulation.

Use arrow keys, WASD, or the direction pad. Preserve focus and keyboard access
to controls and dialogs. The home screen explains pushing, parking, and undo;
the play screen exposes undo and hints. Victory offers another random puzzle or
a harder band. Avoid displaying internal certificate, solver, or pipeline data
as player-facing achievements.

## Verification and release

Run `npm --workspace neutron-hullshift test` for the procedural corpus,
independent exhaustive-solver comparison, deterministic identities, hints,
legacy saves, and frozen catalog tests. The corpus checks architecture diversity
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
run. Historical package fixtures also verify that installation has no managed
memory root to reset or migrate.

Follow root `AGENTS.md` and `doc/package-updates.md` for versioning, complete
packaging, offered source, publication, and the required no-op postflight.
Retain the existing app license terms. The Dispenser starter is a separate
release decision.

Generation research: Taylor and Parberry, [Procedural Generation of Sokoban
Levels](https://ianparberry.com/techreports/LARC-2011-01.pdf), particularly reverse
construction and box lines as a measure beyond raw push length.
