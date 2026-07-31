import { validateLevel } from "./mechanics.ts";
import type {
  ChannelDefinition,
  Coord,
  Direction,
  FixtureDefinition,
  LevelDefinition,
  ObjectDefinition,
  TerrainKind,
} from "./model.ts";
import {
  canonicalLevelHash,
  createInitialSnapshot,
  resolveDirectionalAction,
} from "./simulation.ts";
import {
  analyzeLevel,
  replayWitness,
  type AnalysisReport,
  type WitnessReplay,
} from "./solver.ts";
import { HULLSHIFT_BOARD_SYMBOLS } from "./mechanic_reference.ts";

export const TRAINING_CAMPAIGN_VERSION = "v1" as const;

export const TRAINING_IDS = [
  "training-1",
  "training-2",
  "training-3",
  "training-4",
  "training-5",
  "training-6",
] as const;

export type TrainingId = (typeof TRAINING_IDS)[number];

export type TrainingMechanicId =
  | "movement"
  | "cargo"
  | "pushing"
  | "blocked-push"
  | "undo"
  | "gate"
  | "plate"
  | "door"
  | "reactor-cell"
  | "socket"
  | "restart"
  | "relay"
  | "bridge"
  | "vacuum"
  | "causal-failure"
  | "rewind"
  | "fracture"
  | "disposal";

export interface TrainingIdentity {
  readonly campaignVersion: typeof TRAINING_CAMPAIGN_VERSION;
  readonly missionId: TrainingId;
}

export interface TrainingBriefingCard {
  readonly mechanic: TrainingMechanicId;
  readonly symbol: string;
  readonly name: string;
  readonly rule: string;
}

export interface TrainingBriefing {
  readonly title: string;
  readonly objective: string;
  readonly summary: string;
  readonly cards: readonly TrainingBriefingCard[];
}

export type TrainingPracticeOutcome =
  | "blocked"
  | "playing"
  | "physical-failure"
  | "causal-failure";

export interface TrainingPractice {
  readonly id: string;
  readonly prompt: string;
  /** Directional steps start from the certified initial state. */
  readonly actions: readonly Direction[];
  readonly expectedOutcome: TrainingPracticeOutcome;
  readonly recovery: "undo" | "rewind" | "restart" | null;
}

export interface TrainingDefinition {
  readonly identity: TrainingIdentity;
  readonly order: number;
  readonly title: string;
  readonly level: LevelDefinition;
  readonly levelHash: string;
  readonly witness: readonly Direction[];
  /** All board rules and recovery concepts presented by this mission. */
  readonly mechanicsPresent: readonly TrainingMechanicId[];
  /** Local briefing flags awarded on completion; never simulation inputs. */
  readonly learnedMechanics: readonly TrainingMechanicId[];
  readonly briefing: TrainingBriefing;
  readonly practice: readonly TrainingPractice[];
}

export interface TrainingCertification {
  readonly trainingId: TrainingId;
  readonly levelHash: string;
  readonly replay: WitnessReplay;
  readonly analysis: AnalysisReport;
}

interface PositionedFixture {
  readonly position: Coord;
  readonly fixture: FixtureDefinition;
}

interface TerrainCell {
  readonly position: Coord;
  readonly terrain?: Exclude<TerrainKind, "bulkhead">;
}

interface TrainingLevelInput {
  readonly channels: readonly ChannelDefinition[];
  readonly terrain: readonly TerrainCell[];
  readonly fixtures: readonly PositionedFixture[];
  readonly player: Coord;
  readonly objects?: readonly ObjectDefinition[];
}

const ALPHA: ChannelDefinition = Object.freeze({ id: "alpha", symbol: "A" });
const BETA: ChannelDefinition = Object.freeze({ id: "beta", symbol: "B" });

function coordinateKey(position: Coord): string {
  return `${position.x},${position.y}`;
}

function cellsInRect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): readonly TerrainCell[] {
  const result: TerrainCell[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) result.push({ position: { x, y } });
  }
  return result;
}

