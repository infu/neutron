export const JET_ABILITY_KINDS = Object.freeze([
  "counterflare",
  "gravity-knot",
  "phoenix-squadron",
] as const);

export type JetAbilityKind = typeof JET_ABILITY_KINDS[number];

export const JET_FLIGHT_SYSTEM_KINDS = Object.freeze([
  "dash",
  "low-profile",
  "missiles",
  "counterflare",
  "gravity-knot",
  "phoenix-squadron",
  "remote-bomb",
  "guardian-wing",
] as const);

export type JetFlightSystemKind = typeof JET_FLIGHT_SYSTEM_KINDS[number];

export const JET_FLIGHT_SYSTEM_KEYS = Object.freeze({
  dash: "1",
  "low-profile": "2",
  missiles: "3",
  counterflare: "4",
  "gravity-knot": "5",
  "phoenix-squadron": "6",
  "remote-bomb": "7",
  "guardian-wing": "8",
} as const);

export type JetAbilityKey = (typeof JET_FLIGHT_SYSTEM_KEYS)[JetAbilityKind];

export const JET_FLIGHT_SYSTEM_LABELS: Readonly<Record<JetFlightSystemKind, string>> = Object.freeze({
  dash: "Dash",
  "low-profile": "Low-profile laser",
  missiles: "Homing missiles",
  counterflare: "Counterflare",
  "gravity-knot": "Gravity Knot",
  "phoenix-squadron": "Phoenix Squadron",
  "remote-bomb": "Remote bomb",
  "guardian-wing": "Guardian Wing",
});

export const JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS: Readonly<Record<JetFlightSystemKind, number>> = Object.freeze({
  dash: 3,
  "low-profile": 2,
  missiles: 5,
  counterflare: 10,
  "gravity-knot": 30,
  "phoenix-squadron": 60,
  "remote-bomb": 4,
  "guardian-wing": 8,
});

/** Physical number-row and keypad bindings share one layout-stable action map. */
export function jetFlightSystemForKeyboardCode(code: string): JetFlightSystemKind | null {
  switch (code) {
    case "Digit1":
    case "Numpad1":
      return "dash";
    case "Digit2":
    case "Numpad2":
      return "low-profile";
    case "Digit3":
    case "Numpad3":
      return "missiles";
    case "Digit4":
    case "Numpad4":
      return "counterflare";
    case "Digit5":
    case "Numpad5":
      return "gravity-knot";
    case "Digit6":
    case "Numpad6":
      return "phoenix-squadron";
    case "Digit7":
    case "Numpad7":
      return "remote-bomb";
    case "Digit8":
    case "Numpad8":
      return "guardian-wing";
    default:
      return null;
  }
}

export interface JetAbilitySpec {
  readonly kind: JetAbilityKind;
  readonly label: string;
  readonly crateLabel: string;
  readonly key: JetAbilityKey;
  readonly cooldownSeconds: number;
  readonly activeSeconds: number;
  readonly readyDuplicateScore: number;
}

export const JET_ABILITY_SPECS: Readonly<Record<JetAbilityKind, Readonly<JetAbilitySpec>>> = Object.freeze({
  counterflare: Object.freeze({
    kind: "counterflare",
    label: "Counterflare",
    crateLabel: "Counterflare core",
    key: JET_FLIGHT_SYSTEM_KEYS.counterflare,
    cooldownSeconds: JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.counterflare,
    activeSeconds: 0.7,
    readyDuplicateScore: 250,
  }),
  "gravity-knot": Object.freeze({
    kind: "gravity-knot",
    label: "Gravity Knot",
    crateLabel: "Gravity Knot core",
    key: JET_FLIGHT_SYSTEM_KEYS["gravity-knot"],
    cooldownSeconds: JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["gravity-knot"],
    activeSeconds: 3,
    readyDuplicateScore: 500,
  }),
  "phoenix-squadron": Object.freeze({
    kind: "phoenix-squadron",
    label: "Phoenix Squadron",
    crateLabel: "Phoenix command core",
    key: JET_FLIGHT_SYSTEM_KEYS["phoenix-squadron"],
    cooldownSeconds: JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["phoenix-squadron"],
    activeSeconds: 5.4,
    readyDuplicateScore: 1_000,
  }),
});

export interface JetAbilityState {
  readonly unlocked: boolean;
  readonly cooldownSeconds: number;
  readonly activeSeconds: number;
}

export type JetAbilityStates = Readonly<Record<JetAbilityKind, JetAbilityState>>;

export type AbilityCrateOutcome = "unlocked" | "recharged" | "reserve-shield" | "reserve-score";

export interface AbilityCrateResolution {
  readonly state: JetAbilityState;
  readonly outcome: AbilityCrateOutcome;
  readonly grantShield: boolean;
  readonly score: number;
}

