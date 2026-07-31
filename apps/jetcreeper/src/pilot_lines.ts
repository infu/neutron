export const PILOT_LINE_NODE_COUNT = 3;
export const PILOT_SYNC_TARGET = 3;

export type PilotLane = -1 | 0 | 1;

export interface PilotLineOutcome {
  readonly completed: boolean;
  readonly nextSync: number;
  readonly styleScore: number;
  readonly rapidFireSeconds: number;
  readonly burstSeconds: number;
  readonly syncStrike: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** A readable three-beat route: enter one side, cross center, exit opposite. */
export function pilotLanePattern(startSide: -1 | 1): readonly [PilotLane, PilotLane, PilotLane] {
  return [startSide, 0, startSide === -1 ? 1 : -1];
}

/** Keeps optional route nodes well inside the safe cave aperture. */
export function pilotLaneTarget(safeLeft: number, safeRight: number, lane: PilotLane): number {
  const left = Math.min(safeLeft, safeRight);
  const right = Math.max(safeLeft, safeRight);
  const width = Math.max(0, right - left);
  const center = (left + right) / 2;
  const inset = Math.min(2, width * 0.3);

  if (lane < 0) {
    return left + inset;
  }

  if (lane > 0) {
    return right - inset;
  }

  return center;
}

export function pilotNodeRemainingSeconds(
  nodeY: number,
  velocityY: number,
  lowerBoundary = -16,
): number {
  const descentSpeed = Math.max(0.01, Math.abs(velocityY));
  return Math.max(0, (nodeY - lowerBoundary) / descentSpeed);
}

/** Ordered nodes only advance while a real, recent movement command is live. */
export function nextPilotNodeAfterCrossing(
  nextNode: number,
  crossedNode: number,
  recentHumanInputSeconds: number,
): number {
  const safeNextNode = clamp(Math.floor(nextNode), 0, PILOT_LINE_NODE_COUNT);

  if (
    safeNextNode >= PILOT_LINE_NODE_COUNT
    || crossedNode !== safeNextNode
    || !Number.isFinite(recentHumanInputSeconds)
    || recentHumanInputSeconds <= 0
  ) {
    return safeNextNode;
  }

  return safeNextNode + 1;
}

/**
 * Missing a line is intentionally neutral. Style score is separate from the
 * combat score that drives sectors, so optional success never accelerates the
 * difficulty ramp.
 */
export function resolvePilotLine(
  currentSync: number,
  sector: number,
  completed: boolean,
): PilotLineOutcome {
  const safeSync = clamp(Math.floor(Number.isFinite(currentSync) ? currentSync : 0), 0, PILOT_SYNC_TARGET - 1);

  if (!completed) {
    return {
      completed: false,
      nextSync: safeSync,
      styleScore: 0,
      rapidFireSeconds: 0,
      burstSeconds: 0,
      syncStrike: false,
    };
  }

  const safeSector = Math.max(1, Math.min(200, Math.floor(Number.isFinite(sector) ? sector : 1)));
  const completedSync = safeSync + 1;
  const syncStrike = completedSync >= PILOT_SYNC_TARGET;
  const styleScore = 200
    + safeSector * 20
    + (syncStrike ? 600 : completedSync * 75);

  return {
    completed: true,
    nextSync: syncStrike ? 0 : completedSync,
    styleScore,
    rapidFireSeconds: 2.25,
    burstSeconds: syncStrike ? 1 : 0,
    syncStrike,
  };
}
