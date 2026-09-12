/** Durable SNS action journal. All calls use the invocation's scoped Kernel. */
import type { JsonObject, JsonValue, ScopedKernelClient, SelfCallObject } from "neutron-tools/app";
import { hashContent } from "neutron-tools/src/hash.js";

export type OperationKernel = Pick<ScopedKernelClient, "querySelf" | "updateSelf">;
export type OperationStepStatus = "prepared" | "dispatching" | "replied" | "unknown";
export interface OperationStep {
  step_id: string;
  args: Uint8Array;
  method?: string;
  status: OperationStepStatus;
  reply?: Uint8Array;
  error?: string;
  attempted_at_seconds?: string;
  finished_at_seconds?: string;
}
export interface OperationDetail {
  operation_id: string;
  sns: string;
  governance: string;
  input_json: string;
  review_json: string;
  state_json: string;
  initiator: string;
  seq: string;
  revision: string;
  created_at_seconds: string;
  updated_at_seconds: string;
  steps: OperationStep[];
  kind?: string;
  title?: string;
}
export interface OperationPrepare {
  operation_id: string;
  sns: string;
  governance: string;
  input_json: string;
  review_json: string;
  state_json: string;
  initiator: string;
  steps: { step_id: string; args: Uint8Array; method?: string }[];
}
export interface OperationPage {
  rows: JsonObject[];
  next_before: string | null;
  total: string;
}
export const OPERATION_METHODS = {
  prepare: "snsgov_operation_prepare", get: "snsgov_operation_get", list: "snsgov_operation_list",
  dispatch: "snsgov_operation_dispatch", update: "snsgov_operation_update",
} as const;

export function operationJson(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array || value instanceof Int32Array || value instanceof BigUint64Array) return Array.from(value as ArrayLike<unknown>, operationJson);
  if (Array.isArray(value)) return value.map(operationJson);
  if (typeof value === "object") {
    if ("toText" in value && typeof value.toText === "function") return value.toText();
    return Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, operationJson(v)]));
  }
  throw new Error("SNS operation contains a value that cannot be retained");
}
export const operationJsonText = (value: unknown): string => JSON.stringify(operationJson(value));

/** Exact command bytes travel once, in the journal's binary step attachment. */
export function commandEvidence(args: Uint8Array): JsonObject {
  return { byteLength: args.byteLength, sha256: hashContent(args) };
}

/** Presentation only: the complete value remains in the retained Candid step. */
export function compactReviewValue(value: unknown): JsonValue {
  if (value instanceof Uint8Array) {
    return { kind: "blob", ...commandEvidence(value), ...(value.length <= 64 ? { hex: Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("") } : {}) };
  }
  if (typeof value === "string" && new TextEncoder().encode(value).length > 1024) {
    return { kind: "text", utf8Bytes: new TextEncoder().encode(value).length, sha256: hashContent(value), preview: Array.from(value).slice(0, 256).join("") };
  }
  if (Array.isArray(value)) return value.map(compactReviewValue);
  if (value && typeof value === "object" && !("toText" in value) && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, compactReviewValue(child)]));
  }
  return operationJson(value);
}

/** Keep human fields readable while binding unusually long text exactly. */
export function compactReviewText(value: string): string {
  const evidence = compactReviewValue(value);
  if (typeof evidence === "string") return evidence;
  const text = evidence as JsonObject;
  return `${text.preview}… (${text.utf8Bytes} UTF-8 bytes; SHA-256 ${text.sha256}; full text in the retained command)`;
}
export function operationObject(text: string, label = "operation state"): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

