import { Actor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { querySelf, updateSelf, publishAppStateChange, type JsonValue, type SelfCallObject, type SelfCallValue } from "neutron-tools/app";
import { queryAgent } from "./native.ts";
import { queryWalletRead } from "./wallet_read.ts";
import { parseWalletSnapshot } from "./wallet_data.ts";
import { WALLET_PROJECTION_TOPIC } from "./wallet_projection.ts";
import { transferIdBytes } from "./transfers.ts";

export const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const TCYCLES_LEDGER = "um5iw-rqaaa-aaaaq-qaaba-cai";
export const CYCLES_MINTING_CANISTER = "rkp4c-7iaaa-aaaaa-aaaca-cai";
export type RefillKind = "icp_topup" | "tcycles_topup" | "icp_to_tcycles";
export type RefillInput = { kind: RefillKind; amountAtoms: string; target: string };
export type RefillToken = { ledger: string; symbol: "ICP" | "TCYCLES"; decimals: 8 | 12; balanceAtoms: string | null; feeAtoms: string | null; error: string | null };
export type RefillSnapshot = {
  owner: string; observedAt: number; icp: RefillToken; tcycles: RefillToken;
  rate: { xdrPermyriadPerIcp: string; timestampSeconds: string } | null; errors: string[];
};
export type RefillQuote = RefillInput & {
  version: 1; owner: string; source: "ICP" | "TCYCLES"; sourceDecimals: 8 | 12;
  sourceFeeAtoms: string; totalDebitAtoms: string; estimatedCycles: string;
  estimatedReceivedCycles: string; icpFeeAtoms: string; cyclesFeeAtoms: string;
  observedAt: number; warnings: string[];
};
export type RefillPhase = "prepared" | "transfer_pending" | "notify_pending" | "withdraw_pending" | "forward_pending" | "complete" | "refunded" | "stopped";
export type RefillOperation = RefillInput & {
  requestId: string; icpFeeAtoms: string; cyclesFeeAtoms: string; estimatedCycles: string;
  createdAtNs: string; updatedAtNs: string; phase: RefillPhase;
  sourceBlockIndex: string | null; mintBlockIndex: string | null; forwardBlockIndex: string | null;
  refundBlockIndex: string | null; creditedCycles: string | null; mintedCycles: string | null;
  duplicate: boolean; error: string | null; canContinue: boolean;
};
export type RefillCursor = { createdAtNs: string; requestId: string };
export type RefillPage = { operations: RefillOperation[]; nextCursor: RefillCursor | null };
export type RefillPageOptions = { before?: RefillCursor | null; limit?: number; pendingOnly?: boolean };
export type RefillCalls = {
  querySelf(method: string, args: SelfCallValue[], timeout?: number): Promise<unknown>;
  updateSelf(method: string, args: SelfCallValue[], timeout?: number): Promise<unknown>;
};
const defaultCalls: RefillCalls = { querySelf, updateSelf };

/** Public ledger and CMC reads go directly from this browser to the IC. */
export async function loadRefillSnapshot(owner: string, href = window.location.href): Promise<RefillSnapshot> {
  const principal = Principal.fromText(owner);
  const agent = await queryAgent(href);
  const account = { owner: principal, subaccount: [] as [] };
  const readToken = async (ledger: string, symbol: RefillToken["symbol"], decimals: 8 | 12): Promise<RefillToken> => {
    const actor = Actor.createActor<{
      icrc1_balance_of(account: { owner: Principal; subaccount: [] }): Promise<bigint>;
      icrc1_fee(): Promise<bigint>; icrc1_decimals(): Promise<number>;
    }>(ledgerIdl, { agent, canisterId: ledger });
    const [balance, fee, actualDecimals] = await Promise.allSettled([
      actor.icrc1_balance_of(account), actor.icrc1_fee(), actor.icrc1_decimals(),
    ]);
    const errors = [balance, fee, actualDecimals].flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
    if (actualDecimals.status === "fulfilled" && actualDecimals.value !== decimals) errors.push(`${symbol} decimals do not match its supported ledger`);
    const unitsKnown = actualDecimals.status === "fulfilled" && actualDecimals.value === decimals;
    return {
      ledger, symbol, decimals,
      balanceAtoms: unitsKnown && balance.status === "fulfilled" ? balance.value.toString() : null,
      feeAtoms: unitsKnown && fee.status === "fulfilled" ? fee.value.toString() : null,
      error: errors.length ? errors.join("; ") : null,
    };
  };
  const cmc = Actor.createActor<{ get_icp_xdr_conversion_rate(): Promise<{ data: { xdr_permyriad_per_icp: bigint; timestamp_seconds: bigint } }> }>(cmcIdl, { agent, canisterId: CYCLES_MINTING_CANISTER });
  const [icp, tcycles, rate] = await Promise.all([
    readToken(ICP_LEDGER, "ICP", 8), readToken(TCYCLES_LEDGER, "TCYCLES", 12),
    cmc.get_icp_xdr_conversion_rate().then((value) => ({ value, error: null as string | null }), (error) => ({ value: null, error: errorMessage(error) })),
  ]);
  return {
    owner: principal.toText(), observedAt: Date.now(), icp, tcycles,
    rate: rate.value ? { xdrPermyriadPerIcp: rate.value.data.xdr_permyriad_per_icp.toString(), timestampSeconds: rate.value.data.timestamp_seconds.toString() } : null,
    errors: [icp.error, tcycles.error, rate.error].filter((value): value is string => value !== null),
  };
}

export async function readRefillOwner(calls: RefillCalls = defaultCalls): Promise<string> {
  return parseWalletSnapshot(await queryWalletRead(calls.querySelf.bind(calls), "snapshot") as JsonValue).owner;
}

/** Amount is the amount converted or delivered; the source ledger fee is extra. */
export function quoteRefill(input: RefillInput, snapshot: RefillSnapshot): RefillQuote {
  const kind = refillKind(input.kind);
  const amount = positiveNat(input.amountAtoms, "amount");
  const destination = Principal.fromText(input.target);
  const target = destination.toText();
  if (destination.isAnonymous()) throw new Error("Enter a canister or recipient principal");
  if (target === "aaaaa-aa") throw new Error("Choose a canister or account, not the management canister");
  const targetBytes = destination.toUint8Array();
  if (kind !== "icp_to_tcycles" && targetBytes.at(-1) === 2) throw new Error("A refill needs a canister ID. This principal identifies a user account instead.");
  const owner = Principal.fromText(snapshot.owner).toText();
  const token = kind === "tcycles_topup" ? snapshot.tcycles : snapshot.icp;
  if (token.feeAtoms === null || token.balanceAtoms === null) throw new Error(`${token.symbol} balance and fee are unavailable. Refresh and try again.`);
  const sourceFee = BigInt(nat(token.feeAtoms, "source fee"));
  const total = BigInt(amount) + sourceFee;
  if (total > BigInt(nat(token.balanceAtoms, "source balance"))) throw new Error(`Not enough ${token.symbol} for this amount and its transfer fee`);
  let gross = BigInt(amount);
  if (kind !== "tcycles_topup") {
    if (!snapshot.rate) throw new Error("The current ICP conversion rate is unavailable. Refresh and try again.");
    // ICP has 8 decimals; CMC quotes 1/10,000 XDR per ICP; 1 XDR = 10^12 cycles.
    gross = BigInt(amount) * BigInt(positiveNat(snapshot.rate.xdrPermyriadPerIcp, "ICP conversion rate"));
  }
  let net = gross;
  const warnings: string[] = [];
  if (kind === "icp_to_tcycles") {
    if (snapshot.tcycles.feeAtoms === null) throw new Error("The TCYCLES mint fee is unavailable. Refresh and try again.");
    const fee = BigInt(nat(snapshot.tcycles.feeAtoms, "TCYCLES fee"));
    net -= fee;
    if (target !== owner) net -= fee;
    if (net <= 0n) throw new Error("This amount is too small to cover the TCYCLES mint and delivery fees");
    if (target !== owner) warnings.push("TCYCLES are first minted to your Neutron, then sent to this recipient. The additional delivery fee is included.");
  }
  if (kind !== "tcycles_topup") warnings.push("The ICP conversion rate can change before conversion. The received amount is an estimate.");
  return {
    ...input, kind, target, amountAtoms: amount, version: 1, owner,
    source: token.symbol, sourceDecimals: token.decimals, sourceFeeAtoms: sourceFee.toString(), totalDebitAtoms: total.toString(),
    estimatedCycles: gross.toString(), estimatedReceivedCycles: net.toString(),
    icpFeeAtoms: kind === "tcycles_topup" ? "0" : snapshot.icp.feeAtoms!, cyclesFeeAtoms: kind === "icp_topup" ? "0" : snapshot.tcycles.feeAtoms!,
    observedAt: snapshot.observedAt, warnings,
  };
}

export function maxRefillAmount(token: RefillToken): string {
  if (token.balanceAtoms === null || token.feeAtoms === null) return "0";
  const balance = BigInt(nat(token.balanceAtoms, "balance"));
  const fee = BigInt(nat(token.feeAtoms, "fee"));
  return balance > fee ? (balance - fee).toString() : "0";
}
export function createRefillRequestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
export function refillPrepareArgs(quote: RefillQuote, requestId: string): SelfCallObject {
  return { id: transferIdBytes(requestId), kind: { [refillKind(quote.kind)]: null }, target: Principal.fromText(quote.target).toText(),
    amount: positiveNat(quote.amountAtoms, "amount"), icp_fee: nat(quote.icpFeeAtoms, "ICP fee"), cycles_fee: nat(quote.cyclesFeeAtoms, "TCYCLES fee"), estimated_cycles: positiveNat(quote.estimatedCycles, "estimated cycles") };
}
export async function prepareRefill(quote: RefillQuote, requestId = createRefillRequestId(), calls: RefillCalls = defaultCalls): Promise<RefillOperation> {
  const operation = parseRefillOperation(await calls.updateSelf("wallet_refill_action_v1", [{ prepare: refillPrepareArgs(quote, requestId) }], 60));
  assertRefillMatches(operation, { ...quote, requestId });
  return operation;
}
export async function executeRefill(requestId: string, calls: RefillCalls = defaultCalls): Promise<RefillOperation> {
  try { return assertReturnedRefillId(parseRefillOperation(await calls.updateSelf("wallet_refill_action_v1", [{ execute: transferIdBytes(requestId) }], 180)), requestId); }
  finally { if (calls === defaultCalls) await notifyRefillChange(); }
}
export async function continueRefill(requestId: string, calls: RefillCalls = defaultCalls): Promise<RefillOperation> {
  try { return assertReturnedRefillId(parseRefillOperation(await calls.updateSelf("wallet_refill_action_v1", [{ continue_: transferIdBytes(requestId) }], 180)), requestId); }
  finally { if (calls === defaultCalls) await notifyRefillChange(); }
}
export async function readRefillStatus(requestId: string, calls: RefillCalls = defaultCalls): Promise<RefillOperation | null> {
  const response = record(await calls.querySelf("wallet_read_v1", [{ refill_status: transferIdBytes(requestId) }]), "refill status reply");
  if (!("refill_status" in response)) throw new Error("Wallet returned a different read result");
  const value = response.refill_status;
  if (value && typeof value === "object" && "err" in value && value.err === "Wallet refill was not found") return null;
  return assertReturnedRefillId(parseRefillOperation(value), requestId);
}
export async function listRefillPage(options: RefillPageOptions = {}, calls: RefillCalls = defaultCalls): Promise<RefillPage> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Enter a positive refill page size");
  const before = options.before;
  const response = record(await calls.querySelf("wallet_read_v1", [{ refills: {
    ...(before ? { before: { created_at: nat(before.createdAtNs, "refill history timestamp"), id: transferIdBytes(before.requestId) } } : {}),
    limit: String(limit), pending_only: options.pendingOnly ?? false,
  } }]), "refill history reply");
  const page = record(response.refills, "refill history page");
  if (!Array.isArray(page.operations)) throw new Error("Invalid saved refill history");
  let nextCursor: RefillCursor | null = null;
  if (page.next_cursor != null) {
    const cursor = record(page.next_cursor, "refill history cursor");
    if (!(cursor.id instanceof Uint8Array) || cursor.id.length !== 16) throw new Error("Invalid refill history cursor ID");
    nextCursor = { createdAtNs: nat(cursor.created_at, "refill history timestamp"), requestId: [...cursor.id].map((value) => value.toString(16).padStart(2, "0")).join("") };
    if (before && nextCursor.createdAtNs === before.createdAtNs && nextCursor.requestId === before.requestId) throw new Error("Refill history cursor did not advance");
  }
  return { operations: page.operations.map(parseRefillOperation), nextCursor };
}

