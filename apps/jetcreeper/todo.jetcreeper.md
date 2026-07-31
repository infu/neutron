# Jetcreeper: Production Plan

## Product Goal

Build a responsive, self-contained arcade vertical shooter for Neutron. The
player pilots a jet from the bottom of the combat field, fires continuously,
and survives an endlessly scrolling hostile sector. The visual language is a
GPU-rendered 2.5D tactical display: clear silhouettes, bright projectiles, and
no external images, fonts, or network requests.

## Player Experience

- Start with three lives and a short ready state; `Enter` or the on-screen
  button starts a run. During flight, keys `1` through `8` trigger systems.
- Press `Q` to swap between Super Brain and direct Manual Flight. Arrow keys or
  `WASD` safely nudge Auto and steer directly in Manual; firing remains
  automatic in both modes.
- Use the Super Brain flight systems deliberately: `1` dashes, `2` enters timed
  sub-level laser flight, `3` launches four homing missiles, `4` through `6`
  trigger collected special systems, `7` launches/detonates a remote bomb, and
  `8` calls two defensive wingmen.
- Press `P` or `Escape` to pause. Losing all lives shows score, sector, and a
  restart affordance.
- Destroy fighters, turrets, and asteroids while avoiding projectiles and
  collisions. Collect bonus crates for shield, rapid fire, or hull repair.
- Surface lives, score, sector, shield state, bonus time, and pause state without
  covering combat. Show the eight systems as rounded icon buttons with radial SVG
  cooldown rings: a centered left rail with tiny number badges on desktop and
  two badge-free thumb clusters in the lower corners on touch layouts.

## Game Design And UX Review

### First-Minute Experience

- The ready screen must explain the one core promise in one line: move, survive,
  and fire automatically. It should show the actual movement keys next to the
  launch action rather than hiding controls in a help panel.
- The first ten seconds are a protected onboarding lane: slow stars, one
  readable asteroid or fighter at a time, no turret shot before the player has
  seen and moved around an obstacle.
- Award the first bonus early and label its effect in the HUD. A player should
  understand that crates are valuable before the difficulty curve becomes busy.

### Combat Readability And Feel

- Give each threat a distinct silhouette, movement language, projectile color,
  sound-free visual telegraph, and score value. Fighters weave and fire crimson;
  turrets have a brief amber charge flash before shooting; asteroids rotate and
  never fire; crates remain green and non-threatening.
- Player bullets need a short bright trail and immediate hit feedback. Enemy
  destruction should use a brief debris flash, score pop, and a tiny
  screen-shake that never obscures aiming.
- On damage, use a strong but short visual warning, an invulnerability blink,
  and an explicit life count change. Never let repeated overlapping collisions
  erase multiple lives in one ambiguous moment.
- Keep the player ship visually above the HUD baseline and reserve clear lanes
  around it. Enemies must not spawn inside the player or directly on top of a
  newly collected crate.

### Challenge Curve And Fairness

- Sector progression should feel like a series of short wins, not a hidden
  endurance timer. Announce each new sector briefly and raise one pressure
  variable at a time: density first, then projectile speed, then mixed enemy
  patterns.
- Cap simultaneous hostile shots and enemies. The game should prefer fewer
  legible threats over a dense, unwinnable screen.
- Spawn danger with a visible lead time at the top edge and prevent turret
  shots from entering before a safe reaction window. Bonus crates should become
  slightly more likely after damage or a sparse score streak.
- A repair crate restores one life, converts to a shield at full hull, or gives
  a short cannon boost when both hull and shield are already full. It never
  removes active threats from the playfield.

### Interface And Accessibility

- Keep the HUD persistent and compact: score on the left, lives and active
  bonus on the right, sector in the center. Keep the icon skills tappable at
  narrow widths and preserve a clear bottom-center flight lane.
- Pause automatically on visibility loss and provide an obvious resume state;
  do not leave a live game advancing in a background tab.