function line(
  from: Coord,
  to: Coord,
  terrain: Exclude<TerrainKind, "bulkhead"> = "floor",
): readonly TerrainCell[] {
  if (from.x !== to.x && from.y !== to.y) throw new Error("Training line must be cardinal");
  const result: TerrainCell[] = [];
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  let current = { x: from.x, y: from.y };
  while (true) {
    result.push({ position: current, terrain });
    if (current.x === to.x && current.y === to.y) break;
    current = { x: current.x + dx, y: current.y + dy };
  }
  return result;
}

function buildTrainingLevel(input: TrainingLevelInput): LevelDefinition {
  const width = 7;
  const height = 7;
  const terrainByCell = new Map<string, TerrainKind>();
  for (const entry of input.terrain) {
    terrainByCell.set(coordinateKey(entry.position), entry.terrain ?? "floor");
  }
  const fixtureByCell = new Map(
    input.fixtures.map((entry) => [
      coordinateKey(entry.position),
      Object.freeze({ ...entry.fixture }) as FixtureDefinition,
    ]),
  );
  const cells = Array.from({ length: width * height }, (_, index) => {
    const position = { x: index % width, y: Math.floor(index / width) };
    const fixture = fixtureByCell.get(coordinateKey(position));
    return Object.freeze({
      terrain: terrainByCell.get(coordinateKey(position)) ?? "bulkhead",
      ...(fixture === undefined ? {} : { fixture }),
    });
  });
  return Object.freeze({
    generatorVersion: "g1",
    width,
    height,
    channels: Object.freeze(
      input.channels.map((channel) => Object.freeze({ ...channel })),
    ),
    cells: Object.freeze(cells),
    playerStart: Object.freeze({ ...input.player }),
    objects: Object.freeze(
      (input.objects ?? []).map((object) =>
        Object.freeze({ ...object, position: Object.freeze({ ...object.position }) }),
      ),
    ),
  });
}

function card(
  mechanic: TrainingMechanicId,
  symbol: string,
  name: string,
  rule: string,
): TrainingBriefingCard {
  return Object.freeze({ mechanic, symbol, name, rule });
}

type CircuitBoardMechanic = "plate" | "relay" | "socket" | "door" | "bridge" | "gate";

function channelCardSymbol(
  mechanic: CircuitBoardMechanic,
  channel: ChannelDefinition,
): string {
  return `${HULLSHIFT_BOARD_SYMBOLS[mechanic]}${channel.symbol}`;
}

function practice(
  id: string,
  prompt: string,
  actions: readonly Direction[],
  expectedOutcome: TrainingPracticeOutcome,
  recovery: TrainingPractice["recovery"],
): TrainingPractice {
  return Object.freeze({
    id,
    prompt,
    actions: Object.freeze([...actions]),
    expectedOutcome,
    recovery,
  });
}

function definition(input: Omit<TrainingDefinition, "levelHash">): TrainingDefinition {
  return Object.freeze({
    ...input,
    identity: Object.freeze({ ...input.identity }),
    levelHash: canonicalLevelHash(input.level),
  });
}

const TRAINING_1_LEVEL = buildTrainingLevel({
  channels: [ALPHA],
  terrain: [
    ...cellsInRect(1, 1, 5, 3).filter(
      (entry) => entry.position.x !== 3 || entry.position.y !== 1,
    ),
    { position: { x: 1, y: 5 } },
  ],
  fixtures: [
    { position: { x: 5, y: 2 }, fixture: { kind: "gate", id: "gate", channel: "alpha" } },
    { position: { x: 1, y: 5 }, fixture: { kind: "plate", id: "gate-power", channel: "alpha" } },
  ],
  player: { x: 1, y: 2 },
  objects: [
    { id: "practice-cargo", kind: "cargo", position: { x: 2, y: 2 } },
    { id: "gate-ballast", kind: "cargo", position: { x: 1, y: 5 } },
  ],
});

