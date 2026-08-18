# Hullshift — Neutron Game Specification and Implementation TODO

**Status:** HullshiftBrain `g4` pipeline and frozen-catalog runtime implemented;
pilot catalog curation and release evidence remain in progress
**Updated:** 2026-07-17
**Genre:** Deterministic, turn-based grid puzzle with a 3D diorama presentation
**Platform:** Neutron web app
**Current level identity:** `g4` seed and difficulty deterministically select a
certified entry from the shipped catalog
**Compatibility:** legacy identity and share-code parsing remains available for
existing `g1`, `g2`, and `g3` saves. Those frozen versions cannot create new
missions.

Hullshift is a deterministic grid puzzle inspired by Sokoban, presented as a
top-down, slightly tilted 3D spacecraft diorama. A small maintenance droid must
push cargo, route power, alter ship systems, and enter an operational evacuation
gate aboard a damaged spacecraft.

HullshiftBrain searches for maps offline in Python, then treats production
TypeScript mechanics and exact analysis as the certification authority. The
browser does not run Python or synthesize a board: `src/generator.ts` uses a
frozen, versioned `g4` catalog, deterministically selects by seed and requested
difficulty, validates the level and hash, replays its witness, reruns exact
analysis, and compares the stored certificate before returning a mission.

The committed catalog is a **pilot** artifact until every difficulty band is
populated and the separate release policy passes. Pilot certification is a
deterministic structural screen, not a claim of human-calibrated difficulty.
Release additionally requires stricter interaction gates, corpus/diversity
evidence, human calibration, and frozen catalog bytes. Fixed-point ablation may
be used as a level-design diagnostic, but it is not a release requirement.
If a requested band has no certified entry, generation fails explicitly and
the previous saved mission remains intact.

> Section 10 preserves the retired in-browser `g2` design as historical
> reference. The authoritative `g4` implementation and release checklist live
> in [`../../todo.hullshiftbrain.md`](../../todo.hullshiftbrain.md).

## Checklist rules

- `[x]` means the item is present and verified in the current repository, not
  merely designed or partially implemented.
- `[ ]` means implementation, verification, or a named product decision is
  still required.
- A code item may be checked only after its focused tests pass. A phase gate may
  be checked only after every required item in that phase is complete.
- Deferred items remain unchecked until intentionally implemented; moving an
  item out of V1 requires an explicit spec edit rather than silently skipping it.

## Current repository state

- [x] Capture the original game concept, deterministic generation goal,
  mechanism library, solver model, and difficulty ideas.
- [x] Review the concept from gameplay, UX/accessibility, and Neutron app
  architecture perspectives.
- [x] Define the V1 product boundary, Neutron package shape, supported
  difficulty range, and deterministic analysis limits in this document.
- [x] Create the Hullshift app package with its tile, persistent resident, pure
  engine, exact analyzer, training missions, and GPU renderer.
- [x] Remove the previous map-generation algorithms, policy, forge scripts,
  catalog, sampler, banding, and procedural-construction modules.
- [x] Implement the offline Python HullshiftBrain proposal/search/export tools,
  strict schemas, resumable deterministic shards, and focused parity tests.
- [x] Implement the TypeScript milestone DSL, exact proof metrics, pilot/release
  quality policies, catalog parser/selector, and independent certifier.
- [x] Replace the unavailable seam with strict `g4` catalog selection and
  runtime recertification; never manufacture or persist an empty/dummy level.
- [x] Retain `g1`/`g2`/`g3` share-code parsing without permitting those frozen
  identities to create a new mission.
- [ ] Populate the shipped pilot catalog with at least one independently
  certified level in every difficulty band.
- [ ] Complete large-scale search, catalog cardinality/diversity selection,
  held-out human calibration, and the `g4` release freeze.
- [ ] Generalize the remaining required access, freight, and terminal operation
  counts beyond the bounded V1 core described in Stage 2.
- [ ] Implement and verify every V1 release gate below.

---

## 1. Locked V1 product decisions

These decisions give implementation a stable spine. Changing one requires
updating golden levels, compatibility behavior, and the affected checklists.

### Product and scope

- Hullshift's rules remain a strictly 2D grid, rendered as code-native 3D models
  with Three.js and `WebGLRenderer`. Use a slightly tilted orthographic camera;
  visual Z gives deck, walls, machines, and occupants readable volume but never
  changes collision, movement, hashing, solving, or generation. Perspective,
  depth-dependent movement, real-time movement, and timing puzzles are out of
  scope.
- The presentation target is Jetcreeper's self-contained GPU discipline applied
  to a grid puzzle: bundled Three.js, batched/instanced 3D models, shader-driven
  energy effects, antialiased material lighting, and a bounded whole-scene
  color-grade pass. Jetcreeper is the performance/packaging reference, not a
  mandate to pixelate Hullshift's modeled diorama.
- The game is deterministic after a mission begins. Animation timing, device
  speed, frame rate, and wall-clock time never affect game state.
- V1 supports catalog difficulties `0` through `8`. Internal identity/share
  parsing rejects another value; it is never silently clamped.
- The normal product has no training campaign or mission archive. Difficulty
  `0` is a gentle certified introduction, and Help explains mechanics with the
  same production 3D models used on the board. Legacy authored training levels
  remain internal certification fixtures only.
- V1 includes a deliberately bounded mechanism set: pushing, plates, doors,
  reactor cells and sockets, relays, powered bridges, fracture decks, vacuum,
  and disposal airlocks.
- Lasers, prisms, rails, inertia, warp pads, and polarity fields remain designed
  extensions, but are not V1 implementation dependencies.
- V1 has no global leaderboard, competitive integrity claim, remote analytics,
  cross-device save synchronization, cross-app tools, tray, external
  connections, scheduled work, or network-loaded content.
- Completion metrics are descriptive. Time, rewind use, hints, touch controls,
  reduced motion, and other accessibility choices do not reduce rewards or
  block progression.

### Neutron terminology

- **Neutron kernel** means the trusted operating-system shell only.
- **Simulation core** means Hullshift's pure state transition rules.
- **Generation worker** means the dedicated browser worker that selects a
  frozen catalog entry, replays its witness, and independently recertifies it.
- **Resident game service** means Hullshift's persistent background process,
  which owns runs and local saves.
- Player-facing fiction may call analysis the **ship computer**. Hullshift UI
  must not imitate Neutron install, authorization, signature, or approval UI.

### V1 persistence choice

- The resident game service is the single authority for active runs, revisions,
  undo history, generation jobs, settings, and completion summaries.
- It uses its approved dedicated app origin and IndexedDB for local persistence.
- Saves are local to the current browser profile. Share codes reproduce a level,
  not the player's progress.
- If persistent storage is blocked or unavailable, play continues in volatile
  memory with a persistent `Autosave unavailable` warning. The app never claims
  that volatile progress is durable.
- The V1 Motoko module is intentionally empty. The game has no canister-backed
  state or public backend methods.
- The resident retains the last generated game for Continue. Starting another
  mission never fails because an internal run cap is full: the previous
  unbound generated run is replaced only after the new mission is certified.

---

## 2. Design pillars

### Deterministic systems

- [x] Make every legal `(stable state, action)` pair resolve to exactly one
  stable result.
- [x] Use randomness only while generating a level or choosing non-gameplay
  presentation details.
- [x] Ensure the same generator version, seed, and difficulty produce identical
  canonical level bytes and the same level hash across supported runtimes.
- [x] Keep animation, audio, current date, locale, display size, and device
  performance outside simulation and generation decisions.
- [x] Keep GPU model, shader, driver, frame rate, device pixel ratio, and render
  precision outside canonical level/state bytes and solver decisions.

### Consequential pushing

- [x] Make walking useful for inspection and positioning without treating empty
  distance as difficulty.
- [x] Make pushes, circuit changes, one-use terrain, resource loss, and crossing
  commitment boundaries the meaningful decisions.
- [x] Do not add pulling, chain-pushing, free object rotation, or an all-purpose
  `Use` action in V1.

### Visible cause and effect

- [x] Identify each circuit with both a stable symbol and a color.
- [x] Show every source-to-consumer link, current source state, and affected
  consumer state.
- [x] Give momentary, toggled, permanent, and destroyed states different
  silhouettes or persistent marks.
- [x] Reveal an off-camera consequence before accepting the next move.
- [x] Never require a player to infer hidden links, random resolution order, or
  an exception that contradicts the mechanic reference.

### Failure with recovery

- [x] Permit understandable physical and causal failures.
- [x] Detect a proven unwinnable state as soon as the fatal transition settles.
- [x] Let the player rewind exactly the fatal transition or restart the level.
- [x] Keep failure diagnostic but non-spoilery: explain what became impossible,
  not the remaining winning sequence.
- [ ] Avoid tutorial situations where harmless exploration is one accidental
  input away from an unexplained loss.

### Difficulty from reasoning

- [x] Measure decision structure rather than board area, walking distance,
  decoration count, or repeated corridor pushes.
- [x] Increase difficulty through dependency depth, planning horizon,
  interleaving, mechanic coupling, and controlled commitments.
- [x] Cap fatal-choice pressure so high difficulty does not become arbitrary
  trial and error.

---

## 3. Player experience state machine

The tile uses in-app states rather than HTTP routes:

```text
boot
  -> home
      -> difficulty slider -> generating -> briefing -> playing
      -> continue -> playing
playing
  -> menu/help/settings -> playing
  -> physical failure | causal failure -> rewind | restart | inspect
  -> victory -> replay | new mission | home
any loading state
  -> recoverable error | technical error
```

### Boot and home

- [x] Load the resident snapshot before presenting actions that depend on saves
  or learned mechanics.
- [x] Show a bounded loading state with `aria-busy` while the resident connects.
- [x] Provide `Continue last game` only when a compatible generated save exists.
- [x] Provide one difficulty slider, `Start mission`, optional
  `Continue last game`, `Help`, and `Settings` on the home surface.
- [x] Keep training, archive management, seeds, hashes, generator versions, and
  share-code plumbing out of the normal player-facing start flow.
- [x] Surface volatile-storage mode before the player starts or resumes a run.
- [x] Recover from a resident restart by reconnecting and fetching a full
  authoritative snapshot rather than trusting stale tile state.

### Mission setup