export interface SpecialAbilityTacticalObservation {
  readonly abilities: JetAbilityStates;
  readonly manualCounterflareRequested?: boolean;
  readonly manualGravityKnotRequested?: boolean;
  readonly manualPhoenixSquadronRequested?: boolean;
  readonly nearProjectileCount: number;
  readonly nearRocketCount: number;
  readonly totalProjectileCount: number;
  readonly targetCount: number;
  readonly gravityTargetCount: number;
  readonly bossActive: boolean;
  readonly bossEntering: boolean;
  readonly bossPhase: 1 | 2 | 3;
  readonly bossHealthRatio: number;
  /** Omitted/false while an entry shield or escort health gate clamps damage. */
  readonly bossDamageable?: boolean;
  readonly escortCount: number;
  readonly damageableTargetCount?: number;
  readonly highValueTargetCount?: number;
  readonly terminalProgress: number;
  readonly survivalSeconds: number;
  readonly predictedClearance: number;
  /** Required for non-urgent offensive automation; omission disables that path. */
  readonly planningHorizonSeconds?: number;
  readonly offensiveClearanceFloor?: number;
  readonly stasisActive: boolean;
  readonly dashBurstActive: boolean;
}

export interface SpecialAbilityDecision {
  readonly useCounterflare: boolean;
  readonly useGravityKnot: boolean;
  readonly usePhoenixSquadron: boolean;
}

export interface AbilityCoreDirectorObservation {
  readonly runSeconds: number;
  readonly sector: number;
  readonly lastBossSector: number;
  readonly bossActive: boolean;
  readonly bossPending: boolean;
  readonly availablePickupSlot: boolean;
  readonly offered: Readonly<Record<JetAbilityKind, boolean>>;
}