- Use color plus shape and text for threats, bonuses, damage, shield, and
  paused state. Respect reduced-motion preferences by reducing screen shake and
  background speed while preserving gameplay timing.
- Make every non-gameplay action a native labeled button. The canvas itself
  needs an accessible label and an understandable WebGL-unavailable fallback.

### Replayability

- Preserve a local best score for the current browser origin when storage is
  available, but never block play if storage is unavailable.
- Present a short end-of-run recap: score, sector reached, best score, and one
  useful prompt to restart. Avoid a long results screen or forced progression.

## Combat Rules

- The player remains within a fixed world width near the bottom edge. Enemies
  enter from the top as the sector scrolls downward.
- Fighters fly descending attack loops and fire aimed shots and missiles.
  Turrets drift with the world and fire at a slower cadence. Asteroids rotate,
  damage on contact, and do not shoot.
- Player fire is continuous, uses pooled projectiles, and becomes faster while
  the rapid-fire bonus is active. Sub-level flight replaces the cannon with a
  precision laser with 10× base damage, a further 5× critical below half hull
  on units, a dedicated 20%-of-maximum-hull boss strike whose credit survives
  escort health gates, and a five-second
  one-third-speed time warp; dash completion grants a
  one-second 10× burst; and each missile action launches four bounded homing
  projectiles. A two-stage remote bomb deals a huge 270× radial blast across a
  15.4-unit radius, while Guardian Wing fields two autonomous escorts for four
  seconds on an eight-second cooldown; they shoot faster than the player,
  independently counter threats, and deploy whenever ready in Full Auto. Hits award
  deterministic points by enemy type.
- Difficulty ramps by sector: spawn cadence, projectile speed, cannon fire
  rate, missile frequency, and concurrent missile caps rise in bounded steps;
  total entity counts stay capped for predictable frame time.
- Damage uses a brief invulnerability window. A shield consumes one hit before
  a life is lost. A fresh life respawns at the bottom without resetting score.

## Rendering And Runtime Architecture

- Use `three` with `WebGLRenderer`, an orthographic camera, and lightweight
  mesh groups rather than a full 3D world. Use instanced stars and simple
  geometric meshes so the GPU does the visual work without asset loading.
- Keep the game engine outside React. React owns HUD and controls; the engine
  owns the animation loop, input, entities, collision checks, and scene.
- Publish HUD snapshots at a bounded rate instead of making React render every
  frame. Use pure game-rule helpers for score, difficulty, bonuses, and
  collision math so they remain testable without WebGL.
- Pool projectiles, cap active entities, clamp frame deltas, and dispose all
  Three.js resources, listeners, animation loops, and observers on unmount.
- Detect unavailable WebGL and provide a clear, non-crashing fallback state.

## Neutron Package Shape

- Create `apps/jetcreeper/` only. Keep the backend as a minimal safe Motoko
  module because the game has no canister-side state or identity requirement.
- Ship one tile, `Flight`, with all browser assets bundled under `dist/web/`.
- Declare `three` locally in the app package and bundle it into the game so the
  runtime makes no CDN or remote module request.
- Follow the shared dark app visual policy: scoped app styles, no CSS
  gradients, accessible native controls, and no imitation of kernel consent UI.

## Game-First Design Pass

- [x] Make the combat field fill the tile and remove the page header, guidance
  cards, and persistent help copy outside the game.
- [x] Replace the wide information layout with a compact in-game status bar,
  contextual bonus chip, icon pause control, and short state overlays.
- [x] Reduce launch, pause, and results copy to the minimum needed to act while
  retaining an explicit WebGL fallback.
- [x] Upgrade the player and fighter silhouettes with swept wings, layered
  armor, cockpits, gun pods, and animated engine glow.
- [x] Upgrade threats and pickups with aiming twin-barrel turrets, lit tumbling
  asteroids, rotating framed bonus crates, and shape-coded bonus symbols.
