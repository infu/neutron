import type { BrainObservation, BrainRouteAssessment } from "./autopilot";

export const EMERGENCY_ASSIST_MAX_SECONDS = 10;
export const EMERGENCY_ASSIST_SAFE_SAMPLE_COUNT = 2;
/** Last-moment window: roughly one or two production planner decisions. */
export const EMERGENCY_ASSIST_TRIGGER_SECONDS = 0.12;
/** Three planner steps of collision-free Manual flight before control returns. */
export const EMERGENCY_ASSIST_HANDOFF_SECONDS = 0.36;
export const EMERGENCY_ASSIST_REARM_CLEARANCE = 0.72;

export interface EmergencyAssistState {
  readonly active: boolean;
  readonly armed: boolean;
  readonly remainingSeconds: number;
  readonly safeSamples: number;
}

export type EmergencyAssistEvent =
  | "none"
  | "started"
  | "released-safe"
  | "released-timeout"
  | "rearmed";

export interface EmergencyAssistTransition {
  readonly state: EmergencyAssistState;
  readonly event: EmergencyAssistEvent;
}

export const INITIAL_EMERGENCY_ASSIST_STATE: Readonly<EmergencyAssistState> = Object.freeze({
  active: false,
  armed: true,
  remainingSeconds: 0,
  safeSamples: 0,
});

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizedClearance(value: number): number {
  return value === Number.POSITIVE_INFINITY
    ? value
    : finiteOr(value, Number.NEGATIVE_INFINITY);
}

function normalizedRoute(route: BrainRouteAssessment): BrainRouteAssessment {
  return {
    survivalSeconds: Math.max(0, finiteOr(route.survivalSeconds, 0)),
    predictedClearance: normalizedClearance(route.predictedClearance),
    hazardExposure: Math.max(0, finiteOr(route.hazardExposure, Number.POSITIVE_INFINITY)),
    terminalBoundaryClearance: Math.max(0, finiteOr(route.terminalBoundaryClearance, 0)),
  };
}

export function manualRouteNeedsEmergencyAssist(
  route: BrainRouteAssessment,
  planningHorizonSeconds: number,
): boolean {
  const safeRoute = normalizedRoute(route);
  const horizon = Math.max(0.03, finiteOr(planningHorizonSeconds, 1.5));
  return safeRoute.survivalSeconds < Math.min(horizon, EMERGENCY_ASSIST_TRIGGER_SECONDS);
}

/** Removes pickup temptation and human steering while retaining every ready skill. */
export function emergencyRescueObservation(
  observation: BrainObservation,
): BrainObservation {
  const specials = observation.abilities.specials;

  return {
    ...observation,
    pickups: [],
    manualIntent: { x: 0, y: 0 },
    abilities: {
      ...observation.abilities,
      // Readiness stays available to the normal policy, but these are not
      // forged human requests: the skill must materially improve survival.
      dashRequested: false,
      lowProfileRequested: false,
      missilesRequested: false,
      ...(specials ? {
        specials: {
          ...specials,
          manualCounterflareRequested: false,
          manualGravityKnotRequested: false,
          manualPhoenixSquadronRequested: false,
        },
      } : {}),
    },
  };
}

export function manualRouteIsSafeForHandoff(
  route: BrainRouteAssessment,
  planningHorizonSeconds: number,
): boolean {
  const safeRoute = normalizedRoute(route);
  const horizon = Math.max(0.03, finiteOr(planningHorizonSeconds, 1.5));
  // `predictedClearance` covers the entire planning horizon, so a distant
  // fireball would keep control even after the immediate dodge was complete.
  // Survival time gives Manual a bounded reaction window while the unchanged
  // last-moment trigger remains ready for genuinely imminent danger.
  return safeRoute.survivalSeconds
    >= Math.min(horizon, EMERGENCY_ASSIST_HANDOFF_SECONDS) - 1e-9;
}

/** A timed-out rescue stays disarmed until the original strict safety bar passes. */
export function manualRouteIsSafeForRearm(
  route: BrainRouteAssessment,
  planningHorizonSeconds: number,
): boolean {
  const safeRoute = normalizedRoute(route);
  const horizon = Math.max(0.03, finiteOr(planningHorizonSeconds, 1.5));
  return safeRoute.survivalSeconds >= horizon - 1e-9
    && safeRoute.predictedClearance >= EMERGENCY_ASSIST_REARM_CLEARANCE;
}

export function rescueRouteIsMeaningfullySafer(
  manualRoute: BrainRouteAssessment,
  rescueRoute: BrainRouteAssessment,
): boolean {
  const manual = normalizedRoute(manualRoute);
  const rescue = normalizedRoute(rescueRoute);
  return rescue.survivalSeconds > manual.survivalSeconds + 0.1
    || (
      rescue.survivalSeconds >= manual.survivalSeconds - 1e-9
      && rescue.predictedClearance > manual.predictedClearance + 0.18
    );
}

/** Advances only while gameplay simulation is running, so pause freezes the limit. */
export function tickEmergencyAssist(
  state: EmergencyAssistState,
  deltaSeconds: number,
): EmergencyAssistTransition {
  if (!state.active) {
    return { state, event: "none" };
  }

  const remainingSeconds = Math.max(
    0,
    finiteOr(state.remainingSeconds, EMERGENCY_ASSIST_MAX_SECONDS)
      - Math.max(0, finiteOr(deltaSeconds, 0)),
  );

  if (remainingSeconds <= 0) {
    return {
      state: {
        active: false,
        armed: false,
        remainingSeconds: 0,
        safeSamples: 0,
      },
      event: "released-timeout",
    };
  }

  return {
    state: { ...state, remainingSeconds },
    event: "none",
  };
}

/** Applies one fresh exact route sample from the shared Super Brain predictor. */
export function evaluateEmergencyAssist(
  state: EmergencyAssistState,
  manualRoute: BrainRouteAssessment,
  rescueRoute: BrainRouteAssessment,
  planningHorizonSeconds: number,
  imminentPhysicalCollision = false,
): EmergencyAssistTransition {
  if (!state.active) {
    if (!state.armed) {
      if (manualRouteIsSafeForRearm(manualRoute, planningHorizonSeconds)) {
        return {
          state: { ...state, armed: true, safeSamples: 0 },
          event: "rearmed",
        };
      }

      return { state, event: "none" };
    }

    if (
      (
        imminentPhysicalCollision
        || manualRouteNeedsEmergencyAssist(manualRoute, planningHorizonSeconds)
      )
      && rescueRouteIsMeaningfullySafer(manualRoute, rescueRoute)
    ) {
      return {
        state: {
          active: true,
          armed: true,
          remainingSeconds: EMERGENCY_ASSIST_MAX_SECONDS,
          safeSamples: 0,
        },
        event: "started",
      };
    }

    return { state, event: "none" };
  }

  const safeSamples = manualRouteIsSafeForHandoff(manualRoute, planningHorizonSeconds)
    ? state.safeSamples + 1
    : 0;

  if (safeSamples >= EMERGENCY_ASSIST_SAFE_SAMPLE_COUNT) {
    return {
      state: {
        active: false,
        armed: true,
        remainingSeconds: 0,
        safeSamples: 0,
      },
      event: "released-safe",
    };
  }

  return {
    state: { ...state, safeSamples },
    event: "none",
  };
}
