# Jetfreeper

Jetfreeper is a self-contained GPU autobattler for Neutron. Super Brain owns
survival, movement planning, and auto-combat while a viewer can gently steer,
trigger flight systems, and trace optional Pilot Lines for style rewards. Press
`Q` during a run to take direct manual control or hand flight back to Super
Brain; the cannon remains automatic in either mode. The Three.js game bundles
every runtime asset and renders the 3D combat field through a GPU pixel-art pass
with depth-aware silhouette detail. It does not require canister state, network
access, or external image assets.

## Controls

- `Q`: toggle between Super Brain and direct Manual Flight
- `WASD` or arrow keys: safely nudge Super Brain, or steer directly in Manual
  Flight
- `1`: dash; completing a dash triggers a one-second 10× cannon burst
- `2`: shrink and fire a 10× precision laser (5× critical below half health on
  normal units, and a 20%-of-maximum-hull strike on bosses whose unused damage
  credit persists across escort health gates), while slowing the
  world to one-third speed for five seconds and boosting jet speed by 1.5×
  (2-second cooldown)
- `3`: launch four homing missiles
- `4`: trigger Counterflare after collecting its core (10-second cooldown)
- `5`: anchor a Gravity Knot after collecting its core (30-second cooldown)
- `6`: call Phoenix Squadron after collecting its core (60-second ultimate cooldown)
- `7`: launch a fast remote bomb; press again to detonate its huge 270× blast
  across a 15.4-unit radius (4-second cooldown after detonation)
- `8`: call two rapid-fire Guardian Wing wingmen whose packetized cannon cadence
  stays faster than every temporary jet fire-rate stack and which independently
  counter incoming threats for four seconds (8-second cooldown); Full Auto
  deploys the formation whenever it is ready
- `Enter`: launch or restart while the run is not active
- `P` or `Escape`: pause or resume

The fighter fires continuously during an active run. Outside a critical rescue,
Manual Flight never spends dash, laser, missiles, or crate abilities unless
their keys are pressed. If the shared swept-route predictor sees an imminent
impact in Manual, emergency Super Brain takes a measurably safer route and may
spend any ready numbered system needed by its normal tactical policy. It returns
control after two consecutive predictions show a short collision-free reaction
window, without waiting for every distant fireball in the full planning horizon,
and always releases within ten seconds. A timeout cannot chain into another
takeover until the manual route becomes fully safe again. Pilot Lines appear
only in Auto and are harmless,
ordered route rings that only count after recent human movement input; missing
one has no penalty and never reduces sync. Completed lines add style score
without advancing sector difficulty and award bounded weapon spectacle. A
compact tactical HUD shows flight mode and intent while eight icon-only action
buttons carry system readiness. On desktop they form a centered left rail with
small number badges; touch layouts split them into thumb-reachable lower-corner
fans and hide the badges. SVG rings and counters show cooldown progress directly
on each icon. Encounters now alternate by construction: three or four bounded
normal-enemy waves build gradually to one boss, then the boss releases three
escort waves at 75%, 50%, and 25% hull. Victory always returns to normal waves,
so score rewards can never create boss-after-boss chains.

The progressive roster now contains twenty enemy craft, each with its own
silhouette, movement family, and weapon family. Six graphically distinct bosses
cycle in order with unique movement and three phase attacks apiece, for eighteen
boss weapons in total; finishing any boss always resets the cadence to normal
waves before another boss can appear.

Flight authority also changes the rendered fighter itself. Direct Manual Flight
uses a solid cyan-blue hull with black panel lines and yellow-to-red engine
trails. A last-moment emergency keeps that craft intact while animated
purple/pink neon bands sweep from its nose to its tail. Full Super Brain control
swaps in a narrower angular blue wireframe model with cyan cores and engines.
All three forms share one physics body, so the visual transformation never
changes collision size or movement rules.

