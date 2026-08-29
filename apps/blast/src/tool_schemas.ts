import {
  NEUTRON_TOOL_AUDIT_METADATA_ONLY,
  type ExposedToolOptions,
  type JsonObject,
} from "neutron-tools/app";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "./limits.ts";
import {
  BLAST_COLLECTION_LIMIT,
  BLAST_PENDING_UPDATE_LIMIT,
  BLAST_RUN_BUDGETS,
} from "./database.ts";
import { BLAST_METHOD_CONTROL_PATTERN_SOURCE } from "./json.ts";

type ToolEffect =
  "network" | "read" | "signature_request" | "user_visible_ui" | "write";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const COLLECTION_ID_PATTERN = "^[A-Za-z0-9._:-]{1,160}$";
const DIGEST_PATTERN = "^[a-f0-9]{64}$";
const LONE_SURROGATE_PATTERN = "[\\uD800-\\uDFFF]";
const SCRIPT_METADATA_CONTROL_PATTERN =
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\uD800-\\uDFFF]";

function positiveDecimalBranches(maximum: string): JsonObject[] {
  const branches: JsonObject[] = [
    {
      type: "string",
      pattern: `^[1-9][0-9]{0,${maximum.length - 2}}$`,
    },
  ];
  for (let index = 0; index < maximum.length; index += 1) {
    const upper = Number(maximum[index]!) - 1;
    const lower = index === 0 ? 1 : 0;
    if (upper < lower) continue;
    const digit = lower === upper ? String(lower) : `[${lower}-${upper}]`;
    const remaining = maximum.length - index - 1;
    branches.push({
      type: "string",
      pattern: `^${maximum.slice(0, index)}${digit}${
        remaining === 0 ? "" : `[0-9]{${remaining}}`
      }$`,
    });
  }
  branches.push({ type: "string", enum: [maximum] });
  return branches;
}

const POSITIVE_NAT64_BRANCHES = positiveDecimalBranches("18446744073709551615");
const POSITIVE_SAFE_INTEGER_BRANCHES = positiveDecimalBranches(
  String(MAX_SAFE_INTEGER),
);

const jsonValueSchema: JsonObject = {
  description:
    "A copied JSON-compatible value. Blast additionally enforces byte, depth, and node limits at runtime.",
};

const nullableStringSchema = (maximum: number): JsonObject => ({
  oneOf: [{ type: "string", maxLength: maximum }, { type: "null" }],
});

const nullableJsonValueSchema: JsonObject = {
  description:
    "A copied JSON-compatible value or null, bounded again by the Blast runtime.",
};

const nonNullJsonValueSchema: JsonObject = {
  ...jsonValueSchema,
  not: { type: "null" },
};

const identityModeSchema: JsonObject = {
  type: "string",
  enum: ["local", "kernel"],
  default: "local",
  description:
    "local uses Blast's distinct browser-held principal, which target canisters can observe, without a Kernel consent dialog. kernel uses the current Kernel owner identity through its consent-protected direct-update route; Blast never receives that private key. Agent Mode requires the Kernel's v2 signed-call route; an ordinary call can use the unversioned compatibility route when v2 is unavailable. Kernel identity cannot target the hosting Neutron canister.",
};

const localIdentityModeSchema: JsonObject = {
  type: "string",
  enum: ["local"],
  default: "local",
  description:
    "Blast's distinct browser-held principal; target canisters can observe it. No Kernel consent dialog is shown, and the Kernel identity is unavailable on this route.",
};

const canisterSchema: JsonObject = {
  type: "string",
  minLength: 5,
  maxLength: 63,
  not: { enum: ["aaaaa-aa"] },
  description:
    "Canonical IC canister principal text. The management canister aaaaa-aa is excluded from every Blast route. The hosting Neutron canister remains available to Blast's independent local identity, but identityMode:kernel rejects it before negotiation because same-Neutron owner calls require a separate private transport.",
};

const methodSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: BLAST_LIMITS.canisterMethodCharacters,
  not: {
    pattern: `${BLAST_METHOD_CONTROL_PATTERN_SOURCE}|${LONE_SURROGATE_PATTERN}`,
  },
  description: "Exact method name from current ICBlast discovery.",
};

const storedV1MethodProjectionProperties: JsonObject = {
  method: { type: "null" },
  methodStatus: {
    type: "string",
    enum: ["stored_v1_method_outside_current_policy"],
  },
  legacyMethodUtf8Hex: {
    type: "string",
    minLength: 2,
    maxLength: BLAST_LIMITS.canisterMethodCharacters * 8,
    pattern: "^[0-9a-f]+$",
    description:
      "Lossless UTF-8 hex for v0.1.0 provenance that is not a callable current method name.",
  },
};

const callArgumentsSchema: JsonObject = {
  type: "array",
  maxItems: BLAST_LIMITS.canisterArgumentItems,
  items: jsonValueSchema,
  description:
    "ICBlast JSON-form Candid arguments. The serialized request is byte-bounded at runtime.",
};

const positiveNat64TextSchema: JsonObject = {
  oneOf: POSITIVE_NAT64_BRANCHES,
};

const scriptIdSchema: JsonObject = {
  ...positiveNat64TextSchema,
  description: "Positive Nat64 script id encoded exactly as decimal text.",
};

const collectionIdSchema: JsonObject = {
  type: "string",
  pattern: COLLECTION_ID_PATTERN,
  maxLength: 160,
};

const digestSchema: JsonObject = {
  type: "string",
  pattern: DIGEST_PATTERN,
  description: "Lowercase SHA-256 hex digest.",
};

const nat64TextSchema: JsonObject = {
  oneOf: [{ type: "string", enum: ["0"] }, ...POSITIVE_NAT64_BRANCHES],
  description: "Nat64 encoded exactly as decimal text.",
};

