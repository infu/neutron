import { Principal } from "@dfinity/principal";
import {
  exposeTool,
  isJsonValue,
  removeExposedTool,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
  type MsgBusToolHandler,
} from "neutron-tools/app";
import {
  BLAST_RUN_PRUNE_BATCH,
  BlastDatabase,
  BlastPageReadLimitError,
  BlastPageReadNodeLimitError,
  canonicalJson,
  encodePageCursor,
  openBlastDatabase,
  runPendingUpdateCount,
  type CheckpointRecord,
  type CollectionDescription,
  type CollectionListEntry,
  type CollectionPageRecord,
  type CollectionRecord,
  type CollectionSource,
  type RunHandle,
  type RunRecord,
  type RunSource,
} from "./database.ts";
import {
  BlastDispatchedCallError,
  createBlastIcblastClient,
  type BlastCallRequest,
  type BlastCallResult,
  type BlastIcblastClient,
  type BlastIdentityMode,
  type BlastOperationOptions,
  type BlastScanResult,
} from "./icblast_client.ts";
import {
  blastPublicIdentity,
  loadOrCreateBlastLocalIdentity,
  type BlastLocalIdentity,
} from "./identity.ts";
import {
  assertBoundedBlastJson,
  assertBoundedBlastStoredV1Json,
  boundedError,
  isUnicodeScalarText,
  jsonBytes,
  requiredBlastMethodName,
  requiredObject,
  sha256Hex,
  stringBytes,
  unicodeScalarLength,
} from "./json.ts";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "./limits.ts";
import { runJsonataQuery } from "./query_runner.ts";
import { loadBlastTrustedRuntime } from "./runtime_config.ts";
import {
  runScript,
  type ScriptHost,
  type ScriptHostCausality,
} from "./script_runner.ts";
import {
  BlastScriptsBackendError,
  createBlastScriptsBackend,
} from "./scripts.ts";
import {
  BLAST_TOOL_DEFINITIONS,
  BLAST_TOOL_NAMES,
  type BlastToolName,
} from "./tool_schemas.ts";

const MAX_SCRIPT_COLLECTIONS = 64;
const MAX_SOURCE_COLLECTIONS = 32;
const MAX_COLLECTION_DELETE_IDS = 64;
const STARTUP_INTERRUPTED_RUNS = 100;
const EXPIRED_RUN_SWEEP_PASSES = 4;
const DELETION_RECOVERY_PASSES = 4;
const EXPIRED_RUN_SWEEP_INTERVAL_MS = 10_000;
const INLINE_CALL_WRAPPER_RESERVE_BYTES = 2_048;
const MAX_RECORDED_UNCERTAIN_OUTCOMES = 16;
const MAX_SCAN_METHODS = 1_024;
const DESCRIBE_PAGE_BYTES = 64 * 1_024;
const QUERY_PAGE_BYTES = BLAST_LIMITS.jsonataInputBytes - 4_096;
// The Worker host-response envelope has its own wrapper reserve, so a script
// can retrieve every individual value that collection storage accepts.
const SCRIPT_PAGE_BYTES = BLAST_LIMITS.collectionPageBytes;
const COLLECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const NAT_TEXT_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const MAX_NAT64 = 18_446_744_073_709_551_615n;
const STORED_V1_JSON_OMISSION =
  "stored_v1_json_outside_current_limits" as const;
const STORED_V1_METHOD_STATUS =
  "stored_v1_method_outside_current_policy" as const;
const STORED_V1_METHOD_EVIDENCE_OMISSION =
  "stored_v1_method_evidence_outside_current_transport" as const;
const utf8Encoder = new TextEncoder();

export type BlastServiceState = Readonly<{
  database: BlastDatabase;
  identity: BlastLocalIdentity;
  icblast: BlastIcblastClient;
}>;

export type BlastServiceAdapters = Readonly<{
  runScript: typeof runScript;
  runJsonataQuery: typeof runJsonataQuery;
  now: () => number;
  storageManager: () => StorageManager | null;
}>;

const defaultAdapters: BlastServiceAdapters = Object.freeze({
  runScript,
  runJsonataQuery,
  now: Date.now,
  storageManager: () => globalThis.navigator?.storage ?? null,
});

/**
 * Open each durable browser resource once for this resident generation, run
 * bounded recovery before exposure, and continue it periodically while the
 * resident remains loaded.
 */
export async function initializeBlastService(): Promise<BlastServiceState> {
  let database: BlastDatabase | undefined;
  let recoveryInterval: ReturnType<typeof globalThis.setInterval> | undefined;
  let maintenanceRunning = false;
  const closeDatabase = () => {
    database?.close();
    database = undefined;
  };
  const lifecycle = createBlastPageLifecycle({
    stopMaintenance: () => {
      if (recoveryInterval !== undefined) {
        clearInterval(recoveryInterval);
        recoveryInterval = undefined;
      }
    },
    removeTools: () => {
      for (const name of BLAST_TOOL_NAMES) removeExposedTool(name);
    },
    closeDatabase,
    reload: () => globalThis.window?.location.reload(),
  });
  // Install these before the first await. A page entering BFCache during
  // startup must close resources attached by a later continuation and reload
  // rather than resume a half-initialized resident.
  globalThis.addEventListener?.("pagehide", lifecycle.pagehide);
  globalThis.addEventListener?.("pageshow", (event) => {
    lifecycle.pageshow((event as PageTransitionEvent).persisted === true);
  });

  try {
    const [runtime, identity] = await Promise.all([
      loadBlastTrustedRuntime(),
      loadOrCreateBlastLocalIdentity(),
    ]);
    assertBlastPageActive(lifecycle);
    const openedDatabase = await openBlastDatabase({
      onTerminated: () => {
        lifecycle.pagehide();
        globalThis.window?.location.reload();
      },
    });
    if (lifecycle.isClosed()) {
      openedDatabase.close();
      throw new Error("Blast resident page closed during database startup");
    }
    database = openedDatabase;
    assertBlastPageActive(lifecycle);
    await runBlastRecoveryPass(openedDatabase);
    assertBlastPageActive(lifecycle);
    const icblast = createBlastIcblastClient({
      runtime,
      localIdentity: identity,
    });
    recoveryInterval = globalThis.setInterval?.(() => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      void runBlastRecoveryPass(openedDatabase)
        .catch((error: unknown) => {
          console.error("Blast maintenance failed", error);
        })
        .finally(() => {
          maintenanceRunning = false;
        });
    }, EXPIRED_RUN_SWEEP_INTERVAL_MS);
    assertBlastPageActive(lifecycle);
    return Object.freeze({ database: openedDatabase, identity, icblast });
  } catch (error) {
    lifecycle.pagehide();
    throw error;
  }
}

export async function runBlastRecoveryPass(
  database: BlastDatabase,
): Promise<void> {
  await sweepExpiredRuns(database);
  await resumeDeletingCollections(database, DELETION_RECOVERY_PASSES);
  await database.pruneTerminalRuns({ deletionLimit: BLAST_RUN_PRUNE_BATCH });
}

async function resumeDeletingCollections(
  database: BlastDatabase,
  maximumPasses: number,
): Promise<void> {
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const result = await database.resumeDeletingCollections({
      pageBudget: BLAST_LIMITS.collectionDeleteBatch,
      collectionLimit: BLAST_LIMITS.collectionListPage,
    });
    if (!result.incompleteCleanup) return;
  }
}

export function createBlastPageLifecycle(
  actions: Readonly<{
    stopMaintenance: () => void;
    removeTools: () => void;
    closeDatabase: () => void;
    reload: () => void;
  }>,
): Readonly<{
  pagehide: () => void;
  pageshow: (persisted: boolean) => void;
  isClosed: () => boolean;
}> {
  let closed = false;
  return Object.freeze({
    pagehide: () => {
      if (closed) return;
      closed = true;
      actions.stopMaintenance();
      actions.removeTools();
      actions.closeDatabase();
    },
    pageshow: (persisted) => {
      if (closed && persisted) actions.reload();
    },
    isClosed: () => closed,
  });
}

function assertBlastPageActive(
  lifecycle: Readonly<{ isClosed: () => boolean }>,
): void {
  if (lifecycle.isClosed()) {
    throw new Error("Blast resident page closed during startup");
  }
}

