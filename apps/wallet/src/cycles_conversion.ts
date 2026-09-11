import { Actor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  getOneTimeCycleCallStatus, listOneTimeCycleCalls, publishAppStateChange,
  quoteOneTimeCycleCall, requestOneTimeCycleCall, type ScopedKernelClient,
} from "neutron-tools/app";
import type { OneTimeCycleCallPage, OneTimeCycleCallQuote, OneTimeCycleCallReceipt, OneTimeCycleCallRequest, OneTimeCycleCallSummary } from "neutron-tools/protocol";
import { CYCLES_DEPOSIT_LEDGER, decodeCyclesDeposit, decodeCyclesDepositReceipt, encodeCyclesDeposit, parseCyclesAtoms } from "./cycles_deposit.ts";
import { queryAgent } from "./native.ts";
import { WALLET_PROJECTION_TOPIC } from "./wallet_projection.ts";

export type OperatingCyclesSnapshot = {
  owner: string; target: string; balanceAtoms: string; reserveAtoms: string;
  callCostAtoms: string; maxCyclesAtoms: string; feeAtoms: string; observedAt: number;
};
export type OperatingCyclesInput = { requestId: string; owner: string; target: string; amountAtoms: string; allowPartial: boolean };
export type OperatingCyclesQuote = OperatingCyclesInput & {
  feeAtoms: string; expectedNetAtoms: string; balanceAtoms: string; reserveAtoms: string;
  callCostAtoms: string; maxCyclesAtoms: string; remainingCyclesAtoms: string; observedAt: number;
};
export type OperatingCyclesOperation = {
  requestId: string; target: string | null; requestedCyclesAtoms: string; attachedCyclesAtoms: string | null;
  expectedNetAtoms: string | null; feeAtoms: string | null; status: "pending" | "complete" | "failed" | "unknown";
  ledgerBlockIndex: string | null; recipientBalanceAtoms: string | null; error: string | null;
  createdAtNs: string; updatedAtNs: string; refundedCyclesAtoms: string | null;
  chargedCyclesAtoms: string | null; allowPartial: boolean; detailsAvailable: boolean;
};
export type OperatingCyclesPage = { operations: OperatingCyclesOperation[]; nextCursor: string | null; excludedCount: number };
export type OperatingCyclesServices = {
  fee(): Promise<string>;
  quote(request: OneTimeCycleCallRequest): Promise<OneTimeCycleCallQuote>;
  request(request: OneTimeCycleCallRequest): Promise<OneTimeCycleCallReceipt>;
  status(requestId: string): Promise<OneTimeCycleCallReceipt | null>;
  list(options: { before?: string; limit?: number }): Promise<OneTimeCycleCallPage>;
  publish(): Promise<void>;
};
export function operatingCyclesServices(kernel?: ScopedKernelClient): OperatingCyclesServices {
  return {
    fee: readCyclesDepositFee,
    quote: (request) => withKernelFeature(quoteOneTimeCycleCall(request, kernel)),
    request: (request) => withKernelFeature(requestOneTimeCycleCall(request, kernel)),
    status: (id) => withKernelFeature(getOneTimeCycleCallStatus(id, kernel)),
    list: (options) => withKernelFeature(listOneTimeCycleCalls(options, kernel)),
    publish: () => publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()),
  };
}
export async function loadOperatingCyclesSnapshot(owner: string, target = owner, io = operatingCyclesServices()): Promise<OperatingCyclesSnapshot> {
  owner = Principal.fromText(owner).toText();
  target = Principal.fromText(target).toText();
  const feeAtoms = (parseCyclesAtoms(await io.fee())).toString();
  const quote = await io.quote({ requestId: "00".repeat(16), canister: CYCLES_DEPOSIT_LEDGER, method: "deposit", argsHex: encodeCyclesDeposit("00".repeat(16), target, feeAtoms), cyclesAtoms: "0" });
  for (const amount of [quote.balanceAtoms, quote.reserveAtoms, quote.callCostAtoms, quote.maxCyclesAtoms]) parseCyclesAtoms(amount);
  return { owner, target, feeAtoms, balanceAtoms: quote.balanceAtoms, reserveAtoms: quote.reserveAtoms, callCostAtoms: quote.callCostAtoms, maxCyclesAtoms: quote.maxCyclesAtoms, observedAt: Date.now() };
}
export function quoteOperatingCyclesConversion(input: OperatingCyclesInput, snapshot: OperatingCyclesSnapshot): OperatingCyclesQuote {
  const owner = Principal.fromText(input.owner).toText();
  const target = Principal.fromText(input.target).toText();
  if (snapshot.owner !== owner || snapshot.target !== target) throw new Error("Refresh the conversion details for this recipient");
  encodeCyclesDeposit(input.requestId, target, snapshot.feeAtoms);
  if (typeof input.allowPartial !== "boolean") throw new Error("Choose an exact amount or an up-to amount");
  const requested = parseCyclesAtoms(input.amountAtoms);
  const max = parseCyclesAtoms(snapshot.maxCyclesAtoms);
  const selected = input.allowPartial && requested > max ? max : requested;
  if (requested === 0n) throw new Error("Enter an amount greater than zero");
  if (!input.allowPartial && requested > max) throw new Error("This amount would leave too few cycles to run your Neutron. Choose a smaller amount or Max.");
  const fee = parseCyclesAtoms(snapshot.feeAtoms);
  if (selected <= fee) throw new Error("Choose enough cycles to cover the TCYCLES mint fee");
  const balance = parseCyclesAtoms(snapshot.balanceAtoms);
  const cost = parseCyclesAtoms(snapshot.callCostAtoms);
  if (selected + cost > balance) throw new Error("Refresh the Neutron cycle balance");
  return { ...input, owner, target, feeAtoms: snapshot.feeAtoms, expectedNetAtoms: (selected - fee).toString(),
    balanceAtoms: snapshot.balanceAtoms, reserveAtoms: snapshot.reserveAtoms, callCostAtoms: snapshot.callCostAtoms,
    maxCyclesAtoms: snapshot.maxCyclesAtoms, remainingCyclesAtoms: (balance - selected - cost).toString(), observedAt: snapshot.observedAt };
}
export function operatingCyclesRequest(quote: OperatingCyclesQuote): OneTimeCycleCallRequest {
  const amount = parseCyclesAtoms(quote.amountAtoms);
  if (amount <= parseCyclesAtoms(quote.feeAtoms)) throw new Error("Choose enough cycles to cover the TCYCLES mint fee");
  return { requestId: quote.requestId, canister: CYCLES_DEPOSIT_LEDGER, method: "deposit", argsHex: encodeCyclesDeposit(quote.requestId, quote.target, quote.feeAtoms), cyclesAtoms: amount.toString(), allowPartial: quote.allowPartial };
}
/** Kernel always asks the owner, including requests initiated by a root agent. */
export async function executeOperatingCyclesConversion(quote: OperatingCyclesQuote, io = operatingCyclesServices()): Promise<OperatingCyclesOperation> {
  const request = operatingCyclesRequest(quote);
  try {
    const receipt = await io.request(request);
    assertOperatingRequest(receipt.request, request);
    return operatingCyclesOperation(receipt);
  } catch (error) {
    // deposit has no deduplication. An interrupted reply is recovered only from
    // Kernel's original call record, never by another transfer of cycles.
    let saved: OneTimeCycleCallReceipt | null;
    try { saved = await io.status(request.requestId); }
    catch { throw unresolvedError(request.requestId, error); }
    if (saved) { assertOperatingRequest(saved.request, request); return operatingCyclesOperation(saved); }
    if (isOperatingCyclesNotDispatched(error)) throw error;
    throw unresolvedError(request.requestId, error);
  } finally { try { await io.publish(); } catch { /* The durable Kernel receipt remains authoritative. */ } }
}
export async function readOperatingCyclesConversionStatus(requestId: string, io = operatingCyclesServices()): Promise<OperatingCyclesOperation | null> {
  const saved = await io.status(requestId);
  if (saved && saved.request.requestId !== requestId) throw new Error("Kernel returned a different cycle conversion");
  return saved ? operatingCyclesOperation(saved) : null;
}
export async function listOperatingCyclesConversions(options: { before?: string; limit?: number } = {}, io = operatingCyclesServices()): Promise<OperatingCyclesPage> {
  const page = await io.list({ ...options, limit: options.limit ?? 20 });
  const supported = page.calls.filter((call) => call.request.canister === CYCLES_DEPOSIT_LEDGER && call.request.method === "deposit");
  return { operations: supported.map(operatingCyclesSummary), nextCursor: page.nextBefore, excludedCount: page.calls.length - supported.length };
}
export function operatingCyclesOperation(receipt: OneTimeCycleCallReceipt): OperatingCyclesOperation {
  if (receipt.request.canister !== CYCLES_DEPOSIT_LEDGER || receipt.request.method !== "deposit") throw new Error("This saved call is not a Wallet TCYCLES conversion");
  const deposit = decodeCyclesDeposit(receipt.request.argsHex);
  if (deposit.requestId !== receipt.request.requestId) throw new Error("Saved TCYCLES memo does not match its request ID");
  const actual = parseCyclesAtoms(receipt.actualCyclesAtoms);
  const charged = receipt.chargedCyclesAtoms === null ? null : parseCyclesAtoms(receipt.chargedCyclesAtoms);
  if (charged !== null && charged > actual) throw new Error("Invalid attached-cycle charge in the saved receipt");
  let status: OperatingCyclesOperation["status"] = "pending";
  let ledgerBlockIndex: string | null = null;
  let recipientBalanceAtoms: string | null = null;
  let error: string | null = null;
  if (receipt.result && "replyHex" in receipt.result) {
    try {
      const decoded = decodeCyclesDepositReceipt(receipt.result.replyHex);
      ledgerBlockIndex = decoded.blockIndex; recipientBalanceAtoms = decoded.recipientBalanceAtoms;
      status = receipt.dispatched ? "complete" : "unknown";
      if (!receipt.dispatched) error = "A response was retained without dispatch evidence. Do not send another conversion.";
    } catch {
      status = "unknown";
      error = "Kernel retained the original response, but its TCYCLES receipt could not be decoded. Do not send another conversion.";
    }
  } else if (receipt.result && "error" in receipt.result) {
    // An explicit original rejection with a refunded attachment is terminal.
    // A rejection with unknown/positive acceptance cannot justify another send.
    status = !receipt.dispatched || charged === 0n ? "failed" : "unknown";
    error = receipt.result.error.message;
  }
  const fee = parseCyclesAtoms(deposit.feeAtoms);
  return { requestId: receipt.request.requestId, target: deposit.target, requestedCyclesAtoms: receipt.request.cyclesAtoms,
    attachedCyclesAtoms: receipt.dispatched ? actual.toString() : null,
    expectedNetAtoms: status === "complete" && actual > fee ? (actual - fee).toString() : null,
    feeAtoms: deposit.feeAtoms, status, ledgerBlockIndex, recipientBalanceAtoms, error,
    createdAtNs: receipt.createdAtNs, updatedAtNs: receipt.updatedAtNs,
    refundedCyclesAtoms: charged !== null && receipt.dispatched ? (actual - charged).toString() : null,
    chargedCyclesAtoms: receipt.chargedCyclesAtoms, allowPartial: receipt.request.allowPartial === true, detailsAvailable: true };
}
function operatingCyclesSummary(receipt: OneTimeCycleCallSummary): OperatingCyclesOperation {
  const actual = parseCyclesAtoms(receipt.actualCyclesAtoms);
  const charged = receipt.chargedCyclesAtoms === null ? null : parseCyclesAtoms(receipt.chargedCyclesAtoms);
  return { requestId: receipt.request.requestId, target: null, requestedCyclesAtoms: receipt.request.cyclesAtoms,
    attachedCyclesAtoms: receipt.dispatched ? receipt.actualCyclesAtoms : null,
    expectedNetAtoms: null, feeAtoms: null,
    status: receipt.outcome === "replied" ? "unknown" : receipt.outcome === "rejected" ? !receipt.dispatched || charged === 0n ? "failed" : "unknown" : "pending",
    ledgerBlockIndex: null, recipientBalanceAtoms: null,
    error: receipt.outcome === "rejected" ? "Open details to see the saved call result." : null,
    createdAtNs: receipt.createdAtNs, updatedAtNs: receipt.updatedAtNs,
    refundedCyclesAtoms: charged !== null && charged <= actual && receipt.dispatched ? (actual - charged).toString() : null,
    chargedCyclesAtoms: receipt.chargedCyclesAtoms, allowPartial: receipt.request.allowPartial === true, detailsAvailable: false };
}
function assertOperatingRequest(actual: OneTimeCycleCallRequest, expected: OneTimeCycleCallRequest): void {
  if (actual.requestId !== expected.requestId || actual.canister !== expected.canister || actual.method !== expected.method || actual.argsHex !== expected.argsHex || actual.cyclesAtoms !== expected.cyclesAtoms || (actual.allowPartial === true) !== (expected.allowPartial === true)) throw new Error("This request ID belongs to a different saved cycle conversion. Check its original status; do not send another deposit.");
}
export function isOperatingCyclesCancellation(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ONE_TIME_CYCLE_CALL_CANCELLED";
}
/** Only Kernel's stage-attested errors permit clearing a fresh attempt. A
 * generic timeout/cancel and an absent status are not non-dispatch evidence. */
