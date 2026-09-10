import { HttpAgent } from "@dfinity/agent";
import type { Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { isJsonObject, requestBackendCallReservationsForTool, type BackendCallReservationsRequest } from "neutron-tools/app";
import type { Kernel, StoredState } from "./store.ts";
import { bytes, unwrap, validateHost } from "./store.ts";

export type Method = { args: IDL.Type[]; returns: IDL.Type[]; update?: boolean };
export type Contract = Record<string, Method>;
export type QueryAgent = Pick<HttpAgent, "query">;
export const UPDATE_METHODS = ["read_delegate_set", "purchase", "withdraw", "referral_get_or_create", "rating_set", "listing_save", "upload_begin", "upload_chunk", "upload_finish", "candidate_submit", "install_prepare", "ethereum_prepare", "ethereum_verify", "ethereum_settle", "ethereum_cancel"] as const;

export async function makeAgent(state: StoredState, identity?: Identity): Promise<HttpAgent> {
  const host = validateHost(state.host);
  const agent = await HttpAgent.create({ host, ...(identity ? { identity } : {}) });
  const hostname = new URL(host).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") await agent.fetchRootKey();
  return agent;
}
type ReservationRequest = (kernel: Kernel, request: BackendCallReservationsRequest) => Promise<unknown>;

/** A Kernel snapshot contains this app's durable grants. Validate every entry:
 * an unavailable or malformed snapshot must never be mistaken for permission. */
function reservedMethods(value: unknown, canister: string): Set<string> {
  if (!isJsonObject(value) || !Array.isArray(value.reservations)) throw new Error("Marketplace backend access is unavailable: invalid reservation list.");
  const methods = new Set<string>();
  for (const row of value.reservations) {
    if (!isJsonObject(row)) throw new Error("Marketplace backend access is unavailable: invalid reservation.");
    const principal = typeof row.principal === "string" && row.principal.length > 0;
    const method = typeof row.method === "string" && row.method.length > 0;
    if (row.scopeKind === "exact" && principal && method) {
      if (row.principal === canister) methods.add(row.method as string);
    } else if (!((row.scopeKind === "principal" && principal) || (row.scopeKind === "method" && method))) {
      throw new Error("Marketplace backend access is unavailable: invalid reservation scope.");
    }
  }
  return methods;
}

export function makeTransport(input: { canisterId: string; agent: QueryAgent; contract: Contract; kernel: Kernel; requestReservations?: ReservationRequest }) {
  const canister = Principal.fromText(input.canisterId);
  function signature(method: string, update: boolean): Method {
    const signature = input.contract[method];
    if (!signature || !!signature.update !== update) throw new Error(`The marketplace does not expose ${method} as a ${update ? "write" : "read"}.`);
    return signature;
  }
  function decode(method: Method, value: unknown): unknown {
    const values = IDL.decode(method.returns, bytes(value));
    return values.length === 1 ? values[0] : values;
  }
  return {
    async query<T>(name: string, args: unknown[] = []): Promise<T> {
      const method = signature(name, false);
      const response = await input.agent.query(canister, { methodName: name, arg: IDL.encode(method.args, args) });
      if (response.status !== "replied") throw new Error(`Marketplace read failed: ${response.reject_message}`);
      return decode(method, response.reply.arg) as T;
    },
    async update<T>(name: string, args: unknown[], cycles: bigint): Promise<T> {
      const method = signature(name, true);
      if (cycles < 0n) throw new Error("The marketplace cycle estimate is invalid.");
      const response = await input.kernel.updateSelf("marketplace_call", [{
        canister: canister.toText(), method: name, args: new Uint8Array(IDL.encode(method.args, args)), cycles: String(cycles),
      }], 0);
      return decode(method, unwrap(response)) as T;
    },
    async reserve(): Promise<void> {
      const principal = canister.toText();
      const existing = reservedMethods(await input.kernel.callTool({ target: "kernel", name: "backend_calls.list", arguments: {} }), principal);
      const missing = UPDATE_METHODS.filter(method => !existing.has(method));
      if (missing.length === 0) return;
      const request = input.requestReservations ?? requestBackendCallReservationsForTool;
      const confirmed = reservedMethods(await request(input.kernel, {
        actions: missing.map(method => ({ kind: "reserve", scope: { kind: "exact", principal, method } })),
      }), principal);
      if (UPDATE_METHODS.some(method => !confirmed.has(method))) throw new Error("Marketplace backend access was not confirmed. Retry setup to check the current permissions.");
    },
  };
}
export type ProtocolTransport = ReturnType<typeof makeTransport>;

/** Preserve Candid integers and bytes in saved intents without lossy number conversion. */
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return [...value];
  if (value instanceof Principal) return value.toText();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJson(entry)]));
  return value;
}
