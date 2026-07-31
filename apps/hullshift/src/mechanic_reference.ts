import type { LevelDefinition } from "./model.ts";

/**
 * Canonical non-color-only UI glyphs shared by Help, mechanic callouts, and
 * training briefings. The GPU art mirrors these semantics with vector shapes;
 * it does not rasterize or parse these strings.
 *
 * Circuit cards may append their channel symbol (for example `◈A`), but the
 * mechanic glyph itself must always come from this manifest.
 */
export const HULLSHIFT_BOARD_SYMBOLS = Object.freeze({
  cargo: "▣",
  reactor: "◆",
  plate: "◈",
  relay: "◐",
  socket: "◉",
  door: "▥",
  bridge: "═",
  vacuum: "·",
  fracture: "╳",
  disposal: "▽",
  gate: "⇱",
} as const);

export type MechanicReference = Readonly<{
  key: string;
  label: string;
  symbol: string;
  rule: string;
}>;

export const MECHANIC_REFERENCE: Readonly<Record<string, MechanicReference>> = Object.freeze({
  cargo: Object.freeze({ key: "cargo", label: "Cargo pod", symbol: HULLSHIFT_BOARD_SYMBOLS.cargo, rule: "Push it one cell at a time; it cannot be pulled or chain-pushed." }),
  reactor: Object.freeze({ key: "reactor", label: "Reactor cell", symbol: HULLSHIFT_BOARD_SYMBOLS.reactor, rule: "Push it into a matching socket to create a permanent power source." }),
  plate: Object.freeze({ key: "plate", label: "Mass plate", symbol: HULLSHIFT_BOARD_SYMBOLS.plate, rule: "The droid, cargo, or a reactor cell powers its channel while occupying it." }),
  relay: Object.freeze({ key: "relay", label: "Relay pad", symbol: HULLSHIFT_BOARD_SYMBOLS.relay, rule: "The droid toggles it on entry; movable objects do not toggle it." }),
  socket: Object.freeze({ key: "socket", label: "Reactor socket", symbol: HULLSHIFT_BOARD_SYMBOLS.socket, rule: "A matching reactor cell docks here permanently and powers its channel." }),
  door: Object.freeze({ key: "door", label: "Blast door", symbol: HULLSHIFT_BOARD_SYMBOLS.door, rule: "Power opens it; if power drops while occupied, it jams until vacated." }),
  bridge: Object.freeze({ key: "bridge", label: "Phase bridge", symbol: HULLSHIFT_BOARD_SYMBOLS.bridge, rule: "Power makes safe deck; without power the cell is vacuum." }),
  vacuum: Object.freeze({ key: "vacuum", label: "Vacuum", symbol: HULLSHIFT_BOARD_SYMBOLS.vacuum, rule: "The droid is lost on entry, while pushed objects are removed from the deck." }),
  fracture: Object.freeze({ key: "fracture", label: "Fracture deck", symbol: HULLSHIFT_BOARD_SYMBOLS.fracture, rule: "It collapses into vacuum after an occupant leaves it empty." }),
  disposal: Object.freeze({ key: "disposal", label: "Disposal airlock", symbol: HULLSHIFT_BOARD_SYMBOLS.disposal, rule: "Pushed objects are removed; the droid cannot enter." }),
  gate: Object.freeze({ key: "gate", label: "Evacuation gate", symbol: HULLSHIFT_BOARD_SYMBOLS.gate, rule: "Enter it while its channel is powered to complete the mission." }),
});

/** Stable board-order vocabulary used by briefings, Help, and learned flags. */
export const HULLSHIFT_BOARD_REFERENCE_ORDER = Object.freeze([
  "cargo", "reactor", "plate", "relay", "socket", "door",
  "bridge", "vacuum", "fracture", "disposal", "gate",
] as const);

export function mechanicReferencesForLevel(level: LevelDefinition): readonly MechanicReference[] {
  const present = new Set<string>();
  for (const object of level.objects) {
    present.add(object.kind === "reactor-cell" ? "reactor" : "cargo");
  }
  for (const cell of level.cells) {
    if (cell.terrain === "vacuum") present.add("vacuum");
    if (cell.terrain === "fracture") present.add("fracture");
    if (cell.fixture) present.add(cell.fixture.kind);
  }
  return Object.freeze(HULLSHIFT_BOARD_REFERENCE_ORDER
    .filter((key) => present.has(key))
    .map((key) => MECHANIC_REFERENCE[key]!));
}