- [x] Let the player select a labeled difficulty `0..8` with a range slider and
  show a one-sentence description of the selected band.
- [x] Generate the mission seed internally with cryptographically strong browser
  randomness; never expose seeds, hashes, or share codes in the normal setup UI.
- [x] Keep mission setup sandbox-safe: use explicit button handlers and never
  rely on native form submission inside the sandboxed tile.
- [x] Retain canonical seed/share parsing and distinct validation errors as an
  internal compatibility boundary for legacy identities and tests.
- [x] Never alter a valid requested seed, difficulty, or generator version after
  generation fails.
- [x] Keep the previous generated run until its replacement has successfully
  generated and certified; generation failure never destroys Continue state.

### Generation

- [x] Select a `g4` catalog entry deterministically from the canonical seed,
  requested difficulty, stable sorted IDs, and frozen unbiased SHA-256 mapping.
- [x] Strictly validate the catalog/level schema, canonical hash, witness,
  mandatory milestones, required precedence, difficulty, and exact certificate
  before returning a mission.
- [x] Distinguish pilot certification from the stricter release gate; never
  describe pilot thresholds as human calibration.
- [x] Keep any previously saved mission intact when generation is requested.
- [x] Never substitute a dummy, fallback, authored map, different difficulty,
  or altered seed when selection or certification fails.
- [ ] Ship certified pilot entries for all nine difficulty bands.
- [ ] Complete release-quality search, diversity, performance,
  repeat-rate, and human-calibration gates before freezing `g4`.

### Briefing

- [x] Show the evacuation objective, difficulty label, and mechanics present in
  the mission without exposing generator identity.
- [x] Call out a newly introduced mechanic with its exact name and one-sentence
  rule; Help carries the full production-model visual reference.
- [x] Let experienced players skip previously seen briefings.
- [x] Do not expose the witness solution, fatal frontier, optimal path, or
  internal candidate score in the briefing.

### Playing

- [x] Make the board the dominant surface.
- [x] Keep persistent chrome to objective status, Undo, Restart, a direct Lobby
  exit, Menu, compact circuit status, and the last important effect.
- [x] Keep Mission Details player-facing: difficulty, board dimensions, systems,
  and circuit relationships only; do not expose seeds, hashes, or certificates.
- [x] Suspend board input while a modal, resolution animation, failure,
  victory, or reconnect state owns interaction.

### Failure

- [x] Complete the action and show its environmental consequence before the
  failure panel appears.
- [x] Distinguish physical from causal failure and show an affected system or
  resource symbol when known.
- [x] Focus `Rewind` as the primary action and provide `Restart`, `Inspect
  board`, and `Exit to lobby` as secondary actions.
- [x] If no safe specific explanation can be proven, use the truthful generic
  reason `No evacuation route remains`.
- [x] Never continue accepting moves after a terminal failure.

### Victory

- [x] Resolve the final stable turn and evacuation reaction before showing the
  results panel.
- [x] Show difficulty, accepted actions, pushes, commitments, rewinds, hints,
  and optional active solve time.
- [x] Compare actions and pushes with solver-derived reference values without
  turning the comparison into a punitive score.
- [x] Offer `New mission at this difficulty`, `Replay`, `Mission details`, and
  `Exit to lobby` without exposing share codes or hashes.

---

## 4. Controls and turn contract

### Input map

| Action | Keyboard | Pointer/touch |
| --- | --- | --- |
| Move north/west/south/east | Arrow keys or `WASD` | Labeled four-way D-pad |
| Undo | `U` or `Ctrl/Cmd+Z` | Undo button |
| Restart | `R` | Restart button |
| Menu/pause | `Escape` | Menu button |
| Exit without deleting the save | — | Lobby button or `Exit to lobby` |

- [x] Accept one direction per non-repeated key press; ignore `KeyboardEvent`
  repeat for movement.
- [x] Keep movement keys live across the board, D-pad, and non-editable game HUD
  so a pointer interaction cannot silently strand keyboard movement. Do not
  capture them while a text input, select, textarea, editable region, or modal
  owns interaction.
- [x] Prevent arrow-key page scrolling only while a playable run owns the
  movement shortcut context.
- [x] Do not queue directions during resolution or animation.
- [x] Give blocked walking and blocked pushing different brief feedback without
  recording a turn.
- [x] Use D-pad targets of at least `40×40` CSS pixels on coarse pointers.
- [x] Keep swipe and gamepad input out of V1; they may be added only as
  edge-triggered one-action alternatives.
- [x] On document visibility loss, suspend audio and decorative animation but
  do not change puzzle state or active solve time.

### Directional action

For direction `a ∈ {N,E,S,W}`, the simulation attempts exactly one of:

1. If the adjacent cell is legally enterable, move the player into it.
2. Otherwise, if it contains one pushable object and the cell beyond can accept
   that object, atomically move the object one cell and the player into the
   object's former cell.
3. Otherwise return a no-op with a blocked reason.

- [x] Prevent pulling and pushing two objects as a chain.
- [x] Evaluate entry legality from the pre-action stable state.
- [x] Treat a successful push as one action and one push, regardless of later
  deterministic device reactions.
- [x] Record only accepted actions in undo history and run statistics.
- [x] Keep an explicit event trace for presentation and failure explanation.

### Undo, restart, and pause

- [x] Undo to the immediately preceding stable state, including ordinary
  movement, device memory, installed cells, collapsed terrain, object loss,
  counters, and camera-relevant event context.
- [x] Permit repeated undo to the level start. Branching after undo discards the
  abandoned future branch.
- [x] Make `Rewind` after failure exactly one Undo of the fatal transition.
- [x] Make restart reconstruct the exact initial state without regenerating.
- [x] Treat pause as an interface state: it blocks input and audio but does not
  advance or mutate a turn-based puzzle.

---

## 5. Formal puzzle model

### Coordinate and board limits

- Coordinates are integer `(x,y)` pairs with `(0,0)` at the top-left.
- Canonical cell order is row-major, then layer order.
- V1 boards are between `7×7` and `16×16` cells.
- V1 candidates contain at most `160` non-bulkhead cells, `8` movable objects,
  `4` channels, `24` stateful fixtures, and `16` monotonic milestones.
- Every limit is pinned by generator version. Frozen `g1` remains unchanged;
  changing a limit in a way that changes returned output requires another
  generator-version decision after current `g4`.

- [x] Reject candidates outside every declared structural bound before exact
  analysis.
- [x] Validate that every object, fixture, channel, and link has a stable unique
  identifier in canonical output.
- [x] Keep decorative cells outside the simulation model.

### Cell layers

Each cell has four conceptual layers:

| Layer | V1 examples |
| --- | --- |
| Terrain | Hull floor, bulkhead, vacuum, fracture deck |
| Fixture | Plate, relay, socket, door, bridge, disposal airlock, gate |
| Occupant | Player, cargo pod, reactor cell |
| Field | Powered/unpowered channel presentation |

- [x] Permit only combinations listed in the mechanic compatibility table.
- [x] Reject overlapping terrain, fixture, or occupant combinations with no
  explicit rule.
- [x] Derive fields and momentary circuit states; do not store duplicate values
  that can disagree with source state.

### Stable state

For level definition `L`, the canonical puzzle configuration is conceptually:

\[
q = (p, O, R, K, H)
\]

where:

- `p` is the player position;
- `O` is the ordered set of movable object positions and types;
- `R` is the relay bitset;
- `K` is the set of permanently installed reactor cells;
- `H` is the set of collapsed fracture cells and removed objects.

A runtime snapshot is `(q,Z)`, where `Z` is `playing`, `physical-failure`,
`causal-failure`, or `victory`. `Z`, counters, and UI history are result/session
data rather than inputs to ordinary successor generation. Failure outcomes are
classified terminal transitions; victory is a terminal goal tag.

Plate occupancy, powered channels, door state, bridge state, and presentation
fields are derived from `(L,s)`.

- [x] Canonically sort object and device records rather than relying on object,
  map, or set iteration order.
- [x] Use finite integer and bitset domains only.
- [x] Exclude animation state, wall-clock time, camera position, audio state,
  and UI focus from the puzzle state.
- [x] Produce a canonical byte encoding and stable hash for every state.
- [x] Spawn every gameplay entity in the certified initial level; V1 has no
  mid-level entity spawning, autonomous actors, timers, or gameplay randomness.

### Stable turn resolution

For stable state `s` and action `a`, `T(s,a)` has at most one stable result. A
successful turn resolves in this exact order:

1. Validate and atomically apply the walk or single push against pre-turn
   passability.
2. Record entity exits and entries in object-id order; apply direct entry/exit
   effects such as relay toggles, socket docking, occupancy-transition fracture
   collapse, disposal, and gate entry.
3. Apply all permanent terrain/object changes from those events.
4. Derive all source outputs from the new base state.
5. Derive channel values simultaneously using OR semantics.
6. Derive every consumer state simultaneously; apply bridge loss/failure and
   occupied-door jam rules.
7. Repeat derivation only if a rule explicitly removed an object or player;
   stop after the fixed V1 cascade bound of `32` internal passes.
8. Resolve physical failure.
9. Resolve victory.
10. Canonicalize the stable state and test membership in the precomputed
    winning set; if absent, resolve causal failure.

- [x] Reject a generated candidate that needs more than `32` internal passes,
  contains an oscillation, or reaches an ambiguous simultaneous outcome.
- [x] Apply simultaneous losses in stable object-id order for event reporting,
  while ensuring the order cannot change the final state.
- [x] Resolve rules immediately; make animation a later rendering of the event
  trace.
- [x] Accept the next input only after presentation has reached the returned
  stable state or the player fast-forwards eligible known feedback.

### Initial settlement

- [x] Derive starting plate outputs, channels, doors, sockets, bridges, and gate
  state once before play without firing entry/exit triggers or consuming a turn.
- [x] Do not toggle a relay, collapse a fracture deck, dock a cell, dispose an
  object, or win merely because an entity starts on a fixture.
- [x] Reject any candidate whose initial placement needs such an entry effect to
  become valid.
- [x] Reject any initial board that is terminal, has overlapping occupants,
  starts the player in a hazard, places an entity on unsupported terrain, or
  cannot settle to one valid derived state.

---

## 6. V1 tile and mechanism library

### Compatibility rules

