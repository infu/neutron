const WEAPON_EFFECT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  shield: "Shield ready",
  rapid: "Rapid fire",
  pulse: "Hull repair",
  spread: "Spread cannon",
  plasma: "Plasma rounds",
  missile: "Missile rack",
  beam: "Beam cannon",
  drone: "Wing drones",
  overdrive: "Overdrive",
  stasis: "Stasis field",
  "low-profile": "Low-profile laser",
  "time-warp": "3× time warp",
  "dash-burst": "10× dash burst",
  "sync-strike": "10× sync strike",
  counterflare: "Counterflare",
  "gravity-knot": "Gravity Knot",
  "phoenix-squadron": "Phoenix Squadron",
  "guardian-wing": "Guardian Wing",
});

export type AbilityHudPhase = "locked" | "ready" | "cooldown" | "active";

export interface AbilityHudReadout {
  readonly phase: AbilityHudPhase;
  readonly label: string;
}

export interface SkillActionHudReadout {
  readonly kind: JetFlightSystemKind;
  readonly label: string;
  readonly key: string;
  readonly phase: AbilityHudPhase;
  readonly status: string;
  readonly cooldownSeconds: number;
  readonly cooldownTotalSeconds: number;
  readonly cooldownProgress: number;
}

interface SkillActionSnapshot {
  readonly dashActiveSeconds: number;
  readonly dashCooldownSeconds: number;
  readonly burstSeconds: number;
  readonly lowProfileSeconds: number;
  readonly lowProfileCooldownSeconds: number;
  readonly missileCooldownSeconds: number;
  readonly remoteBombActive: boolean;
  readonly remoteBombArmedSeconds: number;
  readonly remoteBombCooldownSeconds: number;
  readonly guardianWingSeconds: number;
  readonly guardianWingCooldownSeconds: number;
  readonly jetAbilities: readonly {
    readonly kind: JetAbilityKind;
    readonly unlocked: boolean;
    readonly cooldownSeconds: number;
    readonly activeSeconds: number;
  }[];
}

export interface FlightModeHudReadout {
  readonly title: "Super Brain" | "Manual Flight";
  readonly toggleLabel: "Auto" | "Manual";
  readonly statusFallback: "Standby" | "Direct steering";
  readonly guidance: string;
  readonly toggleHint: string;
}

export interface BrainButtonHudReadout {
  readonly active: boolean;
  readonly pressed: boolean | "mixed";
  readonly mode: string;
}

/** Accessible persistent state for Auto, direct Manual, and transient rescue. */
export function brainButtonHudReadout(
  autoPilotEnabled: boolean,
  emergencyAssistActive: boolean,
  emergencyAssistSeconds: number,
): BrainButtonHudReadout {
  if (emergencyAssistActive) {
    const seconds = Number.isFinite(emergencyAssistSeconds)
      ? Math.max(0, Math.ceil(emergencyAssistSeconds))
      : 0;
    return {
      active: true,
      pressed: "mixed",
      mode: `Emergency assist controlling movement; Manual returns in at most ${seconds} seconds`,
    };
  }

  return {
    active: autoPilotEnabled,
    pressed: autoPilotEnabled,
    mode: autoPilotEnabled ? "Automatic flight enabled" : "Manual flight enabled",
  };
}

/** Keeps the keyboard legend, panel title, and accessible guidance in sync. */
export function flightModeHudReadout(autoPilotEnabled: boolean): FlightModeHudReadout {
  if (autoPilotEnabled) {
    return {
      title: "Super Brain",
      toggleLabel: "Auto",
      statusFallback: "Standby",
      guidance: "WASD / arrows nudge the route · auto cannon stays on",
      toggleHint: "Press Q for Manual Flight",
    };
  }

  return {
    title: "Manual Flight",
    toggleLabel: "Manual",
    statusFallback: "Direct steering",
    guidance: "WASD / arrows steer directly · auto cannon stays on",
    toggleHint: "Press Q for Super Brain automatic flight",
  };
}

interface AbilitySnapshot {
  readonly unlocked: boolean;
  readonly cooldownSeconds: number;
  readonly activeSeconds: number;
}

function compactSeconds(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return safeSeconds >= 10 ? `${Math.ceil(safeSeconds)}s` : `${safeSeconds.toFixed(1)}s`;
}

/** Remaining fraction for the icon ring, clamped against corrupt snapshots. */
export function circularCooldownProgress(remainingSeconds: number, totalSeconds: number): number {
  if (!Number.isFinite(remainingSeconds) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, remainingSeconds / totalSeconds));
}

/** A compact WoW-style countdown: whole seconds, then tenths for the final second. */
export function cooldownCounterLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0.05) {
    return "";
  }

  return seconds < 1 ? Math.max(0.1, seconds).toFixed(1) : String(Math.ceil(seconds));
}

/** Converts gameplay state into one stable, compact ability status. */
export function abilityHudReadout(ability: AbilitySnapshot): AbilityHudReadout {
  if (!ability.unlocked) {
    return { phase: "locked", label: "Locked" };
  }

  if (ability.activeSeconds > 0.05) {
    return { phase: "active", label: `Active ${compactSeconds(ability.activeSeconds)}` };
  }

  if (ability.cooldownSeconds > 0.05) {
    return { phase: "cooldown", label: `Cooldown ${compactSeconds(ability.cooldownSeconds)}` };
  }

  return { phase: "ready", label: "Ready" };
}