const TRAINING_2_LEVEL = buildTrainingLevel({
  channels: [ALPHA, BETA],
  terrain: line({ x: 1, y: 2 }, { x: 5, y: 2 }),
  fixtures: [
    { position: { x: 2, y: 2 }, fixture: { kind: "plate", id: "door-plate", channel: "alpha" } },
    { position: { x: 3, y: 2 }, fixture: { kind: "door", id: "door", channel: "alpha" } },
    { position: { x: 4, y: 2 }, fixture: { kind: "plate", id: "gate-plate", channel: "beta" } },
    { position: { x: 5, y: 2 }, fixture: { kind: "gate", id: "gate", channel: "beta" } },
  ],
  player: { x: 1, y: 2 },
});

const TRAINING_3_LEVEL = buildTrainingLevel({
  channels: [ALPHA],
  terrain: cellsInRect(1, 1, 5, 3),
  fixtures: [
    {
      position: { x: 3, y: 2 },
      fixture: { kind: "socket", id: "socket", channel: "alpha", initiallyInstalled: false },
    },
    { position: { x: 4, y: 2 }, fixture: { kind: "door", id: "door", channel: "alpha" } },
    { position: { x: 5, y: 2 }, fixture: { kind: "gate", id: "gate", channel: "alpha" } },
  ],
  player: { x: 1, y: 2 },
  objects: [{ id: "reactor-cell", kind: "reactor-cell", position: { x: 2, y: 2 } }],
});

const TRAINING_4_LEVEL = buildTrainingLevel({
  channels: [ALPHA, BETA],
  terrain: line({ x: 1, y: 2 }, { x: 5, y: 2 }),
  fixtures: [
    { position: { x: 2, y: 2 }, fixture: { kind: "plate", id: "plate", channel: "alpha" } },
    { position: { x: 3, y: 2 }, fixture: { kind: "door", id: "door", channel: "alpha" } },
    {
      position: { x: 4, y: 2 },
      fixture: { kind: "relay", id: "relay", channel: "beta", initialOn: false },
    },
    { position: { x: 5, y: 2 }, fixture: { kind: "gate", id: "gate", channel: "beta" } },
  ],
  player: { x: 1, y: 2 },
});

const TRAINING_5_LEVEL = buildTrainingLevel({
  channels: [ALPHA, BETA],
  terrain: [
    ...cellsInRect(1, 1, 2, 3),
    ...cellsInRect(4, 1, 5, 3),
    { position: { x: 3, y: 1 }, terrain: "vacuum" },
    { position: { x: 3, y: 2 }, terrain: "vacuum" },
    { position: { x: 3, y: 3 }, terrain: "vacuum" },
  ],
  fixtures: [
    {
      position: { x: 1, y: 3 },
      fixture: { kind: "relay", id: "bridge-relay", channel: "alpha", initialOn: false },
    },
    { position: { x: 3, y: 2 }, fixture: { kind: "bridge", id: "bridge", channel: "alpha" } },
    { position: { x: 5, y: 2 }, fixture: { kind: "plate", id: "gate-plate", channel: "beta" } },
    { position: { x: 4, y: 1 }, fixture: { kind: "gate", id: "gate", channel: "beta" } },
  ],
  player: { x: 1, y: 2 },
  objects: [{ id: "mission-cargo", kind: "cargo", position: { x: 2, y: 2 } }],
});

const TRAINING_6_LEVEL = buildTrainingLevel({
  channels: [ALPHA],
  terrain: [
    ...line({ x: 1, y: 1 }, { x: 3, y: 1 }),
    { position: { x: 1, y: 2 }, terrain: "fracture" },
    ...line({ x: 3, y: 2 }, { x: 4, y: 2 }),
    { position: { x: 1, y: 3 } },
    { position: { x: 3, y: 3 } },
    ...line({ x: 1, y: 4 }, { x: 3, y: 4 }),
  ],
  fixtures: [
    {
      position: { x: 2, y: 1 },
      fixture: { kind: "relay", id: "gate-relay", channel: "alpha", initialOn: false },
    },
    {
      position: { x: 3, y: 3 },
      fixture: { kind: "disposal", id: "chain-disposal" },
    },
    {
      position: { x: 3, y: 4 },
      fixture: { kind: "disposal", id: "practice-disposal" },
    },
    { position: { x: 4, y: 2 }, fixture: { kind: "gate", id: "gate", channel: "alpha" } },
  ],
  player: { x: 1, y: 3 },
  objects: [
    { id: "blocking-cargo", kind: "cargo", position: { x: 3, y: 2 } },
    { id: "practice-cargo", kind: "cargo", position: { x: 2, y: 4 } },
  ],
});