export function createOperationClient(kernel: OperationKernel) {
  return {
    async get(operationId: string): Promise<OperationDetail | null> {
      const value = await kernel.querySelf(OPERATION_METHODS.get, [operationId]);
      return value === null || value === undefined ? null : parseOperation(value);
    },
    async prepare(input: OperationPrepare): Promise<OperationDetail> {
      const label = (json: string, key: string, fallback: string) => {
        try { const value=operationObject(json)[key]; return typeof value==="string"&&value.trim()?value:fallback; }
        catch { return fallback; }
      };
      return parseOperation(await kernel.updateSelf(OPERATION_METHODS.prepare, [{...input,kind:label(input.input_json,"kind","operation"),title:label(input.review_json,"title","SNS operation")} as unknown as SelfCallObject]));
    },
    async dispatch(operationId: string, stepId: string): Promise<OperationDetail> {
      try {
        return parseOperation(await kernel.updateSelf(OPERATION_METHODS.dispatch, [{ operation_id: operationId, step_id: stepId }], 180));
      } catch (error) {
        // An interrupted update is not proof of no dispatch. Read the durable
        // record once; never issue a replacement call here.
        try {
          const value = await kernel.querySelf(OPERATION_METHODS.get, [operationId]);
          if (value !== null && value !== undefined) return parseOperation(value);
        } catch { /* Preserve the original failure if status is also unavailable. */ }
        throw error;
      }
    },
    async update(operation: OperationDetail, state: JsonObject): Promise<OperationDetail> {
      return parseOperation(await kernel.updateSelf(OPERATION_METHODS.update, [{
        operation_id: operation.operation_id, expected_revision: operation.revision, state_json: operationJsonText(state),
      }]));
    },
    async list(input: { before?: string; limit?: string } = {}): Promise<OperationPage> {
      const value = record(await kernel.querySelf(OPERATION_METHODS.list, [{ ...input, limit: input.limit ?? "100" }]), "operation list");
      if (!Array.isArray(value.rows)) throw new Error("Invalid operation rows");
      return { rows: value.rows as JsonObject[], next_before: value.next_before == null ? null : decimal(value.next_before, "cursor"), total: decimal(value.total, "total") };
    },
  };
}
export type OperationClient = ReturnType<typeof createOperationClient>;

export function parseOperation(value: unknown): OperationDetail {
  const row = record(value, "SNS operation");
  if (!Array.isArray(row.steps)) throw new Error("SNS operation omitted its retained steps");
  const steps = row.steps.map((value): OperationStep => {
    const step = record(value, "operation step");
    if (!["prepared", "dispatching", "replied", "unknown"].includes(String(step.status))) throw new Error("Unknown SNS operation step status");
    return {
      step_id: text(step.step_id, "step ID"), args: bytes(step.args), method: step.method == null ? "manage_neuron" : text(step.method,"step method"), status: step.status as OperationStepStatus,
      ...(step.reply == null ? {} : { reply: bytes(step.reply) }),
      ...(step.error == null ? {} : { error: text(step.error, "step error") }),
      ...(step.attempted_at_seconds == null ? {} : { attempted_at_seconds: decimal(step.attempted_at_seconds, "attempt timestamp") }),
      ...(step.finished_at_seconds == null ? {} : { finished_at_seconds: decimal(step.finished_at_seconds, "finish timestamp") }),
    };
  });
  return {
    operation_id: text(row.operation_id, "operation ID"), sns: principalText(row.sns), governance: principalText(row.governance),
    input_json: text(row.input_json, "operation input"), review_json: text(row.review_json, "operation review"),
    state_json: text(row.state_json, "operation state"), initiator: text(row.initiator, "initiator"),
    seq: decimal(row.seq, "sequence"), revision: decimal(row.revision, "revision"),
    created_at_seconds: decimal(row.created_at_seconds, "created timestamp"), updated_at_seconds: decimal(row.updated_at_seconds, "updated timestamp"), steps,
    ...(typeof row.kind==="string"?{kind:row.kind}:{}),...(typeof row.title==="string"?{title:row.title}:{}),
  };
}
function principalText(value: unknown): string {
  return typeof value === "object" && value !== null && "toText" in value && typeof value.toText === "function" ? value.toText() : text(value, "principal");
}
function text(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`Invalid ${label}`); return value; }
function decimal(value: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value.toString();
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value) && value.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return Uint8Array.from(value);
  throw new Error("Invalid retained SNS command bytes");
}

/** Merge independently completed evidence after concurrent dispatch/state updates. */
export async function mergeOperationState(client:OperationClient,operation:OperationDetail,merge:(current:JsonObject)=>JsonObject):Promise<OperationDetail>{
  let current=operation;
  for(;;){
    const state=operationObject(current.state_json),next=merge(state);
    if(operationJsonText(next)===operationJsonText(state))return current;
    try{return await client.update(current,next);}
    catch(error){
      const latest=await client.get(current.operation_id);
      if(!latest||latest.revision===current.revision)throw error;
      current=latest;
    }
  }
}
