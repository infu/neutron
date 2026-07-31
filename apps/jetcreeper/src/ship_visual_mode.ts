export type ShipVisualMode = "manual" | "emergency" | "auto";

export interface ShipVisualProfile {
  readonly hullColor: number;
  readonly hullEmissive: number;
  readonly wingColor: number;
  readonly wingEmissive: number;
  readonly accentColor: number;
  readonly cockpitColor: number;
  readonly cockpitEmissive: number;
  readonly engineOuterColor: number;
  readonly engineCoreColor: number;
  readonly wireframe: boolean;
}

export const SHIP_VISUAL_PROFILES: Readonly<Record<ShipVisualMode, Readonly<ShipVisualProfile>>> = Object.freeze({
  manual: Object.freeze({
    hullColor: 0x42dce8,
    hullEmissive: 0x073b55,
    wingColor: 0x1688a8,
    wingEmissive: 0x052331,
    accentColor: 0x05080b,
    cockpitColor: 0xffe45c,
    cockpitEmissive: 0x8d3d06,
    engineOuterColor: 0xff3b24,
    engineCoreColor: 0xffdf52,
    wireframe: false,
  }),
  emergency: Object.freeze({
    hullColor: 0x42dce8,
    hullEmissive: 0x073b55,
    wingColor: 0x1688a8,
    wingEmissive: 0x052331,
    accentColor: 0x05080b,
    cockpitColor: 0xffe45c,
    cockpitEmissive: 0x8d3d06,
    engineOuterColor: 0xff3b24,
    engineCoreColor: 0xffdf52,
    wireframe: false,
  }),
  auto: Object.freeze({
    hullColor: 0x4cc9ff,
    hullEmissive: 0x0c4f9f,
    wingColor: 0x1d65c8,
    wingEmissive: 0x092c75,
    accentColor: 0x67dbef,
    cockpitColor: 0xc8f8ff,
    cockpitEmissive: 0x187fb8,
    engineOuterColor: 0x315dff,
    engineCoreColor: 0x78f5ff,
    wireframe: true,
  }),
});

export interface EmergencyHullScan {
  readonly progress: number;
  readonly y: number;
  readonly width: number;
  readonly opacity: number;
}

/** Emergency authority always wins if state is ever observed during a toggle. */
export function shipVisualMode(
  autoPilotEnabled: boolean,
  emergencyAssistActive: boolean,
): ShipVisualMode {
  if (emergencyAssistActive) return "emergency";
  return autoPilotEnabled ? "auto" : "manual";
}

/** Front-to-back neon hull scanner shared by rendering and deterministic tests. */
export function emergencyHullScan(
  elapsedSeconds: number,
  index: number,
  count: number,
  reducedMotion = false,
): EmergencyHullScan {
  const safeCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  const safeTime = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const travel = reducedMotion ? 0.38 : safeTime * 0.92;
  const rawProgress = travel + safeIndex / safeCount * 0.16;
  const progress = ((rawProgress % 1) + 1) % 1;
  const envelope = Math.sin(progress * Math.PI);

  return {
    progress,
    y: 1.42 - progress * 2.68,
    width: 0.34 + Math.pow(Math.max(0, envelope), 0.58) * 2.08,
    opacity: reducedMotion ? 0.32 : 0.22 + Math.max(0, envelope) * 0.42,
  };
}
