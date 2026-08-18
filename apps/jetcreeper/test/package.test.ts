import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const scriptUrl = new URL("../dist/web/main.js", import.meta.url);
const appSourceUrl = new URL("../src/index.tsx", import.meta.url);
const autopilotSourceUrl = new URL("../src/autopilot.ts", import.meta.url);
const emergencyAssistSourceUrl = new URL("../src/emergency_assist.ts", import.meta.url);
const gameSourceUrl = new URL("../src/game.ts", import.meta.url);
const hudSourceUrl = new URL("../src/hud.ts", import.meta.url);
const pilotLinesSourceUrl = new URL("../src/pilot_lines.ts", import.meta.url);
const runQuotesSourceUrl = new URL("../src/run_quotes.ts", import.meta.url);
const shipVisualSourceUrl = new URL("../src/ship_visual_mode.ts", import.meta.url);
const styleSourceUrl = new URL("../src/style.scss", import.meta.url);
const packageUrl = new URL("../jetcreeper.v0.3.3.neutron", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Jetfreeper declares one safe frontend tile", async () => {
  const manifest = await readManifest();

  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "jetcreeper",
    name: "Jetfreeper",
    version: 303,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    tiles: [{
      id: "flight",
      title: "Jetfreeper",
      path: "index.html",
      icon: "static/icon.svg",
    }],
    func: {},
  });
});

