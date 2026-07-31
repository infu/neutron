import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import {
  HULLSHIFT_TOOLS,
  clearDataInputSchema,
  generationCancelInputSchema,
  generationStartInputSchema,
  resultSchema,
  runActionInputSchema,
  runCloseInputSchema,
  runHintInputSchema,
  runMutationInputSchema,
  runOpenInputSchema,
  settingsInputSchema,
  settingsPatch,
  snapshotInputSchema,
  trainingStartInputSchema,
  residentSnapshotSchema,
} from "./api.ts";
import { HULLSHIFT_STATE_TOPIC, HullshiftResident } from "./resident.ts";
import type { Direction } from "./model.ts";
import type { TrainingId } from "./training.ts";
import { GeneratorWorkerClient } from "./generator_client.ts";
import workerSource from "hullshift-worker-source";

const resident = new HullshiftResident({
  worker: new GeneratorWorkerClient(workerSource),
  onInvalidate: (revision) => publishAppStateChange(HULLSHIFT_STATE_TOPIC, revision),
});
const ready = resident.initialize();

const readAnnotations: JsonObject = { "neutron:effects": ["read"] };
const writeAnnotations: JsonObject = { "neutron:effects": ["write"] };

exposeTool(
  HULLSHIFT_TOOLS.snapshot,
  {
    title: "Read Hullshift State",
    description: "Read the authoritative local Hullshift state for one tile.",
    inputSchema: snapshotInputSchema,
    outputSchema: residentSnapshotSchema,
    annotations: readAnnotations,
  },
  async (args) => {
    await ready;
    return json(resident.snapshot(requiredString(args, "tileId")));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.generationStatus,
  {
    title: "Read Hullshift Generation",
    description: "Read certified HullshiftBrain generation progress and current tile state.",
    inputSchema: snapshotInputSchema,
    outputSchema: residentSnapshotSchema,
    annotations: readAnnotations,
  },
  async (args) => {
    await ready;
    return json(resident.snapshot(requiredString(args, "tileId")));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.generationStart,
  {
    title: "Generate Hullshift Mission",
    description: "Select and exactly certify a deterministic HullshiftBrain catalog mission.",
    inputSchema: generationStartInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.startGeneration(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "seed"),
      requiredInteger(args, "difficulty"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.generationCancel,
  {
    title: "Cancel Hullshift Generation",
    description: "Cancel the active HullshiftBrain certification job owned by this tile.",
    inputSchema: generationCancelInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.cancelGeneration(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "jobId"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.generationDismiss,
  {
    title: "Dismiss Hullshift Generation",
    description: "Dismiss one completed, cancelled, or failed local generation job.",
    inputSchema: generationCancelInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.dismissGeneration(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "jobId"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.trainingStart,
  {
    title: "Open Hullshift Training",
    description: "Create or reopen one fixed, exactly certified Hullshift training mission.",
    inputSchema: trainingStartInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.startTraining(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "trainingId") as TrainingId,
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.runOpen,
  {
    title: "Open Hullshift Mission",
    description: "Bind this tile to an explicitly selected saved mission.",
    inputSchema: runOpenInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.openRun(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "runId"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.runClose,
  {
    title: "Close Hullshift Mission",
    description: "Return this tile to Hullshift home without deleting its mission.",
    inputSchema: runCloseInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.closeRun(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.runAction,
  {
    title: "Move in Hullshift",
    description: "Apply one cardinal action to the authoritative stable puzzle state.",
    inputSchema: runActionInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.action(
      requiredString(args, "tileId"),
      requiredString(args, "runId"),
      requiredInteger(args, "expectedRevision"),
      requiredString(args, "direction") as Direction,
    ));
  },
);

for (const [name, title, description, operation] of [
  [HULLSHIFT_TOOLS.runUndo, "Undo Hullshift Move", "Restore the state immediately before the latest accepted action.", "undo"],
  [HULLSHIFT_TOOLS.runRestart, "Restart Hullshift Mission", "Restore the exact certified initial mission state.", "restart"],
  [HULLSHIFT_TOOLS.runDelete, "Delete Hullshift Mission", "Delete one explicitly selected local mission save.", "deleteRun"],
] as const) {
  exposeTool(
    name,
    { title, description, inputSchema: runMutationInputSchema, outputSchema: resultSchema, annotations: writeAnnotations },
    async (args) => {
      await ready;
      return json(await resident[operation](
        requiredString(args, "tileId"),
        requiredString(args, "runId"),
        requiredInteger(args, "expectedRevision"),
      ));
    },
  );
}

exposeTool(
  HULLSHIFT_TOOLS.runBriefed,
  {
    title: "Acknowledge Hullshift Briefing",
    description: "Record the mechanics shown in the current mission briefing for local briefing preferences.",
    inputSchema: runMutationInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.acknowledgeBriefing(
      requiredString(args, "tileId"),
      requiredString(args, "runId"),
      requiredInteger(args, "expectedRevision"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.runHint,
  {
    title: "Request Hullshift Hint",
    description: "Return a bounded non-directional hint derived from the exact certified winning set.",
    inputSchema: runHintInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.hint(
      requiredString(args, "tileId"),
      requiredString(args, "runId"),
      requiredInteger(args, "expectedRevision"),
      requiredInteger(args, "tier") as 1 | 2,
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.settingsUpdate,
  {
    title: "Update Hullshift Settings",
    description: "Update local sound, motion, and briefing preferences.",
    inputSchema: settingsInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.updateSettings(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      settingsPatch(args),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.storageRetry,
  {
    title: "Retry Hullshift Autosave",
    description: "Retry writing the in-memory Hullshift state to persistent local storage.",
    inputSchema: runCloseInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.retryStorage(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
    ));
  },
);

exposeTool(
  HULLSHIFT_TOOLS.clearData,
  {
    title: "Clear Hullshift Local Data",
    description: "Permanently clear every local Hullshift mission and preference.",
    inputSchema: clearDataInputSchema,
    outputSchema: resultSchema,
    annotations: writeAnnotations,
  },
  async (args) => {
    await ready;
    return json(await resident.clearData(
      requiredString(args, "tileId"),
      requiredInteger(args, "expectedServiceRevision"),
      requiredString(args, "confirmation"),
    ));
  },
);

window.addEventListener("pagehide", () => resident.dispose(), { once: true });

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`Hullshift ${key} must be a string`);
  return value;
}

function requiredInteger(args: JsonObject, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Hullshift ${key} must be an integer`);
  }
  return value;
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}
