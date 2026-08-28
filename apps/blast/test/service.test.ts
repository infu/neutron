import { describe, expect, test } from "bun:test";
import {
  normalizeToolDescriptor,
  validateToolArguments,
  validateToolResult,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
  type ScopedKernelClient,
} from "neutron-tools/app";
import { assertBoundedJson } from "neutron-tools/protocol";
import type {
  BlastDatabase,
  CollectionRecord,
  RunRecord,
} from "../src/database.ts";
import {
  BLAST_RUN_BUDGETS,
  BlastPageReadLimitError,
  canonicalJson,
} from "../src/database.ts";
import type {
  BlastCallResult,
  BlastIcblastClient,
} from "../src/icblast_client.ts";
import { BlastDispatchedCallError } from "../src/icblast_client.ts";
import type { BlastLocalIdentity } from "../src/identity.ts";
import { assertBoundedBlastJson, jsonBytes, sha256Hex } from "../src/json.ts";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "../src/limits.ts";
import type { ScriptHostCausality } from "../src/script_runner.ts";
import {
  createBlastPageLifecycle,
  createBlastToolHandlers,
  runBlastRecoveryPass,
  type BlastServiceAdapters,
  type BlastServiceState,
} from "../src/service.ts";
import { BLAST_TOOL_DEFINITIONS } from "../src/tool_schemas.ts";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const IDENTITY = {
  slot: 0,
  principal: "aaaaa-aa",
  createdAt: 1,
  publicKeyFingerprint: "1".repeat(64),
  identity: {},
} as unknown as BlastLocalIdentity;
const KERNEL = {} as ScopedKernelClient;

function causality(
  requestId: number,
  observedResponseIds: readonly number[] = [],
): ScriptHostCausality {
  return { requestId, observedResponseIds };
}

