/**
 * Jetcreeper's deliberately small arcade palette. Every color has one stable
 * gameplay role so the screen stays readable when the pixel pass gets busy.
 */
export const ARCADE_PALETTE = Object.freeze({
  void: 0x070611,
  deepPlum: 0x160c20,
  caveMauve: 0x42203f,
  ivory: 0xf6f2dc,
  aiCyan: 0x67dbef,
  playerMagenta: 0xff2f92,
  playerYellow: 0xffe45c,
  dangerCrimson: 0xff3158,
  telegraphOrange: 0xff8a3d,
  repairGreen: 0x78e66a,
  shieldAzure: 0x4cc9ff,
  plasmaCobalt: 0x597bff,
  stasisViolet: 0xa77bff,
  counterMint: 0x53f2c3,
  neutralSteel: 0x8590a8,
} as const);

export type ArcadePaletteRole = keyof typeof ARCADE_PALETTE;

export const ARCADE_PALETTE_ROLES = Object.freeze(
  Object.keys(ARCADE_PALETTE) as ArcadePaletteRole[],
);

export function arcadeColor(role: ArcadePaletteRole): number {
  return ARCADE_PALETTE[role];
}