export function isOperatingCyclesNotDispatched(error: unknown): boolean {
  return isOperatingCyclesCancellation(error) || !!error && typeof error === "object" && "code" in error && error.code === "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED";
}
function unresolvedError(requestId: string, cause: unknown): Error {
  return Object.assign(new Error(`The conversion reply was interrupted. Check saved request ${requestId}; do not submit another deposit. ${cause instanceof Error ? cause.message : String(cause)}`), { code: "CYCLES_CONVERSION_UNRESOLVED", requestId });
}
export function operatingCyclesFeatureError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown tool ['"]backend_calls\.cycles_(quote|request|status|list)['"]/.test(message)) {
    return Object.assign(new Error("Update Neutron to convert its operating cycles to TCYCLES. ICP and TCYCLES refills are still available."), { code: "KERNEL_UPDATE_REQUIRED" });
  }
  return error;
}
async function withKernelFeature<T>(result: Promise<T>): Promise<T> { try { return await result; } catch (error) { throw operatingCyclesFeatureError(error); } }
async function readCyclesDepositFee(): Promise<string> {
  const actor = Actor.createActor<{ icrc1_fee(): Promise<bigint>; icrc1_decimals(): Promise<number> }>(
    ({ IDL }) => IDL.Service({ icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]), icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]) }),
    { agent: await queryAgent(window.location.href), canisterId: CYCLES_DEPOSIT_LEDGER },
  );
  const [fee, decimals] = await Promise.all([actor.icrc1_fee(), actor.icrc1_decimals()]);
  if (decimals !== 12) throw new Error("The TCYCLES ledger returned unsupported token units");
  return fee.toString();
}