The three reusable special systems begin locked on every run. Their distinct
core crates are offered on a guaranteed schedule outside the twenty-attachment
shuffle: Counterflare early, Gravity Knot around sector three, and Phoenix
Squadron by or just after the first boss. Super Brain spends at most one special
per tactical decision; direct `4`/`5`/`6` commands take effect immediately when
ready. Remote Bomb and Guardian Wing are built-in systems and remain directly
available on `7` and `8` from the start of every run.

The normal crate shuffle contains twenty timed jet attachments. Alongside the
original rapid, scatter, plasma, beam, drone, overdrive, and stasis hardware,
rounds can pierce, ricochet, arc through a bounded lightning chain, splash,
freeze targets, steer predictively, or gain rail velocity. Afterburner and
phase-hull crates change flight authority and the physical collision profile;
magnet and nanorepair hardware pull pickups and turn a bounded kill charge into
hull repair. Missile Rack launches eight double-damage homing rounds, while
Bomb Amplifier doubles the remote bomb's damage and expands its radius by 1.5×.
Every attachment has its own color, crate glyph, timer, and tactical HUD effect.

Super Brain ranks survival time, collision clearance, accumulated hazard, and
remaining escape room before steering preference, crates, or firing lanes. Its
controller persists evade, stabilize, recover, collect, and engage regimes to
avoid one-frame tactical thrashing. In a critical route it expands a bounded
three-ply maneuver beam, predicting an opening move and two later turns; only
the first move is executed before the battlefield is observed and planned
again.

Difficulty is deliberately bounded but steep: sector one preserves its protected
opening, later sectors add formations and denser enemy/boss shot families, and
mixed crossfire becomes effectively terminal around sector 200. Projectiles,
rockets, enemies, and pooled impact particles all retain hard runtime caps.

Flight takes place inside a deterministic procedural cave rather than a flat
grid. Five charcoal rock strata carry a pixel-art, travel-anchored stone
texture over deterministic Z-relief grids. The stone map and its lit facets go
through the same whole-scene pixel shader as the jet, with nearest-only texture
sampling and four-CSS-pixel output blocks. The ridges read as mountain rock
seen from above while remaining dark charcoal with cool mineral-gray
variation instead of a flat phosphor field. The terrain reads as irregular rock
and the strata share one continuous,
independently shaped left/right foreground rim. Either wall may intrude by as
much as one quarter of the 20-unit flight field, and the full tunnel visibly
bends as it scrolls. That foreground rim is physical: swept collision catches
both fast dashes and a wall moving into a stationary jet. Super Brain predicts
the same moving wall field over its planning horizon, while Manual Flight may
scrape it and spend a shield or life. The cave backdrop counteracts brief camera
shake so its forward scroll remains stable while combat impacts retain their
feedback. Friendly fire remains cyan and hostile craft and fire use orange/red
so dense combat stays readable against the neutral terrain.

## Development

From this directory:

```sh
npm run package
npm test
```

The final artifact is `jetcreeper.v0.3.2.neutron`.

Combat changes are measured by deterministic, renderer-free harnesses rather
than tuned from one lucky run. `enemy_pressure_hyperopt.ts` replays eight fixed
seeds across the difficulty curve; the retained profile scores 65.41 versus
47.03 for the old profile, with no deaths through sector 150 and terminal
pressure at sectors 195–200. `combat_progression_simulation.ts` evaluates 42
formation and boss scenarios; its bounded winner reduces the surrogate
sector-200 score-time estimate from about 2,505 seconds to 659 seconds without
timing out a scenario or exceeding the planner-work budget. These are headless
comparative metrics, not a promise of identical wall-clock play time.

`brain_survival_simulation.ts` combines the moving cave with current enemy and
projectile caps, all twenty roster rules, the 3/4-wave cadence, boss escort
health stages, earned defensive cores, and the exact two-second low-profile
cooldown plus five-second time warp. Across five fixed seeds the bounded
controller reaches sector 50 with all three lives and zero recorded hits while
replaying 28 normal waves, seven defeated bosses, and 22 observed escort stages.
The regression also caps peak planner work at 2,400 units per decision.
