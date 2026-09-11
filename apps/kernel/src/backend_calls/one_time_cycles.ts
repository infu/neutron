import { Principal } from "@dfinity/principal";
import { assertBoundedJson, KernelPolicyError, type JsonValue, type OneTimeCycleCallRequest, type OneTimeCycleCallQuote, type OneTimeCycleCallReceipt, type OneTimeCycleCallPage, type OneTimeCycleCallSummary } from "neutron-tools/protocol";
import { CANISTER_METHOD_MAX_LENGTH } from "neutron-tools/src/physical_names.js";
import type { RegisteredEndpoint } from "../frame_context.ts";
import { requestBackendCallConsent } from "../reducer/backend_calls.ts";
import { throwIfRequestCancelled } from "../request_cancel.ts";
import { assertEndpointCurrent, requestSource, requireDeclaration } from "./service.ts";

export type OwnerCycleTransport = {
  quote: (request: unknown) => Promise<unknown>;
  execute: (request: unknown) => Promise<unknown>;
  status: (request: unknown) => Promise<unknown>;
  list: (request: unknown) => Promise<unknown>;
};

const defaultTransport: OwnerCycleTransport = {
  async quote(request) { return (await actor()).kernel_owner_cycle_call_quote_v1(request); },
  async execute(request) { return (await actor()).kernel_owner_cycle_call_execute_v1(request); },
  async status(request) { return (await actor()).kernel_owner_cycle_call_status_v1(request); },
  async list(request) { return (await actor()).kernel_owner_cycle_call_list_v1(request); },
};

/** The sole execution path always asks the owner. Agent authority cannot supply
 * this consent, and no durable permission or budget increase is written. */