test("Jetfreeper bundles a focused local GPU game without remote frontend assets", async () => {
  const [
    html,
    css,
    script,
    appSource,
    autopilotSource,
    emergencyAssistSource,
    gameSource,
    hudSource,
    pilotLinesSource,
    runQuotesSource,
    shipVisualSource,
    styleSource,
  ] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
    readFile(appSourceUrl, "utf8"),
    readFile(autopilotSourceUrl, "utf8"),
    readFile(emergencyAssistSourceUrl, "utf8"),
    readFile(gameSourceUrl, "utf8"),
    readFile(hudSourceUrl, "utf8"),
    readFile(pilotLinesSourceUrl, "utf8"),
    readFile(runQuotesSourceUrl, "utf8"),
    readFile(shipVisualSourceUrl, "utf8"),
    readFile(styleSourceUrl, "utf8"),
  ]);

  expect(html).toContain("./main.css");
  expect(html).toContain("./main.js");
  expect(html).toContain("<title>Jetfreeper</title>");
  expect(html).toContain("viewport-fit=cover");
  expect(html).not.toMatch(/https?:\/\//i);
  expect(css).toContain(".jetastn-stage");
  expect(css).toContain(".jetastn-hud");
  expect(css).toContain(".jetastn-statusbar");
  expect(css).toContain(".jetastn-skill-dock");
  expect(css).toContain(".jetastn-skill-button--brain");
  expect(css).toContain(".jetastn-skill-button--brain-emergency");
  expect(css).toContain(".jetastn-brain-emergency-mark");
  expect(css).toContain(".jetastn-skill-button--active");
  expect(css).toContain(".jetastn-skill-cooldown-progress");
  expect(css).toContain(".jetastn-effects");
  expect(css).toContain(".jetastn-effect-chip");
  expect(css).toContain(".jetastn-bossbar");
  expect(css).toContain(".jetastn-score-gain");
  expect(css).toContain(".jetastn-damage-pulse");
  expect(css).toContain(".jetastn-pilot-line-float");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/https?:\/\//i);
  expect(appSource).not.toContain("jetastn-readout");
  expect(appSource).not.toContain("jetastn-help");
  expect(appSource).toContain("Super Brain");
  expect(appSource).toContain("dashCooldownSeconds");
  expect(appSource).toContain("burstSeconds");
  expect(appSource).toContain("lowProfileCooldownSeconds");
  expect(appSource).toContain("missileCooldownSeconds");
  expect(appSource).toContain("snapshot.bossName");
  expect(appSource).toContain("snapshot.bossPattern");
  expect(hudSource).toContain("snapshot.activeWeaponEffects");
  expect(hudSource).toContain('effectIds.has("rapid")');
  expect(appSource).toContain("Short evade + 10× burst");
  expect(appSource).toContain("function SkillActionButton");
  expect(appSource).toContain("function BrainActionButton");
  expect(appSource).toContain('aria-keyshortcuts="Q"');
  expect(appSource).toContain('data-system="super-brain"');
  expect(appSource).toContain("gameRef.current?.requestAutoPilotToggle()");
  expect(appSource).toContain('{"♥".repeat(snapshot.lives)}');
  expect(appSource).toContain('aria-label={`Level ${snapshot.sector}`}');
  expect(appSource).not.toContain("jetastn-brand");
  expect(appSource).not.toContain("jetastn-flight-state");
  expect(appSource).not.toContain("jetastn-pause-spacer");
  expect(appSource).toContain('aria-keyshortcuts={readout.key}');
  expect(appSource).toContain('data-system={readout.kind}');
  expect(appSource).toContain('pathLength="100"');
  expect(appSource).toContain("strokeDashoffset={ringOffset}");
  expect(appSource).toContain("gameRef.current?.requestFlightSystem(kind)");
  expect(appSource).not.toContain("SystemReadout");
  expect(appSource).not.toContain("jetastn-system-grid");
  expect(appSource).toContain("Keys 4–6 let you call the moment");
  expect(appSource).toContain("<kbd>Enter</kbd> to launch");
  expect(appSource).not.toMatch(/<kbd>(?:SPACE|SHIFT|X|C|V|B)<\/kbd>/);
  expect(appSource).toContain("Auto / Manual Flight");
  expect(appSource).toContain("Nudge in Auto · steer in Manual");
  expect(hudSource).toContain("auto cannon stays on");
  expect(appSource).toContain("emergencyAssistActive");
  expect(appSource).toContain('aria-pressed={readout.pressed}');
  expect(appSource).toContain("jetastn-brain-emergency-mark");
  expect(appSource).toContain("Launch 4 homing missiles");
  expect(appSource).toContain("270× blast · press again to detonate");
  expect(appSource).toContain("Two rapid-fire countermeasure wingmen");
  expect(appSource).toContain("snapshot.pilotLineActive");
  expect(appSource).toContain("snapshot.pilotStyleScore");
  expect(gameSource).not.toContain("BrainIntentVisual");
  expect(gameSource).not.toContain("createBrainIntentVisual");
  expect(gameSource).not.toContain("updateBrainIntentVisual");
  expect(gameSource).toContain("jetFlightSystemForKeyboardCode(event.code)");
  expect(gameSource).toContain("public requestFlightSystem(kind: JetFlightSystemKind)");
  expect(gameSource).toContain("public requestAutoPilotToggle(): void");
  expect(gameSource).toContain("private readonly emergencySuperBrain = new SuperBrainController()");
  expect(gameSource).toContain("assessSuperBrainRoute(observation, observation.manualIntent)");
  expect(gameSource).toContain("evaluateEmergencyAssist(");
  expect(gameSource).toContain("tickEmergencyAssist(");
  expect(gameSource).toContain("const elapsedWallSeconds = Math.max(0,");
  expect(gameSource).not.toMatch(/tickEmergencyAssist\([\s\S]{0,120}elapsedWallSeconds/);
  expect(gameSource).toMatch(/private update\(deltaSeconds: number\): void \{[\s\S]*?tickEmergencyAssist\([\s\S]*?deltaSeconds/);
  expect(gameSource).toContain("evaluateManualEmergencySentinel({");
  expect(gameSource).toMatch(/const imminentManualCollision = !this\.autoPilotEnabled[\s\S]*?this\.emergencyAssistState\.armed[\s\S]*?this\.manualEmergencyCollisionImminent\(\)/);
  expect(gameSource).toMatch(/imminentManualCollision[\s\S]*?this\.brainDecisionCooldown > 0/);
  expect(gameSource).toContain("decideAutoCombatSystems({");
  expect(gameSource).toMatch(/this\.updateRemoteBomb\(deltaSeconds\);\s*this\.updateAutoCombatSystems\(\);\s*this\.updateGuardianWingmen/);
  expect(gameSource).toContain('this.launchRemoteBomb("automatic")');
  expect(gameSource.match(/targetTimeScale: this\.currentHostileTimeScale\(\)/g)?.length).toBe(2);
  expect(gameSource).toContain("committedDamage: this.committedProjectileDamageForEnemy(enemy.id)");
  expect(gameSource).toContain("committedDamage: this.committedProjectileDamageForBoss()");
  expect(gameSource).toContain("weaponReachable:");
  expect(gameSource).toContain("emergencyRescueObservation(observation)");
  expect(gameSource).toContain("this.autoPilotEnabled || this.emergencyAssistState.active");
  expect(gameSource).toContain('emergencyControl ? "emergency" : "auto"');
  expect(gameSource).toContain('type AbilitySource = "auto" | "emergency" | "manual" | "crate"');
  expect(gameSource).not.toMatch(/if \(!emergencyControl\) \{[\s\S]*?decision\.useDash/);
  expect(gameSource).toContain("Emergency assist · dash");
  expect(gameSource).toContain("Emergency assist · sub-level laser");
  expect(gameSource).toContain('const salvoLabel = this.attachmentActive("missile-rack") ? "eight heavy missiles" : "four missiles";');
  expect(gameSource).toContain("`Emergency assist · ${salvoLabel}`");
  expect(gameSource).toContain('manualModel.name = "Jetfreeper.ship.manual"');
  expect(gameSource).toContain('autoModel.name = "Jetfreeper.ship.auto-wireframe"');
  expect(gameSource).toContain('emergencyOverlay.name = "Jetfreeper.ship.emergency-neon"');
  expect(gameSource).toContain('setAttribute("data-player-visual-mode", mode)');
  expect(gameSource).toContain("new THREE.OctahedronGeometry(0.34, 0)");
  expect(gameSource).toContain("uTailColor:");
  expect(gameSource).toContain("uCoreColor:");
  expect(gameSource).toContain("emergencyHullScan(");
  expect(gameSource).toContain("this.reducedMotion");
  expect(shipVisualSource).toContain('export type ShipVisualMode = "manual" | "emergency" | "auto"');
  expect(shipVisualSource).toContain("wireframe: true");
  expect(shipVisualSource).toContain("engineOuterColor: 0xff3b24");
  expect(shipVisualSource).toContain("engineCoreColor: 0xffdf52");
  expect(emergencyAssistSource).toContain("export const EMERGENCY_ASSIST_MAX_SECONDS = 10");
  expect(emergencyAssistSource).toContain("export const EMERGENCY_ASSIST_SAFE_SAMPLE_COUNT = 2");
  expect(emergencyAssistSource).toContain("export const EMERGENCY_ASSIST_TRIGGER_SECONDS = 0.12");
  expect(emergencyAssistSource).toContain("active: false,\n        armed: false");
  expect(emergencyAssistSource).toContain("...observation.abilities");
  expect(emergencyAssistSource).toContain("manualCounterflareRequested: false");
  expect(autopilotSource).toContain('export type BrainStrategyRegime =');
  expect(autopilotSource).toContain("plannedMoves: readonly [Vec2, Vec2, Vec2]");
  expect(autopilotSource).toContain("assessSuperBrainRoute");
  expect(gameSource).toContain("this.requestFlightSystem(flightSystem)");
  expect(gameSource).toContain("event.target.closest(\"button, a, input, select, textarea, [role='button']\")");
  expect(gameSource).not.toMatch(/event\.code === "(?:Space|ShiftLeft|ShiftRight|KeyX|KeyC|KeyV|KeyB)"/);
  expect(gameSource).toContain('event.code === "Enter"');
  expect(gameSource).toContain("shield: THREE.RingGeometry");
  expect(gameSource).toMatch(/playerShield\w*:\s*THREE\.SphereGeometry/);
  expect(gameSource).toMatch(/playerShield\w*Material:\s*THREE\.MeshPhysicalMaterial/);
  expect(gameSource).toContain("playerShieldEnergyMaterial: THREE.ShaderMaterial");
  expect(gameSource).toContain("new THREE.MeshPhysicalMaterial({");
  const shieldGlassSource = gameSource.match(
    /const playerShieldGlassMaterial = this\.trackMaterial\(new THREE\.MeshPhysicalMaterial\(\{([\s\S]*?)\}\)\);/,
  )?.[1] ?? "";
  const shieldGlassOpacity = Number(
    shieldGlassSource.match(/\bopacity:\s*([0-9.]+)/)?.[1] ?? Number.NaN,
  );
  expect(shieldGlassSource).toContain("transparent: true");
  expect(shieldGlassOpacity).toBeGreaterThan(0);
  expect(shieldGlassOpacity).toBeLessThanOrEqual(0.35);
  expect(shieldGlassSource).toContain("clearcoat:");
  expect(shieldGlassSource).toContain("clearcoatRoughness:");
  expect(shieldGlassSource).toContain("iridescence:");
  expect(shieldGlassSource).toContain("iridescenceIOR:");
  expect(gameSource).not.toContain("transmission:");
  expect(gameSource).not.toContain("thickness:");
  expect(gameSource).not.toMatch(/\bior\s*:/);
  expect(gameSource).not.toContain("transmissionResolutionScale");
  expect(gameSource).toMatch(/const playerShieldEnergyMaterial = this\.trackMaterial\(new THREE\.ShaderMaterial\(\{[\s\S]*?blending: THREE\.AdditiveBlending/);
  expect(gameSource).toContain("uTime:");
  expect(gameSource).toContain("uOpacity:");
  expect(gameSource).toContain("float fresnel");
  expect(gameSource).toContain("float caustic");
  expect(gameSource).toContain("float chroma");
  expect(gameSource).toContain("nextPilotNodeAfterCrossing");
  expect(gameSource).toContain("this.score + this.pilotStyleScore");
  expect(pilotLinesSource).toContain("Missing a line is intentionally neutral");
  expect(gameSource).toContain("MeshStandardMaterial");
  expect(gameSource).toContain("IcosahedronGeometry");
  expect(gameSource).toContain("AdditiveBlending");
  expect(gameSource).toContain("RenderPixelatedPass");
  expect(gameSource).toContain("EffectComposer");
  expect(gameSource).toContain("OutputPass");
  expect(gameSource).not.toContain("createGrid");
  expect(gameSource).not.toContain("gridMaterial");
  expect(gameSource).not.toContain("gridOffset");
  expect(gameSource).toContain("const WORLD_CLEAR_COLOR = 0x060708");
  expect(gameSource).toContain("const PLAYER_FIRE_CYAN = ARCADE_PALETTE.aiCyan");
  expect(gameSource).toContain('"deep-void": 0x0d0f10');
  expect(gameSource).toContain('"far-rock": 0x161819');
  expect(gameSource).toContain('"mid-rock": 0x202325');
  expect(gameSource).toContain('"near-rock": 0x292d30');
  expect(gameSource).toContain("rim: 0x34393c");
  expect(gameSource).toContain("0x464b4e");
  expect(gameSource).toContain("0x383c3f");
  expect(gameSource).toContain('"Jetcreeper.cave-rock"');
  expect(gameSource).toContain("const CAVE_ROCK_SEED =");
  expect(gameSource).toContain("new THREE.DataTexture(");
  expect(gameSource).toContain("THREE.RepeatWrapping");
  expect(gameSource).toContain("texture.magFilter = THREE.NearestFilter");
  expect(gameSource).toContain("texture.minFilter = THREE.NearestMipmapNearestFilter");
  expect(gameSource).toContain("THREE.NearestMipmapNearestFilter");
  expect(gameSource).toMatch(/setAttribute\(["']uv["']/);
  expect(gameSource).toContain("rockMap: { value: this.caveRockTexture }");
  expect(gameSource).toContain("this.caveRockTexture.dispose()");
  expect(gameSource).toContain("const CAVE_MESH_COLUMN_COUNT = 9");
  expect(gameSource).toContain("Jetcreeper.cave-mountain-relief:");
  expect(gameSource).toContain("Jetcreeper.cave-rock-lit:");
  expect(gameSource).toContain("Jetcreeper.cave-rock-neutral-shader:");
  expect(gameSource).toContain("dFdx(vViewPosition)");
  expect(gameSource).toContain("dFdy(vViewPosition)");
  expect(gameSource).toContain("rockColor * reliefLight * textureShade");
  expect(gameSource).toContain("caveTravel + WORLD_TOP + y");
  expect(gameSource).toContain("layer.leftGeometry.computeVertexNormals()");
  expect(gameSource).toContain("flatShading: true");
  expect(gameSource).toContain("this.starTransform.position.set(star.x, star.y, -10.75)");
  expect(gameSource).toContain("private backgroundVisualsDirty = true");
  expect(gameSource).toMatch(/private renderOnce\(\): void \{[\s\S]*?this\.updateCaveLayers\(\)[\s\S]*?this\.composer\.render\(\)/);
  expect(gameSource).toContain("backgroundGroup");
  expect(gameSource).toMatch(
    /(?:backgroundGroup\.position[\s\S]{0,240}camera\.position|camera\.position[\s\S]{0,240}backgroundGroup\.position)/,
  );
  expect(gameSource).toContain("sweepCircleThroughCave({");
  expect(gameSource).toContain("this.resolveCaveCollision(playerRadius)");
  expect(gameSource).toContain("const DASH_TRAVEL_SECONDS = 0.12");
  expect(gameSource).toContain("const DASH_EFFECT_SECONDS = 1.08");
  expect(gameSource).toContain("createDashTrail");
  expect(gameSource).toContain("dashBarrelRollAngle");
  expect(gameSource).not.toContain("DashEcho");
  expect(gameSource).not.toContain("createDashEchoes");
  expect(gameSource).toContain("Math.min(deltaSeconds, this.dashRemaining)");
  expect(gameSource).toContain("const RESPAWN_INVULNERABILITY_SECONDS = 2.4");
  expect(gameSource).toContain("this.clearRespawnProjectileBubble(respawnX, PLAYER_START_Y)");
  expect(gameSource).toContain("this.abilityCoreCollected[kind] = true");
  expect(gameSource).not.toContain("this.abilityCoreOffered[dueKind] = true");
  expect(gameSource).toContain("travelDistance: this.caveTravel");
  expect(gameSource).toContain("scrollSpeed: this.difficulty.scrollSpeed");
  expect(gameSource).toContain("PIXEL_BLOCK_CSS_PIXELS");
  expect(gameSource).toContain("HalfFloatType");
  expect(gameSource).toContain("NearestFilter");
  expect(gameSource).toContain("depthBuffer: false");
  expect(gameSource).toContain("this.composer.setPixelRatio(1)");
  expect(gameSource).toContain("Math.max(1, Math.ceil(width / PIXEL_BLOCK_CSS_PIXELS))");
  expect(gameSource).toMatch(
    /this\.backgroundGroup\.add\([\s\S]*?\.\.\.this\.caveLayers\.flatMap[\s\S]*?this\.scene\.add\([\s\S]*?this\.backgroundGroup/,
  );
  expect(gameSource).toContain("this.pixelPass.dispose()");
  expect(gameSource).toContain("this.composer.render()");
  expect(gameSource).not.toContain("antialias: true");
  expect(gameSource).toContain("fighterLoopPose");
  expect(gameSource).toContain("fireEnemyRocket");
  expect(gameSource).toContain("enemyRocketPool");
  expect(gameSource).toContain("cometHead");
  expect(gameSource).toContain("cometTail");
  expect(gameSource).toContain("orientProjectileToVelocity");
  expect(gameSource).toContain("scaleCometVisual");
  expect(gameSource).not.toMatch(/projectile\.mesh\.rotation\.[xy] \+=/);
  expect(gameSource).toContain("fireBossAttack");
  expect(gameSource).toContain("damageBoss");
  expect(gameSource).toContain("bossPending");
  expect(gameSource).toContain("recordNormalWaveClear");
  expect(gameSource).toContain("recordBossDefeat");
  expect(gameSource).toContain("detonateRemoteBomb");
  expect(gameSource).toContain("selectWingmanCountermeasures");
  expect(gameSource).toContain("fireGuardianWingProjectile(wing, cadence.logicalShots)");
  expect(gameSource).toContain("stepGuardianWingCadence({");
  expect(gameSource).toContain("playerCannonFireInterval({");
  expect(gameSource).toContain("GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS");
  expect(gameSource).toContain("GUARDIAN_WING_PROJECTILE_DAMAGE * packetShots");
  expect(gameSource).toContain("laserDamageForBoss");
  expect(gameSource).toContain("lowProfileBossLaserHitAvailable");
  expect(gameSource).toContain("lowProfileBossDamagePending");
  expect(gameSource).toContain("drainLowProfileBossDamage()");
  expect(gameSource.match(/this\.drainLowProfileBossDamage\(\)/g)?.length).toBe(2);
  expect(gameSource).toContain("remainingBossLaserStrikeDamage(");
  expect(gameSource).toContain("payload.radius * 0.65");
  expect(gameSource).toMatch(
    /fireGuardianWingProjectile\(wing, cadence\.logicalShots\)[\s\S]*?if \(!active \|\| this\.enemyProjectiles\.length === 0\)/,
  );
  expect(gameSource).not.toContain("clearEnemyProjectiles");
  expect(appSource).toContain('role="progressbar"');
  expect(styleSource).toContain(".jetastn-stage:focus");
  expect(styleSource).toMatch(/\.jetastn-stage:focus,[\s\S]*?\.jetastn-stage:focus-visible[\s\S]*?outline: none/);
  expect(styleSource).toMatch(/\.jetastn-overlay-card \{[\s\S]*?box-sizing: border-box/);
  expect(appSource).toContain("jetastn-overlay-card--${snapshot.status}");
  expect(appSource).toContain('className="jetastn-ready-intro"');
  expect(appSource).toContain('className="jetastn-ready-guide"');
  expect(appSource).toContain("AI Autopilot + human intervention");
  expect(appSource).toContain("human intervention gives you a better chance of survival");
  expect(appSource).not.toContain("optional pilot skill");
  expect(appSource).toContain('name="jetfreeper-difficulty"');
  expect(appSource).toContain("RUN_DIFFICULTY_LEVELS.map");
  expect(appSource).toContain("handleNewGame");
  expect(appSource).toContain("New Game");
  expect(appSource).toContain("runCompleteQuote(snapshot.score, snapshot.sector, snapshot.pilotStyleScore)");
  expect(appSource).not.toContain("Dash through a cave pinch, then spend the burst on the next wave.");
  expect(runQuotesSource.match(/^  "/gm)?.length).toBe(20);
  expect(runQuotesSource).toContain("Route 66");
  expect(runQuotesSource).toContain("motorcycle");
  expect(gameSource).toContain("setNextDifficulty");
  expect(gameSource).toContain("returnToReady");
  expect(gameSource).toContain("scaledBossHealth");
  expect(gameSource).toContain("scaledCrateSpawnDelay");
  expect(gameSource).toContain("enemyImpactShardCount");
  expect(gameSource).toContain("scaledHostileFireDelay");
  expect(gameSource).toContain("scaledHostileVolleyCount");
  expect(gameSource).toContain("scaledHostileProjectileSpeed");
  expect(gameSource).toContain("scaledHostileProjectileCap");
  for (const kind of [
    "corsair", "bulwark", "shifter", "leech", "splitter",
    "warden", "rammer", "stalker", "chronodrone", "commander",
  ]) {
    expect(gameSource).toContain(`kind === "${kind}"`);
  }
  for (const movement of [
    "strafe-dash", "shield-advance", "blink-ambush", "siphon-pursuit", "split-flank",
    "tether-orbit", "ram-charge", "cloak-stalk", "chrono-zigzag", "command-weave",
  ]) {
    expect(gameSource).toContain(`case "${movement}"`);
  }
  for (const weapon of [
    "arc-burst", "shield-barrage", "blink-volley", "siphon-beam", "fork-missiles",
    "tether-shot", "shockwave-cannon", "cloak-torpedo", "time-shard", "support-drones",
  ]) {
    expect(gameSource).toContain(`case "${weapon}"`);
  }
  expect(gameSource).toContain("variants.chronarch");
  expect(gameSource).toContain('case "temporal-lattice"');
  expect(gameSource).toContain('case "clock-hand-sweep"');
  expect(gameSource).toContain('case "rewind-barrage"');
  expect(gameSource).toContain('case "time-rift-collapse"');
  expect(gameSource).toContain("projectile.rewindAtSeconds = -1");
  expect(gameSource).toContain("cometTailOffsetY");
  expect(gameSource).toContain("core.position.set(0, 0, 0.08)");
  expect(gameSource).not.toContain("this.enemyProjectiles.length >= this.difficulty.maxEnemyProjectiles");
  expect(gameSource).not.toContain("this.enemyProjectiles.length < this.difficulty.maxEnemyProjectiles");
  expect(gameSource).not.toContain("this.activeRocketCount() >= this.difficulty.maxEnemyRockets");
  expect(appSource.match(/className="jetastn-control-key"/g)?.length).toBe(8);
  expect(styleSource).toMatch(/\.jetastn-overlay--ready \{[^}]*padding: 0/);
  expect(styleSource).toMatch(/\.jetastn-overlay-card--ready \{[^}]*grid-template-columns:[^}]*inline-size: 100%;[^}]*block-size: 100%;[^}]*max-block-size: none;[^}]*overflow: hidden/);
  expect(styleSource).toMatch(/\.jetastn-overlay-card--ready \{[^}]*background: transparent;[^}]*box-shadow: none/);
  expect(styleSource).toMatch(/\.jetastn-overlay-card--ready h1 \{[^}]*white-space: nowrap/);
  expect(styleSource).toMatch(/\.jetastn-difficulty-option \{[^}]*min-block-size: 44px/);
  expect(styleSource).toMatch(/\.jetastn-difficulty-input:focus-visible \+ span \{[^}]*outline:/);
  expect(styleSource).toMatch(/\.jetastn-overlay-actions \{[^}]*grid-template-columns: repeat\(2,/);
  expect(styleSource).toMatch(/kbd\.jetastn-control-key \{[^}]*border-radius: 3px;[^}]*background-color: rgb\(var\(--jet-player-yellow\)\);[^}]*box-shadow:/);
  expect(styleSource).toMatch(/@media \(max-width: 620px\) and \(orientation: portrait\)[\s\S]*?\.jetastn-overlay-card--ready \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  expect(styleSource).toMatch(/\.jetastn-skill-button \{[\s\S]*?min-inline-size: 44px/);
  expect(styleSource).toMatch(/\.jetastn-skill-button \{[\s\S]*?min-block-size: 44px/);
  expect(styleSource).toMatch(/\.jetastn-skill-button \{[\s\S]*?pointer-events: auto/);
  expect(styleSource).toMatch(/\.jetastn-skill-button \{[\s\S]*?touch-action: manipulation/);
  expect(styleSource).toMatch(/@media \(max-width: 760px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.jetastn-skill-key \{\s*display: none/);
  expect(appSource).toContain("<MobileMovementControls onChange={handleMovementControl} />");
  for (const direction of ["up", "down", "left", "right"]) {
    expect(appSource).toContain(`direction="${direction}"`);
  }
  expect(gameSource).toContain("public setMovementControl(");
  expect(styleSource).toMatch(/@media \(max-width: 760px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.jetastn-movement-controls \{[\s\S]*?display: block/);
  expect(styleSource).toMatch(/\.jetastn-movement-button \{[\s\S]*?touch-action: none/);
  expect(styleSource).toContain("env(safe-area-inset-bottom, 0px)");
  expect(styleSource).toContain(".jetastn-skill-button:focus-visible");
  expect(styleSource).not.toContain(".jetastn-systems");
  expect(styleSource).not.toContain(".jetastn-system {");
  expect(styleSource).not.toContain(".jetastn-flight-mode-toggle");
  expect(styleSource).not.toContain(".jetastn-flight-state");
  expect(styleSource).not.toContain(".jetastn-brain-status");
  expect(styleSource).toMatch(/\.jetastn-statusbar \{[^}]*block-size: 0;[^}]*background: transparent;/);
  expect(styleSource).toMatch(/\.jetastn-pause \{[^}]*background: transparent;/);
  expect(styleSource).toMatch(/\.jetastn-pilot-line-float \{[^}]*background: transparent;[^}]*animation: jetastn-floating-text 1\.05s/);
  expect(styleSource).toMatch(/\.jetastn-effect-chip \{[^}]*background: transparent;[^}]*box-shadow: none;[^}]*animation: jetastn-floating-text 1\.05s/);
  expect(styleSource).toMatch(/\.jetastn-announcement \{[^}]*background: transparent;[^}]*box-shadow: none;[^}]*animation: jetastn-floating-text 1\.05s/);
  expect(styleSource).not.toMatch(/\.jetastn-statusbar \{[^}]*backdrop-filter/);
  expect(styleSource).not.toMatch(/\.jetastn-skill-button--(?:locked|cooldown)[^{]*\{[^}]*\bopacity\s*:/);
  expect(gameSource).toContain("PILOT_LINE_AUTO_RESUME_COOLDOWN_SECONDS");
  expect(gameSource).toContain("suspendPilotLineForManualFlight");
  expect(gameSource).toMatch(/private updatePilotLine\(deltaSeconds: number\): void \{\s*\/\/[\s\S]*?if \(!this\.autoPilotEnabled\) \{\s*return;/);
  expect(gameSource).toMatch(/private suspendPilotLineForManualFlight\(\): void \{[\s\S]*?this\.pilotLine\.active = false;[\s\S]*?node\.mesh\.visible = false;/);
  expect(gameSource).toContain("const MAX_ACTIVE_IMPACTS = 36");
  expect(gameSource).toContain("const REDUCED_MOTION_MAX_ACTIVE_IMPACTS = 12");
  expect(gameSource).toContain("const IMPACT_SHARD_COUNT = 10");
  expect(gameSource).toContain("const ENEMY_MUZZLE_IMPACT_BASE = 2");
  expect(gameSource).toContain("const BOSS_MUZZLE_IMPACT_BASE = 3");
  expect(gameSource).toContain("const ROCKET_LAUNCH_IMPACT_COUNT = 3");
  expect(gameSource.match(/BOSS_MUZZLE_IMPACT_BASE \+ Math\.ceil/g)?.length).toBe(2);
  expect(gameSource).toContain("ENEMY_MUZZLE_IMPACT_BASE + Math.ceil(patternTier / 2)");
  expect(gameSource).toMatch(/const boundedCount = Math\.min\(this\.reducedMotion \? 1 : 6,/);
  expect(script).toContain("WebGLRenderer");
  expect(script).toContain("InstancedMesh");
  expect(script).toContain("Jetfreeper");
});

test("Jetfreeper package includes the self-contained flight tile", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked);

  expect(paths).toContain("neutron.json");
  expect(paths).toContain("schema.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/static/icon.svg");

  const packagedScript = new TextDecoder().decode(unpacked["web/main.js"]);
  const packagedCss = new TextDecoder().decode(unpacked["web/main.css"]);
  const packagedHtml = new TextDecoder().decode(unpacked["web/index.html"]);

  expect(packagedHtml).toContain("<title>Jetfreeper</title>");
  expect(packagedCss).toContain(".jetastn-skill-button--brain-emergency");
  expect(packagedCss).toContain(".jetastn-brain-emergency-mark");
  expect(packagedScript).toContain("plannedMoves");
  expect(packagedScript).toContain("lookaheadUsed");
  expect(packagedScript).toContain("Emergency evade");
  expect(packagedScript).toContain("Emergency assist");
  expect(packagedScript).toContain("taking controls");
  expect(packagedScript).toContain("Manual returns in at most");
  expect(packagedScript).toContain("data-player-visual-mode");
  expect(packagedScript).toContain("Jetfreeper.ship.manual");
  expect(packagedScript).toContain("Jetfreeper.ship.auto-wireframe");
  expect(packagedScript).toContain("Jetfreeper.ship.emergency-neon");
  expect(packagedScript).toContain("The bartender called it a crash");

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.files.map((file) => file.path)).toContain("app/jetcreeper/main.js");
});
