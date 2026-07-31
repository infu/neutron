/**
 * Hullshift's bounded presentation palette.
 *
 * These values are presentation-only. They must never be used by simulation,
 * hashing, or solver code. Gameplay roles are additionally
 * communicated by geometry and symbols, so a color is never the sole rule
 * carrier.
 */
export const HULLSHIFT_PALETTE = Object.freeze({
  void: 0x05080d,
  hullDeep: 0x0b121a,
  hull: 0x14222e,
  hullRaised: 0x203542,
  hullEdge: 0x3f5863,
  steel: 0x71838b,
  textLight: 0xd8e5df,
  focusCyan: 0x57dbe8,
  powerGreen: 0x68db87,
  goalIvory: 0xf1edc5,
  warningAmber: 0xf0ad4e,
  hazardOrange: 0xf06d3f,
  dangerRed: 0xe4474f,
  relayViolet: 0x9a77df,
  reactorGold: 0xe2c35b,
  cargoBlue: 0x4f87a4,
  inactive: 0x40505a,
  shadow: 0x020407,
} as const);

export type HullshiftPaletteRole = keyof typeof HULLSHIFT_PALETTE;

export const HULLSHIFT_PALETTE_ROLES = Object.freeze(
  Object.keys(HULLSHIFT_PALETTE) as HullshiftPaletteRole[],
);

/** The fixed palette sampled by the whole-scene post-process. */
export const HULLSHIFT_PIXEL_PALETTE = Object.freeze([
  HULLSHIFT_PALETTE.void,
  HULLSHIFT_PALETTE.hullDeep,
  HULLSHIFT_PALETTE.hull,
  HULLSHIFT_PALETTE.hullRaised,
  HULLSHIFT_PALETTE.hullEdge,
  HULLSHIFT_PALETTE.steel,
  HULLSHIFT_PALETTE.textLight,
  HULLSHIFT_PALETTE.focusCyan,
  HULLSHIFT_PALETTE.powerGreen,
  HULLSHIFT_PALETTE.goalIvory,
  HULLSHIFT_PALETTE.warningAmber,
  HULLSHIFT_PALETTE.hazardOrange,
  HULLSHIFT_PALETTE.dangerRed,
  HULLSHIFT_PALETTE.relayViolet,
  HULLSHIFT_PALETTE.reactorGold,
  HULLSHIFT_PALETTE.cargoBlue,
] as const);

export const HULLSHIFT_CHANNEL_COLORS = Object.freeze([
  0x57dbe8,
  0xe2c35b,
  0x9a77df,
  0x68db87,
] as const);

export function paletteColor(role: HullshiftPaletteRole): number {
  return HULLSHIFT_PALETTE[role];
}

/** Stable modulo lookup for the four V1 circuit channels. */
export function channelColor(channelIndex: number): number {
  if (!Number.isInteger(channelIndex) || channelIndex < 0) {
    throw new RangeError("Channel index must be a non-negative integer");
  }
  return HULLSHIFT_CHANNEL_COLORS[channelIndex % HULLSHIFT_CHANNEL_COLORS.length]!;
}

export function colorChannels(color: number): readonly [number, number, number] {
  if (!Number.isInteger(color) || color < 0 || color > 0xff_ffff) {
    throw new RangeError("Palette color must be a 24-bit integer");
  }
  return Object.freeze([
    ((color >>> 16) & 0xff) / 255,
    ((color >>> 8) & 0xff) / 255,
    (color & 0xff) / 255,
  ] as const);
}