- A cell has exactly one terrain type.
- At most one fixture and one occupant may be present.
- A player or object may occupy floor, an intact fracture deck, an open door,
  an active bridge, an empty socket, a plate, or a relay when that entity is
  accepted by the fixture.
- A closed door, inactive gate, installed socket, bulkhead, and player-blocking
  disposal airlock are not enterable.
- Vacuum and an inactive bridge accept entry as a fatal/loss transition rather
  than as a stable occupied cell.
- V1 generation does not stack a plate, relay, socket, door, bridge, airlock,
  or gate on one another.

- [x] Encode and validate this compatibility matrix in one shared rules table.
- [ ] Use the same table in generation, simulation, solver expansion, renderer
  assertions, and mechanic-reference content.

### Structural terrain and objective

| Element | Exact V1 behavior | Purpose |
| --- | --- | --- |
| Hull floor | Traversable by player and movable objects. | Basic maneuvering. |
| Bulkhead | Blocks player, objects, and circuit-link routing. | Topology and pushing constraints. |
| Vacuum | Player entry is physical failure; pushed objects are permanently lost. | Hazard and resource loss. |
| Evacuation gate | Closed and blocking until its channel is active; only the player may enter. Legal entry snapshots that the gate was active, then wins after physical-failure precedence. | Universal objective. |

- [x] Give the active gate a persistent, non-color-only ready state.
- [x] Prevent victory from merely standing on an inactive gate when it becomes
  powered; the player must enter an already active gate.
- [x] Base gate-entry legality on the pre-turn stable channel state and retain
  that entry fact through post-move circuit recomputation.
- [x] Reject a level whose start position is hazardous or already victorious.

### Movable objects

#### Cargo pod

- [x] Make cargo pods pushable, plate-activating, and permanently removable by
  vacuum or a disposal airlock.
- [x] Let cargo serve as a movable weight, blocker, and staging resource without
  assigning every pod a unique destination.
- [x] Detect static corners and exact causal deadlocks; do not rely on corner
  heuristics as the final solvability proof.

#### Reactor cell

- [x] Give reactor cells normal one-cell push behavior and plate mass.
- [x] Dock a cell permanently when it is pushed onto an empty reactor socket;
  replace the movable occupant with the socket's installed state.
- [x] Make an installed socket blocking and irreversible in V1.
- [x] Treat losing a required undocked cell as a causal failure after the turn
  settles.

### Circuit sources

#### Mass plate

- [x] Use one universal V1 mass rule: player, cargo pod, and undocked reactor
  cell all activate a plate while occupying it.
- [x] Derive plate output from occupancy with no stored toggle state.
- [x] Display both the plate's channel symbol and depressed/released state.

#### Relay pad

- [x] Toggle a relay only when the player enters it from another cell.
- [x] Do not toggle from cargo/reactor occupancy, remaining on the pad, Undo
  replay, animation, or reconnect.
- [x] Persist the relay bit until a later distinct player entry toggles it.
- [x] Show both binary positions without relying only on color.

#### Reactor socket

- [x] Let player and non-reactor movable objects traverse an empty socket.
- [x] Accept and lock exactly one reactor cell.
- [x] Output its channel permanently after docking.
- [x] Prevent removal, traversal, or repeat docking once installed.

### Circuit consumers

#### Blast door

- [x] Make an unpowered unoccupied door closed and blocking.
- [x] Make a powered door open and traversable.
- [x] If power is lost while the player or an object occupies the door cell,
  keep it jammed open until vacated; then close it during the same turn.
- [x] Ensure a door never crushes, displaces, or overlaps an entity.

#### Phase bridge

- [x] Make an active bridge traversable and an inactive bridge equivalent to
  visible vacuum.
- [x] If it deactivates beneath the player, resolve physical failure.
- [x] If it deactivates beneath an object, remove that object before causal
  failure analysis.
- [x] Show destabilization before the failure/loss panel without delaying the
  logical result.

### One-way consequences

#### Fracture deck

- [x] Let an intact fracture cell support the player or one object.
- [x] Collapse it into vacuum only when atomic turn occupancy changes from
  occupied to empty. If a pushed object leaves while the player enters its old
  cell, the deck remains intact until the player later leaves.
- [x] Do not collapse it from an attempted blocked move or from merely entering.
- [x] Restore it through Undo and level restart only.

#### Disposal airlock

- [x] Accept a pushed cargo pod or reactor cell and remove it permanently.
- [x] Block player entry in V1; use vacuum for player-fatal holes.
- [x] Clearly distinguish the airlock from ordinary floor before a push.
- [ ] Permit generated levels to require disposal of an obstructing object, but
  reject hidden required-object guessing.

### Circuit semantics

- [x] Give each source exactly one channel and each consumer exactly one channel
  in V1.
- [x] Combine multiple sources on one channel with visible OR behavior.
- [x] Recompute all channel values simultaneously after the base state changes.
- [x] Do not generate AND gates, negation, feedback loops, delayed signals, or
  channel-controlled motion in V1.
- [x] Provide a compact legend mapping channel symbols/colors to their sources,
  consumers, and current state.

---

## 7. Internal fixtures and mechanic progression

Hand-authored mechanic missions remain independently certified internal test
fixtures with fixed identities. They use the production simulation and solver,
but they are not presented as a player-facing training campaign.

- [x] Training 1 teaches four-way movement, one-cell pushing, blocked pushes,
  Undo, and entering an already active gate.
- [x] Training 2 teaches a universal mass plate and visibly linked blast door
  with no fatal move.
- [x] Training 3 teaches reactor-cell docking as a permanent circuit source and
  introduces restart after an intentional safe demonstration.
- [x] Training 4 teaches relay toggling and the difference between momentary and
  persistent power.
- [x] Training 5 teaches powered bridges, vacuum loss, causal failure, and
  Rewind.
- [x] Training 6 teaches fracture decks and disposal, first separately and then
  in one small dependency chain.
- [x] Use difficulty `0`, concise mission briefings, and the production-model
  Help gallery as the player-facing learn–test–combine path.
- [x] Keep all training selection/replay entry points out of Home and Help.
- [x] Track learned-mechanic flags locally for briefing behavior only; learned
  flags never alter generation or puzzle rules.

V1 procedural mechanic bands:

| Difficulty | Allowed character |
| ---: | --- |
| 0 | Cargo, plate, door; generous space; no required fatal commitment. |
| 1 | Add reactor cell/socket; at most one irreversible required action. |
| 2 | Add relay; short dependencies and clear recovery. |
| 3 | Add bridge/vacuum; first visible causal failures. |
| 4 | Add fracture deck or disposal, not both in the same first-introduction mission. |
| 5–6 | Reuse resources, temporary power, two or three coupled families. |
| 7–8 | Multi-zone interleaving, longer horizons, controlled irreversible choices. |

- [x] Encode allowed mechanic families and combination constraints per
  difficulty in versioned generator data.
- [x] Reject a candidate that introduces a mechanic outside its band or before
  its required visual explanation can be shown.

---

## 8. Difficulty model

Difficulty is a requested ordinal target, not a promise that every larger
natural number is supported by one finite generator version. V1 accepts only
`0..8`; future ranges require a new calibrated contract.

### Decision graph

The analyzer compresses neutral repositioning while preserving every action
that can alter objects, device memory, terrain, future reachability, failure,
or victory.

For each base state:

1. Flood-fill only ordinary safe cells reachable without entering a fixture,
   hazard, one-way consequence, or state-changing cell.
2. Represent that neutral region by its least row-major coordinate.
3. Emit macro edges for each unique legal boundary entry or push, retaining a
   deterministic shortest approach path for replay.
4. Merge successors with identical canonical states and retain the
   lexicographically smallest action witness.

- [ ] Prove the macro compression exact for V1 by comparing it with an
  uncompressed oracle on exhaustive small boards.
- [x] Keep neutral walking length for solution replay and UX metrics without
  treating each step as a major commitment.
- [x] Treat plate entry, relay entry, fracture departure, gate entry, bridge
  loss, disposal, and every push as decision edges.

### Measured features

| Symbol | Feature | Operational definition |
| --- | --- | --- |
| `A` | Optimal commitment count | Minimum number of meaningful macro edges on a winning path. |
| `D` | Mandatory dependency depth | Longest strict order chain among mandatory milestone events. |
| `P` | Planning horizon | Longest number of intervening commitments between a mandatory enabling event and first mandatory use of its effect. |
| `I` | Interleaving | Maximum simultaneously open generated obligations on an accepted near-optimal solution trace. |
| `R` | Irreversibility | Required non-undoable-in-forward-play transitions on the preferred solution. |
| `B` | Decision pressure | Mean `log2(1+b_s)` at meaningful states with `b_s` non-equivalent legal successors, excluding immediate inverse/no-op edges. |
| `X` | Cross-mechanic coupling | Mandatory dependency edges whose endpoints belong to different mechanic families. |
| `E` | State-space complexity | `log2(1+|V|)` for reachable canonical decision states. |
| `F` | Fatal-choice pressure | Plausible fatal successors divided by plausible meaningful successors at sampled winning choice states. |

Milestones are explicit predicates emitted by procedural grammar productions. A
milestone is mandatory only if forbidding all transitions that emit it removes
every path to victory. Precedence between two mandatory milestones is checked
with a two-bit history augmentation; the resulting strict relation must be
acyclic before its longest chain is measured.

- [x] Define every V1 milestone predicate and mechanic-family tag in versioned
  data.
- [x] Compute mandatory status and ordering from the analyzed graph rather than
  trusting the intended mission graph.
- [x] Counterexample-test bypasses by forbidding intended milestones and
  searching again.
- [x] Keep `B`, `I`, and plausibility heuristics out of hard solvability claims;
  record their exact version because tuning them can change rating.

### Provisional targets

For requested difficulty `d ∈ 0..8`:

\[
A_t(d)=4+2d+\lfloor d^{1.2}\rfloor
\]

\[
D_t(d)=2+\lfloor1.2d\rfloor
\]

\[
K_t(d)=\min\left(1+\left\lfloor\frac{d+1}{2}\right\rfloor,6\right)
\]

\[
I_t(d)=\min\left(\left\lfloor\frac{d}{3}\right\rfloor,3\right)
\]

where `K` is the number of interacting mechanic families. The provisional
challenge score retained for calibration is:

\[
C=0.7A+1.8D+1.1P+1.3I+1.0R+0.8B+1.0X+0.35E
\]

- [x] Freeze integer target intervals for `A`, `D`, `K`, `I`, `R`, and `F` for
  all nine V1 difficulties before coding candidate acceptance.
- [x] Start with approximately ±20% intervals for `A` and `D`, then adjust only
  from versioned offline calibration evidence.
- [x] Require `F = 0` at difficulty `0`, keep it low at `1..2`, and cap it at
  `1/3` for every V1 difficulty.
- [x] Rate a candidate by the nearest complete target profile with deterministic
  lower-difficulty tie-breaking; do not gate acceptance on `C` alone.
- [x] Never let player history or local skill adaptation alter the level
  produced by a given identity tuple.

### Solution cost and multiplicity

- [x] Use lexicographic solution cost `(commitments, pushes, total actions,
  canonical action sequence)`.
- [x] Retain one preferred optimal solution and bounded near-optimal alternatives
  up to `optimal commitments + 2`.
- [ ] Count macro solutions only after removing neutral walking variants.
- [ ] Prefer one to three materially different macro solutions for difficulties
  `3..8`; allow more recovery at tutorial and novice difficulty.
- [x] Reject a major shortcut whose profile falls below the accepted interval,
  even when an intended witness still exists.

---

## 9. Exact solvability and failure analysis

Let `R(s₀)` be all reachable canonical decision states from the initial state,
and `G` the set of winning states. The winning set is:

\[
W=\{s\in R(s_0)\mid\exists g\in G,\ s\rightarrow^*g\}
\]

A level is accepted only if `s₀ ∈ W`. A fatal transition is:

\[
s\in W\quad\land\quad T(s,a)\notin W
\]

The complete set of such transitions is the fatal frontier.

### Enumeration contract

- [x] Enumerate reachable canonical states with deterministic queue order and
  deterministic successor order `N,E,S,W` plus stable object-id tie-breaking.
- [x] Retain at most `200,000` decision states and `800,000` directed
  transitions for any V1 candidate.
- [x] Reject, rather than approximately certify, a candidate that reaches a
  state, transition, memory, or cascade limit.
- [x] Identify all winning nodes, reverse-traverse the retained graph, and mark
  exactly the nodes in `W`.
- [x] Keep physical-failure terminal outcomes as classified transitions rather
  than stable playable graph nodes.
- [x] Verify that every runtime stable state reached from the accepted initial
  state has a canonical graph entry.

### Runtime failure detection

- [x] Keep the accepted level's compact winning-state index available to the
  resident while a run is active.
- [x] After each stable accepted action, classify physical failure, victory, or
  causal failure before returning the authoritative result to a tile.
- [x] Restore or deterministically rebuild the winning-state index after
  resident restart; do not persist the full explored graph in IndexedDB.
- [x] Cache analysis by canonical level hash within the resident session only.
- [x] Map proven resource, topology, and power impossibilities to bounded reason
  identifiers; keep display copy separate from solver logic.

### Solver independence

- [x] Keep constructive witness generation and independent state-space solving
  in separate modules with no shared `solved` flag or trusted acceptance result.
- [x] Replay the witness using the production simulation before analysis.
- [x] Let the independent solver replace the witness with a shorter valid
  solution and use that discovery in difficulty scoring.
- [x] Reject a candidate when witness replay, independent reachability,
  milestone checks, and stored certificate disagree.

---

## 10. Retired deterministic generator design reference

This section documents constraints that may inform the redesign. The algorithms,
budgets, stages, PRNG implementation, policies, catalogs, and recovery pipeline
described below are not implemented in the current tree.

### Identity, randomness, and canonical output

- `generatorVersion` pins PRNG, rules, mission grammar, budgets, limits,
  canonical serialization, scoring, recovery policy, and tie-breaking. Legacy
  `g1` additionally pins its compatibility template and fallback catalog.
- A seed is an unsigned 64-bit integer stored canonically as 16 lowercase
  hexadecimal digits but not displayed in the normal player UI.
- Structural randomness uses `xoshiro128**` with four non-zero 32-bit words
  derived from the seed and a stream tag by a frozen integer hash.
- Bounded selection uses rejection sampling, not floating-point percentages or
  biased modulo reduction.
- Independent tagged streams cover mission plan, spatial layout, object
  placement, mutation, and cosmetics.

- [x] Publish golden PRNG vectors, stream-derivation vectors, rejection-sampling
  vectors, and canonical level hashes.
- [x] Use fixed-width integer operations for every structural random decision.
- [x] Never call `Math.random`, use elapsed time, depend on worker scheduling,
  or iterate an unordered collection during generation.
- [x] Keep cosmetic stream changes from altering simulation layout.
- [x] Canonically serialize terrain row-major, fixtures by cell then id,
  objects by id, channels by id, and metadata by a frozen key order.

### Internal identity/share compatibility

The compatibility grammar is:

```text
HS1-G<1|2>-D<base36 difficulty>-S<16 hex seed>-C<8 hex checksum>
```

The checksum detects typing errors; it is not a signature or security claim.
The canonical level hash is SHA-256 over canonical level bytes. Both values are
internal artifacts and are deliberately absent from Home, briefing, Mission
Details, and results.

- [x] Implement strict case-normalized parsing with no ambiguous whitespace,
  omitted fields, or trailing data.
- [x] Distinguish invalid checksum, unsupported share-code version, unsupported
  generator version, and unsupported difficulty.
- [x] Keep identity/share parsing out of the normal UI and do not turn it into
  an HTTP route or URL query capability.
- [x] Treat the solution certificate and level hash as analysis artifacts, not
  anti-cheat secrets.

### Search budget

For difficulty `d`, generation considers exactly:

\[
B(d)=256+64d
\]

structural proposals. Only bounded survivors receive complete analysis:

- retain at most `32` candidates after static validation;
- retain at most `24` after witness replay and cheap structural scoring;
- run complete reachable-state analysis on at most `24` candidates;
- legacy `g1` may retain the best `8` accepted candidates for deterministic
  comparison; current `g2` returns the first fully certified candidate in its
  frozen seed-derived analysis order to keep interactive generation latency
  bounded without making one causal family dominate every identity;
- high-band `g2` reserves `12` of the `24` witness and exact-analysis slots for
  each transit family before applying the seed-derived family preference, so
  preference cannot crowd the alternate generated structure out of analysis.

If normal `g2` analysis finds no accepted candidate, procedural recovery resumes
at the first proposal index not constructed for the normal static-valid window
and stops no later than index `B(d)+255`. Recovery therefore never revisits an
authored board or repeats the normal prefix. It may run at most `24` additional
exact analyses. The generator first constructs, statically validates, deduplicates,
and witness-replays the entire fixed 256-proposal recovery horizon, then applies
the same deterministic cost/family ranking before exact-analyzing its best 24.
Combined construction is bounded by `B(d)+256` proposal indices and combined
exact analysis by `48` candidates. Returned budget metadata records normal and
recovery work separately.

- [x] Apply cheap topology, compatibility, reachability, corner, space, and
  witness checks before complete graph enumeration.
- [x] Do not solve and fully rescore every raw mutation.
- [x] Use operation counts, not wall-clock deadlines, to decide when search ends.
- [ ] Compare multiple accepted `g2` candidates by a frozen tuple: hard-profile validity,
  target distance, shortcut penalty, walking overhead, dead content, fatal
  fairness, spatial reuse, canonical candidate id.
- [x] Select the lexicographically smallest candidate on a complete tie where
  the versioned generator retains more than one accepted candidate.

### Stage 1 — target profile

- [x] Derive exact ranges for commitments, dependency depth, mechanic families,
  interleaving, irreversibility, fatal pressure, zones, objects, and board area.
- [x] Choose only mechanics allowed for the requested band.

### Stage 2 — causal mission graph

The root objective is `enter active evacuation gate`. Seed-derived grammar
productions expand it into typed prerequisites such as:

```text
reach active gate
  <- power gate
  <- dock reactor cell
  <- transport reactor cell across bridge
  <- temporarily power bridge
  <- position cargo on plate
```

For `g2`, **no whole-mission templates** (catalog-free) means that no
pre-authored `LevelDefinition`, whole-mission skeleton or DAG/zone record, cell
map, role-to-coordinate room layout, freight coordinate sequence, placement
set, or witness is available for selection by either normal generation or
recovery. Reusable local operation descriptors, mechanic compatibility rules,
structural bounds, and exact acceptance predicates are constraint grammar, not
whole-mission templates.

**Mission-structure-generated** is the stronger requirement: the seed-derived
compiler emits the semantic task multiset, required causal DAG, task-to-zone
placement, active zone count, parent graph, and source-to-consumer assignment.
This does not require inventing a new operation vocabulary or making every
operation count arbitrary. Changes to room packing, route bends, optional
checkpoint count, channel names, generated ids, or board symmetry do not count
as different mission structures on their own.

`g2` must not select from an authored catalog of whole-mission skeleton records.
Because the board, operation, and search bounds are finite, its generated domain
is necessarily finite; variation must come from composing an authored operation
vocabulary and solving typed graph/spatial constraints, not from choosing a
stored whole mission. The current compiler already constraint-enumerates typed
source-to-consumer edges, route-derived operations, and zone-parent assignments,
including held/latched/terminal resource lifetime. It rejects cycles, unused
sources, objective-disconnected nodes, and temporary-power bypasses, then uses a
topological ready-set shuffle to derive a constructive witness schedule. Low-band
task inventory is generated from mechanic-band rules. In high bands, the
`mission-modules` stream selects relay-bay versus transit-integrated relay; that
choice emits the physical relay task placement and five-versus-six-zone active
graph. The other tagged streams divide responsibility: `mission-plan` generates
service mode, terminal consumer, source assignment, and required-DAG edges;
`object-placement` generates freight routes; and `spatial-layout` packs rooms.
The access, freight, and terminal core remains a bounded V1 grammar rather than
an unrestricted task-count generator.

- [x] Derive an acyclic causal plan of milestones, resources, conditions, and
  effects from the independent mission-plan stream.
- [x] Use chains at low difficulty and bounded branches/interleaving at higher
  difficulty.
- [x] Emit family-tagged milestone predicates for every selected causal
  production so exact analysis can prove mandatory status and ordering.
