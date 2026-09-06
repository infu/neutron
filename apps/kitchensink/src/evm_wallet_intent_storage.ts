import { isJsonObject, normalizeToolDescriptor, validateToolArguments, type JsonObject, type MsgBusClient } from "neutron-tools/app";
import {
  evmAccountSchema,
  evmOperationOutputSchema,
  evmSendTransactionInputSchema,
  evmSignMessageInputSchema,
  evmSignTypedDataInputSchema,
} from "neutron-tools/evm_wallet";
import {
  EVM_DEMO_KINDS,
  assertEvmDemoOperation,
  evmDemoRecordTerminal,
  type EvmDemoIntent,
  type EvmDemoJournal,
  type EvmDemoRecord,
} from "./evm_wallet_demo.ts";

export const EVM_DEMO_STORAGE_KEY = "neutron.kitchensink.evm-wallet-intents.v1";
export const EVM_DEMO_INTENT_TOOL = "evm_wallet_intent_v1";
const idSchema = { type: "string", pattern: "^[0-9a-f]{32}$" };
const numberSchema = { type: "integer", minimum: 0 };
const textSchema = { type: "string" };
const nullable = (value: JsonObject): JsonObject => ({ oneOf: [value, { type: "null" }] });
const closed = (properties: JsonObject): JsonObject => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const evmDemoIntentSchema = closed({
  id: idSchema,
  kind: { enum: [...EVM_DEMO_KINDS] },
  chainId: { type: "string", pattern: "^[1-9][0-9]*$" },
  account: evmAccountSchema,
  createdAtNs: { oneOf: [{ const: "0" }, { type: "string", pattern: "^[1-9][0-9]*$" }] },
  steps: { type: "array", items: { oneOf: [
    closed({ title: textSchema, kind: { const: "transaction" }, request: evmSendTransactionInputSchema }),
    closed({ title: textSchema, kind: { const: "message" }, request: evmSignMessageInputSchema }),
    closed({ title: textSchema, kind: { const: "typed_data" }, request: evmSignTypedDataInputSchema }),
  ] } },
});
export const evmDemoRecordSchema = closed({
  intent: evmDemoIntentSchema,
  revision: numberSchema,
  progress: { type: "array", items: closed({
    attempted: { type: "boolean" }, operation: nullable({ $ref: "#/definitions/operation" }), error: nullable(textSchema), signatureVerified: { type: "boolean" },
  }) },
});
export const evmDemoIntentActionSchema: JsonObject = { oneOf: [
  closed({ action: { const: "prepare" }, intent: evmDemoIntentSchema }),
  closed({ action: { const: "list" } }),
  closed({ action: { const: "get" }, id: idSchema }),
  closed({ action: { const: "attempting" }, id: idSchema, revision: numberSchema, step: numberSchema }),
  closed({ action: { const: "observed" }, id: idSchema, revision: numberSchema, step: numberSchema, operation: evmOperationOutputSchema, signatureVerified: { type: "boolean" } }),
  closed({ action: { const: "failed" }, id: idSchema, revision: numberSchema, step: numberSchema, error: textSchema }),
] };
// A local reference keeps the strict receipt/log shape within the existing
// Kernel schema-depth bound when nested under a saved consumer record.
export const evmDemoIntentResultSchema = {
  ...closed({ records: { type: "array", items: evmDemoRecordSchema } }),
  definitions: { operation: evmOperationOutputSchema },
};
type EvmDemoAction =
  | { action: "prepare"; intent: EvmDemoIntent }
  | { action: "list" }
  | { action: "get"; id: string }
  | { action: "attempting"; id: string; revision: number; step: number }
  | { action: "observed"; id: string; revision: number; step: number; operation: NonNullable<EvmDemoRecord["progress"][number]["operation"]>; signatureVerified: boolean }
  | { action: "failed"; id: string; revision: number; step: number; error: string };
type IntentStorage = Pick<Storage, "getItem" | "setItem">;

const actionDescriptor = normalizeToolDescriptor({ name: EVM_DEMO_INTENT_TOOL, inputSchema: evmDemoIntentActionSchema, outputSchema: evmDemoIntentResultSchema });
const resultDescriptor = normalizeToolDescriptor({ name: "evm_demo_saved_records", inputSchema: evmDemoIntentResultSchema });