export const TRAINING_CAMPAIGN: readonly TrainingDefinition[] = Object.freeze([
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-1" },
    order: 1,
    title: "First Shift",
    level: TRAINING_1_LEVEL,
    witness: Object.freeze(["E", "S", "E", "E", "E", "N"] as const),
    mechanicsPresent: Object.freeze(["movement", "cargo", "pushing", "blocked-push", "undo", "gate"]),
    learnedMechanics: Object.freeze(["movement", "cargo", "pushing", "blocked-push", "undo", "gate"]),
    briefing: Object.freeze({
      title: "Training 1 — First Shift",
      objective: "Push the cargo once, circle around it, and enter the ready evacuation gate.",
      summary: "Every direction is one turn. A blocked walk or push changes nothing, and Undo restores the prior stable turn.",
      cards: Object.freeze([
        card("movement", "↑↓←→", "Move", "Move one cell north, east, south, or west."),
        card("pushing", HULLSHIFT_BOARD_SYMBOLS.cargo, "Cargo pod", "Walk into one pod to push it one cell. You cannot pull or chain-push."),
        card("undo", "↶", "Undo", "Restore exactly the stable state before the latest accepted action."),
        card("gate", channelCardSymbol("gate", ALPHA), "Ready gate", "Only the player enters, and its channel must already be active."),
      ]),
    }),
    practice: Object.freeze([
      practice(
        "blocked-push",
        "Push east, walk below the pod, then try north. The bulkhead makes that push a true no-op.",
        ["E", "S", "E", "N"],
        "blocked",
        null,
      ),
      practice(
        "undo-push",
        "Push east once, use Undo, and confirm both the pod and droid return.",
        ["E"],
        "playing",
        "undo",
      ),
    ]),
  }),
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-2" },
    order: 2,
    title: "Momentary Mass",
    level: TRAINING_2_LEVEL,
    witness: Object.freeze(["E", "E", "E", "E"] as const),
    mechanicsPresent: Object.freeze(["movement", "plate", "door", "gate"]),
    learnedMechanics: Object.freeze(["plate", "door"]),
    briefing: Object.freeze({
      title: "Training 2 — Momentary Mass",
      objective: "Hold each marked plate long enough to pass its linked consumer.",
      summary: "Plates are momentary sources. Player, cargo, and undocked reactor cells all count as mass.",
      cards: Object.freeze([
        card("plate", channelCardSymbol("plate", ALPHA), "Mass plate", "Its channel stays active only while any accepted entity occupies it."),
        card("door", channelCardSymbol("door", ALPHA), "Blast door", "Power opens it. If power drops while occupied, it jams open until vacated."),
      ]),
    }),
    practice: Object.freeze([]),
  }),
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-3" },
    order: 3,
    title: "Permanent Charge",
    level: TRAINING_3_LEVEL,
    witness: Object.freeze(["E", "S", "E", "E", "N", "E"] as const),
    mechanicsPresent: Object.freeze(["movement", "reactor-cell", "socket", "door", "gate", "restart"]),
    learnedMechanics: Object.freeze(["reactor-cell", "socket", "restart"]),
    briefing: Object.freeze({
      title: "Training 3 — Permanent Charge",
      objective: "Dock the reactor cell, route around the installed socket, and evacuate.",
      summary: "A pushed reactor cell docks permanently. Restart reconstructs this exact training board from its fixed identity.",
      cards: Object.freeze([
        card("reactor-cell", HULLSHIFT_BOARD_SYMBOLS.reactor, "Reactor cell", "Pushes like cargo and activates plates until it is installed."),
        card("socket", channelCardSymbol("socket", ALPHA), "Reactor socket", "A reactor pushed onto an empty socket locks there and powers its channel permanently."),
        card("restart", "↺", "Restart", "Return the complete board to its certified initial state without regenerating."),
      ]),
    }),
    practice: Object.freeze([
      practice(
        "restart-after-docking",
        "Dock the cell once, inspect the permanent source, then Restart before solving it again.",
        ["E"],
        "playing",
        "restart",
      ),
    ]),
  }),
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-4" },
    order: 4,
    title: "Remembered Signal",
    level: TRAINING_4_LEVEL,
    witness: Object.freeze(["E", "E", "E", "E"] as const),
    mechanicsPresent: Object.freeze(["movement", "plate", "door", "relay", "gate"]),
    learnedMechanics: Object.freeze(["relay"]),
    briefing: Object.freeze({
      title: "Training 4 — Remembered Signal",
      objective: "Use momentary power for the door, then switch persistent power for the gate.",
      summary: "A plate follows current mass. A relay remembers each distinct player entry until the player enters it again.",
      cards: Object.freeze([
        card("plate", channelCardSymbol("plate", ALPHA), "Momentary source", "Leaving removes its output unless another source still powers the channel."),
        card("relay", channelCardSymbol("relay", BETA), "Relay pad", "Player entry toggles it. Objects, waiting, reconnecting, and animation do not."),
      ]),
    }),
    practice: Object.freeze([]),
  }),
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-5" },
    order: 5,
    title: "Mind the Gap",
    level: TRAINING_5_LEVEL,
    witness: Object.freeze(["S", "N", "E", "E", "E", "N"] as const),
    mechanicsPresent: Object.freeze([
      "movement",
      "cargo",
      "relay",
      "plate",
      "bridge",
      "vacuum",
      "causal-failure",
      "rewind",
      "gate",
    ]),
    learnedMechanics: Object.freeze(["bridge", "vacuum", "causal-failure", "rewind"]),
    briefing: Object.freeze({
      title: "Training 5 — Mind the Gap",
      objective: "Latch bridge power, move the required pod across, and weigh down the gate plate.",
      summary: "Vacuum can destroy the droid or a required resource. Rewind restores exactly the fatal transition.",
      cards: Object.freeze([
        card("bridge", channelCardSymbol("bridge", ALPHA), "Phase bridge", "It supports entities only while active. Power loss beneath an occupant takes effect this turn."),
        card("vacuum", HULLSHIFT_BOARD_SYMBOLS.vacuum, "Vacuum", "Player entry is physical failure; a pushed object is permanently lost."),
        card("causal-failure", "!", "No route remains", "Losing a required resource fails only after exact analysis proves evacuation impossible."),
        card("rewind", "↶", "Rewind", "After failure, restore the one stable state immediately before the fatal action."),
      ]),
    }),
    practice: Object.freeze([
      practice(
        "physical-vacuum",
        "Latch the relay, move beside the lower breach, then step east into visible vacuum.",
        ["S", "E", "E"],
        "physical-failure",
        "rewind",
      ),
      practice(
        "causal-bridge-loss",
        "Put the required pod on the bridge, return to the relay, and switch the bridge off.",
        ["S", "N", "E", "W", "S"],
        "causal-failure",
        "rewind",
      ),
    ]),
  }),
  definition({
    identity: { campaignVersion: TRAINING_CAMPAIGN_VERSION, missionId: "training-6" },
    order: 6,
    title: "No Way Back",
    level: TRAINING_6_LEVEL,
    witness: Object.freeze(["N", "N", "E", "E", "S", "E"] as const),
    mechanicsPresent: Object.freeze(["movement", "cargo", "relay", "fracture", "disposal", "gate"]),
    learnedMechanics: Object.freeze(["fracture", "disposal"]),
    briefing: Object.freeze({
      title: "Training 6 — No Way Back",
      objective: "Practice each one-way system, then cross the fracture and dispose of the pod blocking the gate.",
      summary: "Try the nearby fracture and airlock separately, Restart, then combine them: the deck closes the retreat and the airlock clears the advance.",
      cards: Object.freeze([
        card("fracture", HULLSHIFT_BOARD_SYMBOLS.fracture, "Fracture deck", "An intact cell collapses only when occupied becomes empty. Entering alone does not collapse it."),
        card("disposal", HULLSHIFT_BOARD_SYMBOLS.disposal, "Disposal airlock", "A pushed cargo pod or reactor cell is removed permanently. The player cannot enter."),
      ]),
    }),
    practice: Object.freeze([
      practice(
        "fracture-alone",
        "Step north onto the fracture, then north off it. Inspect the collapsed deck and Restart.",
        ["N", "N"],
        "playing",
        "restart",
      ),
      practice(
        "disposal-alone",
        "Walk south and push the practice pod east into its airlock, then Restart.",
        ["S", "E"],
        "playing",
        "restart",
      ),
    ]),
  }),
]);