const scriptSourceSchema: JsonObject = {
  type: "string",
  minLength: 1,
  // A character bound cannot express a UTF-8 byte bound, but this coarse
  // ceiling does not reject any source that satisfies the exact runtime cap.
  maxLength: BLAST_LIMITS.scriptSourceBytes,
  not: { pattern: LONE_SURROGATE_PATTERN },
  description: [
    "An async-function body receiving `input`; it must explicitly return a JSON-compatible value (`return null` is valid), and falling through fails the run.",
    "Before collection-wide work, inspect collection.describe({id,pageLimit:1}).pages[0].value outside the script. Inspection does not consume a page or set a script cursor.",
    "Guest canister API: blast.identity(); blast.scan({canister}); blast.schema({canister,method}); blast.validateInput({canister,method,args}); blast.query({canister,method,args?,identityMode?:\"local\"}); blast.update({canister,method,args?,identityMode?:\"local\"}).",
    "Guest collection API: collections.create({name,kind,description?,source?,sourceCollectionIds?}) returns the record; collections.putPage(id,key,value); collections.append(id,value,key?); collections.readPages(id,{cursor?,limit?}) returns {values,nextCursor}; collections.pages(id,{cursor?,limit?}); collections.complete(id,summary?); collections.fail(id,summary). Guest run API: run.checkpoint(value); run.progress(value).",
    "A raw collection may declare source but no sourceCollectionIds; a derived collection may declare sourceCollectionIds but no source. Pass every readable id in inputCollectionIds; derived lineage ids must be in that allowlist. Writes are allowed only to collections created by this run.",
    "putPage requires an idempotency key: replaying the same key and canonical value while writable returns the existing page, but another value conflicts. append is at-least-once when key is omitted and can duplicate on retry; pass a key when replay safety is required.",
    `collections.pages is a lazy async iterable of whole stored page values, not nested rows. Without limit it follows cursors until null or a run budget stops it. A finite limit counts total yielded pages and returns no continuation when reached; use readPages and return its nextCursor plus partial aggregates to resume in a later run. Only nextCursor:null proves that batch traversal ended.`,
    "After shape inspection, a row count can use `let count=0; for await (const page of collections.pages(input.sourceId)) { if (!Array.isArray(page)) throw new Error(\"Expected an inspected row array\"); count += page.length; } return {count};`; replace the extraction for nested pages.",
    "Every collection created by a run must reach collections.complete() or collections.fail() before normal return. Store large output incrementally and return only compact ids, cursors, and counts.",
    `Run budgets are ${BLAST_RUN_BUDGETS.calls} canister/discovery calls, ${BLAST_RUN_BUDGETS.requestBytes} canister-request bytes, ${BLAST_RUN_BUDGETS.responseBytes} canister-response bytes, ${BLAST_RUN_BUDGETS.pageReads} page reads, ${BLAST_RUN_BUDGETS.pageWrites} page writes, ${BLAST_RUN_BUDGETS.readBytes} collection-read bytes, and ${BLAST_RUN_BUDGETS.writeBytes} collection-write bytes. The Worker permits ${BLAST_LIMITS.scriptHostCalls} total host calls with ${BLAST_LIMITS.scriptConcurrentHostCalls} concurrent.`,
    `Each host read returns at most ${BLAST_LIMITS.collectionBatchPages} pages, ${BLAST_LIMITS.collectionBatchBytes} serialized bytes, and ${BLAST_STORED_V1_JSON_LIMITS.nodes} JSON values. The script return is limited to ${BLAST_LIMITS.scriptResultBytes} UTF-8 bytes.`,
    "For an update, use `const result = await blast.update(request); await run.checkpoint({phase:\"update-consumed\"}); return result;`: the checkpoint must be issued after the update response is consumed so its durable evidence can be settled.",
    `run.progress(value) reports bounded progress. Browser fetch, DOM, storage, eval, and Function are unavailable. Source is limited to ${BLAST_LIMITS.scriptSourceBytes} UTF-8 bytes.`,
  ].join(" "),
};

const scriptMetadataRules: JsonObject[] = [
  { not: { pattern: SCRIPT_METADATA_CONTROL_PATTERN } },
  { not: { pattern: "^\\s" } },
  { not: { pattern: "\\s$" } },
];

const scriptNameSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  allOf: scriptMetadataRules,
  description:
    "Trimmed Unicode-scalar script name without control, bidirectional-control, or selected zero-width formatting characters; the exact UTF-8 byte limit is enforced at runtime.",
};

const scriptDescriptionSchema: JsonObject = {
  oneOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: 1_024,
      allOf: scriptMetadataRules,
      description:
        "Trimmed Unicode-scalar script description without control, bidirectional-control, or selected zero-width formatting characters; Blast enforces the exact 1024-byte UTF-8 limit at runtime.",
    },
    { type: "null" },
  ],
};

const nonNegativeIntegerSchema: JsonObject = {
  type: "integer",
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
};

const closedObject = (
  required: readonly string[],
  properties: JsonObject,
  description?: string,
): JsonObject => ({
  type: "object",
  ...(required.length === 0 ? {} : { required: [...required] }),
  properties,
  additionalProperties: false,
  ...(description === undefined ? {} : { description }),
});

const nullable = (schema: JsonObject): JsonObject => ({
  oneOf: [schema, { type: "null" }],
});

const collectionCursorSchema: JsonObject = {
  ...nullable(collectionIdSchema),
  description:
    "Opaque weakly consistent catalogue continuation. Pass a non-null cursor unchanged to the next call; only a returned null cursor means this pass reached the then-visible end. Concurrent inserts at earlier keys require a fresh pass from null. Never infer completion from the number of returned entries.",
};

const pageCursorSchema: JsonObject = {
  ...nullable({
    oneOf: [{ type: "string", enum: ["0"] }, ...POSITIVE_SAFE_INTEGER_BRANCHES],
  }),
  description:
    "Opaque stored-page continuation. Pass a non-null cursor unchanged to the next call; only a returned null cursor means the current traversal reached the end. Never infer completion from pages.length, inputPages, or sampleStatus.",
};

const annotations = (
  effects: readonly ToolEffect[],
  longRunning = false,
): JsonObject => ({
  "neutron:audit": NEUTRON_TOOL_AUDIT_METADATA_ONLY,
  "neutron:effects": [...effects],
  ...(longRunning ? { "neutron:longRunning": true } : {}),
});

const defineTool = (
  title: string,
  description: string,
  inputSchema: JsonObject,
  outputSchema: JsonObject,
  effects: readonly ToolEffect[],
  longRunning = false,
): ExposedToolOptions => ({
  title,
  description,
  inputSchema,
  outputSchema,
  annotations: annotations(effects, longRunning),
});

const methodKindSchema: JsonObject = {
  type: "string",
  enum: ["query", "update", "oneway"],
  description:
    "ICBlast currently reports composite queries as query; no distinct composite-query value is available. Oneway methods are effectful write calls with no execution result.",
};

const discoveredMethodSchema = closedObject(["name", "kind"], {
  name: methodSchema,
  kind: methodKindSchema,
});

const identityOutputSchema = closedObject(
  ["slot", "principal", "createdAt", "publicKeyFingerprint"],
  {
    slot: {
      type: "integer",
      enum: [0],
      description: "The fixed durable Blast-local identity slot zero.",
    },
    principal: { type: "string", minLength: 5, maxLength: 63 },
    createdAt: nonNegativeIntegerSchema,
    publicKeyFingerprint: digestSchema,
  },
);

const schemaDocumentSchema: JsonObject = {
  type: "object",
  maxProperties: 1_024,
  description:
    "An ICBlast-generated JSON Schema document, bounded by serialized bytes at runtime.",
};

const discoveryInputProperties: JsonObject = {
  canister: canisterSchema,
  method: methodSchema,
};

const canisterCallInputProperties: JsonObject = {
  ...discoveryInputProperties,
  args: callArgumentsSchema,
  identityMode: identityModeSchema,
};