export function createLockedJetAbilityStates(): JetAbilityStates {
  return {
    counterflare: { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
    "gravity-knot": { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
    "phoenix-squadron": { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
  };
}

/** Guaranteed first-offer schedule, separate from the ten weapon-crate bag. */
export function nextGuaranteedAbilityCore(
  observation: AbilityCoreDirectorObservation,
): JetAbilityKind | null {
  if (!observation.availablePickupSlot || observation.bossActive || observation.bossPending) {
    return null;
  }
  if (!observation.offered.counterflare && observation.runSeconds >= 12) {
    return "counterflare";
  }
  if (
    !observation.offered["gravity-knot"]
    && (observation.runSeconds >= 38 || observation.sector >= 3)
  ) {
    return "gravity-knot";
  }
  if (
    !observation.offered["phoenix-squadron"]
    && ((observation.lastBossSector >= 5 && !observation.bossPending) || observation.runSeconds >= 120)
  ) {
    return "phoenix-squadron";
  }
  return null;
}

export function jetAbilityReady(state: JetAbilityState): boolean {
  return state.unlocked && state.cooldownSeconds <= 0 && state.activeSeconds <= 0;
}

export function tickJetAbilityState(state: JetAbilityState, deltaSeconds: number): JetAbilityState {
  const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
  return {
    unlocked: state.unlocked,
    cooldownSeconds: Math.max(0, state.cooldownSeconds - delta),
    activeSeconds: Math.max(0, state.activeSeconds - delta),
  };
}

export function activateJetAbility(kind: JetAbilityKind, state: JetAbilityState): JetAbilityState {
  if (!jetAbilityReady(state)) {
    return state;
  }

  const spec = JET_ABILITY_SPECS[kind];
  return {
    unlocked: true,
    cooldownSeconds: spec.cooldownSeconds,
    activeSeconds: spec.activeSeconds,
  };
}

/**
 * The first matching crate unlocks an immediately-ready system. A duplicate
 * during cooldown fully recharges it. A duplicate that cannot add charge is
 * converted into one shield, or a small bounded score reward if shielded.
 */
export function resolveAbilityCrate(
  kind: JetAbilityKind,
  state: JetAbilityState,
  shielded: boolean,
): AbilityCrateResolution {
  if (!state.unlocked) {
    return {
      state: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
      outcome: "unlocked",
      grantShield: false,
      score: 0,
    };
  }

  if (state.activeSeconds > 0) {
    return {
      state: {
        unlocked: true,
        cooldownSeconds: state.activeSeconds,
        activeSeconds: state.activeSeconds,
      },
      outcome: "recharged",
      grantShield: false,
      score: 0,
    };
  }

  if (state.cooldownSeconds > 0) {
    return {
      state: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
      outcome: "recharged",
      grantShield: false,
      score: 0,
    };
  }

  return {
    state,
    outcome: shielded ? "reserve-score" : "reserve-shield",
    grantShield: !shielded,
    score: shielded ? JET_ABILITY_SPECS[kind].readyDuplicateScore : 0,
  };
}

function ready(states: JetAbilityStates, kind: JetAbilityKind): boolean {
  return jetAbilityReady(states[kind]);
}

const POLICY_EPSILON = 1e-9;
const PHOENIX_EXECUTION_HEALTH_RATIO = 0.315;
const PHOENIX_DENSE_DAMAGEABLE_TARGETS = 6;
const PHOENIX_DENSE_HIGH_VALUE_TARGETS = 4;

/**
 * Tactical policy for the three crate systems. It remains conservative: the
 * motion planner still predicts every hostile object normally, while these
 * systems can only remove or hold danger after the plan is chosen.
 */
export function decideSpecialAbilities(
  observation: SpecialAbilityTacticalObservation,
): SpecialAbilityDecision {
  const urgent = observation.survivalSeconds < 1.4 || observation.predictedClearance < 0.62;
  const critical = observation.survivalSeconds < 0.72 || observation.predictedClearance < 0.14;
  const counterReady = ready(observation.abilities, "counterflare");
  const gravityReady = ready(observation.abilities, "gravity-knot");
  const phoenixReady = ready(observation.abilities, "phoenix-squadron");
  const gravityActive = observation.abilities["gravity-knot"].activeSeconds > 0;
  const phoenixActive = observation.abilities["phoenix-squadron"].activeSeconds > 0;

  const counterPressure = observation.nearProjectileCount >= 2
    || observation.nearRocketCount >= 1
    || (urgent && observation.nearProjectileCount >= 1);
  const manualCounterflare = observation.manualCounterflareRequested === true;
  const manualGravityKnot = observation.manualGravityKnotRequested === true;
  const manualPhoenixSquadron = observation.manualPhoenixSquadronRequested === true;
  const autoCounterflare = counterReady
    && counterPressure
    && (!gravityActive || critical);

  const gravityPressure = observation.totalProjectileCount >= 7
    || observation.nearProjectileCount >= 4
    || observation.gravityTargetCount >= 3
    || (observation.bossActive && observation.bossPhase >= 2 && observation.totalProjectileCount >= 4);
  const gravityConflictAllowsUse = !observation.stasisActive || critical;
  const autoGravityKnot = gravityReady
    && !gravityActive
    && gravityPressure
    && urgent
    && gravityConflictAllowsUse;

  const bossMoment = observation.bossActive
    && !observation.bossEntering
    && (
      observation.escortCount >= 2
      || observation.bossPhase >= 3
      || (observation.bossPhase >= 2 && observation.targetCount >= 4)
      || (observation.bossHealthRatio <= 0.48 && observation.totalProjectileCount >= 6)
    );
  const terminalOverload = observation.terminalProgress >= 0.72
    && observation.targetCount >= 9
    && observation.totalProjectileCount >= 12
    && urgent;
  const majorMoment = bossMoment || terminalOverload;
  const planningHorizon = observation.planningHorizonSeconds;
  const clearanceFloor = Number.isFinite(observation.offensiveClearanceFloor)
    ? Math.max(0, observation.offensiveClearanceFloor ?? 0.62)
    : 0.62;
  const safelyOffensive = Number.isFinite(planningHorizon)
    && (planningHorizon ?? 0) > 0
    && observation.survivalSeconds >= (planningHorizon ?? Number.POSITIVE_INFINITY) - POLICY_EPSILON
    && observation.predictedClearance >= clearanceFloor - POLICY_EPSILON;
  const damageableBossExecution = observation.bossActive
    && !observation.bossEntering
    && observation.bossDamageable === true
    && observation.bossHealthRatio <= PHOENIX_EXECUTION_HEALTH_RATIO;
  const denseHighValueFormation = (observation.damageableTargetCount ?? 0)
      >= PHOENIX_DENSE_DAMAGEABLE_TARGETS
    && (observation.highValueTargetCount ?? 0) >= PHOENIX_DENSE_HIGH_VALUE_TARGETS;
  const safeDamageMoment = safelyOffensive
    && (damageableBossExecution || denseHighValueFormation);
  const autoPhoenixSquadron = phoenixReady
    && !phoenixActive
    && ((majorMoment && urgent) || safeDamageMoment)
    && (!observation.dashBurstActive || critical);

  // Explicit keys may coexist, but automation spends at most one special per
  // decision. Immediate survival wins over control, which wins over spectacle.
  const useCounterflare = counterReady && (manualCounterflare || autoCounterflare);
  const useGravityKnot = gravityReady && !gravityActive && (
    manualGravityKnot || (!autoCounterflare && autoGravityKnot)
  );
  const usePhoenixSquadron = phoenixReady && !phoenixActive && (
    manualPhoenixSquadron || (!autoCounterflare && !autoGravityKnot && autoPhoenixSquadron)
  );

  return { useCounterflare, useGravityKnot, usePhoenixSquadron };
}