- [x] Represent permanence and resource lifetime as explicit typed causal-DAG
  edges and include them in structural identity.
- [x] Generate high-band service and relay task placement from bounded operation
  descriptors; a mission may omit the relay-bay slot and integrate its relay
  into the transit cut instead.
- [x] Expose generated zone descriptors, exact task placements, and the required
  causal graph as construction metadata, and normalize generated identifiers,
  ordering, channels, and board symmetry in semantic-structure tests.
- [ ] Generate variable counts for the remaining core access, freight, and
  terminal operations while retaining the exact difficulty/state bounds.
- [ ] Replace production-specific high-band node IDs and the fixed zone-role
  vocabulary completely with generated descriptor IDs; active zone arrays and
  partial parent records are implemented, while core operation IDs remain
  versioned grammar identifiers.
- [x] Reject circular prerequisites and requirements outside structural bounds
  by grammar construction, static validation, and exact milestone analysis.

### Stage 3 — zone graph

- [x] Derive the high-band active zone count, roles, and parent adjacency from
  the selected task/cut graph; relay-bay missions use six zones and
  transit-integrated relay missions use five.
- [x] Convert the resulting role graph into connected functional rooms such as
  start bay, cargo staging, reactor chamber, transit, and evacuation chamber.
- [x] Place gates and resource boundaries so the intended dependency is
  topologically meaningful.
- [x] Reserve a safe player start, gate approach, object staging area, and at
  least one legal approach cell for every required push.
- [x] Reject accidental disconnected floor, unreachable required fixtures, and
  immediate unintended bypasses.

### Stage 4 — grid embedding

- [x] Embed zones into a compact irregular spacecraft layout inside V1 bounds.
- [x] Enumerate legal self-avoiding freight tracks from push-count, turning,
  regrip, and non-progress constraints; current generation contains no authored
  coordinate-path catalog for either low or high difficulty bands.
- [x] Reserve turning cells and recovery space appropriate to difficulty.
- [x] Keep the generated reactor bay's room and service-loop topology visible,
  while making departures from its safe push rail terminal vacuum hazards
  instead of multiplying irrelevant stable reactor positions.
- [x] Route circuit links legibly without passing through unrelated fixture
  symbols.
- [x] Penalize uniform empty mazes, long one-cell corridors, decorative dead
  ends, and remote consequences the camera cannot reveal clearly.

### Current `g2` anti-lane acceptance

The shipped generator must reject the failure mode where every difficulty is a
single corridor that can be solved by holding one direction. These are hard
certification gates, not visual heuristics:

- [x] Freeze per-difficulty topology profiles measuring junction cells, cycle
  rank, non-overlapping `2×2` staging areas, corridor-cell ratio, and longest
  corridor run without changing frozen `g1` behavior.
- [x] Freeze per-difficulty preferred-path/graph profiles measuring direction
  changes, push directions and axes, distinct pushed objects, repositioning
  between pushes, winning choices, recoverable alternatives, fatal alternatives,
  push runs, turning regrips, non-progress pushes, object revisits, maximum
  consequence-free span and ratio, planning horizon `P`, interleaving `I`, and
  mechanic families `K`.
- [x] Make every accepted normal or procedural-recovery `g2` candidate at
  difficulties `0..8` pass its exact topology, decision-structure, hard
  difficulty, witness, and winning-set gates; current generation has no
  authored fallback board.
- [ ] Strengthen progression certification so `0..1` remain forgiving,
  `2` introduces a recoverable route choice, `3+` has a proven meaningful
  mistake, and `4+` requires multi-axis/multi-object manipulation rather than
  counting neutral walking branches as choices.
- [x] Keep the complete serialized generated-worker response below `512 KiB`
  at every difficulty: losslessly dictionary/front-code canonical winning-state
  keys, reference fatal-frontier states through that index, measure the exact
  maximal envelope before acceptance, and constrain movable-object rails and
  turn pockets instead of raising the cap or weakening exact analysis.
- [x] Bound deterministic generation work and solver state growth at every
  difficulty; exact analysis rejects state, transition, or memory overflow
  instead of certifying it.
- [x] Add fixed-corpus diversity checks that normalize rotations/reflections and
  channel-symbol permutations, so seed variation cannot regress to one layout
  wearing cosmetic changes.
- [x] Construction-test route/edge-generated high bands for at least five typed
  causal identities and three parent-adjacency identities per fixed corpus,
  plus deterministic replay and witness victory.
- [x] Add semantic diversity tests for at least two task multisets per high
  difficulty, dynamic zone counts, and normalized required-DAG isomorphism;
  route checkpoint indices alone do not count as a new mission structure.
- [x] Derive causal-family preference from the root identity so exact-analysis
  ordering does not make every high-band seed converge on the same otherwise
  valid production.
- [ ] Force procedural recovery in tests and apply the same normalized geometry,
  semantic-diversity, determinism, and work-accounting assertions to it.

### Stage 5 — backward witness construction

- [x] Construct a legal forward witness alongside each grammar expansion and
  replay every action through production simulation before exact analysis.
- [ ] Start from a valid solved configuration and apply generation-only inverse
  operations to create legal predecessor states.
- [ ] Support inverse push, undock, relay reversal, fracture restoration, and
  object restoration only inside the generator.
- [ ] Record the corresponding forward actions and milestone events.
- [ ] Re-simulate every predecessor-to-successor step with production rules;
  inverse operations themselves never become player actions.

### Stage 6 — choices and mutation

- [x] Add walls, staging space, alternate player approaches, hazards, and
  plausible commitments without introducing a shortcut.
- [ ] Reintroduce an obstructed-relay production only after its cargo is
  confined to a tiny exact-search domain and a dedicated corpus proves it stays
  below analysis limits.
- [ ] Add optional cargo only when exact analysis can classify it as a fair
  alternate commitment rather than decorative or misleading dead content.
- [ ] Mutate one declared structural feature at a time: wall segment, staging
  cell, object start, route, zone boundary, channel assignment, or compatible
  grammar production.
- [x] Derive each proposal from its fixed proposal index and stream so rejected
  work cannot perturb later randomness.
- [x] Preserve up to `32` independent statically valid candidates rather than a
  single hill-climbing lineage.

### Stage 7 — witness replay and exact certification

- [x] Reject illegal actions, rule mismatches, cascade overflow, required entity
  loss, missing victory, or certificate disagreement during witness replay.
- [x] Run independent enumeration, winning-set analysis, optimal solve,
  near-optimal solve, fatal-frontier classification, milestone validation,
  bypass search, difficulty measurement, and quality measurement.
- [x] Require the exact mandatory-milestone and pairwise-precedence reports to
  cover every required node and required dependency in the generated causal
  contract, in both normal selection and procedural recovery; constructive
  turning checkpoints may remain optional when the room permits another route.
  Legacy `g1` candidates omit this contract.
- [x] Return only a candidate that satisfies every hard acceptance condition.

### Procedural recovery and legacy compatibility

- [x] Retain the nine frozen authored fallback boards only for legacy `g1`
  identity compatibility and build-time solver fixtures.
- [x] Keep every authored compatibility board unreachable from current `g2`
  generation.
- [x] If the normal `g2` survivor window has no match, continue into a separate
  bounded range of later seed-derived grammar productions.
- [x] Replay and independently analyze every procedural recovery candidate with
  the same topology, difficulty, manipulation, and winning-set gates as normal
  candidates.
- [x] Report procedural recovery truthfully in result metadata; never present it
  as a different seed or silently lower the requested difficulty.
- [x] Return a deterministic internal certification error if bounded recovery
  is exhausted; never substitute an authored current-version board.

---

## 11. Candidate quality and fairness

Solvability and profile match are hard requirements. The following distinguish
a merely correct puzzle from an elegant one.

### Useful interaction ratio

- [ ] Measure the fraction of interactive elements used by an optimal or
  near-optimal plan or participating in a plausible classified decision.
- [x] Reject required-looking dead content and unreachable interactive areas.
- [ ] Keep decorative spacecraft details visually non-interactive.

### Walking and manipulation overhead

- [x] Measure neutral walking divided by total preferred-solution actions.
- [ ] Penalize long empty corridors and repeated identical pushes with no new
  decision or system effect.
- [ ] Retain enough staging space that difficulty comes from planning rather
  than fiddly accidental alignment.

### Spatial reuse and synergy

- [ ] Reward rooms, routes, and resources used in more than one meaningful
  phase.
- [ ] Reward cross-family chains such as cargo → plate → bridge → cell → gate.
- [ ] Do not count unrelated mechanisms placed side by side as synergy.

### Failure fairness

A good failure is plausible, follows a visible rule, and is understandable
afterward. Reject or heavily penalize:

- [ ] Hidden or ambiguous circuit links.
- [ ] Resolution-order surprises.
- [ ] A required resource one accidental push from an unmarked dead square at
  novice difficulty.
- [x] A remote consequence that receives no reveal.
- [ ] A required action that contradicts Help or the mechanic reference.
- [x] Long continued play after the state is already provably unwinnable.
- [ ] A puzzle whose only explanation is guessing the generator's intended
  sequence rather than reasoning from visible state.

---

## 12. Hint contract

- [x] Offer a solver-backed hint only from a stable winning state.
- [x] Hint tier 1 identifies a relevant current subgoal or channel without
  selecting a direction.
- [x] Repeated request tier 2 highlights the relevant object/fixture pair.
- [x] Keep direct next-action reveal out of V1 unless added as a separately
  confirmed accessibility option.
- [x] Never mutate state, alter the certified solution, or mark a hint as a
  player action.
- [x] Record hint count for the result recap only.
- [x] If the current state is losing, direct the player to Rewind rather than
  inventing a hint.

---

## 13. 3D diorama presentation, camera, and feedback

### Required Three.js GPU renderer

- [x] Render the complete board with bundled Three.js and `WebGLRenderer`.
- [x] Use a slightly tilted top-down `OrthographicCamera` that exposes object and
  wall volume without perspective scale, free orbit, or hidden grid cells.
- [x] Keep the logical game on the XY plane while using bounded visual Z for
  deck thickness, walls, fixtures, occupants, fields, and feedback; visual Z is
  never a simulation input.
- [x] Batch static terrain and repeated elements with merged geometry or
  `InstancedMesh`; do not create an independently animated React/DOM component
  or an unbounded draw call for every cell.