const canisterCallOutputSchema = (
  route: "query" | "update",
  identity: JsonObject,
): JsonObject => {
  const required = [
    "canister",
    "method",
    "kind",
    "identityMode",
    "resultStatus",
    "result",
    "resultBytes",
    "dispatchStatus",
    "retrySafe",
  ];
  const retrySafe = (
    kind: "query" | "update" | "oneway",
    confirmed: boolean,
  ): JsonObject => ({
    type: "boolean",
    enum: [confirmed && kind === "query"],
    description:
      kind === "query"
        ? "True only for a confirmed live-attested query. This says repeating has no remote write effect, not that the same direct reply will fit; follow resultStatus."
        : "False because automatically repeating an effectful call could duplicate a remote effect.",
  });
  const outcomesFor = (kind: "query" | "update" | "oneway"): JsonObject[] => {
    const tooLargeDescription =
      kind === "query"
        ? "The complete query result fit Blast's processing limit but not this direct envelope. An identical direct retry will not fit; repeat it inside a bounded local script to process or store the value."
        : "This update was already dispatched and may have committed, but its result did not fit this direct envelope. Do not repeat it. Reconcile remote state. A local script can process such a result only when chosen before the first dispatch; Kernel identity has no script route.";
    const exceedsDescription =
      kind === "query"
        ? "The query result exceeded Blast's absolute processing limit and was discarded. A script cannot recover it; use canister-level pagination or narrower arguments."
        : "This update was already dispatched and may have committed, but its result exceeded Blast's absolute processing limit and was discarded. Do not repeat it. Reconcile remote state; plan pagination or narrower output before a future update.";
    const common: JsonObject = {
      canister: canisterSchema,
      method: methodSchema,
      kind: {
        type: "string",
        enum: [kind],
        description:
          kind === "query"
            ? "The live local actor attested this query route."
            : kind === "oneway"
              ? "The live local actor attested a Candid oneway method. Dispatch is effectful and supplies no execution result."
              : "For local calls, the live actor attested an update. For Kernel calls, update is the conservative write-route classification because the consent dialog does not attest the live method kind.",
      },
      identityMode: kind === "oneway" ? localIdentityModeSchema : identity,
    };
    const confirmed =
      kind === "oneway"
        ? [
            closedObject(required, {
              ...common,
              resultStatus: {
                type: "string",
                enum: ["dispatched_no_result"],
                description:
                  "Dispatch was accepted, but Candid oneway supplies no execution result and does not attest remote completion.",
              },
              result: { type: "null" },
              resultBytes: { type: "integer", enum: [4] },
              dispatchStatus: { type: "string", enum: ["confirmed"] },
              retrySafe: retrySafe(kind, true),
            }),
          ]
        : [
            closedObject(required, {
              ...common,
              resultStatus: { type: "string", enum: ["complete"] },
              result: jsonValueSchema,
              resultBytes: nonNegativeIntegerSchema,
              dispatchStatus: { type: "string", enum: ["confirmed"] },
              retrySafe: retrySafe(kind, true),
            }),
            closedObject(required, {
              ...common,
              resultStatus: {
                type: "string",
                enum: ["result_too_large"],
                description: tooLargeDescription,
              },
              result: { type: "null" },
              resultBytes: nonNegativeIntegerSchema,
              dispatchStatus: { type: "string", enum: ["confirmed"] },
              retrySafe: retrySafe(kind, true),
            }),
            closedObject(required, {
              ...common,
              resultStatus: {
                type: "string",
                enum: ["result_exceeds_processing_limit"],
                description: exceedsDescription,
              },
              result: { type: "null" },
              resultBytes: nonNegativeIntegerSchema,
              dispatchStatus: { type: "string", enum: ["confirmed"] },
              retrySafe: retrySafe(kind, true),
            }),
          ];
    return [
      ...confirmed,
      closedObject(required, {
        ...common,
        resultStatus: {
          type: "string",
          enum: ["dispatched_result_unknown"],
          description:
            "Blast crossed the call boundary but cannot determine whether remote dispatch occurred or recover a complete result.",
        },
        result: { type: "null" },
        resultBytes: { type: "null" },
        dispatchStatus: { type: "string", enum: ["unknown"] },
        retrySafe: retrySafe(kind, false),
      }),
      closedObject(required, {
        ...common,
        resultStatus: {
          type: "string",
          enum: ["dispatched_result_unknown"],
          description:
            "Dispatch is confirmed, but Blast cannot return a complete result after normalization or durable accounting.",
        },
        result: { type: "null" },
        resultBytes: { type: "null" },
        dispatchStatus: { type: "string", enum: ["confirmed"] },
        retrySafe: retrySafe(kind, true),
      }),
    ];
  };
  const kinds =
    route === "query" ? (["query"] as const) : (["update", "oneway"] as const);
  return {
    oneOf: kinds.flatMap(outcomesFor),
  };
};

const scriptSummaryProperties: JsonObject = {
  id: scriptIdSchema,
  revision: positiveNat64TextSchema,
  name: scriptNameSchema,
  description: scriptDescriptionSchema,
  sourceDigest: digestSchema,
  sourceBytes: {
    type: "integer",
    minimum: 1,
    maximum: BLAST_LIMITS.scriptSourceBytes,
  },
  createdAtNs: positiveNat64TextSchema,
  updatedAtNs: positiveNat64TextSchema,
};

const scriptSummarySchema = closedObject(
  [
    "id",
    "revision",
    "name",
    "description",
    "sourceDigest",
    "sourceBytes",
    "createdAtNs",
    "updatedAtNs",
  ],
  scriptSummaryProperties,
);

const savedScriptSchema = closedObject(
  [
    "id",
    "revision",
    "name",
    "description",
    "sourceDigest",
    "sourceBytes",
    "createdAtNs",
    "updatedAtNs",
    "source",
  ],
  {
    ...scriptSummaryProperties,
    source: scriptSourceSchema,
  },
);

const scriptCursorSchema = closedObject(
  ["afterId", "libraryRevision"],
  {
    afterId: {
      ...scriptIdSchema,
      description: "Last script id from the preceding catalogue page.",
    },
    libraryRevision: {
      ...nat64TextSchema,
      description: "Library revision pinned for this catalogue pass.",
    },
  },
  "Opaque saved-script continuation. Pass it unchanged. Any save or delete makes it stale; discard the partial pass and restart with cursor:null.",
);

const saveScriptResultSchema = closedObject(
  ["libraryRevision", "totalSourceBytes", "script"],
  {
    libraryRevision: nat64TextSchema,
    totalSourceBytes: {
      type: "integer",
      minimum: 0,
      maximum: 16 * 1_024 * 1_024,
    },
    script: scriptSummarySchema,
  },
);

const scriptMutationUnknownProperties: JsonObject = {
  mutationStatus: {
    type: "string",
    enum: ["outcome_unknown"],
    description:
      "The backend mutation was attempted, but Blast cannot determine whether it committed.",
  },
  retrySafe: {
    const: false,
    description:
      "Never repeat this mutation blindly. Reconcile the exact submitted evidence first.",
  },
};

const scriptMutationMatchFields = [
  "name",
  "description",
  "sourceDigest",
  "sourceBytes",
] as const;
const scriptMutationMatchProperties: JsonObject = {
  name: scriptNameSchema,
  description: scriptDescriptionSchema,
  sourceDigest: digestSchema,
  sourceBytes: {
    type: "integer",
    minimum: 1,
    maximum: BLAST_LIMITS.scriptSourceBytes,
  },
};
const scriptMutationMatchSchema = closedObject(
  scriptMutationMatchFields,
  scriptMutationMatchProperties,
);

const createScriptOutcomeUnknownSchema = closedObject(
  ["mutationStatus", "retrySafe", "reconciliation"],
  {
    ...scriptMutationUnknownProperties,
    reconciliation: closedObject(["kind", "tool", "match"], {
      kind: { type: "string", enum: ["create"] },
      tool: { type: "string", enum: ["script.list"] },
      match: closedObject(
        [...scriptMutationMatchFields, "revision"],
        {
          ...scriptMutationMatchProperties,
          revision: { type: "string", enum: ["1"] },
        },
        "Page through script.list and compare every field. A matching revision-one entry is evidence, not a unique receipt: an older identical script can also match, so never blindly repeat the create.",
      ),
    }),
  },
);