export async function oneTimeCycleCallForEndpoint(
  action: "quote" | "request" | "status" | "list",
  payload: JsonValue,
  endpoint: RegisteredEndpoint,
  signal?: AbortSignal,
  transport: OwnerCycleTransport = defaultTransport,
): Promise<JsonValue> {
  let confirmedNoSavedCall = false;
  let executionStarted = false;
  try {
    requireDeclaration(endpoint);
    const binding = endpoint.sessionId ? { endpointSession: endpoint.sessionId } : {};
    const active = () => { throwIfRequestCancelled(signal); assertEndpointCurrent(endpoint, binding); };
    active();
    const scope = endpoint.appScope;
    if (!scope) throw new Error("The requesting app has no current installation scope");
    const appScope = { app_id: endpoint.context.appId, installation_uid: BigInt(scope.installationUid) };
    const input = record(payload);
    if (action === "status") {
      onlyKeys(input, ["requestId"]);
      const result = optional(await transport.status({ app_scope: appScope, id: fromHex(id(input.requestId)) }));
      active();
      return json(result == null ? null : receipt(result));
    }
    if (action === "list") {
      onlyKeys(input, ["before", "limit"]);
      const before = input.before === undefined ? [] : [BigInt(nat(input.before))];
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || Number(limit) <= 0) throw new Error("limit must be a positive integer");
      const page = record(await transport.list({ app_scope: appScope, before, limit: BigInt(Number(limit)) }));
      active();
      if (!Array.isArray(page.calls)) throw new Error("Invalid cycle call history");
      return json({ calls: page.calls.map(summary), nextBefore: optionalNat(page.next_before) } satisfies OneTimeCycleCallPage);
    }
    const request = normalizeRequest(input);
    const candid = { id: fromHex(request.requestId), app_scope: appScope, call: { canister: Principal.fromText(request.canister), method: request.method, args: fromHex(request.argsHex), cycles: BigInt(request.cyclesAtoms) }, allow_partial: request.allowPartial ?? false };
    if (action === "request") {
      if (request.cyclesAtoms === "0") throw new Error("Choose an amount of cycles greater than zero");
      const saved = optional(await transport.status({ app_scope: appScope, id: candid.id }));
      confirmedNoSavedCall = saved == null;
      active();
      if (saved != null) {
        const result = receipt(saved);
        if (!sameRequest(result.request, request)) throw new Error("This request id belongs to a different cycle call");
        // Never execute again, including records whose original response is unknown.
        return json(result);
      }
    }
    const quoted = quote(unwrap(await transport.quote(candid)), request.cyclesAtoms);
    active();
    if (action === "quote") return json(quoted);
    if (!request.allowPartial && BigInt(quoted.selectedCyclesAtoms) > BigInt(quoted.maxCyclesAtoms)) throw new Error("This amount would leave less than the required Neutron reserve. Choose a smaller amount or allow up to this amount.");
    if (BigInt(quoted.selectedCyclesAtoms) === 0n) throw new Error("No cycles are available above the Neutron reserve");
    await requestBackendCallConsent({ endpoint: endpoint.endpointId, ...binding, appId: endpoint.context.appId, source: requestSource(endpoint), actions: [], oneTimeCycleCall: Object.freeze({ ...request, ...quoted }) }, signal);
    active();
    // The backend atomically journals the exact call and rechecks the reserve and
    // installation at dispatch. A lost response is recovered through status.
    executionStarted = true;
    const result = receipt(unwrap(await transport.execute(candid)));
    active();
    if (!sameRequest(result.request, request)) throw new Error("Cycle receipt does not match the approved call");
    return json(result);
  } catch (error) {
    // Only this invocation's own pre-dispatch stage is known. A missing status
    // alone, a failed lookup, or an interrupted execution never proves safety.
    if (action === "request" && confirmedNoSavedCall && !executionStarted) {
      throw new KernelPolicyError(error instanceof KernelPolicyError && error.code === "REQUEST_CANCELLED"
        ? "ONE_TIME_CYCLE_CALL_CANCELLED" : "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED",
        error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function normalizeRequest(input: Record<string, unknown>): Readonly<OneTimeCycleCallRequest> {
  onlyKeys(input, ["requestId", "canister", "method", "argsHex", "cyclesAtoms", "allowPartial"]);
  const canister = String(input.canister ?? "");
  if (Principal.fromText(canister).toText() !== canister) throw new Error("Invalid canonical canister principal");
  const method = String(input.method ?? "");
  if (!/^[a-zA-Z0-9_]+$/.test(method) || method.length > CANISTER_METHOD_MAX_LENGTH) throw new Error("Invalid canister method");
  if (input.allowPartial !== undefined && typeof input.allowPartial !== "boolean") throw new Error("allowPartial must be true or false");
  const argsHex = hex(input.argsHex);
  if (!argsHex.startsWith("4449444c")) throw new Error("argsHex must contain complete Candid arguments");
  return Object.freeze({ requestId: id(input.requestId), canister, method, argsHex, cyclesAtoms: nat(input.cyclesAtoms), allowPartial: input.allowPartial === true });
}

function quote(raw: unknown, requested: string): OneTimeCycleCallQuote {
  const value = record(raw);
  const balance = nat(value.balance), actual = nat(value.actual_cycles), cost = nat(value.call_cost);
  const remaining = BigInt(balance) - BigInt(actual) - BigInt(cost);
  return { balanceAtoms: balance, callCostAtoms: cost, reserveAtoms: nat(value.min_remaining_cycles), maxCyclesAtoms: nat(value.max_cycles), requestedCyclesAtoms: requested, selectedCyclesAtoms: actual, remainingCyclesAtoms: String(remaining < 0n ? 0n : remaining), usualLimitPerCallAtoms: nat(value.max_cycles_per_call), usualLimitPerDayAtoms: nat(value.max_cycles_per_day) };
}

function receipt(raw: unknown): OneTimeCycleCallReceipt {
  const value = record(raw), saved = record(value.request), call = record(saved.call);
  const result = optional(value.result);
  return {
    request: { requestId: toHex(saved.id), canister: principal(call.canister), method: text(call.method), argsHex: toHex(call.args), cyclesAtoms: nat(call.cycles), allowPartial: bool(saved.allow_partial) },
    ...receiptFacts(value),
    result: result == null ? null : "ok" in record(result) ? { replyHex: toHex(record(result).ok) } : { error: errorFields(record(result).err) },
  };
}

function summary(raw: unknown): OneTimeCycleCallSummary {
  const value = record(raw);
  return { request: { requestId: toHex(value.id), canister: principal(value.canister), method: text(value.method), cyclesAtoms: nat(value.requested_cycles), allowPartial: bool(value.allow_partial) }, ...receiptFacts(value), outcome: !bool(value.settled) ? "pending" : optional(value.error) == null ? "replied" : "rejected" };
}

function receiptFacts(value: Record<string, unknown>) {
  return { sequence: nat(value.sequence), createdAtNs: nat(value.created_at), updatedAtNs: nat(value.updated_at), dispatched: bool(value.dispatched), actualCyclesAtoms: nat(value.actual_cycles), chargedCyclesAtoms: optionalNat(value.charged_cycles) };
}
function sameRequest(a: OneTimeCycleCallRequest, b: OneTimeCycleCallRequest) { return a.requestId === b.requestId && a.canister === b.canister && a.method === b.method && a.argsHex === b.argsHex && a.cyclesAtoms === b.cyclesAtoms && Boolean(a.allowPartial) === Boolean(b.allowPartial); }
function record(value: unknown): Record<string, unknown> { if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cycle call response or request"); return value as Record<string, unknown>; }
function onlyKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unexpected cycle call request field"); }
function nat(value: unknown): string { if (typeof value === "bigint" && value >= 0n) return String(value); if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid cycle count or sequence"); return value; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid cycle call text"); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid cycle call flag"); return value; }
function hex(value: unknown): string { if (typeof value !== "string" || !/^(?:[a-f0-9]{2})*$/.test(value)) throw new Error("Invalid lowercase hexadecimal bytes"); return value; }
function id(value: unknown): string { const result = hex(value); if (result.length !== 32) throw new Error("requestId must contain 16 hexadecimal bytes"); return result; }
function fromHex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16)); }
function toHex(value: unknown): string { if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new Error("Invalid cycle call bytes"); return Array.from(value as Uint8Array, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function principal(value: unknown): string { if (typeof value === "string") return Principal.fromText(value).toText(); return Principal.from(value as Principal).toText(); }
function optional(value: unknown): unknown | null { if (value == null) return null; if (Array.isArray(value)) { if (value.length > 1) throw new Error("Invalid optional cycle call field"); return value[0] ?? null; } return value; }
function optionalNat(value: unknown): string | null { const entry = optional(value); return entry == null ? null : nat(entry); }
function errorFields(value: unknown): {code:string;message:string} { const error = record(value); return { code: text(error.code), message: text(error.message) }; }
function unwrap(value: unknown): unknown { const result = record(value); if ("ok" in result) return result.ok; const error = errorFields(result.err); throw Object.assign(new Error(error.message), { code: error.code }); }
function json(value: unknown): JsonValue { assertBoundedJson(value, "One-time cycle call response"); return value as JsonValue; }
async function actor() { return (await import("../reducer/auth.ts")).getNeutronCan(); }