const TRAINING_BY_ID = new Map(
  TRAINING_CAMPAIGN.map((training) => [training.identity.missionId, training]),
);

export function getTrainingDefinition(id: TrainingId): TrainingDefinition {
  const training = TRAINING_BY_ID.get(id);
  if (training === undefined) throw new RangeError(`Unknown Hullshift training mission: ${id}`);
  return training;
}

/** Runs the same static validation, production replay, and exact graph proof as procedural levels. */
export async function certifyTrainingDefinition(
  training: TrainingDefinition,
): Promise<TrainingCertification> {
  const issues = validateLevel(training.level);
  if (issues.length > 0) {
    throw new Error(
      `${training.identity.missionId} failed static validation: ${issues[0]?.message ?? "unknown issue"}`,
    );
  }
  const actualHash = canonicalLevelHash(training.level);
  if (actualHash !== training.levelHash) {
    throw new Error(`${training.identity.missionId} canonical level hash changed`);
  }
  const replay = replayWitness(training.level, training.witness);
  const analysis = await analyzeLevel(training.level);
  if (!analysis.solvable || !analysis.winningStateKeys.has(analysis.initialStateKey)) {
    throw new Error(`${training.identity.missionId} failed exact solvability certification`);
  }
  for (const script of training.practice) {
    let snapshot = createInitialSnapshot(training.level);
    let accepted = true;
    for (let index = 0; index < script.actions.length; index += 1) {
      if (snapshot.outcome.kind !== "playing") {
        throw new Error(`${training.identity.missionId} practice '${script.id}' continues after failure`);
      }
      const transition = resolveDirectionalAction(
        training.level,
        snapshot,
        script.actions[index]!,
        { winningStateKeys: analysis.winningStateKeys },
      );
      accepted = transition.accepted;
      snapshot = transition.after;
      if (!accepted && index !== script.actions.length - 1) {
        throw new Error(`${training.identity.missionId} practice '${script.id}' blocks too early`);
      }
    }
    const actual: TrainingPracticeOutcome = accepted
      ? snapshot.outcome.kind === "playing"
        ? "playing"
        : snapshot.outcome.kind === "physical-failure"
          ? "physical-failure"
          : snapshot.outcome.kind === "causal-failure"
            ? "causal-failure"
            : (() => {
                throw new Error(`${training.identity.missionId} practice '${script.id}' unexpectedly wins`);
              })()
      : "blocked";
    if (actual !== script.expectedOutcome) {
      throw new Error(
        `${training.identity.missionId} practice '${script.id}' expected ${script.expectedOutcome}, got ${actual}`,
      );
    }
  }
  return Object.freeze({
    trainingId: training.identity.missionId,
    levelHash: actualHash,
    replay,
    analysis,
  });
}

export async function certifyTrainingCampaign(): Promise<readonly TrainingCertification[]> {
  const certifications: TrainingCertification[] = [];
  for (const training of TRAINING_CAMPAIGN) {
    certifications.push(await certifyTrainingDefinition(training));
  }
  return Object.freeze(certifications);
}