async function sweepExpiredRuns(database: BlastDatabase): Promise<void> {
  for (let pass = 0; pass < EXPIRED_RUN_SWEEP_PASSES; pass += 1) {
    const interrupted = await database.interruptExpiredRuns(
      STARTUP_INTERRUPTED_RUNS,
    );
    if (interrupted.length < STARTUP_INTERRUPTED_RUNS) return;
  }
}

export function createBlastToolHandlers(
  statePromise: Promise<BlastServiceState>,
  adapters: BlastServiceAdapters = defaultAdapters,
): Readonly<Record<BlastToolName, MsgBusToolHandler>> {
  const withState =
    (
      handler: (
        state: BlastServiceState,
        args: JsonObject,
        context: MsgBusToolContext,
      ) => JsonValue | Promise<JsonValue>,
    ): MsgBusToolHandler =>
    async (args, context) => {
      throwIfAborted(context.signal);
      const state = await awaitReadOnlyAbortable(statePromise, context.signal);
      throwIfAborted(context.signal);
      return await handler(state, args, context);
    };

  return Object.freeze({
    "blast.identity": withState((state, args) => {
      assertExactFields(args, [], [], "blast.identity arguments");
      return asJson(blastPublicIdentity(state.identity));
    }),

    "blast.scan": withState(async (state, args, context) => {
      assertExactFields(args, ["canister"], [], "blast.scan arguments");
      const canister = requiredText(args.canister, "canister", 80);
      const result = await state.icblast.scan(
        canister,
        signalOptions(context.signal),
      );
      assertScanMethodLimit(result);
      throwIfAborted(context.signal);
      return asJson(result);
    }),

    "blast.schema": withState(async (state, args, context) => {
      assertExactFields(
        args,
        ["canister", "method"],
        [],
        "blast.schema arguments",
      );
      const result = await state.icblast.schema(
        requiredText(args.canister, "canister", 80),
        requiredBlastMethodName(args.method, "method"),
        signalOptions(context.signal),
      );
      throwIfAborted(context.signal);
      return asJson(result);
    }),

    "blast.validate_input": withState(async (state, args, context) => {
      assertExactFields(
        args,
        ["canister", "method", "args"],
        [],
        "blast.validate_input arguments",
      );
      const result = await state.icblast.validateInput(
        requiredText(args.canister, "canister", 80),
        requiredBlastMethodName(args.method, "method"),
        requiredJsonArray(args.args, "args"),
        signalOptions(context.signal),
      );
      throwIfAborted(context.signal);
      return asJson(result);
    }),

    "blast.query": withState(async (state, args, context) => {
      const request = directCallRequest(args, "query");
      throwIfAborted(context.signal);
      try {
        const result = await state.icblast.query(
          request,
          undefined,
          signalOptions(context.signal),
        );
        return inlineCallResult(result);
      } catch (error) {
        if (error instanceof BlastDispatchedCallError) {
          return dispatchedCallResult(error);
        }
        throw error;
      }
    }),

    "blast.update": withState(async (state, args, context) => {
      const request = directCallRequest(args, "update");
      throwIfAborted(context.signal);
      // The handler-scoped client retains nested Agent provenance and is the
      // only acceptable route for Kernel-identity calls.
      try {
        const result = await state.icblast.update(
          request,
          context.kernel,
          kernelCallOptions(context),
        );
        return inlineCallResult(result);
      } catch (error) {
        if (error instanceof BlastDispatchedCallError) {
          return dispatchedCallResult(error);
        }
        throw error;
      }
    }),

    "script.list": withState(async (_state, args, context) => {
      assertExactFields(args, [], ["cursor", "limit"], "script.list arguments");
      const cursor = optionalScriptCursor(args.cursor);
      const limit = optionalInteger(args.limit, "limit", 1, 10);
      return asJson(
        await createBlastScriptsBackend(context.kernel).list({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    }),

    "script.get": withState(async (_state, args, context) => {
      assertExactFields(args, ["id"], [], "script.get arguments");
      return asJson(
        await createBlastScriptsBackend(context.kernel).get(
          requiredNat64Text(args.id, "id", true),
        ),
      );
    }),

    "script.save": withState(async (_state, args, context) => {
      assertExactFields(
        args,
        ["name", "source"],
        ["id", "expectedRevision", "description"],
        "script.save arguments",
      );
      const hasId = Object.hasOwn(args, "id");
      const hasExpectedRevision = Object.hasOwn(args, "expectedRevision");
      if (hasId !== hasExpectedRevision) {
        throw new Error(
          "script.save requires id and expectedRevision together for replacement",
        );
      }
      const request = {
        name: requiredText(args.name, "name", 120),
        source: requiredWellFormedText(
          args.source,
          "source",
          BLAST_LIMITS.scriptSourceBytes,
        ),
        description: Object.hasOwn(args, "description")
          ? nullableText(args.description, "description", 1_024)
          : null,
        ...(hasId ? { id: requiredNat64Text(args.id, "id", true) } : {}),
        ...(hasExpectedRevision
          ? {
              expectedRevision: requiredNat64Text(
                args.expectedRevision,
                "expectedRevision",
                true,
              ),
            }
          : {}),
      };
      const sourceDigest = await sha256Hex(request.source);
      throwIfAborted(context.signal);
      try {
        return asJson(
          await createBlastScriptsBackend(context.kernel).save(request),
        );
      } catch (error) {
        if (!(error instanceof BlastScriptsBackendError)) throw error;
        return scriptSaveOutcomeUnknown(request, sourceDigest);
      }
    }),

    "script.delete": withState(async (_state, args, context) => {
      assertExactFields(
        args,
        ["id", "expectedRevision"],
        [],
        "script.delete arguments",
      );
      const id = requiredNat64Text(args.id, "id", true);
      const expectedRevision = requiredNat64Text(
        args.expectedRevision,
        "expectedRevision",
        true,
      );
      try {
        return asJson(
          await createBlastScriptsBackend(context.kernel).delete(
            id,
            expectedRevision,
          ),
        );
      } catch (error) {
        if (!(error instanceof BlastScriptsBackendError)) throw error;
        return scriptDeleteOutcomeUnknown(id, expectedRevision);
      }
    }),

    "script.evaluate": withState(async (state, args, context) => {
      assertExactFields(
        args,
        ["source"],
        ["args", "identityMode", "timeoutMs", "inputCollectionIds"],
        "script.evaluate arguments",
      );
      const source = requiredWellFormedText(
        args.source,
        "source",
        BLAST_LIMITS.scriptSourceBytes,
      );
      const sourceDigest = await sha256Hex(source);
      return await executeScript(
        state,
        {
          source,
          sourceDigest,
          runSource: { kind: "temporary", digest: sourceDigest },
          script: null,
          input: optionalJson(args.args),
          identityMode: optionalScriptIdentityMode(args.identityMode),
          timeoutMs: optionalTimeout(args.timeoutMs),
          inputCollectionIds: optionalCollectionIds(
            args.inputCollectionIds,
            MAX_SCRIPT_COLLECTIONS,
            "inputCollectionIds",
          ),
        },
        context,
        adapters,
      );
    }),

    "script.run": withState(async (state, args, context) => {
      assertExactFields(
        args,
        ["id", "revision", "digest"],
        ["args", "identityMode", "timeoutMs", "inputCollectionIds"],
        "script.run arguments",
      );
      const id = requiredNat64Text(args.id, "id", true);
      const revision = requiredNat64Text(args.revision, "revision", true);
      const digest = requiredDigest(args.digest, "digest");
      const saved = await awaitReadOnlyAbortable(
        createBlastScriptsBackend(context.kernel).get(id),
        context.signal,
      );
      throwIfAborted(context.signal);
      if (saved === null) throw new Error("Saved script was not found");
      if (saved.revision !== revision || saved.sourceDigest !== digest) {
        throw new Error(
          "Saved script no longer matches the selected revision and digest",
        );
      }
      return await executeScript(
        state,
        {
          source: saved.source,
          sourceDigest: digest,
          runSource: { kind: "saved", scriptId: id, revision, digest },
          script: { id, revision },
          input: optionalJson(args.args),
          identityMode: optionalScriptIdentityMode(args.identityMode),
          timeoutMs: optionalTimeout(args.timeoutMs),
          inputCollectionIds: optionalCollectionIds(
            args.inputCollectionIds,
            MAX_SCRIPT_COLLECTIONS,
            "inputCollectionIds",
          ),
        },
        context,
        adapters,
      );
    }),

    "run.list": withState(async (state, args) => {
      assertExactFields(args, [], ["cursor", "limit"], "run.list arguments");
      const cursor = Object.hasOwn(args, "cursor")
        ? nullableText(args.cursor, "cursor", 160)
        : undefined;
      const limit = optionalInteger(args.limit, "limit", 1, 50);
      return asJson(
        await state.database.listRuns({
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    }),

    "run.get": withState(async (state, args) => {
      assertExactFields(args, ["id"], [], "run.get arguments");
      const id = requiredCollectionId(args.id, "id");
      const snapshot = await state.database.getRunSnapshot(id);
      if (snapshot === null) return null;
      return asJson({
        run: publicRunRecord(snapshot.run),
        checkpoint:
          snapshot.checkpoint === null
            ? null
            : publicCheckpointRecord(snapshot.checkpoint),
      });
    }),

    "run.delete": withState(async (state, args) => {
      assertExactFields(
        args,
        ["id"],
        ["acknowledgeUnresolvedUpdates"],
        "run.delete arguments",
      );
      const acknowledgement = args.acknowledgeUnresolvedUpdates;
      if (
        acknowledgement !== undefined &&
        typeof acknowledgement !== "boolean"
      ) {
        throw new Error("acknowledgeUnresolvedUpdates must be boolean");
      }
      return asJson(
        await state.database.deleteRun(
          requiredCollectionId(args.id, "id"),
          acknowledgement === true,
        ),
      );
    }),

    "collection.list": withState(async (state, args) => {
      assertExactFields(
        args,
        [],
        ["cursor", "limit"],
        "collection.list arguments",
      );
      const page = await state.database.listCollections({
        ...(Object.hasOwn(args, "cursor")
          ? { cursor: nullableText(args.cursor, "cursor", 160) }
          : {}),
        ...(Object.hasOwn(args, "limit")
          ? {
              limit: requiredInteger(
                args.limit,
                "limit",
                1,
                BLAST_LIMITS.collectionListPage,
              ),
            }
          : {}),
      });
      return asJson({
        collections: page.collections.map(publicCollectionListEntry),
        cursor: page.cursor,
      });
    }),

    "collection.describe": withState(async (state, args) => {
      assertExactFields(
        args,
        ["id"],
        ["cursor", "pageLimit"],
        "collection.describe arguments",
      );
      const description = await state.database.describeCollection(
        requiredCollectionId(args.id, "id"),
        {
          ...(Object.hasOwn(args, "cursor")
            ? { cursor: nullableText(args.cursor, "cursor", 16) }
            : {}),
          ...(Object.hasOwn(args, "pageLimit")
            ? {
                limit: requiredInteger(
                  args.pageLimit,
                  "pageLimit",
                  1,
                  BLAST_LIMITS.collectionBatchPages,
                ),
              }
            : {}),
          maxBytes: DESCRIBE_PAGE_BYTES,
        },
      );
      return publicCollectionDescription(description);
    }),

    "collection.query": withState(async (state, args, context) => {
      assertExactFields(
        args,
        ["id", "expression"],
        ["cursor", "pageLimit"],
        "collection.query arguments",
      );
      const collectionId = requiredCollectionId(args.id, "id");
      const expression = requiredText(
        args.expression,
        "expression",
        BLAST_LIMITS.jsonataExpressionCharacters,
      );
      const queryDigest = await sha256Hex(expression);
      throwIfAborted(context.signal);
      const run = await state.database.createRun({
        source: { kind: "temporary", digest: queryDigest },
        deadlineAt: adapters.now() + BLAST_LIMITS.jsonataTimeoutMs + 4_000,
        inputCollectionIds: [collectionId],
        identity: null,
      });
      const handle: RunHandle = { runId: run.id, sessionId: run.sessionId };
      try {
        let batch;
        try {
          batch = await state.database.readPages(collectionId, {
            ...(Object.hasOwn(args, "cursor")
              ? { cursor: nullableText(args.cursor, "cursor", 16) }
              : {}),
            ...(Object.hasOwn(args, "pageLimit")
              ? {
                  limit: requiredInteger(
                    args.pageLimit,
                    "pageLimit",
                    1,
                    BLAST_LIMITS.collectionBatchPages,
                  ),
                }
              : {}),
            maxBytes: QUERY_PAGE_BYTES,
            maxNodes: BLAST_LIMITS.jsonNodes - 1,
            run: handle,
          });
        } catch (error) {
          if (error instanceof BlastPageReadLimitError) {
            throw new Error(
              `Collection page ${error.sequence} is ${error.serializedBytes} bytes and exceeds collection.query's ${error.maximumBytes}-byte input envelope; use script.evaluate or script.run with collections.pages to stream it`,
              { cause: error },
            );
          }
          if (error instanceof BlastPageReadNodeLimitError) {
            throw new Error(
              `Collection page ${error.sequence} has ${error.jsonNodes} JSON values and exceeds collection.query's ${error.maximumNodes}-value input envelope; use script.evaluate or script.run with collections.pages to stream it`,
              { cause: error },
            );
          }
          throw error;
        }
        const input = batch.pages.map((page) => page.value);
        const inputBytes = jsonBytes(input);
        const value = await adapters.runJsonataQuery(
          expression,
          input,
          context.signal,
        );
        throwIfAborted(context.signal);
        await state.database.transitionRun(handle, "complete", {
          kind: "collection_query",
          collectionId,
          cursor: batch.cursor,
        });
        return asJson({
          value,
          cursor: batch.cursor,
          pageLocal: true,
          inputPages: batch.pages.length,
          inputBytes,
          outputBytes: jsonBytes(value),
        });
      } catch (error) {
        const stored = await state.database.getRun(run.id);
        if (stored?.state === "running") {
          await state.database.transitionRun(
            handle,
            context.signal?.aborted ? "cancelled" : "failed",
            { error: boundedError(error), kind: "collection_query" },
          );
        }
        throw error;
      }
    }),

    "collection.delete": withState(async (state, args, context) => {
      assertExactFields(args, ["ids"], [], "collection.delete arguments");
      const ids = requiredCollectionIds(
        args.ids,
        MAX_COLLECTION_DELETE_IDS,
        "ids",
      );
      if (ids.length === 0) throw new Error("ids is invalid");
      return asJson(
        await state.database.deleteCollections(ids, {
          pageBudget: BLAST_LIMITS.collectionDeleteBatch,
          ...(context.signal ? { signal: context.signal } : {}),
        }),
      );
    }),

    "storage.status": withState(async (state, args) => {
      assertExactFields(args, [], [], "storage.status arguments");
      const [logical, origin] = await Promise.all([
        state.database.logicalStorageStatus(),
        storageStatus(adapters.storageManager()),
      ]);
      return asJson({
        logical: {
          collections: logical.collectionCount,
          pages: logical.pageCount,
          items: logical.itemCount,
          serializedBytes: logical.serializedBytes,
          deletingCollections: logical.deletingCollectionCount,
          runningRuns: logical.runningRunCount,
        },
        origin,
      });
    }),
  });
}

export function registerBlastService(): void {
  const statePromise = initializeBlastService();
  void statePromise.catch((error) => {
    console.error("[Blast] resident failed to start", boundedError(error));
  });
  const handlers = createBlastToolHandlers(statePromise);
  for (const name of BLAST_TOOL_NAMES) {
    exposeTool(name, BLAST_TOOL_DEFINITIONS[name], handlers[name]);
  }
}

if (typeof globalThis.window !== "undefined") registerBlastService();

type ScriptExecutionRequest = Readonly<{
  source: string;
  sourceDigest: string;
  runSource: RunSource;
  script: Readonly<{ id: string; revision: string }> | null;
  input: JsonValue;
  identityMode: "local";
  timeoutMs: number;
  inputCollectionIds: string[];
}>;

async function executeScript(
  state: BlastServiceState,
  request: ScriptExecutionRequest,
  context: MsgBusToolContext,
  adapters: BlastServiceAdapters,
): Promise<JsonValue> {
  throwIfAborted(context.signal);
  const argumentsDigest = await sha256Hex(canonicalJson(request.input));
  throwIfAborted(context.signal);
  const run = await state.database.createRun({
    source: request.runSource,
    deadlineAt: adapters.now() + request.timeoutMs + 4_000,
    inputCollectionIds: request.inputCollectionIds,
    identity: { mode: "local", principal: state.identity.principal },
  });
  const handle: RunHandle = { runId: run.id, sessionId: run.sessionId };
  const outputCollectionIds = new Set<string>();
  const confirmedUpdateReceipts = new Map<number, string>();
  const uncertainCallOutcomes: JsonObject[] = [];
  let uncertainCallOutcomeCount = 0;
  let checkpointRevision = 0;
  let checkpointTail = Promise.resolve();
  context.reportProgress({ phase: "started", runId: run.id });

  const host: ScriptHost = async (
    operation,
    argumentsValue,
    signal,
    causality,
  ) => {
    throwIfAborted(signal);
    if (operation === "run.checkpoint") {
      assertExactFields(
        argumentsValue,
        ["value"],
        [],
        "run.checkpoint arguments",
      );
      const value = requiredJson(argumentsValue.value, "checkpoint");
      assertBoundedBlastJson(
        value,
        "Run checkpoint",
        BLAST_LIMITS.collectionSummaryBytes,
      );
      // Durable settlement precedes delivery to QuickJS. Correlate only the
      // update responses the guest had consumed when it issued this checkpoint.
      const acknowledgedUpdateReceipts = confirmedReceiptsObservedBy(
        confirmedUpdateReceipts,
        causality,
      );
      const acknowledgedUpdateIds = acknowledgedUpdateReceipts.map(
        ([, updateId]) => updateId,
      );
      let result: JsonValue = null;
      checkpointTail = checkpointTail.then(async () => {
        const checkpoint = await state.database.checkpointRun(
          handle,
          value,
          checkpointRevision,
          acknowledgedUpdateIds,
        );
        checkpointRevision = checkpoint.revision;
        for (const [responseId, updateId] of acknowledgedUpdateReceipts) {
          if (confirmedUpdateReceipts.get(responseId) === updateId) {
            confirmedUpdateReceipts.delete(responseId);
          }
        }
        result = {
          revision: checkpoint.revision,
          serializedBytes: checkpoint.serializedBytes,
          updatedAt: checkpoint.updatedAt,
        };
      });
      await checkpointTail;
      return result;
    }
    if (operation === "run.progress") {
      assertExactFields(
        argumentsValue,
        ["value"],
        [],
        "run.progress arguments",
      );
      const value = requiredJson(argumentsValue.value, "progress");
      assertBoundedBlastJson(value, "Run progress", BLAST_LIMITS.progressBytes);
      context.reportProgress({ runId: run.id, value });
      return { reported: true };
    }
    if (operation === "blast.identity") {
      assertExactFields(argumentsValue, [], [], "blast.identity arguments");
      return asJson({ mode: "local", ...blastPublicIdentity(state.identity) });
    }
    if (
      operation === "blast.scan" ||
      operation === "blast.schema" ||
      operation === "blast.validate_input" ||
      operation === "blast.query" ||
      operation === "blast.update"
    ) {
      return await runIcHostOperation(
        state,
        handle,
        request.identityMode,
        operation,
        argumentsValue,
        signal,
        (outcome) => {
          uncertainCallOutcomeCount += 1;
          if (uncertainCallOutcomes.length < MAX_RECORDED_UNCERTAIN_OUTCOMES) {
            uncertainCallOutcomes.push(outcome);
          }
        },
        (id) => {
          if (causality !== undefined) {
            confirmedUpdateReceipts.set(causality.requestId, id);
          }
        },
      );
    }
    if (operation === "collections.create") {
      assertExactFields(
        argumentsValue,
        ["name", "kind"],
        ["description", "sourceCollectionIds", "source"],
        "collections.create arguments",
      );
      const kind = requiredCollectionKind(argumentsValue.kind);
      const sourceCollectionIds = optionalCollectionIds(
        argumentsValue.sourceCollectionIds,
        MAX_SOURCE_COLLECTIONS,
        "sourceCollectionIds",
      );
      if (
        sourceCollectionIds.some(
          (collectionId) => !request.inputCollectionIds.includes(collectionId),
        )
      ) {
        throw new Error(
          "Collection lineage is outside this run's input allowlist",
        );
      }
      if (
        (kind === "raw" && sourceCollectionIds.length !== 0) ||
        (kind === "derived" &&
          argumentsValue.source !== undefined &&
          argumentsValue.source !== null)
      ) {
        throw new Error("Collection kind and source lineage are inconsistent");
      }
      const collection = await state.database.createCollection({
        name: requiredText(
          argumentsValue.name,
          "name",
          BLAST_LIMITS.collectionNameCharacters,
        ),
        description: nullableText(
          argumentsValue.description,
          "description",
          BLAST_LIMITS.collectionDescriptionCharacters,
        ),
        kind,
        producer:
          request.script === null
            ? null
            : {
                scriptId: request.script.id,
                revision: request.script.revision,
                digest: request.sourceDigest,
              },
        identity: { mode: "local", principal: state.identity.principal },
        source: optionalCollectionSource(argumentsValue.source),
        sourceCollectionIds,
        run: handle,
      });
      outputCollectionIds.add(collection.id);
      return asJson(publicCollectionRecord(collection));
    }
    if (operation === "collections.put_page") {
      assertExactFields(
        argumentsValue,
        ["id", "key", "value"],
        [],
        "collections.put_page arguments",
      );
      const id = requiredRunOutput(argumentsValue.id, outputCollectionIds);
      return asJson(
        await state.database.putPage({
          collectionId: id,
          idempotencyKey: requiredText(argumentsValue.key, "key", 512),
          value: requiredJson(argumentsValue.value, "value"),
          run: handle,
        }),
      );
    }
    if (operation === "collections.append") {
      assertExactFields(
        argumentsValue,
        ["id", "value"],
        ["key"],
        "collections.append arguments",
      );
      const id = requiredRunOutput(argumentsValue.id, outputCollectionIds);
      return asJson(
        await state.database.append({
          collectionId: id,
          value: requiredJson(argumentsValue.value, "value"),
          ...(Object.hasOwn(argumentsValue, "key")
            ? { idempotencyKey: nullableText(argumentsValue.key, "key", 512) }
            : {}),
          run: handle,
        }),
      );
    }
    if (operation === "collections.pages") {
      assertExactFields(
        argumentsValue,
        ["id"],
        ["cursor", "limit"],
        "collections.pages arguments",
      );
      const batch = await state.database.readPages(
        requiredCollectionId(argumentsValue.id, "id"),
        {
          ...(Object.hasOwn(argumentsValue, "cursor")
            ? { cursor: nullableText(argumentsValue.cursor, "cursor", 16) }
            : {}),
          ...(Object.hasOwn(argumentsValue, "limit")
            ? {
                limit: requiredInteger(
                  argumentsValue.limit,
                  "limit",
                  1,
                  BLAST_LIMITS.collectionBatchPages,
                ),
              }
            : {}),
          maxBytes: SCRIPT_PAGE_BYTES,
          maxNodes: BLAST_STORED_V1_JSON_LIMITS.nodes,
          run: handle,
        },
      );
      return {
        values: batch.pages.map((page) => page.value),
        nextCursor: batch.cursor,
      };
    }
    if (
      operation === "collections.complete" ||
      operation === "collections.fail"
    ) {
      assertExactFields(
        argumentsValue,
        operation === "collections.complete" ? ["id"] : ["id", "summary"],
        operation === "collections.complete" ? ["summary"] : [],
        `${operation} arguments`,
      );
      const id = requiredRunOutput(argumentsValue.id, outputCollectionIds);
      const summary = optionalJson(argumentsValue.summary);
      const collection =
        operation === "collections.complete"
          ? await state.database.completeCollection(id, summary, handle)
          : await state.database.failCollection(id, summary, handle);
      return asJson(publicCollectionRecord(collection));
    }
    throw new Error(`Unsupported Blast script host operation '${operation}'`);
  };

  try {
    const result = await adapters.runScript({
      source: request.source,
      input: request.input,
      timeoutMs: request.timeoutMs,
      ...(context.signal ? { signal: context.signal } : {}),
      host,
    });
    await checkpointTail;
    await assertRunOutputsTerminal(state.database, run.id);
    throwIfAborted(context.signal);
    const finalRun = await transitionRunOrAdoptTerminal(
      state.database,
      handle,
      "complete",
      await buildRunSuccessSummary(
        argumentsDigest,
        result,
        uncertainCallOutcomeCount,
        uncertainCallOutcomes,
      ),
    );
    const checkpoint = await state.database.getCheckpoint(run.id);
    context.reportProgress({ phase: finalRun.state, runId: run.id });
    return executionResult(
      finalRun,
      request,
      finalRun.state === "complete" ? result : null,
      checkpoint?.value ?? null,
    );
  } catch (error) {
    const message = boundedError(error);
    const runRecord = await state.database.getRun(run.id);
    if (runRecord !== null && runRecord.state !== "running") {
      const checkpoint = await state.database.getCheckpoint(run.id);
      context.reportProgress({ phase: runRecord.state, runId: run.id });
      return executionResult(
        runRecord,
        request,
        null,
        checkpoint?.value ?? null,
      );
    }
    const cleanupIncomplete = await failOpenRunCollections(
      state.database,
      runRecord?.outputCollectionIds ?? [...outputCollectionIds],
      message,
    );
    const summary = buildRunFailureSummary({
      error: message,
      outputCleanupIncomplete: cleanupIncomplete,
      pendingUpdates: runRecord?.pendingUpdates ?? [],
      uncertainCallOutcomeCount,
      uncertainCallOutcomes,
    });
    const terminalState = context.signal?.aborted ? "cancelled" : "failed";
    const finalRun = await transitionRunOrAdoptTerminal(
      state.database,
      handle,
      terminalState,
      summary,
    );
    const checkpoint = await state.database.getCheckpoint(run.id);
    context.reportProgress({
      phase: finalRun.state,
      runId: run.id,
      ...(finalRun.state === terminalState ? { error: message } : {}),
    });
    return executionResult(finalRun, request, null, checkpoint?.value ?? null);
  }
}

async function buildRunSuccessSummary(
  argumentsDigest: string,
  result: JsonValue,
  uncertainCallOutcomeCount: number,
  uncertainCallOutcomes: JsonObject[],
): Promise<JsonObject> {
  const resultDigest = await sha256Hex(canonicalJson(result));
  const resultBytes = jsonBytes(result);
  const completionEvidence = (includeResult: boolean): JsonObject => ({
    protocol: 1,
    argumentsDigest,
    resultDigest,
    resultBytes,
    resultStatus: includeResult ? "stored" : "digest_only",
    ...(includeResult ? { result } : {}),
  });
  const candidate = (
    detailCount: number,
    includeResult: boolean,
  ): JsonObject => ({
    completionEvidence: completionEvidence(includeResult),
    ...(uncertainCallOutcomeCount === 0
      ? {}
      : {
          uncertainCallOutcomeCount,
          uncertainCallOutcomes: uncertainCallOutcomes.slice(0, detailCount),
          ...(detailCount < uncertainCallOutcomeCount
            ? { uncertainCallOutcomesTruncated: true }
            : {}),
        }),
  });
  const fits = (value: JsonObject): boolean => {
    try {
      assertBoundedBlastJson(
        value,
        "Run summary",
        BLAST_LIMITS.collectionSummaryBytes,
      );
      return true;
    } catch {
      return false;
    }
  };
  const includeResult = fits(candidate(0, true));
  let detailCount = 0;
  while (detailCount < uncertainCallOutcomes.length) {
    if (!fits(candidate(detailCount + 1, includeResult))) {
      break;
    }
    detailCount += 1;
  }
  const summary = candidate(detailCount, includeResult);
  assertBoundedBlastJson(
    summary,
    "Run summary",
    BLAST_LIMITS.collectionSummaryBytes,
  );
  return summary;
}

function buildRunFailureSummary(
  input: Readonly<{
    error: string;
    outputCleanupIncomplete: boolean;
    pendingUpdates: RunRecord["pendingUpdates"];
    uncertainCallOutcomeCount: number;
    uncertainCallOutcomes: JsonObject[];
  }>,
): JsonObject {
  const candidate = (
    error: string,
    pendingDetailCount: number,
    uncertainDetailCount: number,
  ): JsonObject => ({
    error,
    outputCleanupIncomplete: input.outputCleanupIncomplete,
    ...(input.pendingUpdates.length === 0
      ? {}
      : {
          retrySafe: false,
          pendingUpdateCount: input.pendingUpdates.length,
          pendingUpdates: input.pendingUpdates.slice(0, pendingDetailCount),
          ...(pendingDetailCount < input.pendingUpdates.length
            ? { pendingUpdatesTruncated: true }
            : {}),
          ...(input.pendingUpdates.some(
            (attempt) => attempt.status === "call_pending",
          )
            ? { updateOutcomeUnknown: true }
            : { updateDispatchConfirmed: true }),
        }),
    ...(input.uncertainCallOutcomeCount === 0
      ? {}
      : {
          uncertainCallOutcomeCount: input.uncertainCallOutcomeCount,
          uncertainCallOutcomes: input.uncertainCallOutcomes.slice(
            0,
            uncertainDetailCount,
          ),
          ...(uncertainDetailCount < input.uncertainCallOutcomeCount
            ? { uncertainCallOutcomesTruncated: true }
            : {}),
        }),
  });
  const fits = (value: JsonObject) =>
    jsonBytes(value) <= BLAST_LIMITS.collectionSummaryBytes;

  let error = input.error;
  if (!fits(candidate(error, 0, 0))) {
    const scalars = [...error];
    let lower = 0;
    let upper = scalars.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      const truncated =
        middle === scalars.length
          ? error
          : `${scalars.slice(0, middle).join("")}...`;
      if (fits(candidate(truncated, 0, 0))) lower = middle;
      else upper = middle - 1;
    }
    error =
      lower === scalars.length
        ? error
        : `${scalars.slice(0, lower).join("")}...`;
  }

  let pendingDetailCount = 0;
  while (pendingDetailCount < input.pendingUpdates.length) {
    const next = candidate(error, pendingDetailCount + 1, 0);
    if (!fits(next)) break;
    pendingDetailCount += 1;
  }
  let uncertainDetailCount = 0;
  while (uncertainDetailCount < input.uncertainCallOutcomes.length) {
    const next = candidate(error, pendingDetailCount, uncertainDetailCount + 1);
    if (!fits(next)) break;
    uncertainDetailCount += 1;
  }
  const summary = candidate(error, pendingDetailCount, uncertainDetailCount);
  assertBoundedBlastJson(
    summary,
    "Run summary",
    BLAST_LIMITS.collectionSummaryBytes,
  );
  return summary;
}

async function transitionRunOrAdoptTerminal(
  database: BlastDatabase,
  handle: RunHandle,
  state: "complete" | "failed" | "cancelled",
  summary: JsonValue,
): Promise<RunRecord> {
  try {
    return await database.transitionRun(handle, state, summary);
  } catch (error) {
    const stored = await database.getRun(handle.runId);
    if (stored !== null && stored.state !== "running") return stored;
    throw error;
  }
}

async function assertRunOutputsTerminal(
  database: BlastDatabase,
  runId: string,
): Promise<void> {
  const run = await database.getRun(runId);
  if (run === null || run.state !== "running") {
    throw new Error("Blast run disappeared before completion");
  }
  for (const id of run.outputCollectionIds) {
    const collection = await database.getCollection(id);
    if (collection === null) {
      throw new Error(`Run output collection ${id} is missing`);
    }
    if (collection.state === "open") {
      throw new Error(`Run output collection ${id} was left open`);
    }
    if (collection.state === "deleting") {
      throw new Error(`Run output collection ${id} is being deleted`);
    }
  }
}

function confirmedReceiptsObservedBy(
  receipts: ReadonlyMap<number, string>,
  causality: ScriptHostCausality | undefined,
): [number, string][] {
  if (causality === undefined) return [];
  const observed = new Set(causality.observedResponseIds);
  return [...receipts].filter(([responseId]) => observed.has(responseId));
}

async function runIcHostOperation(
  state: BlastServiceState,
  handle: RunHandle,
  identityMode: "local",
  operation:
    | "blast.scan"
    | "blast.schema"
    | "blast.validate_input"
    | "blast.query"
    | "blast.update",
  args: JsonObject,
  signal: AbortSignal,
  recordDispatchedOutcome: (outcome: JsonObject) => void,
  recordConfirmedUpdateId: (id: string) => void,
): Promise<JsonValue> {
  const responseReservationBytes =
    operation === "blast.query" || operation === "blast.update"
      ? BLAST_LIMITS.scriptHostResponseBytes
      : BLAST_LIMITS.canisterSchemaBytes + 8_192;
  let preparedUpdate: BlastCallRequest | null = null;
  if (operation === "blast.update") {
    assertExactFields(
      args,
      ["canister", "method"],
      ["args", "identityMode"],
      "blast.update arguments",
    );
    const selected = Object.hasOwn(args, "identityMode")
      ? optionalIdentityMode(args.identityMode)
      : identityMode;
    if (selected !== identityMode) {
      throw new Error(
        "Script canister calls cannot change the run identity mode",
      );
    }
    preparedUpdate = {
      canister: requiredCanister(args.canister, "canister"),
      method: requiredBlastMethodName(args.method, "method"),
      args: optionalJsonArray(args.args, "args"),
      identityMode,
    };
  }
  const pendingUpdateId = await state.database.beginRunCall(handle, {
    requestBytes: jsonBytes(args),
    responseReservationBytes,
    ...(preparedUpdate === null
      ? {}
      : {
          update: {
            canister: preparedUpdate.canister,
            method: preparedUpdate.method,
            argumentsDigest: await sha256Hex(
              canonicalJson(preparedUpdate.args ?? []),
            ),
            identityMode,
          },
        }),
  });
  let result: unknown;
  let settled = false;
  try {
    if (operation === "blast.scan") {
      assertExactFields(args, ["canister"], [], "blast.scan arguments");
      const scan = await state.icblast.scan(
        requiredText(args.canister, "canister", 80),
        signalOptions(signal),
      );
      assertScanMethodLimit(scan);
      result = scan;
    } else if (operation === "blast.schema") {
      assertExactFields(
        args,
        ["canister", "method"],
        [],
        "blast.schema arguments",
      );
      result = await state.icblast.schema(
        requiredText(args.canister, "canister", 80),
        requiredBlastMethodName(args.method, "method"),
        signalOptions(signal),
      );
    } else if (operation === "blast.validate_input") {
      assertExactFields(
        args,
        ["canister", "method", "args"],
        [],
        "blast.validate_input arguments",
      );
      result = await state.icblast.validateInput(
        requiredText(args.canister, "canister", 80),
        requiredBlastMethodName(args.method, "method"),
        requiredJsonArray(args.args, "args"),
        signalOptions(signal),
      );
    } else {
      assertExactFields(
        args,
        ["canister", "method"],
        ["args", "identityMode"],
        `${operation} arguments`,
      );
      const selected = Object.hasOwn(args, "identityMode")
        ? optionalIdentityMode(args.identityMode)
        : identityMode;
      if (selected !== identityMode) {
        throw new Error(
          "Script canister calls cannot change the run identity mode",
        );
      }
      const request: BlastCallRequest = preparedUpdate ?? {
        canister: requiredText(args.canister, "canister", 80),
        method: requiredBlastMethodName(args.method, "method"),
        args: optionalJsonArray(args.args, "args"),
        identityMode,
      };
      result =
        operation === "blast.query"
          ? await state.icblast.query(request, undefined, signalOptions(signal))
          : await state.icblast.update(
              request,
              undefined,
              signalOptions(signal),
            );
    }
    const json =
      operation === "blast.query" || operation === "blast.update"
        ? scriptCallResult(result as BlastCallResult)
        : asJson(result);
    try {
      const accountedResponseBytes =
        operation === "blast.query" || operation === "blast.update"
          ? Math.max(jsonBytes(json), (result as BlastCallResult).resultBytes)
          : jsonBytes(json);
      await state.database.settleRunCall(handle, {
        responseReservationBytes,
        responseBytes: accountedResponseBytes,
        pendingUpdateId,
        ...(pendingUpdateId === null || pendingUpdateId === undefined
          ? {}
          : { updateResolution: "confirmed" as const }),
      });
      if (pendingUpdateId !== null && pendingUpdateId !== undefined) {
        recordConfirmedUpdateId(pendingUpdateId);
      }
    } catch (cause) {
      if (operation === "blast.update") {
        const call = result as BlastCallResult;
        const evidenceSettled = await markConfirmedUpdateEvidence(
          state.database,
          handle,
          pendingUpdateId,
        );
        if (
          evidenceSettled &&
          pendingUpdateId !== null &&
          pendingUpdateId !== undefined
        ) {
          recordConfirmedUpdateId(pendingUpdateId);
        }
        const outcome = dispatchedCallResult(
          new BlastDispatchedCallError({
            canister: call.canister,
            method: call.method,
            kind: call.kind,
            identityMode: call.identityMode,
            resultStatus: "dispatched_result_unknown",
            resultBytes: null,
            dispatchStatus: "confirmed",
            cause,
          }),
        );
        recordDispatchedOutcome(outcome);
        // The remote update returned, but durable accounting did not settle.
        // Keep the full reservation and surface a non-retryable unknown result.
        settled = true;
        return outcome;
      }
      throw cause;
    }
    settled = true;
    return json;
  } catch (error) {
    if (error instanceof BlastDispatchedCallError) {
      if (error.dispatchStatus === "confirmed") {
        const evidenceSettled = await markConfirmedUpdateEvidence(
          state.database,
          handle,
          pendingUpdateId,
        );
        if (
          evidenceSettled &&
          pendingUpdateId !== null &&
          pendingUpdateId !== undefined
        ) {
          recordConfirmedUpdateId(pendingUpdateId);
        }
      }
      const outcome = dispatchedCallResult(error) as JsonObject;
      recordDispatchedOutcome(outcome);
      // Keep the full reservation charged: Blast crossed the call boundary and
      // exact response usage is unavailable or over the absolute bound.
      settled = true;
      return outcome;
    }
    if (!settled) {
      try {
        await state.database.settleRunCall(handle, {
          responseReservationBytes,
          responseBytes: 0,
          pendingUpdateId,
          ...(pendingUpdateId === null || pendingUpdateId === undefined
            ? {}
            : { updateResolution: "not_dispatched" as const }),
        });
      } catch {
        // The run may have reached a terminal state while the IC operation was
        // pending. Preserve the original operation error in that case.
      }
    }
    throw error;
  }
}

async function markConfirmedUpdateEvidence(
  database: BlastDatabase,
  handle: RunHandle,
  pendingUpdateId: string | null | undefined,
): Promise<boolean> {
  if (pendingUpdateId === null || pendingUpdateId === undefined) return false;
  try {
    // Keep the admitted response reservation charged while durably upgrading
    // only the retry-safety evidence from call_pending to confirmed.
    await database.settleRunCall(handle, {
      responseReservationBytes: 0,
      responseBytes: 0,
      pendingUpdateId,
      updateResolution: "confirmed",
    });
    return true;
  } catch {
    // A failed evidence update remains conservatively call_pending. Never turn
    // a confirmed or ambiguous remote update into a generic retryable error.
    return false;
  }
}

function directCallRequest(
  args: JsonObject,
  route: "query" | "update",
): BlastCallRequest {
  assertExactFields(
    args,
    ["canister", "method", "args"],
    ["identityMode"],
    `blast.${route} arguments`,
  );
  const identityMode = optionalIdentityMode(args.identityMode);
  if (route === "query" && identityMode !== "local") {
    throw new Error("Kernel identity is rejected by blast.query");
  }
  return {
    canister: requiredText(args.canister, "canister", 80),
    method: requiredBlastMethodName(args.method, "method"),
    args: requiredJsonArray(args.args, "args"),
    identityMode,
  };
}

function inlineCallResult(result: BlastCallResult): JsonValue {
  const inline =
    result.resultBytes <=
    BLAST_LIMITS.inlineCallResultBytes - INLINE_CALL_WRAPPER_RESERVE_BYTES;
  const oneway = result.kind === "oneway";
  return asJson({
    canister: result.canister,
    method: result.method,
    kind: result.kind,
    identityMode: result.identityMode,
    resultStatus: oneway
      ? "dispatched_no_result"
      : inline
        ? "complete"
        : "result_too_large",
    result: oneway || !inline ? null : result.result,
    resultBytes: result.resultBytes,
    dispatchStatus: "confirmed",
    retrySafe: result.kind === "query",
  });
}

function scriptCallResult(result: BlastCallResult): JsonValue {
  return asJson({
    canister: result.canister,
    method: result.method,
    kind: result.kind,
    identityMode: result.identityMode,
    resultStatus:
      result.kind === "oneway" ? "dispatched_no_result" : "complete",
    result: result.kind === "oneway" ? null : result.result,
    resultBytes: result.resultBytes,
    dispatchStatus: "confirmed",
    retrySafe: result.kind === "query",
  });
}

function dispatchedCallResult(error: BlastDispatchedCallError): JsonObject {
  return {
    canister: error.canister,
    method: error.method,
    kind: error.kind,
    identityMode: error.identityMode,
    resultStatus: error.resultStatus,
    result: null,
    resultBytes: error.resultBytes,
    dispatchStatus: error.dispatchStatus,
    retrySafe: error.retrySafe,
  };
}

function scriptSaveOutcomeUnknown(
  request: Readonly<{
    id?: string;
    expectedRevision?: string;
    name: string;
    description: string | null;
    source: string;
  }>,
  sourceDigest: string,
): JsonObject {
  const match = {
    name: request.name,
    description: request.description,
    sourceDigest,
    sourceBytes: stringBytes(request.source),
  };
  if (request.id === undefined || request.expectedRevision === undefined) {
    return {
      mutationStatus: "outcome_unknown",
      retrySafe: false,
      reconciliation: {
        kind: "create",
        tool: "script.list",
        match: { revision: "1", ...match },
      },
    };
  }
  return {
    mutationStatus: "outcome_unknown",
    retrySafe: false,
    reconciliation: {
      kind: "replace",
      tool: "script.get",
      id: request.id,
      expectedRevision: request.expectedRevision,
      expectedSuccessorRevision: nat64Successor(request.expectedRevision),
      match,
    },
  };
}

function nat64Successor(value: string): string | null {
  const successor = BigInt(value) + 1n;
  return successor > MAX_NAT64 ? null : String(successor);
}

function scriptDeleteOutcomeUnknown(
  id: string,
  expectedRevision: string,
): JsonObject {
  return {
    mutationStatus: "outcome_unknown",
    retrySafe: false,
    reconciliation: {
      kind: "delete",
      tool: "script.get",
      id,
      expectedRevision,
    },
  };
}

function executionResult(
  run: RunRecord,
  request: ScriptExecutionRequest,
  result: JsonValue,
  checkpoint: JsonValue,
): JsonValue {
  const pendingUpdateCount = runPendingUpdateCount(run);
  return asJson({
    runId: run.id,
    state: run.state,
    sourceDigest: request.sourceDigest,
    script: request.script,
    result,
    collectionIds: run.outputCollectionIds,
    checkpoint,
    summary: run.summary,
    // Re-running arbitrary guest code is never automatically safe: it can
    // write collections or call update methods. Keep checkpoint coverage
    // explicit so callers do not have to decode the summary envelope.
    retrySafe: false,
    pendingUpdateCount,
    calls: run.counters.callCount,
    inputBytes: run.counters.requestBytes + run.counters.readBytes,
    outputBytes: run.counters.responseBytes + run.counters.writeBytes,
  });
}

async function failOpenRunCollections(
  database: BlastDatabase,
  ids: readonly string[],
  message: string,
): Promise<boolean> {
  let incomplete = false;
  for (const id of ids.slice(0, MAX_SCRIPT_COLLECTIONS)) {
    try {
      const collection = await database.getCollection(id);
      if (collection?.state === "open") {
        await database.failCollection(id, { error: message });
      }
    } catch {
      incomplete = true;
    }
  }
  return incomplete;
}

function publicCollectionListEntry(value: CollectionListEntry): JsonObject {
  return {
    id: value.id,
    name: value.name,
    state: value.state,
    kind: value.kind,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    pageCount: value.pageCount,
    itemCount: value.itemCount,
    serializedBytes: value.serializedBytes,
    sourceCollectionIds: [...value.sourceCollectionIds],
    producer: value.producer,
    identity: value.identity,
    source: publicCollectionSource(value.source),
  } as JsonObject;
}

function publicCollectionRecord(value: CollectionRecord): JsonObject {
  return {
    ...publicCollectionListEntry(value),
    description: value.description,
    summary: publicStoredV1Json(
      value.summary,
      `Collection ${value.id} summary`,
      BLAST_LIMITS.collectionSummaryBytes,
    ),
  } as JsonObject;
}

function publicCollectionPage(value: CollectionPageRecord): JsonObject {
  return {
    sequence: value.sequence,
    idempotencyKey: value.idempotencyKey ?? null,
    value: publicStoredV1Json(
      value.value,
      `Collection page ${value.sequence}`,
      BLAST_LIMITS.collectionPageBytes,
    ),
    itemCount: value.itemCount,
    serializedBytes: value.serializedBytes,
    createdAt: value.createdAt,
  };
}

function publicCollectionDescription(value: CollectionDescription): JsonObject {
  const collection = publicCollectionRecord(value.collection);
  if (value.oversizedPage !== null) {
    return asJson({
      collection,
      pages: [],
      cursor: value.cursor,
      sampleStatus: "page_too_large",
      omittedPage: value.oversizedPage,
    }) as JsonObject;
  }

  const pages = value.pages.map(publicCollectionPage);
  const storedV1ValueOmitted = pages.some((page) =>
    isStoredV1JsonOmission(page.value),
  );
  let cursor = value.cursor;
  let output: JsonObject = {
    collection,
    pages,
    cursor,
    sampleStatus: storedV1ValueOmitted
      ? "stored_v1_value_omitted"
      : "complete",
    omittedPage: null,
  };
  // Page bodies are bounded separately, but page keys and collection metadata
  // also consume the direct tool envelope. Preserve ordinary pagination by
  // returning the largest exact prefix that fits and moving the cursor only
  // through pages actually returned.
  while (
    pages.length > 1 &&
    jsonBytes(output) > BLAST_LIMITS.inlineCallResultBytes
  ) {
    pages.pop();
    cursor = encodePageCursor(value.pages[pages.length - 1]!.sequence);
    output = { ...output, pages, cursor };
  }
  if (jsonBytes(output) <= BLAST_LIMITS.inlineCallResultBytes) return output;

  const omitted = value.pages[0];
  if (omitted === undefined) {
    throw new Error("Collection metadata exceeds the direct describe envelope");
  }
  const fallback = asJson({
    collection,
    pages: [],
    cursor: encodePageCursor(omitted.sequence),
    sampleStatus: "page_too_large",
    omittedPage: {
      sequence: omitted.sequence,
      serializedBytes: omitted.serializedBytes,
      maximumBytes: DESCRIBE_PAGE_BYTES,
    },
  });
  if (jsonBytes(fallback) > BLAST_LIMITS.inlineCallResultBytes) {
    throw new Error("Collection metadata exceeds the direct describe envelope");
  }
  return fallback as JsonObject;
}

function isStoredV1JsonOmission(value: JsonValue | undefined): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.$blastStoredV1 === STORED_V1_JSON_OMISSION
  );
}

function publicRunRecord(value: RunRecord): JsonObject {
  return {
    id: value.id,
    source: value.source,
    state: value.state,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
    deadlineAt: value.deadlineAt,
    inputCollectionIds: [...value.inputCollectionIds],
    outputCollectionIds: [...value.outputCollectionIds],
    identity: value.identity,
    counters: value.counters,
    pendingUpdates: value.pendingUpdates.map(publicPendingUpdate),
    checkpointRevision: value.checkpointRevision,
    summary: publicRunSummary(
      value.summary,
      `Run ${value.id} summary`,
      BLAST_LIMITS.collectionSummaryBytes,
    ),
  } as JsonObject;
}

function publicCheckpointRecord(value: CheckpointRecord): JsonObject {
  return {
    runId: value.runId,
    revision: value.revision,
    sourceDigest: value.sourceDigest,
    inputCollectionIds: [...value.inputCollectionIds],
    outputCollectionIds: [...value.outputCollectionIds],
    value: publicStoredV1Json(
      value.value,
      `Run ${value.runId} checkpoint`,
      BLAST_LIMITS.collectionSummaryBytes,
    ),
    serializedBytes: value.serializedBytes,
    updatedAt: value.updatedAt,
  } as JsonObject;
}

function publicCollectionSource(value: CollectionSource | null): JsonValue {
  if (value === null) return null;
  return {
    canister: value.canister,
    ...publicStoredV1Method(value.method),
    argumentsDigest: value.argumentsDigest,
  };
}

function publicPendingUpdate(
  value: RunRecord["pendingUpdates"][number],
): JsonObject {
  return {
    id: value.id,
    canister: value.canister,
    ...publicStoredV1Method(value.method),
    argumentsDigest: value.argumentsDigest,
    identityMode: value.identityMode,
    startedAt: value.startedAt,
    status: value.status,
  };
}

function publicRunSummary(
  value: JsonValue,
  label: string,
  maxBytes: number,
): JsonValue {
  const bounded = publicStoredV1Json(value, label, maxBytes);
  if (
    bounded === null ||
    typeof bounded !== "object" ||
    Array.isArray(bounded)
  ) {
    return bounded;
  }
  const evidence = bounded.updateEvidence;
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.protocol !== 1 ||
    !Array.isArray(evidence.attempts)
  ) {
    return bounded;
  }
  let changed = false;
  const attempts = evidence.attempts.map((attempt) => {
    if (
      attempt === null ||
      typeof attempt !== "object" ||
      Array.isArray(attempt) ||
      typeof attempt.method !== "string"
    ) {
      return attempt;
    }
    try {
      requiredBlastMethodName(attempt.method, "Stored method");
      return attempt;
    } catch {
      changed = true;
      return { ...attempt, ...publicStoredV1Method(attempt.method) };
    }
  });
  if (!changed) return bounded;
  const projected = {
    ...bounded,
    updateEvidence: { ...evidence, attempts },
  } as JsonObject;
  try {
    assertBoundedBlastJson(projected, label, maxBytes);
    return projected;
  } catch {
    return {
      $blastStoredV1: STORED_V1_METHOD_EVIDENCE_OMISSION,
      serializedBytes: jsonBytes(value),
    };
  }
}

function publicStoredV1Method(method: string): JsonObject {
  try {
    requiredBlastMethodName(method, "Stored method");
    return { method };
  } catch {
    return {
      method: null,
      methodStatus: STORED_V1_METHOD_STATUS,
      legacyMethodUtf8Hex: utf8Hex(method),
    };
  }
}

function utf8Hex(value: string): string {
  return [...utf8Encoder.encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function publicStoredV1Json(
  value: JsonValue,
  label: string,
  maxBytes: number,
): JsonValue {
  try {
    assertBoundedBlastJson(value, label, maxBytes);
    return value;
  } catch {
    // A v0.1.0 row may be wider than today's MessagePort JSON boundary. Keep
    // the durable row untouched and return a small, explicit omission instead
    // of misclassifying valid schema-v1 state as corrupt or emitting a result
    // that the current transport cannot carry.
    assertBoundedBlastStoredV1Json(value, label, maxBytes);
    return {
      $blastStoredV1: STORED_V1_JSON_OMISSION,
      serializedBytes: jsonBytes(value),
    };
  }
}

async function storageStatus(
  storage: StorageManager | null,
): Promise<JsonObject> {
  if (storage === null) return { usage: null, quota: null, persisted: null };
  const [estimate, persisted] = await Promise.all([
    typeof storage.estimate === "function"
      ? storage.estimate().catch(() => null)
      : Promise.resolve(null),
    typeof storage.persisted === "function"
      ? storage.persisted().catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    usage: safeStorageInteger(estimate?.usage),
    quota: safeStorageInteger(estimate?.quota),
    persisted: typeof persisted === "boolean" ? persisted : null,
  };
}

function safeStorageInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function optionalScriptCursor(
  value: JsonValue | undefined,
): { afterId: string; libraryRevision: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const cursor = requiredObject(value, "script cursor");
  assertExactFields(
    cursor,
    ["afterId", "libraryRevision"],
    [],
    "script cursor",
  );
  return {
    afterId: requiredNat64Text(cursor.afterId, "cursor afterId", true),
    libraryRevision: requiredNat64Text(
      cursor.libraryRevision,
      "cursor libraryRevision",
      false,
    ),
  };
}

function optionalCollectionSource(
  value: JsonValue | undefined,
): CollectionSource | null {
  if (value === undefined || value === null) return null;
  const source = requiredObject(value, "collection source");
  assertExactFields(
    source,
    ["canister", "method", "argumentsDigest"],
    [],
    "collection source",
  );
  return {
    canister: requiredCanister(source.canister, "source canister"),
    method: requiredBlastMethodName(source.method, "source method"),
    argumentsDigest: requiredDigest(
      source.argumentsDigest,
      "source argumentsDigest",
    ),
  };
}

function requiredCanister(value: unknown, label: string): string {
  const text = requiredText(value, label, 63);
  try {
    const canonical = Principal.fromText(text).toText();
    if (canonical !== text || canonical === "aaaaa-aa") {
      throw new Error(`${label} is invalid`);
    }
    return canonical;
  } catch (cause) {
    throw new Error(`${label} is invalid`, { cause });
  }
}

function requiredRunOutput(
  value: JsonValue | undefined,
  outputIds: ReadonlySet<string>,
): string {
  const id = requiredCollectionId(value, "id");
  if (!outputIds.has(id)) {
    throw new Error("Collection is not an output of this script run");
  }
  return id;
}

function requiredCollectionKind(value: unknown): "raw" | "derived" {
  if (value !== "raw" && value !== "derived") {
    throw new Error("Collection kind is invalid");
  }
  return value;
}

function optionalIdentityMode(value: unknown): BlastIdentityMode {
  if (value === undefined || value === "local") return "local";
  if (value === "kernel") return "kernel";
  throw new Error("identityMode is invalid");
}

function optionalScriptIdentityMode(value: unknown): "local" {
  const identityMode = optionalIdentityMode(value);
  if (identityMode !== "local") {
    throw new Error(
      "Script tools support only Blast's local identity; use blast.update for a consent-protected Kernel-identity call",
    );
  }
  return identityMode;
}

function optionalTimeout(value: unknown): number {
  if (value === undefined) return BLAST_LIMITS.scriptDefaultTimeoutMs;
  return requiredInteger(
    value,
    "timeoutMs",
    1_000,
    BLAST_LIMITS.scriptMaximumTimeoutMs,
  );
}

function optionalJson(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : requiredJson(value, "args");
}

function requiredJson(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) throw new Error(`${label} must be JSON-compatible`);
  return value;
}

function requiredJsonArray(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value) || !isJsonValue(value)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return value;
}

function optionalJsonArray(value: unknown, label: string): JsonValue[] {
  return value === undefined ? [] : requiredJsonArray(value, label);
}

function optionalCollectionIds(
  value: unknown,
  maximum: number,
  label: string,
): string[] {
  return value === undefined
    ? []
    : requiredCollectionIds(value, maximum, label);
}

function requiredCollectionIds(
  value: unknown,
  maximum: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  const ids = value.map((item) => requiredCollectionId(item, label));
  if (new Set(ids).size !== ids.length)
    throw new Error(`${label} has duplicates`);
  return ids;
}

function requiredCollectionId(value: unknown, label: string): string {
  if (typeof value !== "string" || !COLLECTION_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredNat64Text(
  value: unknown,
  label: string,
  positive: boolean,
): string {
  if (
    typeof value !== "string" ||
    !NAT_TEXT_PATTERN.test(value) ||
    BigInt(value) > MAX_NAT64 ||
    (positive && value === "0")
  ) {
    throw new Error(
      `${label} is not a valid ${positive ? "positive " : ""}Nat64 decimal string`,
    );
  }
  return value;
}

function nullableText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, label, maximum);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    unicodeScalarLength(value) > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredWellFormedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarText(value) ||
    stringBytes(value) > maximumBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined
    ? undefined
    : requiredInteger(value, label, minimum, maximum);
}

function requiredInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertExactFields(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Blast operation was cancelled");
}

function awaitReadOnlyAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(
      signal.reason ?? new Error("Blast request was cancelled"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(signal.reason ?? new Error("Blast request was cancelled")),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    // Both branches remain attached after cancellation, so a later rejection
    // from the read-only self-call is observed rather than becoming unhandled.
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function signalOptions(
  signal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal }> | undefined {
  return signal === undefined ? undefined : { signal };
}

function kernelCallOptions(context: MsgBusToolContext): BlastOperationOptions {
  return {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    agentMode: context.agentMode === true,
  };
}

function assertScanMethodLimit(result: BlastScanResult): void {
  if (result.methods.length > MAX_SCAN_METHODS) {
    throw new Error(`ICBlast returned more than ${MAX_SCAN_METHODS} methods`);
  }
}

function asJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error("Blast returned a non-JSON value");
  return value;
}
