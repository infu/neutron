export interface FlightMotionInput {
  readonly velocityX: number;
  readonly velocityY: number;
  readonly accelerationX: number;
  readonly accelerationY: number;
  readonly maximumSpeed: number;
  readonly manualInfluence: number;
  readonly dashActive: boolean;
  readonly reducedMotion: boolean;
}

export interface FlightMotionState {
  /** Roll around the jet's longitudinal axis, rendered as a Three.js Y rotation. */
  readonly bank: number;
  /** Nose-up/down impression, rendered as a Three.js X rotation. */
  readonly pitch: number;
  /** Small heading change in the screen plane, rendered as a Three.js Z rotation. */
  readonly yaw: number;
  readonly leftExhaust: number;
  readonly rightExhaust: number;
  readonly exhaustWidth: number;
}

export const DASH_BARREL_ROLL_SECONDS = 0.42;

export const RESTING_FLIGHT_MOTION: FlightMotionState = Object.freeze({
  bank: 0,
  pitch: 0,
  yaw: 0,
  leftExhaust: 0.82,
  rightExhaust: 0.82,
  exhaustWidth: 0.46,
});

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function approach(current: number, target: number, rate: number, deltaSeconds: number): number {
  const safeDelta = clamp(finiteOr(deltaSeconds), 0, 0.25);
  const alpha = 1 - Math.exp(-Math.max(0, rate) * safeDelta);
  return current + (target - current) * alpha;
}

/** Presentation-only full turn around the fighter's local nose-to-tail axis. */
export function dashBarrelRollAngle(
  progress: number,
  direction: number,
  reducedMotion: boolean,
): number {
  if (reducedMotion) return 0;
  const safeProgress = clamp(finiteOr(progress), 0, 1);
  const turnDirection = finiteOr(direction, 1) < 0 ? -1 : 1;
  const easedProgress = safeProgress < 0.5
    ? 2 * safeProgress * safeProgress
    : 1 - Math.pow(-2 * safeProgress + 2, 2) / 2;
  return turnDirection * Math.PI * 2 * easedProgress;
}

/**
 * Converts the real gameplay velocity and acceleration into presentation-only
 * flight cues. Every output is bounded so a wall clamp or a resumed frame can
 * never flip or hide the fighter.
 */
export function targetFlightMotion(input: FlightMotionInput): FlightMotionState {
  const maximumSpeed = Math.max(0.01, Math.abs(finiteOr(input.maximumSpeed, 1)));
  const lateralVelocity = clamp(finiteOr(input.velocityX) / maximumSpeed, -1, 1);
  const forwardVelocity = clamp(finiteOr(input.velocityY) / maximumSpeed, -1, 1);
  const lateralAcceleration = clamp(
    finiteOr(input.accelerationX) / (maximumSpeed * 7),
    -1,
    1,
  );
  const forwardAcceleration = clamp(
    finiteOr(input.accelerationY) / (maximumSpeed * 7),
    -1,
    1,
  );
  const manualInfluence = clamp(finiteOr(input.manualInfluence), 0, 1);
  const angleScale = input.reducedMotion ? 0.34 : 1;
  const manualAuthority = 1 + manualInfluence * 0.1;

  const bank = clamp(
    -(lateralVelocity * 0.42 + lateralAcceleration * 0.17) * manualAuthority,
    -0.54,
    0.54,
  ) * angleScale || 0;
  const yaw = clamp(
    -(lateralVelocity * 0.078 + lateralAcceleration * 0.046),
    -0.115,
    0.115,
  ) * angleScale || 0;
  const dashPitch = input.dashActive ? forwardVelocity * 0.08 : 0;
  const pitch = clamp(
    forwardVelocity * 0.075 + forwardAcceleration * 0.095 + dashPitch,
    -0.16,
    0.16,
  ) * angleScale;

  const speedRatio = clamp(
    Math.hypot(finiteOr(input.velocityX), finiteOr(input.velocityY)) / maximumSpeed,
    0,
    1.35,
  );
  const accelerationEnergy = Math.min(0.16, Math.hypot(lateralAcceleration, forwardAcceleration) * 0.1);
  const dashBoost = input.dashActive ? (input.reducedMotion ? 0.42 : 1.08) : 0;
  const exhaust = clamp(
    0.82 + speedRatio * 0.44 + Math.max(0, forwardVelocity) * 0.16 + accelerationEnergy + dashBoost,
    0.78,
    2.62,
  );
  const differentialScale = input.reducedMotion ? 0.36 : 1;
  const turnDifferential = clamp(
    (lateralAcceleration * 0.12 + lateralVelocity * 0.07) * differentialScale,
    -0.18,
    0.18,
  );

  return {
    bank,
    pitch,
    yaw,
    leftExhaust: exhaust * (1 - turnDifferential),
    rightExhaust: exhaust * (1 + turnDifferential),
    exhaustWidth: clamp(0.46 - speedRatio * 0.075 - (input.dashActive ? 0.07 : 0), 0.3, 0.46),
  };
}

/** Smoothly follows the target while giving active human steering a crisper feel. */
export function stepFlightMotion(
  current: FlightMotionState,
  input: FlightMotionInput,
  deltaSeconds: number,
): FlightMotionState {
  const target = targetFlightMotion(input);
  const manualInfluence = clamp(finiteOr(input.manualInfluence), 0, 1);
  const angleRate = (input.reducedMotion ? 7 : 9.5) + manualInfluence * 5;
  const settleRate = input.reducedMotion ? 4 : 4.4;
  const exhaustRate = input.reducedMotion ? 10 : 17;
  const angleApproach = (currentValue: number, targetValue: number, rateScale = 1): number => {
    const returningToCenter = Math.abs(targetValue) < Math.abs(currentValue)
      && (targetValue === 0 || Math.sign(currentValue) === Math.sign(targetValue));
    return approach(
      currentValue,
      targetValue,
      (returningToCenter ? settleRate : angleRate) * rateScale,
      deltaSeconds,
    );
  };

  return {
    bank: angleApproach(finiteOr(current.bank), target.bank),
    pitch: angleApproach(finiteOr(current.pitch), target.pitch, 0.82),
    yaw: angleApproach(finiteOr(current.yaw), target.yaw, 1.12),
    leftExhaust: approach(finiteOr(current.leftExhaust, RESTING_FLIGHT_MOTION.leftExhaust), target.leftExhaust, exhaustRate, deltaSeconds),
    rightExhaust: approach(finiteOr(current.rightExhaust, RESTING_FLIGHT_MOTION.rightExhaust), target.rightExhaust, exhaustRate, deltaSeconds),
    exhaustWidth: approach(finiteOr(current.exhaustWidth, RESTING_FLIGHT_MOTION.exhaustWidth), target.exhaustWidth, exhaustRate, deltaSeconds),
  };
}