describe("Blast resident service", () => {
  test("continues bounded deletion recovery and prunes runs on startup and maintenance", async () => {
    const deletionStates = [true, true, false, true, true, true, true];
    let deletionPasses = 0;
    let prunePasses = 0;
    const database = {
      interruptExpiredRuns: async () => [],
      resumeDeletingCollections: async () => ({
        processedCollectionIds: [],
        deletedCollectionIds: [],
        deletedPages: 0,
        incompleteCleanup: deletionStates[deletionPasses++] ?? false,
      }),
      pruneTerminalRuns: async () => {
        prunePasses += 1;
        return { deletedRunIds: [], incompleteCleanup: false };
      },
    } as unknown as BlastDatabase;

    await runBlastRecoveryPass(database);
    expect(deletionPasses).toBe(3);
    expect(prunePasses).toBe(1);

    await runBlastRecoveryPass(database);
    expect(deletionPasses).toBe(7);
    expect(prunePasses).toBe(2);
  });

  test("removes tools before closing and reloads a restored BFCache page", () => {
    const actions: string[] = [];
    const lifecycle = createBlastPageLifecycle({
      stopMaintenance: () => actions.push("stop"),
      removeTools: () => actions.push("remove"),
      closeDatabase: () => actions.push("close"),
      reload: () => actions.push("reload"),
    });

    expect(lifecycle.isClosed()).toBe(false);
    lifecycle.pageshow(false);
    lifecycle.pagehide();
    lifecycle.pagehide();
    expect(lifecycle.isClosed()).toBe(true);
    expect(actions).toEqual(["stop", "remove", "close"]);

    lifecycle.pageshow(true);
    expect(actions).toEqual(["stop", "remove", "close", "reload"]);
  });

  test("declares collection.query local run persistence as read and write", () => {
    expect(
      BLAST_TOOL_DEFINITIONS["collection.query"].annotations,
    ).toMatchObject({
      "neutron:effects": ["read", "write"],
    });
  });

  test("keeps the fixed local identity input closed", () => {
    const descriptor = normalizeToolDescriptor({
      name: "blast.identity",
      ...BLAST_TOOL_DEFINITIONS["blast.identity"],
    });
    validateToolArguments(descriptor, {});
    expect(() => validateToolArguments(descriptor, { slot: 0 })).toThrow();
  });

  test("declares slow IC discovery routes and saved-library network effects", () => {
    for (const name of [
      "blast.scan",
      "blast.schema",
      "blast.validate_input",
      "blast.query",
    ] as const) {
      expect(BLAST_TOOL_DEFINITIONS[name].annotations).toMatchObject({
        "neutron:longRunning": true,
      });
    }
    expect(
      BLAST_TOOL_DEFINITIONS["blast.update"].annotations,
    ).toMatchObject({ "neutron:longRunning": true });
    for (const name of ["script.list", "script.get"] as const) {
      expect(BLAST_TOOL_DEFINITIONS[name].annotations).toMatchObject({
        "neutron:effects": ["read", "network"],
      });
    }
    for (const name of ["script.save", "script.delete"] as const) {
      expect(BLAST_TOOL_DEFINITIONS[name].annotations).toMatchObject({
        "neutron:effects": ["write", "network"],
      });
    }
  });

  test("documents target exclusions and identity compatibility boundaries", () => {
    for (const name of ["blast.scan", "blast.validate_input"] as const) {
      const descriptor = normalizeToolDescriptor({
        name,
        ...BLAST_TOOL_DEFINITIONS[name],
      });
      const argumentsValue =
        name === "blast.scan"
          ? { canister: "aaaaa-aa" }
          : { canister: "aaaaa-aa", method: "read", args: [] };
      expect(() => validateToolArguments(descriptor, argumentsValue)).toThrow();
    }
    expect(BLAST_TOOL_DEFINITIONS["blast.identity"].description).toContain(
      "target canisters can observe",
    );
    expect(BLAST_TOOL_DEFINITIONS["blast.update"].description).toContain(
      "never receives its key",
    );
    expect(BLAST_TOOL_DEFINITIONS["blast.update"].description).toContain(
      "hosting Neutron canister",
    );
    expect(BLAST_TOOL_DEFINITIONS["blast.update"].description).toContain(
      "Agent Mode requires the v2",
    );
    expect(BLAST_TOOL_DEFINITIONS["blast.update"].description).toContain(
      "cancellation is not phase-aware",
    );
  });

  test("binds validation success and diagnostics exactly", () => {
    const descriptor = normalizeToolDescriptor({
      name: "blast.validate_input",
      ...BLAST_TOOL_DEFINITIONS["blast.validate_input"],
    });
    const common = {
      canister: CANISTER,
      method: "read",
      kind: "query",
    };
    validateToolResult(descriptor, { ...common, valid: true, errors: null });
    validateToolResult(descriptor, {
      ...common,
      valid: false,
      errors: [{ message: "invalid" }],
    });
    expect(() =>
      validateToolResult(descriptor, {
        ...common,
        valid: true,
        errors: [],
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(descriptor, {
        ...common,
        valid: false,
        errors: null,
      }),
    ).toThrow();
    expect(descriptor.description).toContain("Candid preparation");
  });

  test("declares script execution as local-identity-only", () => {
    for (const name of ["script.evaluate", "script.run"] as const) {
      const descriptor = normalizeToolDescriptor({
        name,
        ...BLAST_TOOL_DEFINITIONS[name],
      });
      expect(descriptor.annotations?.["neutron:effects"]).toEqual([
        "read",
        "write",
        "network",
      ]);
      const common = { identityMode: "kernel" };
      expect(() =>
        validateToolArguments(
          descriptor,
          name === "script.evaluate"
            ? { source: "return null;", ...common }
            : {
                id: "1",
                revision: "1",
                digest: "a".repeat(64),
                ...common,
              },
        ),
      ).toThrow();
    }
    const sourceSchema = (
      BLAST_TOOL_DEFINITIONS["script.evaluate"].inputSchema
        .properties as JsonObject
    ).source as JsonObject;
    expect(sourceSchema.description).toContain("async-function body");
    expect(sourceSchema.description).toContain("explicitly return");
    expect(sourceSchema.description).toContain("pageLimit:1");
    expect(sourceSchema.description).toContain("collections.create({");
    expect(sourceSchema.description).toContain("inputCollectionIds");
    expect(sourceSchema.description).toContain("collections.append");
    expect(sourceSchema.description).toContain("collections.complete");
    expect(sourceSchema.description).toContain("before normal return");
    expect(sourceSchema.description).toContain("lazy async iterable");
    expect(sourceSchema.description).toContain("not nested rows");
    expect(sourceSchema.description).toContain("for await");
    expect(sourceSchema.description).toContain("Array.isArray(page)");
    expect(sourceSchema.description).toContain("count += page.length");
    expect(sourceSchema.description).toContain("collections.readPages");
    expect(sourceSchema.description).toContain("nextCursor");
    expect(sourceSchema.description).toContain(
      "finite limit counts total yielded pages",
    );
    expect(sourceSchema.description).toContain("returns no continuation");
    expect(sourceSchema.description).toContain("blast.scan({canister})");
    expect(sourceSchema.description).toContain(
      "collections.putPage(id,key,value)",
    );
    expect(sourceSchema.description).toContain("run.progress(value)");
    expect(sourceSchema.description).toContain("idempotency key");
    expect(sourceSchema.description).toContain(
      String(BLAST_RUN_BUDGETS.pageReads),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_RUN_BUDGETS.readBytes),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_LIMITS.collectionBatchPages),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_STORED_V1_JSON_LIMITS.nodes),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_RUN_BUDGETS.calls),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_RUN_BUDGETS.pageWrites),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_LIMITS.scriptHostCalls),
    );
    expect(sourceSchema.description).toContain(
      String(BLAST_LIMITS.scriptResultBytes),
    );
    expect(sourceSchema.description).toContain("run.checkpoint");
    expect(sourceSchema.description).toContain(
      "append is at-least-once when key is omitted",
    );
    expect(sourceSchema.description).not.toContain(
      "append derives a key when omitted",
    );
    expect(sourceSchema.description).toContain(
      "const result = await blast.update",
    );

    const outputProperties = (
      BLAST_TOOL_DEFINITIONS["script.evaluate"].outputSchema as JsonObject
    ).properties as JsonObject;
    const resultDescription = String(
      (outputProperties.result as JsonObject).description,
    );
    expect(resultDescription).toContain(String(BLAST_LIMITS.scriptResultBytes));
    expect(resultDescription).toContain(String(BLAST_LIMITS.jsonNodes));
    expect(resultDescription).toContain(String(BLAST_LIMITS.jsonDepth));

    expect(BLAST_TOOL_DEFINITIONS["script.run"].description).toContain(
      "script.get",
    );

    expect((outputProperties.calls as JsonObject).maximum).toBe(
      BLAST_RUN_BUDGETS.calls,
    );
    expect(String((outputProperties.calls as JsonObject).description)).toContain(
      "Canister and discovery",
    );
    expect(
      String((outputProperties.inputBytes as JsonObject).description),
    ).toContain("collection-page bytes read");
    expect(
      String((outputProperties.outputBytes as JsonObject).description),
    ).toContain("collection-page bytes written");
  });

  test("documents pagination recovery, cancellation, cleanup, and provenance", () => {
    expect(BLAST_TOOL_DEFINITIONS["script.list"].description).toContain(
      "restart with cursor:null",
    );
    for (const name of ["script.evaluate", "script.run"] as const) {
      expect(BLAST_TOOL_DEFINITIONS[name].description).toContain("run.list");
      expect(BLAST_TOOL_DEFINITIONS[name].description).toContain("never rerun");
    }
    expect(BLAST_TOOL_DEFINITIONS["script.delete"].description).toContain(
      "does not delete prior runs or collections",
    );
    expect(BLAST_TOOL_DEFINITIONS["run.delete"].description).toContain(
      "does not delete its output collections or saved script",
    );

    const collectionListText = JSON.stringify(
      BLAST_TOOL_DEFINITIONS["collection.list"].outputSchema,
    );
    expect(collectionListText).toContain("Script-declared external-call provenance");
    expect(collectionListText).toContain("does not attest that stored pages");
    expect(collectionListText).toContain("System-bound saved-script revision");
    expect(collectionListText).toContain("Script-declared lineage");
  });

  test("documents cursor and completeness semantics on direct collection tools", () => {
    const list = normalizeToolDescriptor({
      name: "collection.list",
      ...BLAST_TOOL_DEFINITIONS["collection.list"],
    });
    const describe = normalizeToolDescriptor({
      name: "collection.describe",
      ...BLAST_TOOL_DEFINITIONS["collection.describe"],
    });
    const query = normalizeToolDescriptor({
      name: "collection.query",
      ...BLAST_TOOL_DEFINITIONS["collection.query"],
    });

    expect(list.description).toContain("only cursor:null");
    expect(list.description).toContain("pageCount");
    expect(list.description).toContain("itemCount");
    expect(describe.description).toContain("one stored page value");
    expect(describe.description).toContain("stored_v1_value_omitted");
    expect(describe.description).toContain("only cursor:null");
    expect(describe.description).toContain("pageLimit:1");
    expect(describe.description).toContain("byte/node-safe prefix");
    expect(query.description).toContain("always page-local");
    expect(query.description).toContain("only cursor:null");
    expect(query.description).toContain("automatically returns a smaller");
    expect(query.description).toContain("combine results incrementally");
    expect(query.description).toContain("prefer one script.evaluate");
    expect(query.description).toContain(
      String(BLAST_LIMITS.jsonataOutputBytes),
    );
    expect(query.description).not.toContain("Reduce pageLimit");

    const describeInput = describe.inputSchema.properties as JsonObject;
    expect(
      String((describeInput.pageLimit as JsonObject).description),
    ).toContain("smaller byte/node-safe prefix");
    const queryInput = query.inputSchema.properties as JsonObject;
    expect(String((queryInput.pageLimit as JsonObject).description)).toContain(
      "smaller byte/node-safe prefix",
    );
  });

  test("documents exact collection cleanup follow-up semantics", () => {
    const descriptor = normalizeToolDescriptor({
      name: "collection.delete",
      ...BLAST_TOOL_DEFINITIONS["collection.delete"],
    });
    expect(descriptor.description).toContain("deleted or missing");
    expect(descriptor.description).toContain("deleting means");
    expect(descriptor.description).toContain("Re-list collections");
    expect(descriptor.description).toContain("origin-wide");
    expect(descriptor.description).toContain("run.delete");

    const outputProperties = descriptor.outputSchema!.properties as JsonObject;
    const results = outputProperties.results as JsonObject;
    const resultProperties = (results.items as JsonObject)
      .properties as JsonObject;
    expect(
      String((resultProperties.status as JsonObject).description),
    ).toContain("call collection.delete again");
    expect(
      String((outputProperties.incompleteCleanup as JsonObject).description),
    ).toContain("global flag alone");
  });

  test("counts method and JSONata schema lengths in Unicode code points", () => {
    const query = normalizeToolDescriptor({
      name: "blast.query",
      ...BLAST_TOOL_DEFINITIONS["blast.query"],
    });
    validateToolArguments(query, {
      canister: CANISTER,
      method: "😀".repeat(BLAST_LIMITS.canisterMethodCharacters),
      args: [],
    });
    expect(() =>
      validateToolArguments(query, {
        canister: CANISTER,
        method: "😀".repeat(BLAST_LIMITS.canisterMethodCharacters + 1),
        args: [],
      }),
    ).toThrow();

    const collectionQuery = normalizeToolDescriptor({
      name: "collection.query",
      ...BLAST_TOOL_DEFINITIONS["collection.query"],
    });
    validateToolArguments(collectionQuery, {
      id: "collection_input",
      expression: "😀".repeat(BLAST_LIMITS.jsonataExpressionCharacters),
    });
    expect(() =>
      validateToolArguments(collectionQuery, {
        id: "collection_input",
        expression: "😀".repeat(BLAST_LIMITS.jsonataExpressionCharacters + 1),
      }),
    ).toThrow();
  });

  test("keeps saved-script CAS pairs and Nat64 bounds exact in schemas", () => {
    const save = normalizeToolDescriptor({
      name: "script.save",
      ...BLAST_TOOL_DEFINITIONS["script.save"],
    });
    validateToolArguments(save, { name: "Create", source: "return 1;" });
    validateToolArguments(save, {
      id: "18446744073709551615",
      expectedRevision: "1",
      name: "Replace",
      source: "return 2;",
    });
    expect(() =>
      validateToolArguments(save, {
        id: "7",
        name: "Invalid partial CAS",
        source: "return 3;",
      }),
    ).toThrow();

    const get = normalizeToolDescriptor({
      name: "script.get",
      ...BLAST_TOOL_DEFINITIONS["script.get"],
    });
    validateToolArguments(get, { id: "18446744073709551615" });
    expect(() =>
      validateToolArguments(get, {
        id: "18446744073709551616",
      }),
    ).toThrow();
  });

  test("keeps collection page cursor schemas within safe integer bounds", () => {
    for (const name of ["collection.describe", "collection.query"] as const) {
      const descriptor = normalizeToolDescriptor({
        name,
        ...BLAST_TOOL_DEFINITIONS[name],
      });
      const base =
        name === "collection.query"
          ? { id: "collection_input", expression: "$" }
          : { id: "collection_input" };
      validateToolArguments(descriptor, {
        ...base,
        cursor: String(Number.MAX_SAFE_INTEGER),
      });
      for (const cursor of ["9007199254740992", "9999999999999999"]) {
        expect(() =>
          validateToolArguments(descriptor, {
            ...base,
            cursor,
          }),
        ).toThrow();
      }
    }
  });

  test("keeps maximum-depth canister arguments inside the public call envelope", () => {
    let value: JsonValue = {};
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      value = [value];
    }
    const descriptor = normalizeToolDescriptor({
      name: "blast.update",
      ...BLAST_TOOL_DEFINITIONS["blast.update"],
    });
    const argumentsValue: JsonObject = {
      canister: CANISTER,
      method: "write",
      args: [value],
      identityMode: "local",
    };

    validateToolArguments(descriptor, argumentsValue);
    expect(() =>
      assertBoundedJson(
        {
          target: "app:blast:background",
          name: "blast.update",
          arguments: argumentsValue,
        },
        "Blast call payload",
      ),
    ).not.toThrow();
  });

  test("returns bounded create reconciliation instead of inviting a duplicate retry", async () => {
    const controller = new AbortController();
    const source = "return { proposals: true };";
    const sourceDigest = await sha256Hex(source);
    let updates = 0;
    const kernel = {
      updateSelf: async () => {
        updates += 1;
        controller.abort(new Error("cancelled after update dispatch"));
        throw controller.signal.reason;
      },
    } as unknown as ScopedKernelClient;
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(clientFixture())),
      adapterFixture(),
    );

    const output = await handlers["script.save"](
      {
        name: "Governance proposals",
        description: "Fetch nested proposal pages",
        source,
      },
      { ...contextFixture(), kernel, signal: controller.signal },
    );

    expect(updates).toBe(1);
    expect(output).toEqual({
      mutationStatus: "outcome_unknown",
      retrySafe: false,
      reconciliation: {
        kind: "create",
        tool: "script.list",
        match: {
          revision: "1",
          name: "Governance proposals",
          description: "Fetch nested proposal pages",
          sourceDigest,
          sourceBytes: new TextEncoder().encode(source).byteLength,
        },
      },
    });
    const descriptor = normalizeToolDescriptor({
      name: "script.save",
      ...BLAST_TOOL_DEFINITIONS["script.save"],
    });
    validateToolResult(descriptor, output);
    expect(JSON.stringify(output)).not.toContain(source);
    expect(() =>
      validateToolResult(descriptor, {
        ...(output as JsonObject),
        retrySafe: true,
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(descriptor, {
        ...(output as JsonObject),
        source,
      }),
    ).toThrow();
    expect(descriptor.description).toContain(
      "repeating a lost create can make a duplicate",
    );
  });

  test("returns exact replace and delete reconciliation after ambiguous updates", async () => {
    const source = "return 42;";
    const sourceDigest = await sha256Hex(source);
    let updates = 0;
    const kernel = {
      updateSelf: async (_method: string) => {
        updates += 1;
        if (updates === 1) throw new Error("Timeout after 45 seconds");
        // A malformed reply is post-attempt ambiguity too: the backend may
        // already have committed before its response failed validation.
        return { outcome: { ok: {} } };
      },
    } as unknown as ScopedKernelClient;
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(clientFixture())),
      adapterFixture(),
    );
    const context = { ...contextFixture(), kernel };

    const replaced = await handlers["script.save"](
      {
        id: "7",
        expectedRevision: "3",
        name: "Replacement",
        source,
      },
      context,
    );
    expect(replaced).toEqual({
      mutationStatus: "outcome_unknown",
      retrySafe: false,
      reconciliation: {
        kind: "replace",
        tool: "script.get",
        id: "7",
        expectedRevision: "3",
        expectedSuccessorRevision: "4",
        match: {
          name: "Replacement",
          description: null,
          sourceDigest,
          sourceBytes: new TextEncoder().encode(source).byteLength,
        },
      },
    });

    const saturatedReplacement = await handlers["script.save"](
      {
        id: "7",
        expectedRevision: "18446744073709551615",
        name: "Replacement",
        source,
      },
      context,
    );
    expect(saturatedReplacement).toMatchObject({
      reconciliation: {
        kind: "replace",
        expectedSuccessorRevision: null,
      },
    });

    const deleted = await handlers["script.delete"](
      { id: "7", expectedRevision: "4" },
      context,
    );
    expect(deleted).toEqual({
      mutationStatus: "outcome_unknown",
      retrySafe: false,
      reconciliation: {
        kind: "delete",
        tool: "script.get",
        id: "7",
        expectedRevision: "4",
      },
    });
    validateToolResult(
      normalizeToolDescriptor({
        name: "script.save",
        ...BLAST_TOOL_DEFINITIONS["script.save"],
      }),
      replaced,
    );
    validateToolResult(
      normalizeToolDescriptor({
        name: "script.save",
        ...BLAST_TOOL_DEFINITIONS["script.save"],
      }),
      saturatedReplacement,
    );
    validateToolResult(
      normalizeToolDescriptor({
        name: "script.delete",
        ...BLAST_TOOL_DEFINITIONS["script.delete"],
      }),
      deleted,
    );
  });

  test("keeps definite saved-script domain rejections as errors", async () => {
    let updates = 0;
    const kernel = {
      updateSelf: async () => {
        updates += 1;
        return {
          outcome: {
            rejected: {
              revision_conflict: { expected: "3", actual: "4" },
            },
          },
        };
      },
    } as unknown as ScopedKernelClient;
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(clientFixture())),
      adapterFixture(),
    );
    const context = { ...contextFixture(), kernel };

    await expect(
      handlers["script.save"](
        { name: " padded", source: "return 42;" },
        context,
      ),
    ).rejects.toThrow("Invalid script name");
    expect(updates).toBe(0);
    await expect(
      handlers["script.save"](
        {
          id: "7",
          expectedRevision: "3",
          name: "Replacement",
          source: "return 42;",
        },
        context,
      ),
    ).rejects.toThrow("revision conflict");
    await expect(
      handlers["script.delete"]({ id: "7", expectedRevision: "3" }, context),
    ).rejects.toThrow("revision conflict");
    expect(updates).toBe(2);
  });

  test("rejects impossible direct call outcome combinations", () => {
    const query = normalizeToolDescriptor({
      name: "blast.query",
      ...BLAST_TOOL_DEFINITIONS["blast.query"],
    });
    const complete = {
      canister: CANISTER,
      method: "read",
      kind: "query",
      identityMode: "local",
      resultStatus: "complete",
      result: { ok: true },
      resultBytes: 11,
      dispatchStatus: "confirmed",
      retrySafe: true,
    };
    validateToolResult(query, complete);
    validateToolResult(query, {
      ...complete,
      resultStatus: "result_exceeds_processing_limit",
      result: null,
      resultBytes: BLAST_LIMITS.canisterResultBytes + 1,
    });
    expect(() =>
      validateToolResult(query, {
        ...complete,
        result: null,
        resultStatus: "dispatched_result_unknown",
        resultBytes: null,
        dispatchStatus: "unknown",
        retrySafe: true,
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(query, {
        ...complete,
        dispatchStatus: "unknown",
      }),
    ).toThrow();

    const update = normalizeToolDescriptor({
      name: "blast.update",
      ...BLAST_TOOL_DEFINITIONS["blast.update"],
    });
    validateToolResult(update, {
      ...complete,
      method: "write",
      kind: "update",
      resultStatus: "dispatched_result_unknown",
      result: null,
      resultBytes: null,
      dispatchStatus: "confirmed",
      retrySafe: false,
    });
    validateToolResult(update, {
      ...complete,
      method: "notify",
      kind: "oneway",
      resultStatus: "dispatched_no_result",
      result: null,
      resultBytes: 4,
      dispatchStatus: "confirmed",
      retrySafe: false,
    });
    expect(() =>
      validateToolResult(update, {
        ...complete,
        method: "notify",
        kind: "oneway",
        identityMode: "kernel",
        resultStatus: "dispatched_no_result",
        result: null,
        resultBytes: 4,
        retrySafe: false,
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(update, {
        ...complete,
        method: "notify",
        kind: "oneway",
        resultStatus: "complete",
        result: null,
        resultBytes: 4,
        retrySafe: false,
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(update, {
        ...complete,
        kind: "update",
        retrySafe: true,
      }),
    ).toThrow();

    const querySchema = JSON.stringify(query.outputSchema);
    const updateSchema = JSON.stringify(update.outputSchema);
    expect(querySchema).toContain("repeat it inside a bounded local script");
    expect(querySchema).toContain("identical direct retry will not fit");
    expect(updateSchema).toContain("already dispatched and may have committed");
    expect(updateSchema).toContain("Do not repeat it");
    expect(updateSchema).toContain("Kernel identity has no script route");
  });

  test("counts saved-script names in Unicode scalars like the backend", async () => {
    let updateCalls = 0;
    const kernel = {
      updateSelf: async () => {
        updateCalls += 1;
        return { outcome: { rejected: { invalid_source: null } } };
      },
    } as unknown as ScopedKernelClient;
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(clientFixture())),
      adapterFixture(),
    );
    await expect(
      handlers["script.save"](
        { name: "😀".repeat(120), source: "return null;" },
        { ...contextFixture(), kernel },
      ),
    ).rejects.toThrow("source is invalid");
    expect(updateCalls).toBe(1);

    await expect(
      handlers["script.save"](
        { name: "😀".repeat(121), source: "return null;" },
        { ...contextFixture(), kernel },
      ),
    ).rejects.toThrow("name is invalid");
    expect(updateCalls).toBe(1);
  });

  test("rejects invalid script text and empty collection deletion before effects", async () => {
    const saveDescriptor = normalizeToolDescriptor({
      name: "script.save",
      ...BLAST_TOOL_DEFINITIONS["script.save"],
    });
    validateToolArguments(saveDescriptor, {
      name: "😀 analysis",
      description: "Nested proposal data",
      source: "return '😀';",
    });
    for (const argumentsValue of [
      { name: " padded", source: "return null;" },
      { name: "unsafe\u200bname", source: "return null;" },
      { name: "\ud800", source: "return null;" },
      { name: "Valid", description: "\udc00", source: "return null;" },
      { name: "Valid", source: "return '\ud800';" },
    ]) {
      expect(() =>
        validateToolArguments(saveDescriptor, argumentsValue),
      ).toThrow();
    }

    const deleteDescriptor = normalizeToolDescriptor({
      name: "collection.delete",
      ...BLAST_TOOL_DEFINITIONS["collection.delete"],
    });
    expect(() =>
      validateToolArguments(deleteDescriptor, { ids: [] }),
    ).toThrow();

    let backendCalls = 0;
    let createRunCalls = 0;
    let deleteCalls = 0;
    const kernel = {
      updateSelf: async () => {
        backendCalls += 1;
        throw new Error("must not call");
      },
    } as unknown as ScopedKernelClient;
    const database = {
      createRun: async () => {
        createRunCalls += 1;
        throw new Error("must not create");
      },
      deleteCollections: async () => {
        deleteCalls += 1;
        throw new Error("must not delete");
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );

    await expect(
      handlers["script.save"](
        { name: "\ud800", source: "return null;" },
        { ...contextFixture(), kernel },
      ),
    ).rejects.toThrow("name is invalid");
    await expect(
      handlers["script.save"](
        { name: "Valid", description: "\udc00", source: "return null;" },
        { ...contextFixture(), kernel },
      ),
    ).rejects.toThrow("description");
    await expect(
      handlers["script.save"](
        { name: "Valid", source: "return '\ud800';" },
        { ...contextFixture(), kernel },
      ),
    ).rejects.toThrow("source");
    await expect(
      handlers["script.evaluate"](
        { source: "return '\ud800';" },
        contextFixture(),
      ),
    ).rejects.toThrow("source is invalid");
    await expect(
      handlers["collection.delete"]({ ids: [] }, contextFixture()),
    ).rejects.toThrow("ids is invalid");
    expect({ backendCalls, createRunCalls, deleteCalls }).toEqual({
      backendCalls: 0,
      createRunCalls: 0,
      deleteCalls: 0,
    });
  });

  test("rejects invalid method provenance before durable or remote effects", async () => {
    const running = runFixture("running", []);
    const complete = {
      ...running,
      state: "complete" as const,
      completedAt: 3,
      updatedAt: 3,
    };
    let beginRunCallCalls = 0;
    let createCollectionCalls = 0;
    let updateCalls = 0;
    const database = {
      createRun: async () => running,
      beginRunCall: async () => {
        beginRunCallCalls += 1;
        throw new Error("must not journal");
      },
      createCollection: async () => {
        createCollectionCalls += 1;
        throw new Error("must not create");
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async () => complete,
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async () => {
        updateCalls += 1;
        throw new Error("must not dispatch");
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        const errors: string[] = [];
        const invalidCalls: Array<[string, JsonObject]> = [
          [
            "blast.update",
            { canister: CANISTER, method: "bad\nmethod", args: [] },
          ],
          [
            "collections.create",
            {
              name: "Raw",
              kind: "raw",
              source: {
                canister: CANISTER,
                method: "bad\u007fmethod",
                argumentsDigest: "a".repeat(64),
              },
            },
          ],
        ];
        for (const [operation, argumentsValue] of invalidCalls) {
          try {
            await host(operation, argumentsValue, signal);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        return { errors };
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return null;" },
      contextFixture(),
    );

    expect(output).toMatchObject({
      state: "complete",
      result: {
        errors: ["method is invalid", "source method is invalid"],
      },
    });
    expect({ beginRunCallCalls, createCollectionCalls, updateCalls }).toEqual({
      beginRunCallCalls: 0,
      createCollectionCalls: 0,
      updateCalls: 0,
    });
  });

  test("forwards Agent cancellation to bounded multi-collection deletion", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const database = {
      deleteCollections: async (
        _ids: readonly string[],
        options: Readonly<{ signal?: AbortSignal }>,
      ) => {
        observedSignal = options.signal;
        return { results: [], incompleteCleanup: false };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );

    await handlers["collection.delete"](
      { ids: ["collection_one", "collection_two"] },
      { ...contextFixture(), signal: controller.signal },
    );
    expect(observedSignal).toBe(controller.signal);
  });

  test("reports a dispatched oversized call without returning or truncating it", async () => {
    const result = "x".repeat(BLAST_LIMITS.inlineCallResultBytes + 1);
    const icblast = clientFixture({
      query: async () => ({
        canister: CANISTER,
        method: "large_query",
        kind: "query",
        identityMode: "local",
        result,
        resultBytes: new TextEncoder().encode(JSON.stringify(result))
          .byteLength,
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );
    const output = await handlers["blast.query"](
      {
        canister: CANISTER,
        method: "large_query",
        args: [],
        identityMode: "local",
      },
      contextFixture(),
    );

    expect(output).toMatchObject({
      canister: CANISTER,
      method: "large_query",
      kind: "query",
      identityMode: "local",
      resultStatus: "result_too_large",
      result: null,
    });
    expect((output as JsonObject).resultBytes).toBeGreaterThan(
      BLAST_LIMITS.inlineCallResultBytes,
    );
    validateToolResult(
      normalizeToolDescriptor({
        name: "blast.query",
        ...BLAST_TOOL_DEFINITIONS["blast.query"],
      }),
      output,
    );
  });

  test("keeps a maximum-depth call result inside the public tool boundary", async () => {
    let result: JsonValue = null;
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      result = [result];
    }
    const resultBytes = new TextEncoder().encode(
      JSON.stringify(result),
    ).byteLength;
    const icblast = clientFixture({
      query: async () => ({
        canister: CANISTER,
        method: "deep_query",
        kind: "query",
        identityMode: "local",
        result,
        resultBytes,
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );

    const output = await handlers["blast.query"](
      {
        canister: CANISTER,
        method: "deep_query",
        args: [],
        identityMode: "local",
      },
      contextFixture(),
    );

    expect((output as JsonObject).result).toEqual(result);
    expect(() => assertBoundedJson(output, "Blast tool result")).not.toThrow();
  });

  test("keeps a maximum-depth stored page inside the deepest public wrapper", async () => {
    let value: JsonValue = {};
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      value = [value];
    }
    const database = {
      describeCollection: async () => ({
        collection: collectionFixture(),
        pages: [
          {
            schema: 1,
            collectionId: "collection_output",
            sequence: 0,
            digest: "a".repeat(64),
            value,
            itemCount: 1,
            serializedBytes: new TextEncoder().encode(JSON.stringify(value))
              .byteLength,
            createdAt: 1,
          },
        ],
        cursor: null,
        serializedBytes: 0,
        oversizedPage: null,
      }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );

    const output = await handlers["collection.describe"](
      { id: "collection_output" },
      contextFixture(),
    );

    expect(() => assertBoundedJson(output, "Blast tool result")).not.toThrow();
    validateToolResult(
      normalizeToolDescriptor({
        name: "collection.describe",
        ...BLAST_TOOL_DEFINITIONS["collection.describe"],
      }),
      output,
    );
  });

  test("preserves a dispatched unknown update as an explicit non-retryable result", async () => {
    const icblast = clientFixture({
      update: async () => {
        throw new BlastDispatchedCallError({
          canister: CANISTER,
          method: "uncertain_update",
          kind: "update",
          identityMode: "kernel",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
        });
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );
    const output = await handlers["blast.update"](
      {
        canister: CANISTER,
        method: "uncertain_update",
        args: [],
        identityMode: "kernel",
      },
      contextFixture(),
    );

    expect(output).toEqual({
      canister: CANISTER,
      method: "uncertain_update",
      kind: "update",
      identityMode: "kernel",
      resultStatus: "dispatched_result_unknown",
      result: null,
      resultBytes: null,
      dispatchStatus: "unknown",
      retrySafe: false,
    });
    validateToolResult(
      normalizeToolDescriptor({
        name: "blast.update",
        ...BLAST_TOOL_DEFINITIONS["blast.update"],
      }),
      output,
    );
  });

  test("passes trusted Agent Mode state to Kernel-identity negotiation", async () => {
    const observed: Array<{
      kernel: ScopedKernelClient | undefined;
      agentMode: boolean | undefined;
    }> = [];
    const icblast = clientFixture({
      update: async (request, kernel, options) => {
        observed.push({ kernel, agentMode: options?.agentMode });
        return {
          canister: request.canister,
          method: request.method,
          kind: "update",
          identityMode: "kernel",
          result: null,
          resultBytes: 4,
        };
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );

    await handlers["blast.update"](
      {
        canister: CANISTER,
        method: "write",
        args: [],
        identityMode: "kernel",
      },
      contextFixture([], true),
    );
    await handlers["blast.update"](
      {
        canister: CANISTER,
        method: "write",
        args: [],
        identityMode: "kernel",
      },
      contextFixture([], false),
    );

    expect(observed).toEqual([
      { kernel: KERNEL, agentMode: true },
      { kernel: KERNEL, agentMode: false },
    ]);
  });

  test("reports a confirmed local oneway dispatch without claiming completion", async () => {
    const icblast = clientFixture({
      update: async (request) => ({
        canister: request.canister,
        method: request.method,
        kind: "oneway",
        identityMode: "local",
        result: null,
        resultBytes: 4,
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );

    const output = await handlers["blast.update"](
      {
        canister: CANISTER,
        method: "notify",
        args: [],
        identityMode: "local",
      },
      contextFixture(),
    );

    expect(output).toEqual({
      canister: CANISTER,
      method: "notify",
      kind: "oneway",
      identityMode: "local",
      resultStatus: "dispatched_no_result",
      result: null,
      resultBytes: 4,
      dispatchStatus: "confirmed",
      retrySafe: false,
    });
    validateToolResult(
      normalizeToolDescriptor({
        name: "blast.update",
        ...BLAST_TOOL_DEFINITIONS["blast.update"],
      }),
      output,
    );
  });

  test("rejects a scan that exceeds the declared method-count bound", async () => {
    const icblast = clientFixture({
      scan: async (canister) => ({
        canister,
        methods: Array.from({ length: 1_025 }, (_, index) => ({
          name: `method_${index}`,
          kind: "query" as const,
        })),
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(icblast)),
      adapterFixture(),
    );
    await expect(
      handlers["blast.scan"]({ canister: CANISTER }, contextFixture()),
    ).rejects.toThrow("more than 1024 methods");
  });

  test("rejects Kernel identity for scripts before creating a run", async () => {
    let createRunCalls = 0;
    const database = {
      createRun: async () => {
        createRunCalls += 1;
        throw new Error("must not create");
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );

    await expect(
      handlers["script.evaluate"](
        {
          source: "return null;",
          identityMode: "kernel",
        },
        contextFixture([], true),
      ),
    ).rejects.toThrow("only Blast's local identity");
    expect(createRunCalls).toBe(0);
  });

  test("cancels while resident startup is pending and observes its late rejection", async () => {
    const controller = new AbortController();
    let rejectStartup!: (error: Error) => void;
    const statePromise = new Promise<BlastServiceState>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const handlers = createBlastToolHandlers(statePromise, adapterFixture());
    const pending = handlers["blast.identity"](
      {},
      {
        ...contextFixture(),
        signal: controller.signal,
      },
    );

    controller.abort(new Error("cancel during Blast startup"));
    await expect(pending).rejects.toThrow("cancel during Blast startup");
    rejectStartup(new Error("late startup failure"));
    await Promise.resolve();
  });

  test("cancels the read-only saved-script preflight and observes its late rejection", async () => {
    const controller = new AbortController();
    let rejectQuery!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const kernel = {
      querySelf: async () =>
        await new Promise((_resolve, reject) => {
          rejectQuery = reject;
          markStarted();
        }),
    } as unknown as ScopedKernelClient;
    const handlers = createBlastToolHandlers(
      Promise.resolve(stateFixture(clientFixture())),
      adapterFixture(),
    );
    const pending = handlers["script.run"](
      { id: "1", revision: "1", digest: "a".repeat(64) },
      {
        ...contextFixture(),
        kernel,
        signal: controller.signal,
      },
    );
    await started;
    controller.abort(new Error("cancel saved-script preflight"));
    await expect(pending).rejects.toThrow("cancel saved-script preflight");
    rejectQuery(new Error("late read failure"));
    await Promise.resolve();
  });

  test("turns post-update accounting failure into a durable unknown outcome", async () => {
    const running = runFixture("running", []);
    let terminalSummary: JsonValue = null;
    let beginInput: unknown;
    let settleInput: unknown;
    let checkpointAcknowledgements: readonly string[] | undefined;
    const database = {
      createRun: async () => running,
      beginRunCall: async (_handle: unknown, input: unknown) => {
        beginInput = input;
        return "update_1";
      },
      settleRunCall: async (_handle: unknown, input: unknown) => {
        settleInput = input;
        throw new Error("IndexedDB settlement failed");
      },
      checkpointRun: async (
        _handle: unknown,
        value: JsonValue,
        revision: number,
        acknowledgedUpdateIds: readonly string[],
      ) => {
        checkpointAcknowledgements = acknowledgedUpdateIds;
        return {
          schema: 1 as const,
          runId: running.id,
          revision: revision + 1,
          sourceDigest: running.source.digest,
          inputCollectionIds: [...running.inputCollectionIds],
          outputCollectionIds: [],
          acknowledgedUpdateIds: [...acknowledgedUpdateIds],
          value,
          serializedBytes: 4,
          updatedAt: 2,
        };
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: string,
        summary: JsonValue,
      ) => {
        terminalSummary = summary;
        return {
          ...running,
          state,
          completedAt: 2,
          summary,
        };
      },
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => ({
        canister: request.canister,
        method: request.method,
        kind: "update",
        identityMode: "local",
        result: { committed: true },
        resultBytes: 18,
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        const result = await host(
          "blast.update",
          { canister: CANISTER, method: "commit", args: [] },
          signal,
        );
        await host("run.checkpoint", { value: null }, signal);
        return result;
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return await blast.update(...);" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "complete",
      result: {
        dispatchStatus: "confirmed",
        resultStatus: "dispatched_result_unknown",
        result: null,
        resultBytes: null,
        retrySafe: false,
      },
    });
    expect(terminalSummary).toMatchObject({
      uncertainCallOutcomeCount: 1,
      uncertainCallOutcomes: [
        {
          dispatchStatus: "confirmed",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          retrySafe: false,
        },
      ],
    });
    expect(beginInput).toMatchObject({
      update: {
        canister: CANISTER,
        method: "commit",
        argumentsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        identityMode: "local",
      },
    });
    expect(settleInput).toMatchObject({
      pendingUpdateId: "update_1",
      updateResolution: "confirmed",
    });
    expect(checkpointAcknowledgements).toEqual([]);
  });

  test("treats a script oneway call as a confirmed effect with no result", async () => {
    const running = runFixture("running", []);
    const complete = { ...runFixture("complete", []), pendingUpdates: [] };
    let beginInput: unknown;
    let settleInput: unknown;
    const database = {
      createRun: async () => running,
      beginRunCall: async (_handle: unknown, input: unknown) => {
        beginInput = input;
        return "oneway_1";
      },
      settleRunCall: async (_handle: unknown, input: unknown) => {
        settleInput = input;
        return running;
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async () => complete,
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => ({
        canister: request.canister,
        method: request.method,
        kind: "oneway",
        identityMode: "local",
        result: null,
        resultBytes: 4,
      }),
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(
        async ({ host }) =>
          await host(
            "blast.update",
            { canister: CANISTER, method: "notify", args: [] },
            new AbortController().signal,
            causality(1),
          ),
      ),
    );

    const output = await handlers["script.evaluate"](
      { source: "return await blast.update(...);" },
      contextFixture(),
    );

    expect(output).toMatchObject({
      state: "complete",
      result: {
        canister: CANISTER,
        method: "notify",
        kind: "oneway",
        identityMode: "local",
        resultStatus: "dispatched_no_result",
        result: null,
        resultBytes: 4,
        dispatchStatus: "confirmed",
        retrySafe: false,
      },
    });
    expect(beginInput).toMatchObject({
      update: {
        canister: CANISTER,
        method: "notify",
        argumentsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        identityMode: "local",
      },
    });
    expect(settleInput).toMatchObject({
      pendingUpdateId: "oneway_1",
      updateResolution: "confirmed",
    });
  });

  test("checkpoints a confirmed oversized update only after evidence settles", async () => {
    const running = { ...runFixture("running", []), checkpointRevision: 0 };
    let checkpointAcknowledgements: readonly string[] = [];
    const database = {
      createRun: async () => running,
      beginRunCall: async () => "update_1",
      settleRunCall: async () => running,
      checkpointRun: async (
        _handle: unknown,
        value: JsonValue,
        revision: number,
        acknowledgedUpdateIds: readonly string[],
      ) => {
        checkpointAcknowledgements = acknowledgedUpdateIds;
        return {
          schema: 1 as const,
          runId: running.id,
          revision: revision + 1,
          sourceDigest: running.source.digest,
          inputCollectionIds: [...running.inputCollectionIds],
          outputCollectionIds: [],
          acknowledgedUpdateIds: [...acknowledgedUpdateIds],
          value,
          serializedBytes: 4,
          updatedAt: 2,
        };
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async () => ({
        ...running,
        state: "complete" as const,
        completedAt: 2,
      }),
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async () => {
        throw new BlastDispatchedCallError({
          canister: CANISTER,
          method: "large_update",
          kind: "update",
          identityMode: "local",
          resultStatus: "result_exceeds_processing_limit",
          resultBytes: BLAST_LIMITS.canisterResultBytes + 1,
          dispatchStatus: "confirmed",
        });
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        const outcome = await host(
          "blast.update",
          { canister: CANISTER, method: "large_update", args: [] },
          signal,
          causality(1),
        );
        await host(
          "run.checkpoint",
          { value: null },
          signal,
          causality(2, [1]),
        );
        return outcome;
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return await blast.update(...);" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "complete",
      result: {
        resultStatus: "result_exceeds_processing_limit",
        dispatchStatus: "confirmed",
        retrySafe: false,
      },
    });
    expect(checkpointAcknowledgements).toEqual(["update_1"]);
  });

  test("surfaces a confirmed update that is newer than the returned checkpoint", async () => {
    const running = { ...runFixture("running", []), checkpointRevision: 0 };
    const attempt = {
      id: "update_after_checkpoint",
      canister: CANISTER,
      method: "commit_after_checkpoint",
      argumentsDigest: "b".repeat(64),
      identityMode: "local" as const,
      startedAt: 1,
      status: "dispatch_confirmed" as const,
    };
    let checkpoint = { value: { cursor: "before-update" } };
    const terminalSummary = {
      retrySafe: false,
      updateEvidence: {
        protocol: 1,
        uncheckpointedUpdateCount: 1,
        callPendingCount: 0,
        dispatchConfirmedCount: 1,
        attempts: [attempt],
      },
    };
    const database = {
      createRun: async () => running,
      checkpointRun: async () => {
        checkpoint = { value: { cursor: "before-update" } };
        return {
          schema: 1 as const,
          runId: running.id,
          revision: 1,
          sourceDigest: running.source.digest,
          inputCollectionIds: [],
          outputCollectionIds: [],
          acknowledgedUpdateIds: [],
          value: checkpoint.value,
          serializedBytes: 26,
          updatedAt: 2,
        };
      },
      beginRunCall: async () => attempt.id,
      settleRunCall: async () => ({
        ...running,
        checkpointRevision: 1,
        pendingUpdates: [attempt],
      }),
      getRun: async () => ({
        ...running,
        checkpointRevision: 1,
        pendingUpdates: [attempt],
      }),
      getCheckpoint: async () => checkpoint,
      transitionRun: async () => ({
        ...running,
        state: "complete" as const,
        completedAt: 3,
        checkpointRevision: 1,
        pendingUpdates: [],
        summary: terminalSummary,
      }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture({
          update: async (request) => ({
            canister: request.canister,
            method: request.method,
            kind: "update",
            identityMode: "local",
            result: { committed: true },
            resultBytes: 18,
          }),
        }),
      }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        await host("run.checkpoint", { value: checkpoint.value }, signal);
        return await host(
          "blast.update",
          {
            canister: CANISTER,
            method: attempt.method,
            args: [],
          },
          signal,
        );
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "checkpoint(); return await update();" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "complete",
      checkpoint: { cursor: "before-update" },
      retrySafe: false,
      pendingUpdateCount: 1,
      summary: {
        retrySafe: false,
        updateEvidence: {
          uncheckpointedUpdateCount: 1,
          dispatchConfirmedCount: 1,
          attempts: [{ id: attempt.id, status: "dispatch_confirmed" }],
        },
      },
    });
    validateToolResult(
      normalizeToolDescriptor({
        name: "script.evaluate",
        ...BLAST_TOOL_DEFINITIONS["script.evaluate"],
      }),
      output,
    );
  });

  test("warns on failure after a confirmed update that lacks a later checkpoint", async () => {
    let stored = runFixture("running", []);
    const attempt = {
      id: "update_1",
      canister: CANISTER,
      method: "commit",
      argumentsDigest: "b".repeat(64),
      identityMode: "local" as const,
      startedAt: 1,
      status: "call_pending" as const,
    };
    const database = {
      createRun: async () => stored,
      beginRunCall: async () => {
        stored = { ...stored, pendingUpdates: [attempt] };
        return attempt.id;
      },
      settleRunCall: async () => {
        stored = {
          ...stored,
          pendingUpdates: [{ ...attempt, status: "dispatch_confirmed" }],
        };
        return stored;
      },
      getRun: async () => stored,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: string,
        summary: JsonValue,
      ) => {
        stored = { ...stored, state: state as RunRecord["state"], summary };
        return stored;
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture({
          update: async (request) => ({
            canister: request.canister,
            method: request.method,
            kind: "update",
            identityMode: "local",
            result: { committed: true },
            resultBytes: 18,
          }),
        }),
      }),
      adapterFixture(async ({ host }) => {
        await host(
          "blast.update",
          { canister: CANISTER, method: "commit", args: [] },
          new AbortController().signal,
        );
        throw new Error("script failed after update");
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "throw new Error('after update');" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "failed",
      summary: {
        error: "script failed after update",
        retrySafe: false,
        updateDispatchConfirmed: true,
        pendingUpdates: [
          {
            id: attempt.id,
            status: "dispatch_confirmed",
          },
        ],
      },
    });
  });

  test("uses the checkpoint's guest receipt snapshot after a queued update settles", async () => {
    const running = { ...runFixture("running", []), checkpointRevision: 0 };
    const checkpointAcknowledgements: string[][] = [];
    let updateNumber = 0;
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondRelease = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const database = {
      createRun: async () => running,
      beginRunCall: async () => `update_${++updateNumber}`,
      settleRunCall: async () => running,
      checkpointRun: async (
        _handle: unknown,
        value: JsonValue,
        revision: number,
        acknowledgedUpdateIds: readonly string[],
      ) => {
        checkpointAcknowledgements.push([...acknowledgedUpdateIds]);
        return {
          schema: 1 as const,
          runId: running.id,
          revision: revision + 1,
          sourceDigest: running.source.digest,
          inputCollectionIds: [...running.inputCollectionIds],
          outputCollectionIds: [],
          acknowledgedUpdateIds: checkpointAcknowledgements.flat(),
          value,
          serializedBytes: 4,
          updatedAt: 2,
        };
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async () => ({
        ...running,
        state: "complete" as const,
        completedAt: 2,
      }),
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => {
        if (request.method === "second") {
          markSecondStarted();
          await secondRelease;
        }
        return {
          canister: request.canister,
          method: request.method,
          kind: "update",
          identityMode: "local",
          result: null,
          resultBytes: 4,
        };
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        await host(
          "blast.update",
          { canister: CANISTER, method: "first", args: [] },
          signal,
          causality(1),
        );
        await host(
          "run.checkpoint",
          { value: { step: 1 } },
          signal,
          causality(2, [1]),
        );

        const second = host(
          "blast.update",
          { canister: CANISTER, method: "second", args: [] },
          signal,
          causality(3, [1, 2]),
        );
        await secondStarted;
        // The Worker issued this request before receiving update_2's response.
        // Preserve that immutable receipt snapshot even though dispatch below
        // is deliberately delayed until after update_2 has settled durably.
        const queuedCheckpointCausality = causality(4, [1, 2]);
        releaseSecond();
        await second;
        await host(
          "run.checkpoint",
          { value: { step: 2 } },
          signal,
          queuedCheckpointCausality,
        );
        await host(
          "run.checkpoint",
          { value: { step: 3 } },
          signal,
          causality(5, [1, 2, 3, 4]),
        );
        return null;
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return null;" },
      contextFixture(),
    );
    expect(output).toMatchObject({ state: "complete" });
    expect(checkpointAcknowledgements).toEqual([
      ["update_1"],
      [],
      ["update_2"],
    ]);
  });

  test("cancels after the script returns but before durable completion", async () => {
    const controller = new AbortController();
    const running = runFixture("running", []);
    const transitions: string[] = [];
    const database = {
      createRun: async () => running,
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async (_handle: unknown, state: string) => {
        transitions.push(state);
        return {
          ...running,
          state: state as RunRecord["state"],
          completedAt: 2,
        };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(async () => {
        controller.abort(new Error("cancelled after script return"));
        return { late: true };
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return { late: true };" },
      { ...contextFixture(), signal: controller.signal },
    );
    expect(output).toMatchObject({ state: "cancelled", result: null });
    expect(transitions).toEqual(["cancelled"]);
  });

  test("bounds a max-evidence failure summary without losing retry-safety facts", async () => {
    const pendingUpdates = Array.from({ length: 8 }, (_, index) => ({
      id: `${index}`.padEnd(160, "u"),
      canister: "c".repeat(63),
      method: '"'.repeat(192),
      argumentsDigest: `${index.toString(16)}`.padEnd(64, "a"),
      identityMode: "local" as const,
      startedAt: index + 1,
      status:
        index === 0
          ? ("call_pending" as const)
          : ("dispatch_confirmed" as const),
    }));
    const running = { ...runFixture("running", []), pendingUpdates };
    let terminalSummary: JsonObject | null = null;
    const database = {
      createRun: async () => running,
      beginRunCall: async () => null,
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: string,
        summary: JsonObject,
      ) => {
        assertBoundedBlastJson(
          summary,
          "Run summary",
          BLAST_LIMITS.collectionSummaryBytes,
        );
        terminalSummary = summary;
        return {
          ...running,
          state: state as RunRecord["state"],
          completedAt: 2,
          summary,
        };
      },
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => {
        throw new BlastDispatchedCallError({
          canister: request.canister,
          method: request.method,
          kind: "update",
          identityMode: "local",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
        });
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        for (let index = 0; index < 16; index += 1) {
          await host(
            "blast.update",
            {
              canister: CANISTER,
              method: '"'.repeat(192),
              args: [],
            },
            signal,
          );
        }
        throw new Error("界".repeat(1_000));
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "throw new Error('maximum evidence');" },
      contextFixture(),
    );
    expect(output).toMatchObject({ state: "failed", result: null });
    expect(terminalSummary).not.toBeNull();
    expect(jsonBytes(terminalSummary!)).toBeLessThanOrEqual(
      BLAST_LIMITS.collectionSummaryBytes,
    );
    expect(terminalSummary).toMatchObject({
      retrySafe: false,
      pendingUpdateCount: 8,
      updateOutcomeUnknown: true,
      uncertainCallOutcomeCount: 16,
    });
    expect(
      terminalSummary!.pendingUpdatesTruncated === true ||
        terminalSummary!.uncertainCallOutcomesTruncated === true,
    ).toBe(true);
    const includedPending = terminalSummary!.pendingUpdates as JsonObject[];
    expect(includedPending.map((attempt) => attempt.id)).toEqual(
      pendingUpdates
        .slice(0, includedPending.length)
        .map((attempt) => attempt.id),
    );
  });

  test("bounds a successful run summary with maximum uncertain call evidence", async () => {
    const running = runFixture("running", []);
    let terminalSummary: JsonObject | null = null;
    const database = {
      createRun: async () => running,
      beginRunCall: async () => null,
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: string,
        summary: JsonObject,
      ) => {
        assertBoundedBlastJson(
          summary,
          "Run summary",
          BLAST_LIMITS.collectionSummaryBytes,
        );
        terminalSummary = summary;
        return {
          ...running,
          state: state as RunRecord["state"],
          completedAt: 2,
          summary,
        };
      },
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => {
        throw new BlastDispatchedCallError({
          canister: request.canister,
          method: request.method,
          kind: "update",
          identityMode: "local",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
        });
      },
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapterFixture(async ({ host }) => {
        const signal = new AbortController().signal;
        const outcomes: JsonValue[] = [];
        for (let index = 0; index < 16; index += 1) {
          outcomes.push(
            await host(
              "blast.update",
              {
                canister:
                  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
                method: "💥".repeat(192),
                args: [],
              },
              signal,
            ),
          );
        }
        expect(
          jsonBytes({
            uncertainCallOutcomeCount: outcomes.length,
            uncertainCallOutcomes: outcomes,
            uncertainCallOutcomesTruncated: false,
          }),
        ).toBeGreaterThan(BLAST_LIMITS.collectionSummaryBytes);
        return { complete: true };
      }),
    );

    const output = await handlers["script.evaluate"](
      { source: "return { complete: true };" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "complete",
      retrySafe: false,
      result: { complete: true },
    });
    expect(terminalSummary).not.toBeNull();
    expect(jsonBytes(terminalSummary!)).toBeLessThanOrEqual(
      BLAST_LIMITS.collectionSummaryBytes,
    );
    expect(terminalSummary).toMatchObject({ uncertainCallOutcomeCount: 16 });
    const retainedOutcomes = terminalSummary!
      .uncertainCallOutcomes as JsonObject[];
    expect(
      retainedOutcomes.length === 16
        ? !Object.hasOwn(terminalSummary!, "uncertainCallOutcomesTruncated")
        : terminalSummary!.uncertainCallOutcomesTruncated === true,
    ).toBe(true);
  });

  test("lists durable runs and returns checkpoints without session capabilities", async () => {
    const run = {
      ...runFixture("complete", ["collection_output"]),
      identity: null,
    };
    const listEntry = {
      id: run.id,
      source: run.source,
      state: run.state,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      deadlineAt: run.deadlineAt,
      identity: run.identity,
      counters: run.counters,
      checkpointRevision: run.checkpointRevision,
      inputCollectionCount: run.inputCollectionIds.length,
      outputCollectionCount: run.outputCollectionIds.length,
      pendingUpdateCount: run.pendingUpdates.length,
    };
    const checkpoint = {
      schema: 1 as const,
      runId: run.id,
      revision: 1,
      sourceDigest: run.source.digest,
      inputCollectionIds: [...run.inputCollectionIds],
      outputCollectionIds: [...run.outputCollectionIds],
      acknowledgedUpdateIds: [],
      value: { cursor: "resume" },
      serializedBytes: 19,
      updatedAt: 2,
    };
    const database = {
      listRuns: async () => ({ runs: [listEntry], cursor: null }),
      getRunSnapshot: async () => ({ run, checkpoint }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );

    const listed = await handlers["run.list"]({}, contextFixture());
    const fetched = await handlers["run.get"]({ id: run.id }, contextFixture());
    expect(JSON.stringify([listed, fetched])).not.toContain("sessionId");
    validateToolResult(
      normalizeToolDescriptor({
        name: "run.list",
        ...BLAST_TOOL_DEFINITIONS["run.list"],
      }),
      listed,
    );
    const runGetDescriptor = normalizeToolDescriptor({
      name: "run.get",
      ...BLAST_TOOL_DEFINITIONS["run.get"],
    });
    validateToolResult(runGetDescriptor, fetched);
    const fetchedObject = fetched as JsonObject;
    const fetchedRun = fetchedObject.run as JsonObject;
    expect(() =>
      validateToolResult(runGetDescriptor, {
        ...fetchedObject,
        run: {
          ...fetchedRun,
          pendingUpdates: [
            {
              id: "update_1",
              canister: CANISTER,
              method: "write",
              argumentsDigest: "a".repeat(64),
              identityMode: "kernel",
              startedAt: 1,
              status: "call_pending",
            },
          ],
        },
      }),
    ).toThrow();
  });

  test("exposes exact terminal-run cleanup with explicit evidence acknowledgement", async () => {
    const calls: Array<{ id: string; acknowledge: boolean }> = [];
    const database = {
      deleteRun: async (id: string, acknowledge: boolean) => {
        calls.push({ id, acknowledge });
        return {
          id,
          status: "deleted" as const,
          unresolvedUpdateCount: acknowledge ? 1 : 0,
        };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );
    const descriptor = normalizeToolDescriptor({
      name: "run.delete",
      ...BLAST_TOOL_DEFINITIONS["run.delete"],
    });
    validateToolArguments(descriptor, { id: "run_safe" });
    validateToolArguments(descriptor, {
      id: "run_evidence",
      acknowledgeUnresolvedUpdates: true,
    });
    expect(() =>
      validateToolArguments(descriptor, {
        id: "run_evidence",
        acknowledgeUnresolvedUpdates: "yes",
      }),
    ).toThrow();

    const safe = await handlers["run.delete"](
      { id: "run_safe" },
      contextFixture(),
    );
    const acknowledged = await handlers["run.delete"](
      { id: "run_evidence", acknowledgeUnresolvedUpdates: true },
      contextFixture(),
    );
    expect(calls).toEqual([
      { id: "run_safe", acknowledge: false },
      { id: "run_evidence", acknowledge: true },
    ]);
    validateToolResult(descriptor, safe);
    validateToolResult(descriptor, acknowledged);
  });

  test("projects retained v0.1.0 values through current tool boundaries", async () => {
    let retainedValue: JsonValue = null;
    for (let index = 0; index < BLAST_STORED_V1_JSON_LIMITS.depth; index += 1) {
      retainedValue = [retainedValue];
    }
    const retainedBytes = new TextEncoder().encode(
      JSON.stringify(retainedValue),
    ).byteLength;
    const collection: CollectionRecord = {
      ...collectionFixture(),
      state: "complete",
      source: {
        canister: CANISTER,
        method: "legacy\nmethod",
        argumentsDigest: "a".repeat(64),
      },
      summary: retainedValue,
    };
    const running: RunRecord = {
      ...runFixture("running", []),
      id: "run_legacy_pending",
      pendingUpdates: [
        {
          id: "update_legacy",
          canister: CANISTER,
          method: "legacy\u007fmethod",
          argumentsDigest: "b".repeat(64),
          identityMode: "local",
          startedAt: 1,
          status: "call_pending",
        },
      ],
    };
    const terminal: RunRecord = {
      ...runFixture("complete", []),
      id: "run_legacy_summary",
      summary: {
        retrySafe: false,
        updateEvidence: {
          protocol: 1,
          uncheckpointedUpdateCount: 1,
          callPendingCount: 1,
          dispatchConfirmedCount: 0,
          attempts: [
            {
              id: "update_terminal_legacy",
              canister: CANISTER,
              method: "legacy\nterminal",
              argumentsDigest: "d".repeat(64),
              identityMode: "local",
              startedAt: 1,
              status: "call_pending",
            },
          ],
        },
      },
    };
    const checkpoint = (run: RunRecord) => ({
      schema: 1 as const,
      runId: run.id,
      revision: 1,
      sourceDigest: run.source.digest,
      inputCollectionIds: [...run.inputCollectionIds],
      outputCollectionIds: [...run.outputCollectionIds],
      acknowledgedUpdateIds: [],
      value: retainedValue,
      serializedBytes: retainedBytes,
      updatedAt: run.updatedAt,
    });
    const database = {
      describeCollection: async () => ({
        collection,
        pages: [
          {
            schema: 1 as const,
            collectionId: collection.id,
            sequence: 0,
            digest: "c".repeat(64),
            value: retainedValue,
            itemCount: 1,
            serializedBytes: retainedBytes,
            createdAt: 1,
          },
        ],
        cursor: null,
        serializedBytes: retainedBytes,
        oversizedPage: null,
      }),
      getRunSnapshot: async (id: string) => {
        const run = id === running.id ? running : terminal;
        return { run, checkpoint: checkpoint(run) };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(),
    );
    const omitted = {
      $blastStoredV1: "stored_v1_json_outside_current_limits",
      serializedBytes: retainedBytes,
    };

    const described = await handlers["collection.describe"](
      { id: collection.id },
      contextFixture(),
    );
    expect(described).toMatchObject({
      collection: {
        source: {
          canister: CANISTER,
          method: null,
          methodStatus: "stored_v1_method_outside_current_policy",
          legacyMethodUtf8Hex: "6c65676163790a6d6574686f64",
          argumentsDigest: "a".repeat(64),
        },
        summary: omitted,
      },
      pages: [{ value: omitted }],
      sampleStatus: "stored_v1_value_omitted",
    });
    const describeDescriptor = normalizeToolDescriptor({
      name: "collection.describe",
      ...BLAST_TOOL_DEFINITIONS["collection.describe"],
    });
    validateToolResult(describeDescriptor, described);
    expect(() =>
      assertBoundedJson(described, "Blast tool result"),
    ).not.toThrow();

    const pending = await handlers["run.get"](
      { id: running.id },
      contextFixture(),
    );
    expect(pending).toMatchObject({
      run: {
        pendingUpdates: [
          {
            method: null,
            methodStatus: "stored_v1_method_outside_current_policy",
            legacyMethodUtf8Hex: "6c65676163797f6d6574686f64",
          },
        ],
      },
      checkpoint: { value: omitted },
    });
    const terminalOutput = await handlers["run.get"](
      { id: terminal.id },
      contextFixture(),
    );
    expect(terminalOutput).toMatchObject({
      run: {
        summary: {
          updateEvidence: {
            attempts: [
              {
                method: null,
                methodStatus: "stored_v1_method_outside_current_policy",
                legacyMethodUtf8Hex: "6c65676163790a7465726d696e616c",
              },
            ],
          },
        },
      },
      checkpoint: { value: omitted },
    });
    const runDescriptor = normalizeToolDescriptor({
      name: "run.get",
      ...BLAST_TOOL_DEFINITIONS["run.get"],
    });
    for (const output of [pending, terminalOutput]) {
      validateToolResult(runDescriptor, output);
      expect(() =>
        assertBoundedJson(output, "Blast tool result"),
      ).not.toThrow();
    }
  });

  test("records a cancelled collection query instead of completing after abort", async () => {
    const controller = new AbortController();
    const expression = "😀".repeat(10_000);
    const running = runFixture("running", []);
    const transitions: string[] = [];
    const database = {
      createRun: async () => running,
      readPages: async () => ({
        pages: [{ value: { id: 1 } }],
        cursor: null,
        serializedBytes: 8,
      }),
      getRun: async () => running,
      transitionRun: async (_handle: unknown, state: string) => {
        transitions.push(state);
        return { ...running, state };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      {
        ...adapterFixture(),
        runJsonataQuery: async () => {
          controller.abort(new Error("cancelled during query"));
          return { id: 1 };
        },
      },
    );

    validateToolArguments(
      normalizeToolDescriptor({
        name: "collection.query",
        ...BLAST_TOOL_DEFINITIONS["collection.query"],
      }),
      { id: "collection_input", expression },
    );
    await expect(
      handlers["collection.query"](
        { id: "collection_input", expression },
        { ...contextFixture(), signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled during query");
    expect(transitions).toEqual(["cancelled"]);
  });

  test("keeps a large JSONata value and its cursor inside Agent's result envelope", async () => {
    const running = runFixture("running", []);
    const itemCount = Math.floor((BLAST_LIMITS.jsonataOutputBytes - 2) / 2);
    const value = Array.from({ length: itemCount }, () => 0);
    const database = {
      createRun: async () => running,
      readPages: async () => ({
        pages: [{ value: null }],
        cursor: null,
        serializedBytes: 4,
      }),
      transitionRun: async () => ({
        ...running,
        state: "complete" as const,
        completedAt: 3,
        updatedAt: 3,
      }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      { ...adapterFixture(), runJsonataQuery: async () => value },
    );

    const output = await handlers["collection.query"](
      { id: "collection_input", expression: "$" },
      contextFixture(),
    );

    expect(() => assertBoundedJson(output, "Blast tool result")).not.toThrow();
    expect(jsonBytes(output)).toBeLessThan(192 * 1_024);
    validateToolResult(
      normalizeToolDescriptor({
        name: "collection.query",
        ...BLAST_TOOL_DEFINITIONS["collection.query"],
      }),
      output,
    );
  });

  test("reports an oversized describe sample and directs JSONata to streaming scripts", async () => {
    const collection = collectionFixture();
    const running = runFixture("running", []);
    const transitions: string[] = [];
    let queryWorkerCalls = 0;
    const database = {
      describeCollection: async () => ({
        collection,
        pages: [],
        cursor: "0",
        serializedBytes: 0,
        oversizedPage: {
          sequence: 0,
          serializedBytes: 200_000,
          maximumBytes: 114_688,
        },
      }),
      createRun: async () => running,
      readPages: async () => {
        throw new BlastPageReadLimitError(0, 2_097_152, 2_093_056);
      },
      getRun: async () => running,
      transitionRun: async (
        _handle: unknown,
        state: string,
        summary: JsonValue,
      ) => {
        transitions.push(state);
        return { ...running, state, completedAt: 2, summary };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      {
        ...adapterFixture(),
        runJsonataQuery: async () => {
          queryWorkerCalls += 1;
          return null;
        },
      },
    );

    const described = await handlers["collection.describe"](
      { id: collection.id },
      contextFixture(),
    );
    expect(described).toMatchObject({
      pages: [],
      cursor: "0",
      sampleStatus: "page_too_large",
      omittedPage: {
        sequence: 0,
        serializedBytes: 200_000,
        maximumBytes: 114_688,
      },
    });
    const describeDescriptor = normalizeToolDescriptor({
      name: "collection.describe",
      ...BLAST_TOOL_DEFINITIONS["collection.describe"],
    });
    validateToolResult(describeDescriptor, described);
    const describedObject = described as JsonObject;
    const describedCollection = describedObject.collection as JsonObject;
    expect(() =>
      validateToolResult(describeDescriptor, {
        ...describedObject,
        collection: { ...describedCollection, identity: null },
      }),
    ).toThrow();
    expect(() =>
      validateToolResult(describeDescriptor, {
        ...describedObject,
        collection: {
          ...describedCollection,
          identity: { mode: "kernel", principal: null },
        },
      }),
    ).toThrow();

    await expect(
      handlers["collection.query"](
        { id: collection.id, expression: "$" },
        contextFixture(),
      ),
    ).rejects.toThrow("use script.evaluate or script.run");
    expect(queryWorkerCalls).toBe(0);
    expect(transitions).toEqual(["failed"]);
  });

  test("returns the script's local public identity without leaking its key", async () => {
    const invoke = async () => {
      const running = {
        ...runFixture("running", []),
        identity: { mode: "local" as const, principal: IDENTITY.principal },
      };
      const complete = {
        ...running,
        state: "complete" as const,
        completedAt: 2,
      };
      const database = {
        createRun: async () => running,
        getRun: async () => running,
        transitionRun: async () => complete,
        getCheckpoint: async () => null,
      } as unknown as BlastDatabase;
      const handlers = createBlastToolHandlers(
        Promise.resolve({
          database,
          identity: IDENTITY,
          icblast: clientFixture(),
        }),
        adapterFixture(
          async ({ host }) =>
            await host("blast.identity", {}, new AbortController().signal),
        ),
      );
      return (await handlers["script.evaluate"](
        { source: "return await blast.identity();", identityMode: "local" },
        contextFixture(),
      )) as JsonObject;
    };

    expect((await invoke()).result).toEqual({
      mode: "local",
      slot: 0,
      principal: IDENTITY.principal,
      createdAt: IDENTITY.createdAt,
      publicKeyFingerprint: IDENTITY.publicKeyFingerprint,
    });
  });

  test("adopts an expiry sweep's interrupted run instead of forcing a second transition", async () => {
    const running = runFixture("running", []);
    const interrupted = {
      ...running,
      state: "interrupted" as const,
      completedAt: 2,
      summary: { error: "Run deadline elapsed" },
    };
    let transitions = 0;
    const database = {
      createRun: async () => running,
      getRun: async () => interrupted,
      getCheckpoint: async () => null,
      transitionRun: async () => {
        transitions += 1;
        throw new Error("late transition must not run");
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(async () => ({ late: true })),
    );

    const output = await handlers["script.evaluate"](
      { source: "return { late: true };" },
      contextFixture(),
    );
    expect(output).toMatchObject({
      state: "interrupted",
      result: null,
      summary: { error: "Run deadline elapsed" },
    });
    expect(transitions).toBe(0);
  });

  test("routes script host work through the run identity and collection grants", async () => {
    const progress: JsonValue[] = [];
    const createdInputs: unknown[] = [];
    const appendedValues: JsonValue[] = [];
    const calls: string[] = [];
    const largeResult = "x".repeat(BLAST_LIMITS.inlineCallResultBytes + 1);
    const collection = collectionFixture();
    const running = runFixture("running", []);
    const complete = runFixture("complete", [collection.id]);
    const database = {
      createRun: async (input: unknown) => {
        createdInputs.push(input);
        return running;
      },
      createCollection: async (input: unknown) => {
        createdInputs.push(input);
        return collection;
      },
      append: async (input: { value: JsonValue }) => {
        appendedValues.push(input.value);
        return {
          status: "written",
          sequence: 0,
          digest: "2".repeat(64),
          itemCount: 1,
          serializedBytes: 10,
        };
      },
      completeCollection: async () => ({ ...collection, state: "complete" }),
      checkpointRun: async (
        _handle: unknown,
        _value: unknown,
        revision: number,
        acknowledgedUpdateIds: readonly string[],
      ) => ({
        schema: 1,
        runId: running.id,
        revision: revision + 1,
        sourceDigest: "3".repeat(64),
        inputCollectionIds: ["collection_input"],
        outputCollectionIds: [collection.id],
        acknowledgedUpdateIds: [...acknowledgedUpdateIds],
        value: { cursor: "next" },
        serializedBytes: 17,
        updatedAt: 2,
      }),
      beginRunCall: async () => undefined,
      settleRunCall: async () => complete,
      transitionRun: async () => complete,
      getCheckpoint: async () => ({ value: { cursor: "next" } }),
      getRun: async () => ({
        ...running,
        outputCollectionIds: [collection.id],
      }),
      getCollection: async () => ({ ...collection, state: "complete" }),
    } as unknown as BlastDatabase;
    const icblast = clientFixture({
      update: async (request) => {
        calls.push(`${request.identityMode}:${request.method}`);
        return {
          canister: request.canister,
          method: request.method,
          kind: "update",
          identityMode: request.identityMode ?? "local",
          result: largeResult,
          resultBytes: new TextEncoder().encode(JSON.stringify(largeResult))
            .byteLength,
        };
      },
    });
    const adapters = adapterFixture(async ({ host }) => {
      const signal = new AbortController().signal;
      const call = (await host(
        "blast.update",
        { canister: CANISTER, method: "mutate", args: [] },
        signal,
      )) as JsonObject;
      const created = (await host(
        "collections.create",
        {
          name: "Derived",
          kind: "derived",
          sourceCollectionIds: ["collection_input"],
        },
        signal,
      )) as JsonObject;
      await host(
        "collections.append",
        { id: created.id!, value: call.result!, key: "page-1" },
        signal,
      );
      await host("run.checkpoint", { value: { cursor: "next" } }, signal);
      await host("run.progress", { value: { pages: 1 } }, signal);
      await host(
        "collections.complete",
        { id: created.id!, summary: { pages: 1 } },
        signal,
      );
      return { done: true };
    });
    const handlers = createBlastToolHandlers(
      Promise.resolve({ database, identity: IDENTITY, icblast }),
      adapters,
    );
    const output = await handlers["script.evaluate"](
      {
        source: "return { done: true };",
        args: { start: true },
        identityMode: "local",
        timeoutMs: 1_000,
        inputCollectionIds: ["collection_input"],
      },
      contextFixture(progress),
    );

    expect(calls).toEqual(["local:mutate"]);
    expect(appendedValues).toEqual([largeResult]);
    expect(createdInputs[0]).toMatchObject({
      inputCollectionIds: ["collection_input"],
      identity: { mode: "local", principal: IDENTITY.principal },
    });
    expect(createdInputs[1]).toMatchObject({
      kind: "derived",
      sourceCollectionIds: ["collection_input"],
      identity: { mode: "local", principal: IDENTITY.principal },
      run: { runId: running.id, sessionId: running.sessionId },
    });
    expect(output).toMatchObject({
      runId: running.id,
      state: "complete",
      result: { done: true },
      collectionIds: [collection.id],
      checkpoint: { cursor: "next" },
      calls: 1,
    });
    expect(progress).toEqual([
      { phase: "started", runId: running.id },
      { runId: running.id, value: { pages: 1 } },
      { phase: "complete", runId: running.id },
    ]);
    validateToolResult(
      normalizeToolDescriptor({
        name: "script.evaluate",
        ...BLAST_TOOL_DEFINITIONS["script.evaluate"],
      }),
      output,
    );
  });

  test("recovers a committed script result through durable completion evidence", async () => {
    const args = { page: 7, filters: { status: "open" } };
    const result = { proposals: [3, 5, 8] };
    let stored: RunRecord = {
      ...runFixture("running", []),
      checkpointRevision: 0,
    };
    const database = {
      createRun: async () => stored,
      getRun: async () => stored,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: RunRecord["state"],
        summary: JsonValue,
      ) => {
        stored = {
          ...stored,
          state,
          updatedAt: 3,
          completedAt: 3,
          summary,
        };
        return stored;
      },
      getRunSnapshot: async () => ({ run: stored, checkpoint: null }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(async () => result),
    );

    await handlers["script.evaluate"](
      { source: "return { proposals: [3, 5, 8] };", args },
      contextFixture(),
    );
    const fetched = (await handlers["run.get"](
      { id: stored.id },
      contextFixture(),
    )) as JsonObject;
    const fetchedRun = fetched.run as JsonObject;
    expect(fetchedRun.summary).toMatchObject({
      completionEvidence: {
        protocol: 1,
        argumentsDigest: await sha256Hex(canonicalJson(args)),
        resultDigest: await sha256Hex(canonicalJson(result)),
        resultBytes: jsonBytes(result),
        resultStatus: "stored",
        result,
      },
    });
    validateToolResult(
      normalizeToolDescriptor({
        name: "run.get",
        ...BLAST_TOOL_DEFINITIONS["run.get"],
      }),
      fetched,
    );
  });

  test("retains a result digest when the exact result does not fit run history", async () => {
    const result = "x".repeat(BLAST_LIMITS.collectionSummaryBytes);
    const running = { ...runFixture("running", []), checkpointRevision: 0 };
    let terminalSummary: JsonObject | null = null;
    const database = {
      createRun: async () => running,
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async (
        _handle: unknown,
        state: RunRecord["state"],
        summary: JsonObject,
      ) => {
        terminalSummary = summary;
        return {
          ...running,
          state,
          updatedAt: 3,
          completedAt: 3,
          summary,
        };
      },
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(async () => result),
    );

    await handlers["script.evaluate"](
      { source: "return input;", args: null },
      contextFixture(),
    );

    expect(terminalSummary).toMatchObject({
      completionEvidence: {
        protocol: 1,
        argumentsDigest: await sha256Hex("null"),
        resultDigest: await sha256Hex(canonicalJson(result)),
        resultBytes: jsonBytes(result),
        resultStatus: "digest_only",
      },
    });
    expect(
      terminalSummary!.completionEvidence as JsonObject,
    ).not.toHaveProperty("result");
  });

  test("lets a script read a maximum-sized stored page", async () => {
    const value = "x".repeat(BLAST_LIMITS.collectionPageBytes - 2);
    const running = runFixture("running", []);
    let observedMaxBytes = 0;
    let observedMaxNodes = 0;
    const database = {
      createRun: async () => running,
      readPages: async (
        _id: string,
        options: { maxBytes: number; maxNodes: number },
      ) => {
        observedMaxBytes = options.maxBytes;
        observedMaxNodes = options.maxNodes;
        return {
          pages: [{ value }],
          cursor: null,
          serializedBytes: BLAST_LIMITS.collectionPageBytes,
        };
      },
      getRun: async () => running,
      getCheckpoint: async () => null,
      transitionRun: async () => ({
        ...running,
        state: "complete",
        completedAt: 2,
      }),
    } as unknown as BlastDatabase;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      adapterFixture(async ({ host }) => {
        const page = (await host(
          "collections.pages",
          { id: "collection_input", limit: 1 },
          new AbortController().signal,
        )) as JsonObject;
        const values = page.values as JsonValue[];
        return { valueCharacters: (values[0] as string).length };
      }),
    );

    const output = await handlers["script.evaluate"](
      {
        source: "return await collections.pages(...);",
        inputCollectionIds: ["collection_input"],
      },
      contextFixture(),
    );

    expect(observedMaxBytes).toBe(BLAST_LIMITS.collectionPageBytes);
    expect(observedMaxNodes).toBe(BLAST_STORED_V1_JSON_LIMITS.nodes);
    expect(output).toMatchObject({
      state: "complete",
      result: { valueCharacters: value.length },
    });
  });

  test("storage status never requests persistence", async () => {
    let persistCalls = 0;
    const database = {
      logicalStorageStatus: async () => ({
        collectionCount: 2,
        deletingCollectionCount: 1,
        pageCount: 3,
        itemCount: 4,
        serializedBytes: 5,
        runningRunCount: 1,
      }),
    } as unknown as BlastDatabase;
    const storage = {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => true,
      persist: async () => {
        persistCalls += 1;
        return true;
      },
    } as StorageManager;
    const handlers = createBlastToolHandlers(
      Promise.resolve({
        database,
        identity: IDENTITY,
        icblast: clientFixture(),
      }),
      { ...adapterFixture(), storageManager: () => storage },
    );

    const output = await handlers["storage.status"]({}, contextFixture());
    expect(output).toEqual({
      logical: {
        collections: 2,
        pages: 3,
        items: 4,
        serializedBytes: 5,
        deletingCollections: 1,
        runningRuns: 1,
      },
      origin: { usage: 10, quota: 100, persisted: true },
    });
    expect(persistCalls).toBe(0);
  });
});

function stateFixture(icblast: BlastIcblastClient): BlastServiceState {
  return {
    database: {} as BlastDatabase,
    identity: IDENTITY,
    icblast,
  };
}

function clientFixture(
  overrides: Partial<BlastIcblastClient> = {},
): BlastIcblastClient {
  const callResult: BlastCallResult = {
    canister: CANISTER,
    method: "method",
    kind: "query",
    identityMode: "local",
    result: null,
    resultBytes: 4,
  };
  return {
    scan: async (canister) => ({ canister, methods: [] }),
    schema: async (canister, method) => ({
      canister,
      method,
      kind: "query",
      schema: { input: {}, output: {} },
    }),
    validateInput: async (canister, method) => ({
      canister,
      method,
      kind: "query",
      valid: true,
      errors: null,
    }),
    query: async () => callResult,
    update: async () => ({ ...callResult, kind: "update" }),
    ...overrides,
  };
}

function adapterFixture(
  script?: BlastServiceAdapters["runScript"],
): BlastServiceAdapters {
  return {
    runScript:
      script ??
      (async () => {
        throw new Error("Unexpected script execution");
      }),
    runJsonataQuery: async (_expression, input) => input,
    now: () => 1_000,
    storageManager: () => null,
  };
}

function contextFixture(
  progress: JsonValue[] = [],
  agentMode?: boolean,
): MsgBusToolContext {
  return {
    reportProgress: (value) => progress.push(value),
    kernel: KERNEL,
    ...(agentMode === undefined ? {} : { agentMode }),
  };
}

function runFixture(
  state: RunRecord["state"],
  outputCollectionIds: string[],
): RunRecord {
  return {
    schema: 1,
    id: "run_1",
    sessionId: "session_1",
    source: { kind: "temporary", digest: "3".repeat(64) },
    state,
    startedAt: 1,
    updatedAt: 2,
    completedAt: state === "running" ? null : 2,
    deadlineAt: 10_000,
    inputCollectionIds: ["collection_input"],
    outputCollectionIds,
    identity: { mode: "local", principal: IDENTITY.principal },
    counters: {
      callCount: 1,
      requestBytes: 1,
      responseBytes: 2,
      pageReadCount: 0,
      pageWriteCount: 1,
      readBytes: 0,
      writeBytes: 10,
    },
    pendingUpdates: [],
    checkpointRevision: 1,
    summary: null,
  };
}

function collectionFixture(): CollectionRecord {
  return {
    schema: 1,
    id: "collection_output",
    creationNonce: "nonce_1",
    name: "Derived",
    description: null,
    state: "open",
    kind: "derived",
    createdAt: 1,
    updatedAt: 1,
    nextSequence: 0,
    pageCount: 0,
    itemCount: 0,
    serializedBytes: 0,
    producer: null,
    identity: { mode: "local", principal: IDENTITY.principal },
    source: null,
    sourceCollectionIds: ["collection_input"],
    summary: null,
  };
}
