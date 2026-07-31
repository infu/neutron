import type { JsonObject, JsonValue } from "neutron-tools/app";
import type { HullshiftSettings, ResidentResult, ResidentSnapshot } from "./resident.ts";

export const HULLSHIFT_TOOLS = {
  snapshot: "hullshift_snapshot",
  generationStatus: "hullshift_generation_status",
  generationStart: "hullshift_generation_start",
  generationCancel: "hullshift_generation_cancel",
  generationDismiss: "hullshift_generation_dismiss",
  trainingStart: "hullshift_training_start",
  runOpen: "hullshift_run_open",
  runClose: "hullshift_run_close",
  runAction: "hullshift_run_action",
  runUndo: "hullshift_run_undo",
  runRestart: "hullshift_run_restart",
  runHint: "hullshift_run_hint",
  runBriefed: "hullshift_run_briefed",
  runDelete: "hullshift_run_delete",
  settingsUpdate: "hullshift_settings_update",
  storageRetry: "hullshift_storage_retry",
  clearData: "hullshift_clear_data",
} as const;

export type HullshiftToolName = (typeof HULLSHIFT_TOOLS)[keyof typeof HULLSHIFT_TOOLS];

const tileIdSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  pattern: "^[a-zA-Z0-9_.:-]+$",
};
const idSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-zA-Z0-9_-]+$",
};
const revisionSchema: JsonObject = { type: "integer", minimum: 0 };
const directionSchema: JsonObject = { type: "string", enum: ["N", "E", "S", "W"] };

function objectSchema(required: string[], properties: Record<string, JsonValue>): JsonObject {
  return { type: "object", required, properties, additionalProperties: false };
}

export const snapshotInputSchema = objectSchema(["tileId"], { tileId: tileIdSchema });

export const generationStartInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision", "seed", "difficulty"],
  {
    tileId: tileIdSchema,
    expectedServiceRevision: revisionSchema,
    seed: { type: "string", pattern: "^[0-9a-f]{16}$" },
    difficulty: { type: "integer", minimum: 0, maximum: 8 },
  },
);

export const generationCancelInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision", "jobId"],
  { tileId: tileIdSchema, expectedServiceRevision: revisionSchema, jobId: idSchema },
);

export const trainingStartInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision", "trainingId"],
  {
    tileId: tileIdSchema,
    expectedServiceRevision: revisionSchema,
    trainingId: {
      type: "string",
      enum: ["training-1", "training-2", "training-3", "training-4", "training-5", "training-6"],
    },
  },
);

export const runOpenInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision", "runId"],
  { tileId: tileIdSchema, expectedServiceRevision: revisionSchema, runId: idSchema },
);

export const runCloseInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision"],
  { tileId: tileIdSchema, expectedServiceRevision: revisionSchema },
);

export const runMutationInputSchema = objectSchema(
  ["tileId", "runId", "expectedRevision"],
  { tileId: tileIdSchema, runId: idSchema, expectedRevision: revisionSchema },
);

export const runActionInputSchema = objectSchema(
  ["tileId", "runId", "expectedRevision", "direction"],
  {
    tileId: tileIdSchema,
    runId: idSchema,
    expectedRevision: revisionSchema,
    direction: directionSchema,
  },
);

export const runHintInputSchema = objectSchema(
  ["tileId", "runId", "expectedRevision", "tier"],
  {
    tileId: tileIdSchema,
    runId: idSchema,
    expectedRevision: revisionSchema,
    tier: { type: "integer", minimum: 1, maximum: 2 },
  },
);

export const settingsInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision"],
  {
    tileId: tileIdSchema,
    expectedServiceRevision: revisionSchema,
    sound: { type: "boolean" },
    reducedMotion: { type: "string", enum: ["system", "on", "off"] },
    skipKnownBriefings: { type: "boolean" },
  },
);

export const clearDataInputSchema = objectSchema(
  ["tileId", "expectedServiceRevision", "confirmation"],
  {
    tileId: tileIdSchema,
    expectedServiceRevision: revisionSchema,
    confirmation: { const: "CLEAR HULLSHIFT" },
  },
);

const storageSchema = objectSchema(["mode", "error"], {
  mode: { type: "string", enum: ["persistent", "volatile"] },
  error: { type: ["string", "null"], maxLength: 500 },
});
const settingsSchema = objectSchema(["sound", "reducedMotion", "skipKnownBriefings"], {
  sound: { type: "boolean" },
  reducedMotion: { type: "string", enum: ["system", "on", "off"] },
  skipKnownBriefings: { type: "boolean" },
});
const snapshotSchema = objectSchema(
  ["serviceRevision", "storage", "settings", "learnedMechanics", "runs", "activeRunId", "activeRun", "generation"],
  {
    serviceRevision: revisionSchema,
    storage: storageSchema,
    settings: settingsSchema,
    learnedMechanics: { type: "array", maxItems: 64, items: { type: "string", maxLength: 80 } },
    runs: { type: "array", maxItems: 12, items: { type: "object" } },
    activeRunId: { type: ["string", "null"], maxLength: 80 },
    activeRun: { type: ["object", "null"] },
    generation: { type: ["object", "null"] },
  },
);

export const resultSchema: JsonObject = {
  oneOf: [
    objectSchema(["ok", "snapshot"], {
      ok: { const: true },
      snapshot: snapshotSchema,
      accepted: { type: "boolean" },
      pushed: { type: "boolean" },
      events: { type: "array", maxItems: 256, items: { type: "object" } },
      hint: { type: "object" },
    }),
    objectSchema(["ok", "conflict", "snapshot"], {
      ok: { const: false },
      conflict: objectSchema(["scope", "expectedRevision", "actualRevision"], {
        scope: { type: "string", enum: ["service", "run"] },
        expectedRevision: revisionSchema,
        actualRevision: revisionSchema,
      }),
      snapshot: snapshotSchema,
    }),
  ],
};

export { snapshotSchema as residentSnapshotSchema };

export function parseResidentSnapshot(value: unknown): ResidentSnapshot {
  if (
    typeof value !== "object" || value === null ||
    !Number.isSafeInteger((value as { serviceRevision?: unknown }).serviceRevision) ||
    typeof (value as { storage?: unknown }).storage !== "object" ||
    !Array.isArray((value as { runs?: unknown }).runs)
  ) {
    throw new Error("Hullshift resident returned an invalid snapshot");
  }
  return value as ResidentSnapshot;
}

export function parseResidentResult(value: unknown): ResidentResult {
  if (typeof value !== "object" || value === null || typeof (value as { ok?: unknown }).ok !== "boolean") {
    throw new Error("Hullshift resident returned an invalid mutation result");
  }
  const result = value as ResidentResult;
  parseResidentSnapshot(result.snapshot);
  if (!result.ok && typeof result.conflict !== "object") {
    throw new Error("Hullshift resident omitted conflict metadata");
  }
  return result;
}

export function settingsPatch(args: JsonObject): Partial<HullshiftSettings> {
  const patch: Partial<HullshiftSettings> = {};
  if (typeof args.sound === "boolean") patch.sound = args.sound;
  if (args.reducedMotion === "system" || args.reducedMotion === "on" || args.reducedMotion === "off") {
    patch.reducedMotion = args.reducedMotion;
  }
  if (typeof args.skipKnownBriefings === "boolean") patch.skipKnownBriefings = args.skipKnownBriefings;
  return patch;
}