function assertReturnedRefillId(operation: RefillOperation, requestId: string): RefillOperation { if (operation.requestId !== requestId) throw new Error("Wallet returned a different refill request"); return operation; }
export function assertRefillMatches(operation: RefillOperation, input: RefillInput & { requestId: string }): void {
  if (operation.requestId !== input.requestId || operation.kind !== input.kind || operation.amountAtoms !== input.amountAtoms || operation.target !== input.target) {
    throw new Error("This request ID belongs to another refill. Keep its original arguments and check the saved operation.");
  }
}
export function parseRefillOperation(result: unknown): RefillOperation {
  let value = result;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("err" in value && typeof value.err === "string") throw new Error(value.err);
    if ("ok" in value) value = value.ok;
  }
  const row = record(value, "refill operation");
  if (!(row.id instanceof Uint8Array) || row.id.length !== 16) throw new Error("Invalid refill request ID");
  const phase = variant(row.phase, ["prepared", "transfer_pending", "notify_pending", "withdraw_pending", "forward_pending", "complete", "refunded", "stopped"] as const, "phase");
  if (typeof row.duplicate !== "boolean" || typeof row.can_continue !== "boolean") throw new Error("Invalid refill recovery status");
  return {
    requestId: [...row.id].map((value) => value.toString(16).padStart(2, "0")).join(""),
    kind: refillKind(variant(row.kind, ["icp_topup", "tcycles_topup", "icp_to_tcycles"] as const, "kind")),
    target: Principal.fromText(requiredText(row.target, "target")).toText(), amountAtoms: nat(row.amount, "amount"),
    icpFeeAtoms: nat(row.icp_fee, "ICP fee"), cyclesFeeAtoms: nat(row.cycles_fee, "TCYCLES fee"), estimatedCycles: nat(row.estimated_cycles, "estimated cycles"),
    createdAtNs: nat(row.created_at, "creation timestamp"), updatedAtNs: nat(row.updated_at, "update timestamp"), phase,
    sourceBlockIndex: optionalNat(row.source_block), mintBlockIndex: optionalNat(row.mint_block), forwardBlockIndex: optionalNat(row.forward_block), refundBlockIndex: optionalNat(row.refund_block),
    creditedCycles: optionalNat(row.credited_cycles), mintedCycles: optionalNat(row.minted_cycles),
    duplicate: row.duplicate, canContinue: row.can_continue, error: row.error == null ? null : requiredText(row.error, "error"),
  };
}
async function notifyRefillChange(): Promise<void> { try { await publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()); } catch { /* Saved refill evidence remains authoritative. */ } }
function refillKind(value: unknown): RefillKind {
  if (value !== "icp_topup" && value !== "tcycles_topup" && value !== "icp_to_tcycles") throw new Error("Choose a refill or TCYCLES conversion");
  return value;
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`); return value as Record<string, unknown>; }
function requiredText(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`Invalid ${label}`); return value; }
function nat(value: unknown, label: string): string { const text = requiredText(value, label); if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`Invalid ${label}`); return text; }
function positiveNat(value: unknown, label: string): string { const text = nat(value, label); if (text === "0") throw new Error(`${label} must be greater than zero`); return text; }
function optionalNat(value: unknown): string | null { return value == null ? null : nat(value, "refill receipt amount"); }
function variant<T extends string>(value: unknown, options: readonly T[], label: string): T { const row = record(value, label); const keys = Object.keys(row); if (keys.length !== 1 || !options.includes(keys[0] as T)) throw new Error(`Invalid refill ${label}`); return keys[0] as T; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const ledgerIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => IDL.Service({
  icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ["query"]),
  icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]), icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
});
const cmcIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => IDL.Service({
  get_icp_xdr_conversion_rate: IDL.Func([], [IDL.Record({ data: IDL.Record({ xdr_permyriad_per_icp: IDL.Nat64, timestamp_seconds: IDL.Nat64 }), hash_tree: IDL.Vec(IDL.Nat8), certificate: IDL.Vec(IDL.Nat8) })], ["query"]),
});