const replaceScriptOutcomeUnknownSchema = closedObject(
  ["mutationStatus", "retrySafe", "reconciliation"],
  {
    ...scriptMutationUnknownProperties,
    reconciliation: closedObject(
      [
        "kind",
        "tool",
        "id",
        "expectedRevision",
        "expectedSuccessorRevision",
        "match",
      ],
      {
        kind: { type: "string", enum: ["replace"] },
        tool: { type: "string", enum: ["script.get"] },
        id: scriptIdSchema,
        expectedRevision: {
          ...positiveNat64TextSchema,
          description: "The submitted compare-and-set revision.",
        },
        expectedSuccessorRevision: nullable({
          ...positiveNat64TextSchema,
          description:
            "The exact revision a committed replacement must have. Null means the submitted revision has no Nat64 successor and therefore cannot be replaced.",
        }),
        match: scriptMutationMatchSchema,
      },
    ),
  },
);

const deleteScriptOutcomeUnknownSchema = closedObject(
  ["mutationStatus", "retrySafe", "reconciliation"],
  {
    ...scriptMutationUnknownProperties,
    reconciliation: closedObject(["kind", "tool", "id", "expectedRevision"], {
      kind: { type: "string", enum: ["delete"] },
      tool: { type: "string", enum: ["script.get"] },
      id: scriptIdSchema,
      expectedRevision: {
        ...positiveNat64TextSchema,
        description:
          "The exact revision targeted by the delete. Re-read this id to determine its current state before deciding any next action.",
      },
    }),
  },
);

const saveScriptMutationResultSchema: JsonObject = {
  oneOf: [
    saveScriptResultSchema,
    createScriptOutcomeUnknownSchema,
    replaceScriptOutcomeUnknownSchema,
  ],
};

const inputCollectionIdsSchema: JsonObject = {
  type: "array",
  maxItems: 64,
  uniqueItems: true,
  items: collectionIdSchema,
  description:
    "Exact existing collection ids this run may read. The host rejects reads outside this bounded allowlist.",
};

const executionResultSchema = closedObject(
  [
    "runId",
    "state",
    "sourceDigest",
    "script",
    "result",
    "collectionIds",
    "checkpoint",
    "summary",
    "retrySafe",
    "pendingUpdateCount",
    "calls",
    "inputBytes",
    "outputBytes",
  ],
  {
    runId: { type: "string", minLength: 1, maxLength: 96 },
    state: {
      type: "string",
      enum: ["complete", "failed", "cancelled", "interrupted"],
      description: "Terminal state of this execution attempt.",
    },
    sourceDigest: digestSchema,
    script: nullable(
      closedObject(["id", "revision"], {
        id: scriptIdSchema,
        revision: positiveNat64TextSchema,
      }),
    ),
    result: {
      ...nullableJsonValueSchema,
      description: `The script's explicit JSON-compatible return value when state is complete; null is also used when the run did not complete. Falling through without an explicit return fails rather than producing null. The return is limited to ${BLAST_LIMITS.scriptResultBytes} UTF-8 bytes, ${BLAST_LIMITS.jsonNodes} JSON values, and depth ${BLAST_LIMITS.jsonDepth}. Persist large output page by page in a collection and return only its id and compact counts.`,
    },
    collectionIds: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: collectionIdSchema,
      description:
        "Collections created by this run. They are not deleted by run.delete.",
    },
    checkpoint: {
      ...nullableJsonValueSchema,
      description: "Latest durable guest checkpoint value, or null.",
    },
    summary: {
      ...nullableJsonValueSchema,
      description:
        "Bounded durable run summary. Newly completed scripts include versioned completionEvidence with argumentsDigest, resultDigest, resultBytes, resultStatus, and the exact result only when it fits.",
    },
    retrySafe: { const: false },
    pendingUpdateCount: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_PENDING_UPDATE_LIMIT,
      description:
        "Update attempts not covered by a checkpoint issued after the script consumed their responses. Inspect the run before deleting it and never repeat these writes automatically.",
    },
    calls: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.calls,
      description:
        "Canister and discovery host calls charged to this run; other guest host calls are excluded.",
    },
    inputBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.requestBytes + BLAST_RUN_BUDGETS.readBytes,
      description:
        "Canister-request bytes plus collection-page bytes read by this run.",
    },
    outputBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.responseBytes + BLAST_RUN_BUDGETS.writeBytes,
      description:
        "Canister-response bytes plus collection-page bytes written by this run.",
    },
  },
);

const collectionStateSchema: JsonObject = {
  type: "string",
  enum: ["open", "complete", "failed", "deleting"],
  description:
    "Writer state. Only complete or failed is terminal; reaching a cursor or sample boundary does not make an open collection complete.",
};

const collectionKindSchema: JsonObject = {
  type: "string",
  enum: ["raw", "derived"],
};

const collectionProducerSchema: JsonObject = {
  ...nullable(
    closedObject(["scriptId", "revision", "digest"], {
      scriptId: scriptIdSchema,
      revision: positiveNat64TextSchema,
      digest: digestSchema,
    }),
  ),
  description:
    "System-bound saved-script revision and digest for this collection, or null for temporary code.",
};

const collectionIdentitySchema: JsonObject = {
  ...closedObject(["mode", "principal"], {
    mode: { type: "string", enum: ["local"] },
    principal: {
      type: "string",
      minLength: 5,
      maxLength: 63,
    },
  }),
  description:
    "System-bound Blast-local identity that produced this script-owned collection.",
};

const runIdentitySchema = nullable(collectionIdentitySchema);

const runSourceSchema: JsonObject = {
  oneOf: [
    closedObject(["kind", "digest"], {
      kind: { type: "string", enum: ["temporary"] },
      digest: digestSchema,
    }),
    closedObject(["kind", "scriptId", "revision", "digest"], {
      kind: { type: "string", enum: ["saved"] },
      scriptId: scriptIdSchema,
      revision: positiveNat64TextSchema,
      digest: digestSchema,
    }),
  ],
};

const runStateSchema: JsonObject = {
  type: "string",
  enum: ["running", "complete", "failed", "cancelled", "interrupted"],
};

const runCountersSchema = closedObject(
  [
    "callCount",
    "requestBytes",
    "responseBytes",
    "pageReadCount",
    "pageWriteCount",
    "readBytes",
    "writeBytes",
  ],
  {
    callCount: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.calls,
    },
    requestBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.requestBytes,
    },
    responseBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.responseBytes,
    },
    pageReadCount: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.pageReads,
    },
    pageWriteCount: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.pageWrites,
    },
    readBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.readBytes,
    },
    writeBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_RUN_BUDGETS.writeBytes,
    },
  },
);

const pendingUpdateProperties: JsonObject = {
  id: collectionIdSchema,
  canister: canisterSchema,
  argumentsDigest: digestSchema,
  identityMode: localIdentityModeSchema,
  startedAt: nonNegativeIntegerSchema,
  status: {
    type: "string",
    enum: ["call_pending", "dispatch_confirmed"],
  },
};