- [x] Improve combat feedback with twin-cannon fire, projectile glow, charge
  telegraphs, shield animation, debris-ring impacts, lighting, and star streaks.

## Flight Polish Pass

- [x] Reduce star size, brightness, speed, and density so the background stays
  atmospheric without competing with bullets and pickups.
- [x] Replace sideways fighter oscillation with descending circular attack
  loops and align each jet with the tangent of its flight path.
- [x] Add delayed occasional fighter rockets with a distinct silhouette,
  animated exhaust, limited homing time, pooled reuse, and sector-scaled caps.
- [x] Remove the canvas focus outline and outer blue stage edge while keeping
  labeled pause and launch buttons keyboard-visible.

## Super Brain Flight Demo

- [x] Keep `WASD` and arrow movement as a safe Auto nudge, add `Q` direct Manual
  Flight across the visible field, and retain the automatic cannon in both.
- [x] Bind dash to `1` during flight and show its cooldown plus the exact
  post-dash one-second 10× burst state in a compact HUD.
- [x] Bind timed sub-level laser flight to `2`, visibly distinguish the
  low-profile state, and disclose its active time and cooldown.
- [x] Bind `3` to a four-projectile homing missile salvo and expose missile
  readiness without adding a modal or covering the fighter.
- [x] Reduce the `2` cooldown to two seconds, add the exact five-second 3× time
  slowdown and 1.5× player speed, and apply 10× laser damage plus a strict
  below-half-health 5× unit critical and a 20%-of-maximum-health boss strike.
- [x] Bind `7` to a fast two-press remote bomb with a four-second post-blast
  cooldown, 15.4-unit blast radius, and exact 270× normal-cannon damage.
- [x] Bind `8` to a Guardian Wing system that attaches two timed wingmen
  for four seconds on an eight-second cooldown; they fire faster than the player,
  independently intercept incoming threats to any craft in the group, and Full
  Auto deploys them whenever ready.
- [x] Keep launch on `Enter` only while a run is not active, and
  retain `P` or `Escape` for pause and resume.
- [x] Render Super Brain status compactly and expose every skill as an accessible
  icon button with desktop key badges, numeric cooldowns, and circular progress
  so color is never the only signal.

## Boss Encounters

- [x] Require three or four cleared, gradually growing normal waves before each
  focused boss arena; make the cadence score-independent so a boss reward can
  never schedule another boss directly.
- [x] Add the Ravager ace model with a large unique silhouette, twin cannons,
  animated engines, an entry shield, hit flash, and phase-based energy changes.
- [x] Show a compact contextual hull bar with boss identity and current phase;
  keep it absent during normal play so the interface remains quiet.
- [x] Give the boss a figure-eight flight path and three rotating telegraphed
  patterns: aimed fan fire, cross-lane volleys, and limited-homing rockets.
- [x] Escalate movement and attack cadence at two armor breaks without clearing
  active projectiles, and release useful recovery crates to reward survival.
- [x] Award a scaling score bonus, multi-point destruction burst, repair crate,
  and short recovery window after victory before normal sector spawning resumes.
- [x] Tie three deterministic escort waves to the boss's 75%, 50%, and 25% hull
  gates, then make the boss lethally damageable after the final wave deploys.

## Verification Checklist

- [x] Pure rules tests cover collisions, score, sector ramping, bonus timing,
  and life/shield damage behavior.
- [x] Package test validates the manifest and confirms the built game has its
  canvas entrypoint, HUD styles, local Three.js bundle, and no remote URLs.
- [x] Game tests verify the protected opening, spawn caps, invulnerability,
  sector pacing, and readable recovery bonuses.
- [x] Build the `.neutron` package successfully from `apps/jetcreeper/`.
- [ ] Manually verify keyboard controls, pause/restart, responsive resize,
  WebGL fallback, projectile pooling, reduced-motion behavior, and cleanup on
  tile unmount.