- [x] Render the board through a bounded full- or near-full-resolution
  `WebGLRenderTarget`, then apply only a subtle whole-scene color-grade pass;
  preserve antialiased silhouettes, material shading, small mechanical detail,
  circuit symbols, and cell boundaries instead of coarse pixel quantization.
- [x] Use Three.js `EffectComposer` (or its bundle-local equivalent) with one
  scene pass, one bounded custom color-grade pass, and the final output pass;
  avoid an open-ended stack of full-screen effects.
- [x] Use GPU shader uniforms for bounded power pulses, hazard fields, selection,
  docking, fracture, and failure/victory effects; shader time may affect only
  presentation.
- [x] Keep all textures, shader source, models, palettes, and Three.js code
  package-local. Generate simple board textures procedurally or bundle them;
  never fetch them at runtime.
- [x] Keep the simulation core independent from React, Three.js, WebGL,
  animation, and browser APIs.
- [x] Let React own screens, HUD, dialogs, native controls, and accessibility
  text; let the board renderer consume immutable stable snapshots and event
  traces.
- [x] Render logic at stable state immediately and use a bounded presentation
  timeline that cannot feed back into simulation.
- [x] Keep a parallel semantic DOM projection for objective, coordinates,
  adjacent cells, channels, and last effect; WebGL pixels are never the only
  accessibility or rule explanation.
- [x] Treat WebGL support as a runtime requirement. If renderer creation fails,
  show a clear non-crashing `GPU rendering unavailable` state with diagnostics
  and Retry; do not silently replace the required game renderer with Canvas 2D.

### GPU lifecycle and context recovery

- [x] Create the renderer only while the game tile is mounted and size it with a
  `ResizeObserver` against the tile stage, not the top-level browser viewport.
- [x] Cap effective device pixel ratio at `2` and bound render-target dimensions
  before allocating GPU resources.
- [x] Render on demand while a stable turn-based board is idle and use the
  animation loop only for active bounded feedback.
- [x] On `webglcontextlost`, freeze game input, stop animation/audio, and show a
  recoverable GPU state without changing the authoritative resident run.
- [x] On `webglcontextrestored`, rebuild all GPU resources from owned source
  data, fetch the latest resident snapshot, and resume only from that stable
  revision.
- [x] Dispose geometries, materials, textures, render targets, composer passes,
  listeners, animation frames, and renderer state on unmount or rebuild.
- [x] Never use the GPU for generation, collision, transition rules, state
  hashing, solvability, or difficulty certification.

### Visual direction

- [ ] Match the `hullshift.png` direction with modeled, high-contrast spacecraft
  art: dark beveled deck slabs, raised hull machinery, recessed voids, restrained
  emissive system cues, cyan focus, and orange/red hazards.
- [ ] Replace repeated cell-sized boundary blocks with joined perimeter wall
  runs, corner caps, inner wall faces, and occasional machinery panels so the
  hull reads as continuous architecture while the logical grid stays exact.
- [ ] Add bounded contact grounding (one shadow map or cheaper model-local
  contact treatment) and tune material contrast so occupants do not appear to
  hover; include the shadow/resource cost in renderer diagnostics.
- [ ] Refine the evacuation gate into a taller doorway arch with a clear walk-in
  aperture while retaining its green ready state and top-facing exit arrow.
- [x] Use bounded key/fill/ambient lighting and material roughness to make height
  and silhouette readable; lighting may reinforce but never solely encode a
  rule.
- [x] Preserve fixture bases beneath occupants and render a docked reactor as
  the same reactor model visibly nested in its socket with added clamps/state
  cues, never as a replacement glyph.
- [x] Give movable models fixture/state-aware visual support height on occupied
  plates, relays, empty sockets, and active bridges so both models remain
  legible without floating, sinking, or mesh interpenetration.
- [x] Verify the authored socket-fixture docking turn in the installed app: after the reactor
  leaves `state.objects` and enters `installedCells`, the socket base, clamps,
  and recognizable reactor body must all remain visible in the same cell.
- [x] Give floor, bulkhead, vacuum, and fracture distinct foundations and
  negative-space patterns that remain identifiable without color.
- [x] Give plate, relay, socket, door, bridge, disposal, and gate distinct
  mechanical silhouettes tied to their rule rather than variants of one square
  or ring.
- [x] Make cargo, reactor cells, and the maintenance droid recognizable by
  silhouette and internal detail, with the droid dominant over every legal
  underlying fixture.
- [x] Replace repeated square-border power feedback with a non-tile-shaped field
  and keep channel marks large enough to survive compact views and color grading.
- [x] Place circuit traces above the deck surface and channel marks on visible
  fixture ledges; real 3D bases must not depth-occlude required rule cues.
- [x] Render every Help mechanic with the real production terrain, fixture, or
  occupant 3D model, including paired machine states and the reactor visibly
  nested in its installed socket; labels and rules remain semantic DOM text.
- [x] Distinguish terrain by cell foundation, fixtures by inset symbols,
  occupants by dominant silhouettes, and fields/links by thin overlays.
- [x] Use no CSS gradients, remote fonts, decorative page-art background, or
  control radius above `5px` in app chrome. Bounded GPU shader shading is
  allowed inside the game scene, but cannot be the sole carrier of a rule.
- [x] Prevent decoration from resembling an object, fixture, circuit link,
  hazard, or valid destination.
- [x] Give all permanent changes a latched mark and all active momentary states
  a sustained indicator.
- [x] Keep the antialiased post-process stable under resize and ensure its
  sampling/color grade never erases one-cell gaps, model parts, circuit glyphs,
  focus marks, or hazard boundaries.

### Camera and resize

- [x] Fit the whole board only while cells remain at least `24×24` CSS pixels.
- [x] Otherwise use a clamped follow camera with logical position preserved
  across resize.
- [x] Use only automatic fit/follow behavior. Do not provide Overview,
  inspect/pan, or `Return to follow` controls.
- [x] Show direction, channel symbol, and consumer name/state when a turn
  changes a consumer outside the current follow view.
- [ ] Define usable layouts at `260×220`, `320×320`, `480×360`, and `720×520`
  without document-level horizontal overflow.
- [x] Collapse secondary details before shrinking the playable board below its
  readable scale.

### Feedback timing

- [x] Keep ordinary walk/push feedback under `180 ms` at normal motion.
- [x] Keep a complete V1 multi-device presentation cascade under `1200 ms`,
  excluding time spent reading a failure/victory panel.
- [ ] Allow fast-forward only after a mechanic has been seen; preserve the same
  final state and event summary.
- [x] Keep failure, hint, and event UI from covering the affected cell before
  its consequence is shown.
- [x] Give blocked movement, push, relay toggle, docking, power change, door,
  bridge loss, fracture, disposal, failure, and victory distinct visual cues.

### Audio

- [x] Ship a small package-local effects palette with no background music in V1.
- [x] Start audio only after user interaction and provide mute plus effects
  volume.
- [x] Suspend audio while hidden or paused.
- [x] Provide an equivalent visual/text cue for every sound.
- [x] Avoid sudden excessive volume and repeated rapid alert sounds.

---

## 14. Accessibility contract

- [x] Import the Neutron design system for app chrome and place
  `nt-app nt-app--fill hullshift-app` on the root.
- [x] Prefix local classes with `hullshift-` and keep shared selectors scoped.
- [x] Use native labeled buttons for every non-board action; tooltip text is
  never the accessible name.
- [x] Give the board a visible focus state and concise accessible label.
- [x] Restore focus correctly after briefing, menu, help, settings,
  failure, victory, and confirmation dialogs.
- [x] Trap focus only in a true modal and let `Escape` close the innermost modal
  before changing pause state.
- [x] Expose objective, player coordinate, current cell, adjacent cells, active
  channels, and last important effect as DOM text rather than WebGL-only data.
- [x] Use a restrained polite live region for important accepted actions and
  device changes; use an urgent announcement only for newly reached failure.
- [x] Encode every terrain, object, channel, hazard, and state with shape,
  symbol, texture, or text in addition to color.
- [ ] Maintain accessible contrast for UI text and puzzle-critical marks.
- [x] Respect `prefers-reduced-motion` and provide an in-game override that
  removes camera sweeps, shake, particles, animated shader pulses, and flashing
  without changing rules or turning off static state indicators.
- [x] Never flash any effect more than three times per second.
- [ ] Provide high-contrast symbols and board-scale settings.
- [ ] Support browser text zoom without hiding controls or creating page
  overflow.
- [ ] Document that V1 provides semantic state/status support but not a complete
  screen-reader cell-exploration mode; do not claim full nonvisual board play
  until that workflow is implemented and tested.

---

## 15. Neutron application contract

### Validated V1 manifest target

```json
{
  "format": 3,
  "name": "Hullshift",
  "id": "hullshift",
  "version": 202,
  "description": "Generate and solve deterministic sci-fi pushing puzzles",
  "src": "main.mo",
  "background": {
    "path": "service.html",
    "description": "Persist local runs and perform deterministic level analysis"
  },
  "capabilities": {
    "persistent_browser_storage": {
      "api": 1,
      "surface": "background"
    }
  },
  "tiles": [
    {
      "id": "game",
      "title": "Hullshift",
      "path": "index.html",
      "icon": "static/icon.svg",
      "description": "Push cargo, route power, and escape a procedural spacecraft"
    }
  ],
  "func": {}
}
```

- [x] Ship one launcher tile, `game`, at `index.html` with `static/icon.svg`.
- [x] Ship one resident background at `service.html` requesting persistent
  origin storage.
- [x] Keep `backend/main.mo` as a minimal `Init()` module with no public
  functions or managed memory.
- [x] Declare only the resident `persistent_browser_storage` capability; declare
  no connections, tray, dependencies, scheduled tasks, agent entrypoints,
  public methods, or canister memory in V1.
- [x] Bundle every script, stylesheet, worker source, sprite, icon, font, and
  sound into `dist/web`.
- [x] Declare Three.js as an app dependency and bundle it into the tile's local
  `main.js`; do not load Three.js, examples, shaders, or textures from a CDN.
- [x] Make no runtime request to a third-party origin.
- [x] Use only safe relative asset paths and do not depend on SPA route or
  directory-index fallback.
- [x] Treat all static web assets and browser saves as non-secret; app web paths
  are publicly fetchable when known.