const pendingUpdateSchema: JsonObject = {
  oneOf: [
    closedObject(
      [
        "id",
        "canister",
        "method",
        "argumentsDigest",
        "identityMode",
        "startedAt",
        "status",
      ],
      {
        ...pendingUpdateProperties,
        method: methodSchema,
      },
    ),
    closedObject(
      [
        "id",
        "canister",
        "method",
        "methodStatus",
        "legacyMethodUtf8Hex",
        "argumentsDigest",
        "identityMode",
        "startedAt",
        "status",
      ],
      {
        ...pendingUpdateProperties,
        ...storedV1MethodProjectionProperties,
      },
    ),
  ],
};

const runListProperties: JsonObject = {
  id: collectionIdSchema,
  source: runSourceSchema,
  state: runStateSchema,
  startedAt: nonNegativeIntegerSchema,
  updatedAt: nonNegativeIntegerSchema,
  completedAt: nullable(nonNegativeIntegerSchema),
  deadlineAt: nonNegativeIntegerSchema,
  identity: runIdentitySchema,
  counters: runCountersSchema,
  checkpointRevision: nonNegativeIntegerSchema,
  inputCollectionCount: {
    type: "integer",
    minimum: 0,
    maximum: 64,
  },
  outputCollectionCount: {
    type: "integer",
    minimum: 0,
    maximum: 64,
  },
  pendingUpdateCount: {
    type: "integer",
    minimum: 0,
    maximum: BLAST_PENDING_UPDATE_LIMIT,
  },
};

const runListEntrySchema = closedObject(
  Object.keys(runListProperties),
  runListProperties,
);

const publicRunSchema = closedObject(
  [
    "id",
    "source",
    "state",
    "startedAt",
    "updatedAt",
    "completedAt",
    "deadlineAt",
    "inputCollectionIds",
    "outputCollectionIds",
    "identity",
    "counters",
    "pendingUpdates",
    "checkpointRevision",
    "summary",
  ],
  {
    id: collectionIdSchema,
    source: runSourceSchema,
    state: runStateSchema,
    startedAt: nonNegativeIntegerSchema,
    updatedAt: nonNegativeIntegerSchema,
    completedAt: nullable(nonNegativeIntegerSchema),
    deadlineAt: nonNegativeIntegerSchema,
    inputCollectionIds: inputCollectionIdsSchema,
    outputCollectionIds: inputCollectionIdsSchema,
    identity: runIdentitySchema,
    counters: runCountersSchema,
    pendingUpdates: {
      type: "array",
      maxItems: BLAST_PENDING_UPDATE_LIMIT,
      items: pendingUpdateSchema,
    },
    checkpointRevision: nonNegativeIntegerSchema,
    summary: {
      ...nullableJsonValueSchema,
      description:
        "Bounded durable run summary. Newly completed scripts include versioned completionEvidence with argumentsDigest, resultDigest, resultBytes, resultStatus, and the exact result only when it fits.",
    },
  },
);

const checkpointSchema = closedObject(
  [
    "runId",
    "revision",
    "sourceDigest",
    "inputCollectionIds",
    "outputCollectionIds",
    "value",
    "serializedBytes",
    "updatedAt",
  ],
  {
    runId: collectionIdSchema,
    revision: nonNegativeIntegerSchema,
    sourceDigest: digestSchema,
    inputCollectionIds: inputCollectionIdsSchema,
    outputCollectionIds: inputCollectionIdsSchema,
    value: jsonValueSchema,
    serializedBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_LIMITS.collectionSummaryBytes,
    },
    updatedAt: nonNegativeIntegerSchema,
  },
);

const collectionSourceSchema: JsonObject = {
  ...nullable({
    oneOf: [
      closedObject(["canister", "method", "argumentsDigest"], {
        canister: canisterSchema,
        method: methodSchema,
        argumentsDigest: digestSchema,
      }),
      closedObject(
        [
          "canister",
          "method",
          "methodStatus",
          "legacyMethodUtf8Hex",
          "argumentsDigest",
        ],
        {
          canister: canisterSchema,
          argumentsDigest: digestSchema,
          ...storedV1MethodProjectionProperties,
        },
      ),
    ],
  }),
  description:
    "Script-declared external-call provenance. Blast validates its shape but does not attest that stored pages came from this call.",
};

const collectionListProperties: JsonObject = {
  id: collectionIdSchema,
  name: {
    type: "string",
    minLength: 1,
    maxLength: BLAST_LIMITS.collectionNameCharacters,
  },
  state: collectionStateSchema,
  kind: collectionKindSchema,
  createdAt: nonNegativeIntegerSchema,
  updatedAt: nonNegativeIntegerSchema,
  pageCount: {
    ...nonNegativeIntegerSchema,
    description: "Total stored page values in this collection.",
  },
  itemCount: {
    ...nonNegativeIntegerSchema,
    description:
      "Sum of top-level array lengths across stored pages, counting a non-array page value as one. This is not a recursive row count.",
  },
  serializedBytes: {
    ...nonNegativeIntegerSchema,
    description: "Total serialized bytes across every stored page value.",
  },
  sourceCollectionIds: {
    type: "array",
    maxItems: 32,
    uniqueItems: true,
    items: collectionIdSchema,
    description:
      "Script-declared lineage. Blast requires readable allowlisted ids when created, but does not attest that the script read them.",
  },
  producer: collectionProducerSchema,
  identity: collectionIdentitySchema,
  source: collectionSourceSchema,
};

const collectionListEntrySchema = closedObject(
  [
    "id",
    "name",
    "state",
    "kind",
    "createdAt",
    "updatedAt",
    "pageCount",
    "itemCount",
    "serializedBytes",
    "sourceCollectionIds",
    "producer",
    "identity",
    "source",
  ],
  collectionListProperties,
);

const collectionRecordSchema = closedObject(
  [
    "id",
    "name",
    "description",
    "state",
    "kind",
    "createdAt",
    "updatedAt",
    "pageCount",
    "itemCount",
    "serializedBytes",
    "sourceCollectionIds",
    "producer",
    "identity",
    "source",
    "summary",
  ],
  {
    ...collectionListProperties,
    description: nullableStringSchema(
      BLAST_LIMITS.collectionDescriptionCharacters,
    ),
    summary: nullableJsonValueSchema,
  },
);

const collectionPageSchema = closedObject(
  [
    "sequence",
    "idempotencyKey",
    "value",
    "itemCount",
    "serializedBytes",
    "createdAt",
  ],
  {
    sequence: nonNegativeIntegerSchema,
    idempotencyKey: nullableStringSchema(512),
    value: {
      ...jsonValueSchema,
      description:
        "One stored page value. It is often an array of records, but may be any bounded JSON value; it is not necessarily one row.",
    },
    itemCount: nonNegativeIntegerSchema,
    serializedBytes: {
      type: "integer",
      minimum: 0,
      maximum: BLAST_LIMITS.collectionPageBytes,
    },
    createdAt: nonNegativeIntegerSchema,
  },
);

const oversizedCollectionPageSchema = closedObject(
  ["sequence", "serializedBytes", "maximumBytes"],
  {
    sequence: nonNegativeIntegerSchema,
    serializedBytes: {
      type: "integer",
      minimum: 1,
      maximum: BLAST_LIMITS.collectionPageBytes,
    },
    maximumBytes: {
      type: "integer",
      minimum: 1,
      maximum: BLAST_LIMITS.collectionPageBytes,
    },
  },
);