/** Called under the resident origin's Web Lock; there is no await inside a mutation. */
export function runEvmDemoIntentAction(storage: IntentStorage, value: unknown): { records: EvmDemoRecord[] } {
  if (!isJsonObject(value)) throw new Error("Invalid EVM intent action.");
  validateToolArguments(actionDescriptor, value as JsonObject);
  const action = value as EvmDemoAction;
  const encoded = storage.getItem(EVM_DEMO_STORAGE_KEY);
  let records: EvmDemoRecord[];
  try {
    records = encoded === null ? [] : parseRecords(JSON.parse(encoded));
  } catch (error) {
    throw new Error(`Unreadable saved EVM Wallet intents; no record was replaced: ${error instanceof Error ? error.message : String(error)}`);
  }
  const commit = (next: EvmDemoRecord): { records: EvmDemoRecord[] } => {
    const other = records.filter((record) => record.intent.id !== next.intent.id);
    storage.setItem(EVM_DEMO_STORAGE_KEY, JSON.stringify({ records: [...other, next] }));
    return { records: [next] };
  };
  if (action.action === "list") return { records };
  if (action.action === "prepare") {
    validateIntent(action.intent);
    const sameId = records.find((record) => record.intent.id === action.intent.id);
    if (sameId) {
      if (canonical(sameId.intent) !== canonical(action.intent)) throw new Error("Changed EVM intent conflicts with its saved request ID.");
      return { records: [sameId] };
    }
    const active = records.find((record) => record.intent.kind === action.intent.kind && record.intent.chainId === action.intent.chainId &&
      record.intent.account.accountId === action.intent.account.accountId && !evmDemoRecordTerminal(record));
    if (active) {
      if (semanticIntent(active.intent) !== semanticIntent(action.intent)) throw new Error("An unresolved EVM intent already exists for this example and chain. Resume its saved request before preparing a different effect.");
      return { records: [active] };
    }
    return commit({ intent: action.intent, revision: 0, progress: action.intent.steps.map(() => ({ attempted: false, operation: null, error: null, signatureVerified: false })) });
  }
  const current = records.find((record) => record.intent.id === action.id);
  if (!current) throw new Error("Saved EVM Wallet intent was not found.");
  if (action.action === "get" || action.revision !== current.revision) return { records: [current] };
  const previous = current.progress[action.step];
  if (!previous || !current.intent.steps[action.step]) throw new Error("Invalid saved EVM step.");
  const progress = current.progress.map((entry) => ({ ...entry }));
  if (action.action === "attempting") progress[action.step] = { ...previous, attempted: true, error: null };
  if (action.action === "failed") progress[action.step] = { ...previous, error: action.error };
  if (action.action === "observed") {
    const operation = assertEvmDemoOperation(current.intent, action.step, action.operation);
    if (previous.operation && previous.operation.operationId !== operation.operationId) throw new Error("EVM Wallet changed the operation ID for a saved request.");
    progress[action.step] = { attempted: true, operation, error: null, signatureVerified: action.signatureVerified };
  }
  return commit({ ...current, revision: current.revision + 1, progress });
}

export function createEvmDemoJournal(bus: Pick<MsgBusClient, "callTool">): EvmDemoJournal {
  const call = async (action: EvmDemoAction): Promise<EvmDemoRecord[]> => {
    const value = await bus.callTool({ target: "app:kitchensink:background", name: EVM_DEMO_INTENT_TOOL, arguments: action as unknown as JsonObject }, 10);
    return parseRecords(value);
  };
  const one = async (action: EvmDemoAction): Promise<EvmDemoRecord> => {
    const values = await call(action);
    if (values.length !== 1) throw new Error("Invalid resident EVM intent response.");
    return values[0]!;
  };
  return {
    list: () => call({ action: "list" }),
    get: (id) => one({ action: "get", id }),
    prepare: (intent) => one({ action: "prepare", intent }),
    attempting: (record, step) => one({ action: "attempting", id: record.intent.id, revision: record.revision, step }),
    observed: (record, step, operation, signatureVerified) => one({ action: "observed", id: record.intent.id, revision: record.revision, step, operation, signatureVerified }),
    failed: (record, step, error) => one({ action: "failed", id: record.intent.id, revision: record.revision, step, error }),
  };
}

function parseRecords(value: unknown): EvmDemoRecord[] {
  if (!isJsonObject(value)) throw new Error("Invalid saved EVM records.");
  validateToolArguments(resultDescriptor, value as JsonObject);
  const { records } = value as { records: EvmDemoRecord[] };
  const ids = new Set<string>();
  for (const record of records) {
    validateIntent(record.intent);
    if (ids.has(record.intent.id) || record.progress.length !== record.intent.steps.length || !Number.isSafeInteger(record.revision)) throw new Error("Invalid saved EVM record.");
    ids.add(record.intent.id);
    record.progress.forEach((step, index) => { if (step.operation) assertEvmDemoOperation(record.intent, index, step.operation); });
  }
  return records;
}

function validateIntent(intent: EvmDemoIntent): void {
  const expectedSteps = intent.kind === "approval_call" ? 2 : 1;
  if (intent.steps.length !== expectedSteps || intent.id !== intent.steps[0]?.request.requestId) throw new Error("Invalid EVM demo sequence.");
  const requestIds = new Set<string>();
  for (const step of intent.steps) {
    const expectedKind = intent.kind === "message" ? "message" : intent.kind === "typed_data" ? "typed_data" : "transaction";
    if (requestIds.has(step.request.requestId) || step.kind !== expectedKind || step.request.chainId !== intent.chainId || step.request.accountId !== intent.account.accountId) throw new Error("Saved EVM steps must have distinct IDs and the same explicit account and chain.");
    requestIds.add(step.request.requestId);
  }
}

function semanticIntent(intent: EvmDemoIntent): string {
  return canonical({ kind: intent.kind, chainId: intent.chainId, account: intent.account, steps: intent.steps.map(({ kind, request }) => {
    const { requestId: _requestId, ...effect } = request;
    return { kind, request: effect };
  }) });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}