function coreSkillReadout(
  kind: "dash" | "low-profile" | "missiles" | "remote-bomb" | "guardian-wing",
  cooldownSeconds: number,
  activeStatus: string | null,
): SkillActionHudReadout {
  const total = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS[kind];
  const phase: AbilityHudPhase = activeStatus !== null
    ? "active"
    : cooldownSeconds > 0.05
      ? "cooldown"
      : "ready";

  return {
    kind,
    label: JET_FLIGHT_SYSTEM_LABELS[kind],
    key: JET_FLIGHT_SYSTEM_KEYS[kind],
    phase,
    status: activeStatus ?? (phase === "cooldown" ? `Cooldown ${compactSeconds(cooldownSeconds)}` : "Ready"),
    cooldownSeconds,
    cooldownTotalSeconds: total,
    cooldownProgress: circularCooldownProgress(cooldownSeconds, total),
  };
}

/** One stable eight-button model shared by desktop and touch layouts. */
export function skillActionHudReadouts(snapshot: SkillActionSnapshot): SkillActionHudReadout[] {
  const specialStates = new Map(snapshot.jetAbilities.map((ability) => [ability.kind, ability]));

  return JET_FLIGHT_SYSTEM_KINDS.map((kind) => {
    switch (kind) {
      case "dash": {
        const activeStatus = snapshot.dashActiveSeconds > 0.05
          ? `Dashing ${compactSeconds(snapshot.dashActiveSeconds)}`
          : snapshot.burstSeconds > 0.05
            ? `10× burst ${compactSeconds(snapshot.burstSeconds)}`
            : null;
        return coreSkillReadout(kind, snapshot.dashCooldownSeconds, activeStatus);
      }
      case "low-profile":
        return coreSkillReadout(
          kind,
          snapshot.lowProfileCooldownSeconds,
          snapshot.lowProfileSeconds > 0.05
            ? `Laser active ${compactSeconds(snapshot.lowProfileSeconds)}`
            : null,
        );
      case "missiles":
        return coreSkillReadout(kind, snapshot.missileCooldownSeconds, null);
      case "remote-bomb":
        return coreSkillReadout(
          kind,
          snapshot.remoteBombCooldownSeconds,
          snapshot.remoteBombActive
            ? `Press ${JET_FLIGHT_SYSTEM_KEYS["remote-bomb"]} · Detonate · ${compactSeconds(snapshot.remoteBombArmedSeconds)}`
            : null,
        );
      case "guardian-wing":
        return coreSkillReadout(
          kind,
          snapshot.guardianWingCooldownSeconds,
          snapshot.guardianWingSeconds > 0.05
            ? `Wingmen firing + defending ${compactSeconds(snapshot.guardianWingSeconds)}`
            : null,
        );
      default: {
        const state = specialStates.get(kind) ?? {
          unlocked: false,
          cooldownSeconds: 0,
          activeSeconds: 0,
        };
        const readout = abilityHudReadout(state);
        const total = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS[kind];

        return {
          kind,
          label: JET_FLIGHT_SYSTEM_LABELS[kind],
          key: JET_FLIGHT_SYSTEM_KEYS[kind],
          phase: readout.phase,
          status: readout.phase === "locked" ? "Locked — collect its core" : readout.label,
          cooldownSeconds: state.cooldownSeconds,
          cooldownTotalSeconds: total,
          cooldownProgress: circularCooldownProgress(state.cooldownSeconds, total),
        };
      }
    }
  });
}

export interface VisibleWeaponEffect {
  readonly id: string;
  readonly label: string;
}

interface HudWeaponEffect {
  readonly id: string;
  readonly label: string;
  readonly seconds: number | null;
}

interface EffectSnapshot {
  readonly activeWeaponEffects: readonly HudWeaponEffect[];
  readonly rapidFireSeconds: number;
  readonly shielded: boolean;
}

function effectLabel(effect: HudWeaponEffect): string {
  const label = WEAPON_EFFECT_LABELS[effect.id] ?? effect.label;
  return effect.seconds === null ? label : `${label} ${Math.max(1, Math.ceil(effect.seconds))}s`;
}

/**
 * Produces one HUD chip per gameplay effect id. Compatibility fallbacks for
 * shield and rapid fire are deliberately id-based so a display label can never
 * create a duplicate chip.
 */
export function visibleWeaponEffects(snapshot: EffectSnapshot): VisibleWeaponEffect[] {
  const effects = snapshot.activeWeaponEffects.map((effect) => ({
    id: effect.id,
    label: effectLabel(effect),
  }));
  const effectIds = new Set(snapshot.activeWeaponEffects.map((effect) => effect.id));

  if (snapshot.shielded && !effectIds.has("shield")) {
    effects.push({ id: "shield", label: "Shield ready" });
  }

  if (snapshot.rapidFireSeconds > 0 && !effectIds.has("rapid")) {
    effects.push({ id: "rapid", label: `Rapid fire ${Math.ceil(snapshot.rapidFireSeconds)}s` });
  }

  return effects.filter((effect, index) => (
    effects.findIndex((candidate) => candidate.id === effect.id) === index
  ));
}
import {
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
  JET_FLIGHT_SYSTEM_KEYS,
  JET_FLIGHT_SYSTEM_KINDS,
  JET_FLIGHT_SYSTEM_LABELS,
  type JetAbilityKind,
  type JetFlightSystemKind,
} from "./abilities";