- [x] Do not use a service worker. The Neutron resident background is the
  lifecycle primitive.
- [x] Guarantee local play/generation/save after loaded assets are available,
  but do not claim that Neutron shell reload is offline/PWA-capable.

### Expected app layout

```text
apps/hullshift/
  backend/main.mo
  public/index.html
  public/service.html
  public/static/icon.svg
  public/static/...
  src/index.tsx
  src/renderer.ts
  src/render_layers.ts
  src/render_shaders.ts
  src/palette.ts
  src/service.ts
  src/generator_worker.ts
  src/model.ts
  src/simulation.ts
  src/mechanics.ts
  src/generator.ts
  src/solver.ts
  src/difficulty.ts
  src/persistence.ts
  src/share_code.ts
  src/style.scss
  build.ts
  mops.toml
  neutron.json
  neutron.lock.json
  package.json
  tsconfig*.json
  test/*.test.ts
```

- [x] Generate and commit `neutron.lock.json` through the normal format-3
  package flow; do not hand-author it.
- [x] Keep `dist/` and `hullshift.v0.2.2.neutron` as generated artifacts.
- [x] Use the repository's npm workspace, Bun scripts/tests, esbuild browser
  bundle, and shared package order.

---

## 16. Resident game service and persistence

### Authority and tools

- [x] Make the resident game service authoritative for generation jobs, level
  definitions, current stable state, revision, action/undo history, settings,
  learned mechanics, and completion summaries.
- [x] Expose closed-schema same-app tools for service snapshot, generation
  start/status/cancel, create/open run, action, undo, restart, delete run,
  settings update, and clear local data.
- [x] Use exact prefixed tool names and validate input/output on both ends.
- [x] Keep every request/result JSON-compatible and below a project ceiling of
  `512 KiB`, safely inside Neutron's `1 MiB` bus limit.
- [x] Throttle generation progress and state invalidation publications to at
  most five per second.
- [x] Publish only a monotonic revision invalidation after authoritative
  mutation; tiles then fetch the complete snapshot.
- [x] Fetch a full snapshot on mount, reconnect, resident restart, and revision
  gap.

### Concurrency and multiple tiles

- [x] Assign each saved run a random non-authoritative run id independent from
  the deterministic level seed.
- [x] Require `expectedRevision` on every mutation.
- [x] Apply and persist one action atomically before returning its new revision.
- [x] Reject a stale revision and return conflict metadata; never apply silent
  last-write-wins behavior.
- [ ] Let a conflicted tile reload the saved run or fork the stale snapshot into
  a new run after an explicit choice.
- [x] Do not let opening a second Hullshift tile silently replace, restart, or
  advance another tile's mission.

### Save format

Persist a versioned record containing at least:

- save-schema version;
- generator version, seed, requested/rated difficulty, and level hash;
- canonical complete level definition and analysis summary;
- current stable state and monotonic run revision;
- accepted action log, undo cursor, periodic replay checkpoint, and statistics;
- volatile/persistent status, created/updated times for display only; and
- settings, learned mechanics, and bounded completion summaries.

- [x] Define save schema `1` independently from generator `g1` and package
  version `1`.
- [x] Store stable snapshots and commands, never animation/camera/focus state.
- [x] Do not persist the complete explored graph or winning-state set; rebuild
  it from the saved level and verify its hash.
- [x] Keep `12` only as a defensive internal run-record ceiling, while the
  product automatically retains one unbound generated game for Continue;
  bound runs owned by other live tiles are preserved whenever possible.
- [x] Replace the previous unbound generated game only after a new mission is
  certified, so the internal ceiling can never block `Start mission`.
- [x] Bound accepted commands to `65,535` per run and completion summaries to
  `512`.
- [x] Add periodic replay checkpoints so restore work remains bounded while the
  complete command history still supports Undo.
- [ ] Replay and hash-check stored commands/state after schema migration or
  suspected corruption.
- [x] Retain `g1`, `g2`, and `g3` identity/share-code parsing for compatible
  saves while allowing only current `g4` to create a new mission.

### Storage failure and cleanup

- [x] Handle missing, blocked, corrupt, version-unknown, aborted, and
  quota-exceeded IndexedDB without crashing.
- [x] Continue in resident-memory volatile mode and show `Autosave unavailable`
  with Retry and details.
- [x] Preserve the in-memory run after a persistence failure; never report the
  failed write as saved.
- [x] Provide `Clear local data` with a destructive confirmation because
  Neutron does not yet guarantee persistent-origin cleanup on uninstall.
- [x] Test save migrations from every retained schema and reject unknown future
  schemas safely.

---

## 17. Generation worker lifecycle

- [x] Run catalog selection, witness replay, exact solving, winning-set
  calculation, fatal-frontier analysis, certificate comparison, and difficulty
  measurement only in a dedicated Worker owned by the resident background.
- [x] Bundle/embed the worker so it starts in both the approved persistent
  origin and Neutron's opaque fallback environment; make no remote worker fetch.
- [x] Detect startup and protocol failure and return an explicit unsupported or
  technical-error state.
- [x] Use a closed versioned worker protocol with bounded messages and job ids.
- [x] Limit the resident to one exhaustive generation job at a time; queue at
  most one replacement request per live tile.
- [x] Make start, progress, cancellation, completion, and failure explicit job
  states.
- [x] Honor cancellation between deterministic work units and never accept a
  partially analyzed candidate.
- [x] Stop or idle the worker after completion/cancellation so the app consumes
  no ongoing analysis CPU merely because the owner is logged in.
- [x] Keep generation deterministic regardless of progress observers,
  cancellation checks on a job that is not cancelled, or worker message timing.

---

## 18. Data privacy and trust boundaries

- [x] Collect no remote analytics or telemetry in V1.
- [x] Keep optional solve statistics local and owner-visible.
- [ ] If calibration export is added later, make it an explicit user action with
  a preview of exact exported data.
- [x] Treat browser-produced completions, scores, hashes, and certificates as
  non-authoritative; V1 has no competitive leaderboard.
- [x] Store no secret, identity, credential, private key, or authorization data
  in static assets or browser saves.
- [x] Use Neutron app helpers rather than raw parent `postMessage` for kernel or
  same-app communication.
- [x] Do not request public or unauthorized Motoko methods to avoid consent.
- [x] Sanitize bounded error presentation and avoid exposing solver internals,
  full saved records, or giant generated payloads in logs.

---

## 19. Verification strategy

### Pure rules tests

- [x] Test walk, blocked walk, push, blocked push, no chain push, and no pull.
- [x] Test every allowed/forbidden cell-layer combination.
- [x] Test plate activation/deactivation by each accepted entity.
- [x] Test relay entry, remaining, exit, re-entry, object non-trigger, and Undo.
- [x] Test empty/installed socket behavior and permanent docking.
- [x] Test powered/unpowered/occupied door jam behavior.
- [x] Test bridge activation, player failure, object loss, and simultaneous
  channel changes.
- [x] Test fracture enter/leave/blocked-attempt/Undo behavior.
- [x] Test disposal of required and optional objects.
- [x] Test inactive/active gate entry and the stable-turn victory boundary.
- [ ] Test exact turn-order interactions and the `32`-pass cascade rejection.
- [x] Test that animation and rendering data cannot affect simulation results.

### Solver and analyzer tests

- [ ] Exhaustively compare macro-state solving with an uncompressed oracle on
  all bounded tiny-board fixtures.
- [x] Test canonical state equality, hashing, successor ordering, and duplicate
  successor merging.
- [x] Test winning-set reverse traversal and every fatal-frontier category.
- [x] Test physical versus causal failure precedence.
- [x] Test mandatory milestone counterfactuals and pairwise precedence.
- [x] Test optimal lexicographic cost and near-optimal macro-solution grouping.
- [ ] Test state/transition/cascade limit rejection with no approximate pass.
- [ ] Mutation-test common false positives: corner deadlock, door jam, temporary
  plate use, bridge loss, object disposal, and resource reuse.

### Generator tests

- [x] Retain focused legacy share-code compatibility vectors.
- [x] Freeze representative `g4` seed/difficulty catalog-selection vectors.
- [x] Prove a repeated `g4` identity selects byte-identical structural output.
- [x] Test strict catalog parsing, certificate staleness, bounded payloads,
  canonical hash/witness replay, and pilot/release policy separation.
- [ ] Corpus-test at least `1,000` fixed seeds per V1 difficulty before release.
- [ ] Run the complete `g4` catalog through release certification from a clean
  checkout and verify 1,000 identity mappings per difficulty.
- [ ] Detect deliberate shortcuts, unused mechanisms, excessive walking,
  brittle fatal density, and difficulty-band violations in fixtures.

### Worker and service tests

- [x] Test worker start, progress, completion, cancellation, crash, protocol
  mismatch, restart, and idle cleanup.
- [x] Prove cancellation cannot return or persist a partial candidate.
- [ ] Test resident snapshot/revision invalidation and reconnect behavior.
- [ ] Test two-tile stale-revision conflicts, reload, and fork.
- [ ] Test tile close/reopen and workspace switch recovery.
- [ ] Test IndexedDB success, blocked open, corruption, quota failure, schema
  migration, clear-data, and volatile fallback.
- [x] Test payloads remain JSON-compatible and below the `512 KiB` project cap.

### UI and accessibility tests

- [ ] Test a complete keyboard-only flow: home, setup, generation, briefing,
  play, Undo, pause, failure/Rewind, victory, and replay.
- [ ] Test coarse-pointer D-pad play without swipe.
- [ ] Test `260×220`, `320×320`, `480×360`, and `720×520` viewports.
- [ ] Assert board readability, HUD collapse, automatic follow, modal containment,
  resize without state loss, and no document-level overflow.
- [ ] Test focus trap/restore, visible focus, live regions, reduced motion, mute,
  high-contrast symbols, board scale, and browser text zoom.
- [ ] Test internal malformed identity/share-code inputs and unsupported
  version/difficulty separately from player-facing worker failure, save failure,
  resident reconnect, corrupt save, and render failure.
- [ ] Assert no unlabeled visible controls and no coarse-pointer target below
  `40×40` pixels.
- [ ] Manually verify mechanics under common color-vision simulations and with
  audio muted.

### Package and installed-Neutron tests