export const BLAST_TOOL_DEFINITIONS = Object.freeze({
  "blast.identity": defineTool(
    "Blast Local Identity",
    "Return public information for Blast's slot-zero browser-held identity. Discovery and local calls use its principal, which target canisters can observe, without a Kernel consent dialog. It is durable only within this installation, browser profile, and retained site data; clearing data, reinstalling, or changing device may rotate it. No private key or identity object is returned.",
    closedObject([], {}),
    identityOutputSchema,
    ["read"],
  ),

  "blast.scan": defineTool(
    "Scan Canister",
    "Use current ICBlast discovery with Blast's local identity to list a canister's methods and effective modes. The target can observe that local principal. ICBlast currently reports composite queries as query; the management canister is excluded.",
    closedObject(["canister"], {
      canister: canisterSchema,
    }),
    closedObject(["canister", "methods"], {
      canister: canisterSchema,
      methods: {
        type: "array",
        maxItems: 1_024,
        items: discoveredMethodSchema,
      },
    }),
    ["read", "network"],
    true,
  ),

  "blast.schema": defineTool(
    "Canister Method Schema",
    "Use current ICBlast discovery with Blast's local identity to return one bounded input and output JSON Schema. The target can observe that local principal. Script-supplied method metadata is not trusted.",
    closedObject(["canister", "method"], discoveryInputProperties),
    closedObject(["canister", "method", "kind", "schema"], {
      canister: canisterSchema,
      method: methodSchema,
      kind: methodKindSchema,
      schema: closedObject(["input", "output"], {
        input: schemaDocumentSchema,
        output: schemaDocumentSchema,
      }),
    }),
    ["read", "network"],
    true,
  ),

  "blast.validate_input": defineTool(
    "Validate Canister Input",
    "Discover with Blast's local identity, then check JSON-form arguments against ICBlast's current JSON Schema without dispatching the named method. valid:true only means that JSON Schema accepted them; later Candid preparation can still reject values such as an out-of-range integer or malformed principal.",
    closedObject(["canister", "method", "args"], {
      ...discoveryInputProperties,
      args: callArgumentsSchema,
    }),
    {
      oneOf: [
        closedObject(["canister", "method", "kind", "valid", "errors"], {
          canister: canisterSchema,
          method: methodSchema,
          kind: methodKindSchema,
          valid: {
            type: "boolean",
            const: true,
            description:
              "ICBlast's JSON Schema accepted the arguments; this is not a Candid-preparation or dispatch guarantee.",
          },
          errors: {
            type: "null",
            description: "Always null when valid is true.",
          },
        }),
        closedObject(["canister", "method", "kind", "valid", "errors"], {
          canister: canisterSchema,
          method: methodSchema,
          kind: methodKindSchema,
          valid: { type: "boolean", const: false },
          errors: {
            ...nonNullJsonValueSchema,
            description:
              "Non-null ICBlast JSON Schema diagnostics when valid is false.",
          },
        }),
      ],
    },
    ["read", "network"],
    true,
  ),

  "blast.query": defineTool(
    "Query Canister",
    "Execute only a method that current ICBlast discovery identifies as a query, using Blast's browser-held local principal, which the target can observe without a Kernel dialog. Kernel identity is rejected. result_too_large can be repeated inside a bounded local script; an identical direct retry still will not fit. result_exceeds_processing_limit was discarded and requires canister-level pagination or narrower arguments.",
    closedObject(["canister", "method", "args"], {
      ...discoveryInputProperties,
      args: callArgumentsSchema,
      identityMode: localIdentityModeSchema,
    }),
    canisterCallOutputSchema("query", localIdentityModeSchema),
    ["read", "network"],
    true,
  ),

  "blast.update": defineTool(
    "Update Canister",
    "With local identity, live-attest and dispatch an update or oneway under Blast's browser-held principal without a Kernel dialog. With kernel identity, use the current owner identity through the Kernel consent route; Blast never receives its key, and the returned update kind is a conservative route classification rather than live attestation. The hosting Neutron canister is rejected before Kernel negotiation. Agent Mode requires the v2 signed-call route. An ordinary call prefers v2 and can fall back to the unversioned compatibility route, whose dialog reviews pre-conversion JSON and whose cancellation is not phase-aware. An effectful call that returns result_too_large or result_exceeds_processing_limit was already dispatched and may have committed: never repeat it to recover output. A local script helps only when chosen before the first dispatch; Kernel identity has no script route. Reconcile remote state after oversized or uncertain outcomes.",
    closedObject(["canister", "method", "args"], canisterCallInputProperties),
    canisterCallOutputSchema("update", identityModeSchema),
    ["write", "network", "signature_request", "user_visible_ui"],
    true,
  ),

  "script.list": defineTool(
    "List Saved Scripts",
    "Return one compact page of saved-script metadata without source bodies. Pass nextCursor unchanged until null. Any save or delete changes the library revision and makes an existing cursor stale; discard that partial pass and restart with cursor:null.",
    closedObject([], {
      cursor: nullable(scriptCursorSchema),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        default: 10,
      },
    }),
    closedObject(
      ["libraryRevision", "scripts", "total", "totalSourceBytes", "nextCursor"],
      {
        libraryRevision: nat64TextSchema,
        scripts: {
          type: "array",
          maxItems: 10,
          items: scriptSummarySchema,
          description: "This page only; its length is not a completion signal.",
        },
        total: { type: "integer", minimum: 0, maximum: 128 },
        totalSourceBytes: {
          type: "integer",
          minimum: 0,
          maximum: 16 * 1_024 * 1_024,
        },
        nextCursor: {
          ...nullable(scriptCursorSchema),
          description:
            "Pass a non-null value unchanged to the next call. Null means this revision-pinned pass ended.",
        },
      },
    ),
    ["read", "network"],
  ),

  "script.get": defineTool(
    "Get Saved Script",
    "Return one saved script with its exact revision, SHA-256 digest, and UTF-8 source, or null when it does not exist.",
    closedObject(["id"], { id: scriptIdSchema }),
    nullable(savedScriptSchema),
    ["read", "network"],
  ),

  "script.save": defineTool(
    "Save Script",
    "Create a script, or replace an existing script only when its exact expected revision still matches. Saved source can later perform its declared network effects when script.run executes; saving does not run it. A cancellation, timeout, transport loss, or malformed reply after the update attempt has an unknown outcome and is never retry-safe. Reconcile the original evidence first; repeating a lost create can make a duplicate.",
    {
      oneOf: [
        closedObject(["name", "source"], {
          name: scriptNameSchema,
          description: scriptDescriptionSchema,
          source: scriptSourceSchema,
        }),
        closedObject(["id", "expectedRevision", "name", "source"], {
          id: scriptIdSchema,
          expectedRevision: positiveNat64TextSchema,
          name: scriptNameSchema,
          description: scriptDescriptionSchema,
          source: scriptSourceSchema,
        }),
      ],
    },
    saveScriptMutationResultSchema,
    ["write", "network"],
  ),

  "script.delete": defineTool(
    "Delete Saved Script",
    "Delete one saved script only when its exact expected revision still matches. This does not delete prior runs or collections. A cancellation, timeout, transport loss, or malformed reply after the update attempt has an unknown outcome and is never retry-safe. Re-read the exact id and revision before deciding any next action.",
    closedObject(["id", "expectedRevision"], {
      id: scriptIdSchema,
      expectedRevision: positiveNat64TextSchema,
    }),
    {
      oneOf: [
        closedObject(
          [
            "id",
            "deletedRevision",
            "sourceDigest",
            "libraryRevision",
            "totalSourceBytes",
          ],
          {
            id: scriptIdSchema,
            deletedRevision: positiveNat64TextSchema,
            sourceDigest: digestSchema,
            libraryRevision: nat64TextSchema,
            totalSourceBytes: {
              type: "integer",
              minimum: 0,
              maximum: 16 * 1_024 * 1_024,
            },
          },
        ),
        deleteScriptOutcomeUnknownSchema,
      ],
    },
    ["write", "network"],
  ),

  "script.evaluate": defineTool(
    "Evaluate JavaScript",
    "Run a temporary async-function body in bounded QuickJS. Inspect one page before assuming nesting. collections.pages yields stored page values; a finite limit stops without exposing a cursor, while collections.readPages returns resumable values/nextCursor. Store large output incrementally and close every created collection. After each blast.update response is consumed, call run.checkpoint before another update or normal return. Scripts use only Blast's local identity and inputCollectionIds allowlist. After cancellation, timeout, or a lost terminal reply, inspect run.list/run.get and output collection ids; never rerun source automatically. Delete collections and terminal runs separately. Inspect the source schema for the exact API and budgets.",
    closedObject(["source"], {
      source: scriptSourceSchema,
      args: nullableJsonValueSchema,
      inputCollectionIds: inputCollectionIdsSchema,
      identityMode: localIdentityModeSchema,
      timeoutMs: {
        type: "integer",
        minimum: 1_000,
        maximum: BLAST_LIMITS.scriptMaximumTimeoutMs,
        default: BLAST_LIMITS.scriptDefaultTimeoutMs,
      },
    }),
    executionResultSchema,
    ["read", "write", "network"],
    true,
  ),

  "script.run": defineTool(
    "Run Saved Script",
    "Run one exact saved script by id, revision, and digest in bounded QuickJS with Blast's local identity. Inspect it first with script.get. collections.pages yields stored page values; a finite limit stops without exposing a cursor, while collections.readPages is resumable. Close every created collection. After each blast.update response is consumed, call run.checkpoint before another update or normal return. A concurrent edit cannot change selected code. After cancellation, timeout, or a lost terminal reply, inspect run.list/run.get and output collection ids; never rerun automatically. Collection, run, and saved-script cleanup are separate.",
    closedObject(["id", "revision", "digest"], {
      id: scriptIdSchema,
      revision: positiveNat64TextSchema,
      digest: digestSchema,
      args: nullableJsonValueSchema,
      inputCollectionIds: inputCollectionIdsSchema,
      identityMode: localIdentityModeSchema,
      timeoutMs: {
        type: "integer",
        minimum: 1_000,
        maximum: BLAST_LIMITS.scriptMaximumTimeoutMs,
        default: BLAST_LIMITS.scriptDefaultTimeoutMs,
      },
    }),
    executionResultSchema,
    ["read", "write", "network"],
    true,
  ),

  "run.list": defineTool(
    "List Blast Runs",
    "List a bounded, weakly consistent catalogue page of durable script and collection-query run metadata, including the count of update attempts not yet covered by a later checkpoint. Pass each non-null cursor unchanged until null. If runs may be added or removed during traversal, restart from null afterward for a fresh pass. Session capability tokens and checkpoint bodies are never included.",
    closedObject([], {
      cursor: collectionCursorSchema,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 50,
      },
    }),
    closedObject(["runs", "cursor"], {
      runs: {
        type: "array",
        maxItems: 50,
        items: runListEntrySchema,
      },
      cursor: collectionCursorSchema,
    }),
    ["read"],
  ),

  "run.get": defineTool(
    "Get Blast Run",
    "Return one atomic durable snapshot of a run, its latest checkpoint, counters, collection grants, and bounded update evidence not yet covered by a later checkpoint. A newly completed script stores versioned completionEvidence in run.summary: the canonical invocation arguments digest, result digest and byte count, and the exact result when it fits the durable summary bound. Use those fields with the run source and collection grants to recognize a committed run after its terminal tool reply was lost; never rerun arbitrary script code automatically. Pending or confirmed evidence must also be treated as non-retry-safe when resuming. Retained v0.1.0 JSON outside current transport limits is represented by an explicit omission marker; legacy method provenance is returned as lossless UTF-8 hex, or as a bounded legacy marker if that projection cannot fit, never as a callable method. The internal session capability is never exposed.",
    closedObject(["id"], { id: collectionIdSchema }),
    nullable(
      closedObject(["run", "checkpoint"], {
        run: publicRunSchema,
        checkpoint: nullable(checkpointSchema),
      }),
    ),
    ["read"],
  ),

  "run.delete": defineTool(
    "Delete Blast Run",
    "Delete one exact terminal run and its checkpoint; this does not delete its output collections or saved script. Running runs are never deleted. If the run retains uncheckpointed update evidence, inspect it first and explicitly set acknowledgeUnresolvedUpdates to true; deletion then discards that evidence and cannot make the underlying update retry-safe.",
    closedObject(["id"], {
      id: collectionIdSchema,
      acknowledgeUnresolvedUpdates: {
        type: "boolean",
        default: false,
      },
    }),
    closedObject(["id", "status", "unresolvedUpdateCount"], {
      id: collectionIdSchema,
      status: { type: "string", enum: ["deleted", "not_found"] },
      unresolvedUpdateCount: {
        type: "integer",
        minimum: 0,
        maximum: BLAST_PENDING_UPDATE_LIMIT,
      },
    }),
    ["write"],
  ),

  "collection.list": defineTool(
    "List Collections",
    "Return one compact, weakly consistent catalogue page of browser-local collection metadata without page bodies. Each entry's pageCount is stored page values, itemCount sums only top-level array lengths (or one for a non-array page), and state—not counts—says whether its writer finished. Pass a returned non-null cursor unchanged to the next collection.list call; only cursor:null proves this pass reached its then-visible end, never collections.length. If collections may change during traversal, restart from cursor:null afterward for a fresh pass.",
    closedObject([], {
      cursor: collectionCursorSchema,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: BLAST_LIMITS.collectionListPage,
        default: BLAST_LIMITS.collectionListPage,
        description: "Maximum collection entries returned by this call.",
      },
    }),
    closedObject(["collections", "cursor"], {
      collections: {
        type: "array",
        maxItems: BLAST_LIMITS.collectionListPage,
        items: collectionListEntrySchema,
        description:
          "This catalogue page only. Its length is not a completeness signal; follow cursor until null.",
      },
      cursor: collectionCursorSchema,
    }),
    ["read"],
  ),

  "collection.describe": defineTool(
    "Describe Collection",
    "Return metadata and a bounded page sample, not the whole collection. Start with pageLimit:1 to inspect exact nesting before a collection-wide script; never assume a top-level array is the row set. Each pages[i].value is one stored page value and may contain many records. Pass a non-null cursor unchanged; only cursor:null proves this traversal ended. Blast may return fewer pages than pageLimit as a normal byte/node-safe prefix. pages.length and sampleStatus never prove completeness: complete means no page value was omitted, while stored_v1_value_omitted means a retained legacy value requires collections.pages or collections.readPages in a script. If one page cannot fit, page_too_large identifies it and advances the cursor; use a streaming script for whole-page work.",
    closedObject(["id"], {
      id: collectionIdSchema,
      cursor: pageCursorSchema,
      pageLimit: {
        type: "integer",
        minimum: 1,
        maximum: BLAST_LIMITS.collectionBatchPages,
        default: BLAST_LIMITS.collectionBatchPages,
        description:
          "Maximum stored page values requested, not nested records. Blast may return a smaller byte/node-safe prefix plus a non-null cursor without error. Use 1 when inspecting page shape.",
      },
    }),
    {
      oneOf: [
        closedObject(
          ["collection", "pages", "cursor", "sampleStatus", "omittedPage"],
          {
            collection: collectionRecordSchema,
            pages: {
              type: "array",
              maxItems: BLAST_LIMITS.collectionBatchPages,
              items: collectionPageSchema,
              description:
                "One bounded sample batch. Each entry wraps one stored page value; follow cursor until null for traversal completeness.",
            },
            cursor: pageCursorSchema,
            sampleStatus: {
              type: "string",
              enum: ["complete", "stored_v1_value_omitted"],
              description:
                "complete means every returned page value is present. stored_v1_value_omitted means at least one retained v0.1.0 value is represented by an explicit marker and must be read in a script. Neither status means the traversal or writer is complete.",
            },
            omittedPage: { type: "null" },
          },
        ),
        closedObject(
          ["collection", "pages", "cursor", "sampleStatus", "omittedPage"],
          {
            collection: collectionRecordSchema,
            pages: { type: "array", maxItems: 0, items: collectionPageSchema },
            cursor: pageCursorSchema,
            sampleStatus: {
              type: "string",
              enum: ["page_too_large"],
              description:
                "The identified page was omitted from this compact sample and the returned cursor advances past it; use collections.pages in a script for whole-page processing.",
            },
            omittedPage: oversizedCollectionPageSchema,
          },
        ),
      ],
    },
    ["read"],
  ),

  "collection.query": defineTool(
    "Query Collection",
    `Apply bounded JSONata to one batch; the result is always page-local. The expression receives an array of stored page values, not an automatic row array. Pass a non-null cursor unchanged and combine results incrementally; only cursor:null proves traversal ended. Blast automatically returns a smaller byte/node-safe prefix when needed, so continue its cursor instead of guessing another pageLimit. Even cursor:null does not make an open collection writer-complete. For many pages, first inspect one with collection.describe and pageLimit:1, then prefer one script.evaluate or script.run using collections.pages. Results must fit ${BLAST_LIMITS.jsonataOutputBytes} UTF-8 bytes and ${BLAST_LIMITS.jsonNodes} JSON values; project compact output. If one page is too wide, use a streaming script and narrower producer pages. Blast records bounded local run metadata for recovery.`,
    closedObject(["id", "expression"], {
      id: collectionIdSchema,
      expression: {
        type: "string",
        minLength: 1,
        maxLength: BLAST_LIMITS.jsonataExpressionCharacters,
        not: { pattern: LONE_SURROGATE_PATTERN },
        description:
          "JSONata applied to this call's array of stored page values, not automatically to the complete collection.",
      },
      cursor: pageCursorSchema,
      pageLimit: {
        type: "integer",
        minimum: 1,
        maximum: BLAST_LIMITS.collectionBatchPages,
        default: BLAST_LIMITS.collectionBatchPages,
        description:
          "Maximum stored page values requested for this page-local query, not nested records. Blast may return a smaller byte/node-safe prefix plus a non-null cursor without error.",
      },
    }),
    closedObject(
      [
        "value",
        "cursor",
        "pageLocal",
        "inputPages",
        "inputBytes",
        "outputBytes",
      ],
      {
        value: {
          ...jsonValueSchema,
          description:
            "JSONata result for this call's bounded page batch only. Combine successive cursor pages incrementally when a collection-wide answer is needed.",
        },
        cursor: pageCursorSchema,
        pageLocal: {
          type: "boolean",
          enum: [true],
          description:
            "Always true: this result covers only this call's input batch.",
        },
        inputPages: {
          type: "integer",
          minimum: 0,
          maximum: BLAST_LIMITS.collectionBatchPages,
          description:
            "Stored page values processed by this call, not nested record count and not a completeness signal.",
        },
        inputBytes: {
          type: "integer",
          minimum: 0,
          maximum: BLAST_LIMITS.jsonataInputBytes,
        },
        outputBytes: {
          type: "integer",
          minimum: 0,
          maximum: BLAST_LIMITS.jsonataOutputBytes,
        },
      },
    ),
    ["read", "write"],
  ),

  "collection.delete": defineTool(
    "Delete Collections",
    "Idempotently delete only the exact collection ids supplied. First inspect run.list/run.get: deleting a running run's input or output can make that run fail. For each id, deleted or missing means no collection data remains; deleting means call again later with that exact id. Re-list collections to verify absence. incompleteCleanup is origin-wide and may describe another deletion, so do not use it alone to choose ids. This does not delete saved scripts or run records; use script.delete or run.delete separately.",
    closedObject(["ids"], {
      ids: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        items: collectionIdSchema,
      },
    }),
    closedObject(["results", "incompleteCleanup"], {
      results: {
        type: "array",
        maxItems: 64,
        items: closedObject(["id", "status"], {
          id: collectionIdSchema,
          status: {
            type: "string",
            enum: ["missing", "deleting", "deleted"],
            description:
              "deleted or missing means this id has no remaining collection data; deleting means call collection.delete again later with this exact id.",
          },
        }),
      },
      incompleteCleanup: {
        type: "boolean",
        description:
          "True when any collection at this browser origin is still being reclaimed, including collections not named in this request. Use each result status, not this global flag alone, to choose ids to repeat.",
      },
    }),
    ["write"],
  ),

  "storage.status": defineTool(
    "Blast Storage Status",
    "Report browser-local logical totals and origin quota estimates. This does not request persistent-storage permission.",
    closedObject([], {}),
    closedObject(["logical", "origin"], {
      logical: closedObject(
        [
          "collections",
          "pages",
          "items",
          "serializedBytes",
          "deletingCollections",
          "runningRuns",
        ],
        {
          collections: {
            type: "integer",
            minimum: 0,
            maximum: BLAST_COLLECTION_LIMIT,
          },
          pages: nonNegativeIntegerSchema,
          items: nonNegativeIntegerSchema,
          serializedBytes: nonNegativeIntegerSchema,
          deletingCollections: {
            type: "integer",
            minimum: 0,
            maximum: BLAST_COLLECTION_LIMIT,
          },
          runningRuns: nonNegativeIntegerSchema,
        },
      ),
      origin: closedObject(["usage", "quota", "persisted"], {
        usage: nullable(nonNegativeIntegerSchema),
        quota: nullable(nonNegativeIntegerSchema),
        persisted: nullable({ type: "boolean" }),
      }),
    }),
    ["read"],
  ),
} satisfies Record<string, ExposedToolOptions>);

export type BlastToolName = keyof typeof BLAST_TOOL_DEFINITIONS;

export const BLAST_TOOL_NAMES = Object.freeze(
  Object.keys(BLAST_TOOL_DEFINITIONS) as BlastToolName[],
);