- [x] Validate `neutron.json` and exact tile/background assets.
- [x] Verify the package contains design-system CSS, local worker/game assets,
  its local Three.js renderer/shaders, no unexpected path, and no remote runtime
  URL.
- [x] Run Hullshift unit/package tests through `bun test`.
- [x] Run repository `npm run typecheck` and focused root tests.
- [x] Build `hullshift.v0.2.2.neutron` through the normal
  `validate → build → mogen → mopack → schema → pack` flow.
- [x] Compile Hullshift with the current kernel through `neutron-cli`.
- [ ] Install into a kernel-only local Neutron and run Playwright through install,
  launch, generation, movement, failure/Rewind, lobby exit, tile close, reopen,
  and last-game recovery.
- [ ] Assert installed play makes no third-party request and emits no unexpected
  console/page/request error.
- [x] Smoke-test installed Hullshift through launch, difficulty-`8` generation,
  an accepted move, lobby exit, Continue visibility, Help/Settings, and
  contained `260×220` settings.
- [x] Verify that the installed Hullshift flow makes no third-party request and
  emits no page error, failed request, or sandboxed-form warning.

### Performance gates

- [ ] Keep tile input-to-stable-service-result p95 below `50 ms` for ordinary
  turns on the reference development machine, excluding presentation time.
- [ ] Keep board render/update p95 below one animation frame at `60 Hz` for the
  maximum V1 board after the stable snapshot arrives.
- [x] Keep the maximum V1 board within a measured draw-call/resource budget by
  batching repeated terrain, fixture, object, link, and effect layers; freeze
  the numeric budget after the Phase 1 renderer prototype.
- [x] Cap render-target size and device pixel ratio, and record GPU renderer,
  draw-call, triangle, texture, and render-target diagnostics in development
  builds without exposing them as gameplay state.
- [x] Keep generation off the UI thread and ensure visible UI remains responsive
  during maximum-budget analysis.
- [ ] Record reference generation operation counts, wall time, peak worker
  memory, state count, and transition count for the fixed corpus.
- [ ] Set release wall-time expectations only after a measured prototype; do
  not make wall time part of deterministic acceptance.
- [ ] Verify repeated generation/cancel/open/close cycles release workers,
  listeners, animation frames, audio nodes, and renderer resources.
- [ ] Verify WebGL context loss/restoration, tile remount, and rapid resize do
  not lose or advance the resident puzzle revision.

---

## 20. Implementation phases

### Phase 0 — package skeleton

- [x] Create the V1 manifest, minimal Motoko module, tile/background HTML,
  icon, package scripts, TypeScript configs, build, and package test.
- [x] Bundle separate tile and resident entrypoints plus the embedded worker.
- [x] Bundle Three.js and render an orthographic GPU stage behind the
  design-system loading/home shell in a local Neutron tile.
- [x] Implement explicit WebGL-unavailable and context-loss recovery states.
- [x] Pass manifest validation, typecheck, package build, and install smoke.
- [x] **Gate:** Check this only when the installable empty Hullshift shell is
  verified inside Neutron.

### Phase 1 — simulation vertical slice

- [x] Implement canonical level/state data, compatibility table, transition
  order, Undo, event trace, and the Three.js orthographic renderer.
- [x] Implement batched GPU terrain/fixture/occupant/link layers and the bounded
  antialiased color-grade post-process with no renderer-to-simulation feedback.
- [x] Implement floor, bulkhead, player, cargo, plate, door, and active gate.
- [x] Keep authored mechanic fixtures for internal certification without a
  player-facing training campaign.
- [ ] Complete pure rule and keyboard/touch vertical-slice tests.
- [ ] Complete resize, reduced-motion, context-loss, renderer cleanup, and
  maximum-board GPU profiling for the vertical slice.
- [ ] **Gate:** Check this only when a player can finish, fail safely, Undo, and
  restart a small authored grid puzzle in the installed tile.

### Phase 2 — resident authority and local saves

- [x] Implement resident tools, revisions, IndexedDB schema 1, volatile fallback,
  settings, run list, conflicts, and clear-data flow.
- [x] Restore an exact run across tile close/reopen and workspace switching.
- [x] Verify two tiles cannot silently overwrite one run.
- [ ] **Gate:** Check this only when all persistence and lifecycle failure tests
  pass in an installed Neutron.

### Phase 3 — exact solver and failure frontier

- [ ] Implement macro-state compression, graph enumeration, winning set,
  optimal costs, fatal frontier, and reason identifiers.
- [ ] Compare against the uncompressed oracle and enforce all graph limits.
- [x] Integrate immediate causal failure and solver-backed tier-1 hints.
- [ ] **Gate:** Check this only when every accepted authored fixture is exactly
  classified and all deliberate false-positive fixtures pass.

### Phase 4 — complete V1 mechanics and explanation

- [x] Add reactor cell/socket, relay, bridge/vacuum, fracture, and disposal in
  the specified order.
- [x] Complete the authored mechanic certification fixtures and production 3D
  Help reference.
- [ ] Add final visual, audio, camera, failure, and accessibility feedback.
- [ ] **Gate:** Check this only when every mechanic interaction and authored
  certification fixture is solver-certified and installed-browser tested.

### Phase 5 — deterministic generator

- [x] Freeze legacy generator `g1` constants, PRNG vectors, templates, target
  bands, search budgets, serialization, and share-code checksum.
- [x] Implement the offline `g4` causal mission graph, board embedding, verified
  backward construction, bounded filters, deterministic process shards,
  checkpoint/resume, minimization, archive, and catalog export pipeline.
- [x] Implement immutable catalog selection plus independent production
  witness/hash/milestone/difficulty/certificate checks at runtime.
- [ ] Populate and curate the pilot catalog across all nine bands.
- [ ] Run the large fixed candidate corpus, performance measurements, optional
  ablation diagnostics, diversity review, and held-out human calibration.
- [ ] **Gate:** Check this only when every supported identity deterministically
  returns a certified matching-difficulty level or a truthful internal error.

### Phase 6 — product and release hardening

- [ ] Complete all experience states, results, settings, responsive layouts,
  accessibility checks, and recovery errors for the simplified product flow.
- [ ] Run all unit, property, corpus, worker, persistence, package, typecheck,
  installed Playwright, and manual visual checks.
- [ ] Review package contents, install disclosure, local data copy, privacy
  claims, and generator compatibility policy.
- [ ] **V1 release gate:** Check only after the built package and installed app
  satisfy every non-deferred V1 item in this specification.

---

## 21. Deferred post-V1 mechanisms

These rules preserve the original expansion direction. They are not part of
the V1 acceptance corpus and must not leak into current generator `g4`.

### Polarity field

- [ ] Add a visible one-way boundary applying to player and movable objects.
- [ ] Define directional push legality, neutral-region compression, camera
  communication, and exact failure behavior before generation uses it.

### Mag-rail

- [ ] Move an entering entity along arrows to a legal landing or pre-obstruction
  stop as one bounded deterministic cascade.
- [ ] Define fixture triggers on every crossed/landing cell and reject loops,
  merging, and chain pushes.

### Inertia deck

- [ ] Continue an entering entity in its incoming direction until a normal
  landing or the cell before an obstruction.
- [ ] Define interactions with hazards, fixtures, objects, and solver macro
  edges without timing.

### Warp pads

- [ ] Pair pads explicitly, transfer atomically only to an accepting destination,
  and prevent same-transition destination retrigger.
- [ ] Reject cycles and ambiguous forced-motion compositions.

### Laser, receiver, prism, and rotator

- [ ] Trace visible straight beams through a frozen optical rule set.
- [ ] Let bulkheads, closed doors, cargo, reactor cells, and prism faces block or
  redirect as explicitly shown.
- [ ] Make player beam occupancy physical failure and receiver illumination a
  momentary circuit source.
- [ ] Give prisms visible `/` or `\` orientation and rotate clockwise only when
  entering a rotator.
- [ ] Define simultaneous beam/channel fixed-point evaluation and reject every
  oscillating or multi-stable network.

### Later UX and product work

- [ ] Add remappable controls with conflict detection.
- [ ] Add focus-gated edge-triggered gamepad support and disconnect recovery.
- [ ] Add optional one-turn swipe input while retaining the D-pad.
- [ ] Add a full nonvisual board-inspection mode before claiming complete
  screen-reader playability.
- [ ] Add tiered direct-action hints, replay timeline, favorite share codes,
  color-vision palettes, localization, and optional synthesized music.
- [ ] Add canister-backed cross-device saves only through a separately reviewed
  format-3 memory and owner-authorized, prefixed method contract.
- [ ] Extend the supported difficulty range only with new bounded calibration,
  procedural-recovery coverage, and an explicit generator-version compatibility
  decision.

---

## 22. Returned-level acceptance contract

Every level returned to play must satisfy all of the following:

- [x] The identity tuple reproduces byte-identical canonical structural output.
- [x] The rules and all settled turns are deterministic.
- [x] The initial state is safe, non-winning, and in the exact winning set.
- [x] The stored witness replays to victory under production rules.
- [x] The independent solver confirms victory and reports its preferred solution.
- [x] No solution drops below the requested hard difficulty profile.
- [x] Every reachable stable state within the accepted graph is classified.
- [x] Every fatal frontier transition has a safe generic explanation and uses a
  specific reason only when proven.
- [x] The candidate remains within all board, object, device, cascade, state,
  transition, message, and search limits.
- [x] Every puzzle-critical link and state is visually communicable.
- [ ] Walking, repetitive pushing, dead content, and fatal pressure remain
  inside accepted quality bounds using meaningful macro decisions rather than
  raw walking-edge counts.
- [x] The catalog certificate binds generator/solver/quality-policy versions,
  requested/rated difficulty, canonical level hash, preferred solution,
  difficulty features, milestone/macro/interaction proof data, and exact
  state/transition counts; the entry also records compact provenance.

The intended V1 pipeline is:

\[
\boxed{
\text{causal plan}
\rightarrow \text{zone/grid embedding}
\rightarrow \text{backward witness}
\rightarrow \text{bounded mutation}
\rightarrow \text{exact state analysis}
\rightarrow \text{difficulty certification}
}
\]

That pipeline is the product promise: Hullshift may search widely for an
interesting spacecraft puzzle, but it returns only a deterministic level whose
solution, losing commitments, bounds, and claimed difficulty were independently
checked.
