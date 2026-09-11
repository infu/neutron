import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import type { OneTimeCycleCallReceipt, OneTimeCycleCallRequest, OneTimeCycleCallSummary } from "neutron-tools/protocol";
import { normalizeToolDescriptor, validateToolArguments, validateToolResult } from "neutron-tools/protocol";
import { bytesHex, CYCLES_DEPOSIT_LEDGER, decodeCyclesDeposit, decodeCyclesDepositReceipt, encodeCyclesDeposit } from "../src/cycles_deposit.ts";
import {
  executeOperatingCyclesConversion, isOperatingCyclesCancellation, isOperatingCyclesNotDispatched, listOperatingCyclesConversions,
  loadOperatingCyclesSnapshot, operatingCyclesFeatureError, operatingCyclesOperation, operatingCyclesRequest,
  quoteOperatingCyclesConversion, readOperatingCyclesConversionStatus, type OperatingCyclesServices,
  type OperatingCyclesSnapshot,
} from "../src/cycles_conversion.ts";
import { handleOperatingCyclesConversion, handleOperatingCyclesQuote, walletOperatingCyclesInputSchema, walletOperatingCyclesOutputSchema, walletOperatingCyclesQuoteInputSchema, walletOperatingCyclesQuoteOutputSchema } from "../src/cycles_conversion_tools.ts";

const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const recipient = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const requestId = "ab".repeat(16);
const feeAtoms = "100000000";
const snapshot: OperatingCyclesSnapshot = { owner, target: owner, balanceAtoms: "55000000000000", reserveAtoms: "5000000000000", callCostAtoms: "10000000", maxCyclesAtoms: "49999990000000", feeAtoms, observedAt: 1 };
const input = { requestId, owner, target: owner, amountAtoms: "1000000000000", allowPartial: false };
const quote = quoteOperatingCyclesConversion(input, snapshot);
function replyHex() { return bytesHex(new Uint8Array(IDL.encode([IDL.Record({ block_index: IDL.Nat, balance: IDL.Nat })], [{ block_index: 12n, balance: 200000000000000n }]))); }
function receipt(request = operatingCyclesRequest(quote), overrides: Partial<OneTimeCycleCallReceipt> = {}): OneTimeCycleCallReceipt {
  return { request, sequence: "1", createdAtNs: "2", updatedAtNs: "3", dispatched: true, actualCyclesAtoms: request.cyclesAtoms, chargedCyclesAtoms: request.cyclesAtoms, result: { replyHex: replyHex() }, ...overrides };
}
function fixture() {
  let saved: OneTimeCycleCallReceipt | null = null;
  let feeReads = 0;
  let quoteReads = 0;
  let requests = 0;
  let ownerDialogs = 0;
  let statuses = 0;
  let loseReply = false;
  let cancelled = false;
  let statusUnavailable = false;
  const services: OperatingCyclesServices = {
    async fee() { feeReads += 1; return feeAtoms; },
    async quote(request) { quoteReads += 1; return { balanceAtoms: snapshot.balanceAtoms, reserveAtoms: snapshot.reserveAtoms, callCostAtoms: snapshot.callCostAtoms, maxCyclesAtoms: snapshot.maxCyclesAtoms, requestedCyclesAtoms: request.cyclesAtoms, selectedCyclesAtoms: request.cyclesAtoms, remainingCyclesAtoms: snapshot.balanceAtoms, usualLimitPerCallAtoms: "1000000000000", usualLimitPerDayAtoms: "10000000000000" }; },
    async request(request) {
      requests += 1;
      // Matches the generic Kernel SDK contract: retained IDs are checked before
      // its red owner dialog, and a request is dispatched at most once.
      if (saved) { if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw new Error("request_conflict"); return saved; }
      ownerDialogs += 1;
      if (cancelled) throw Object.assign(new Error("Canceled by owner"), { code: "ONE_TIME_CYCLE_CALL_CANCELLED" });
      saved = receipt(request);
      if (loseReply) throw new Error("Lost browser reply");
      return saved;
    },
    async status(id) { statuses += 1; if (statusUnavailable) throw new Error("Status unavailable"); return saved?.request.requestId === id ? saved : null; },
    async list() { return { calls: [], nextBefore: null }; }, async publish() {},
  };
  return { services, get saved() { return saved; }, set saved(value) { saved = value; }, get feeReads() { return feeReads; }, get quoteReads() { return quoteReads; }, get requests() { return requests; }, get ownerDialogs() { return ownerDialogs; }, get statuses() { return statuses; }, set loseReply(value: boolean) { loseReply = value; }, set cancelled(value: boolean) { cancelled = value; }, set statusUnavailable(value: boolean) { statusUnavailable = value; } };
}

test("deposit Candid binds recipient, stable request ID and retained reviewed fee", () => {
  const encoded = encodeCyclesDeposit(requestId, recipient, feeAtoms);
  expect(decodeCyclesDeposit(encoded)).toEqual({ requestId, target: recipient, feeAtoms });
  expect(decodeCyclesDepositReceipt(replyHex())).toEqual({ blockIndex: "12", recipientBalanceAtoms: "200000000000000" });
  expect(() => encodeCyclesDeposit(requestId, "aaaaa-aa", feeAtoms)).toThrow("recipient");
});

test("snapshot uses only TCYCLES fee and Kernel's exact call quote, including Max reserve", async () => {
  const h = fixture();
  const read = await loadOperatingCyclesSnapshot(owner, owner, h.services);
  expect(read).toMatchObject({ ...snapshot, observedAt: expect.any(Number) });
  expect(h.feeReads).toBe(1); expect(h.quoteReads).toBe(1); expect(h.requests).toBe(0);
  const max = quoteOperatingCyclesConversion({ ...input, amountAtoms: snapshot.maxCyclesAtoms, allowPartial: true }, read);
  expect(max.remainingCyclesAtoms).toBe("5000000000000");
  expect(max.expectedNetAtoms).toBe("49999890000000");
  expect(() => quoteOperatingCyclesConversion({ ...input, amountAtoms: "50000000000000" }, read)).toThrow("too few cycles");
  expect(quoteOperatingCyclesConversion({ ...input, amountAtoms: "50000000000000", allowPartial: true }, read).remainingCyclesAtoms).toBe("5000000000000");
  expect(() => quoteOperatingCyclesConversion({ ...input, amountAtoms: feeAtoms }, read)).toThrow("mint fee");
});

test("successful receipt uses attached amount minus retained fee estimate, never recipient total balance", () => {
  const operation = operatingCyclesOperation(receipt());
  expect(operation).toMatchObject({ status: "complete", ledgerBlockIndex: "12", target: owner, expectedNetAtoms: "999900000000", recipientBalanceAtoms: "200000000000000", chargedCyclesAtoms: "1000000000000", refundedCyclesAtoms: "0", detailsAvailable: true });
  const capped = operatingCyclesOperation(receipt({ ...operatingCyclesRequest(quote), allowPartial: true }, { actualCyclesAtoms: "800000000000", chargedCyclesAtoms: "800000000000" }));
  expect(capped.expectedNetAtoms).toBe("799900000000");
});

test("in-flight, malformed and accepted-charge rejection remain unresolved; refund is explicit", () => {
  expect(operatingCyclesOperation(receipt(undefined, { result: null, chargedCyclesAtoms: null }))).toMatchObject({ status: "pending", ledgerBlockIndex: null, expectedNetAtoms: null });
  expect(operatingCyclesOperation(receipt(undefined, { result: { replyHex: "4449444c0000" } }))).toMatchObject({ status: "unknown", ledgerBlockIndex: null });
  const error = { error: { code: "canister_reject", message: "Deposit rejected" } };
  expect(operatingCyclesOperation(receipt(undefined, { result: error, chargedCyclesAtoms: "0" }))).toMatchObject({ status: "failed", refundedCyclesAtoms: "1000000000000" });
  expect(operatingCyclesOperation(receipt(undefined, { result: error, chargedCyclesAtoms: "1" }))).toMatchObject({ status: "unknown" });
});

test("lost reply is reconciled from Kernel without another deposit or another owner dialog", async () => {
  const h = fixture(); h.loseReply = true;
  expect(await executeOperatingCyclesConversion(quote, h.services)).toMatchObject({ status: "complete", requestId });
  expect(h.requests).toBe(1); expect(h.ownerDialogs).toBe(1); expect(h.statuses).toBe(1);
  expect(await executeOperatingCyclesConversion(quote, h.services)).toMatchObject({ status: "complete", requestId });
  expect(h.ownerDialogs).toBe(1);
  expect(await readOperatingCyclesConversionStatus(requestId, h.services)).toMatchObject({ status: "complete" });
});

test("owner cancellation clears only when Kernel confirms no saved call", async () => {
  const h = fixture(); h.cancelled = true;
  const error = await executeOperatingCyclesConversion(quote, h.services).catch((error) => error);
  expect(isOperatingCyclesCancellation(error)).toBe(true); expect(h.saved).toBeNull();
  const uncertain = fixture(); uncertain.cancelled = true; uncertain.statusUnavailable = true;
  const unknown = await executeOperatingCyclesConversion(quote, uncertain.services).catch((error) => error);
  expect(isOperatingCyclesCancellation(unknown)).toBe(false);
  expect(unknown).toMatchObject({ code: "CYCLES_CONVERSION_UNRESOLVED", requestId });
});

test("compact replied history remains unverified until details decode and does not hydrate every row", async () => {
  const full = receipt();
  const { argsHex: _argsHex, ...request } = full.request;
  const { result: _result, request: _request, ...fields } = full;
  const summary: OneTimeCycleCallSummary = { ...fields, request, outcome: "replied" };
  const h = fixture();
  h.services.list = async () => ({ calls: [summary, { ...summary, request: { ...request, method: "other" } }], nextBefore: "5" });
  const page = await listOperatingCyclesConversions({}, h.services);
  expect(page).toMatchObject({ nextCursor: "5", excludedCount: 1, operations: [{ status: "unknown", detailsAvailable: false, ledgerBlockIndex: null, target: null }] });
  expect(h.statuses).toBe(0);
});

test("normal and root tools both invoke Kernel owner approval, and same-ID replay never quotes or pays again", async () => {
  for (const audience of ["foreground_tile", "agent_root"] as const) {
    const h = fixture();
    const context = { audience, reportProgress() {}, kernel: { querySelf: async () => ({ snapshot: { owner, configured: true, ledgers: [] } }) } } as unknown as MsgBusToolContext;
    const args: JsonObject = { requestId, amountAtoms: input.amountAtoms, target: null, allowPartial: false };
    const result = await handleOperatingCyclesConversion(args, context, h.services);
    expect(result).toMatchObject({ operation: { status: "complete", requestId } }); expect(h.ownerDialogs).toBe(1);
    const descriptor = normalizeToolDescriptor({ name: "wallet_cycles_conversion_v1", inputSchema: walletOperatingCyclesInputSchema, outputSchema: walletOperatingCyclesOutputSchema });
    expect(() => validateToolResult(descriptor, result)).not.toThrow();
    await handleOperatingCyclesConversion(args, context, h.services);
    expect(h.quoteReads).toBe(1); expect(h.requests).toBe(1);
    await expect(handleOperatingCyclesConversion({ ...args, target: recipient }, context, h.services)).rejects.toThrow("different saved");
  }
});

test("an older Kernel gives an update instruction without relabeling unrelated failures", () => {
  expect(operatingCyclesFeatureError(new Error("Unknown tool 'backend_calls.cycles_quote' on 'kernel'"))).toMatchObject({ code: "KERNEL_UPDATE_REQUIRED", message: expect.stringContaining("Update Neutron") });
  const connection = new Error("message bus connection replaced");
  expect(operatingCyclesFeatureError(connection)).toBe(connection);
});


test("stage-attested preflight failure clears a fresh attempt while ordinary aborts remain unresolved", async () => {
  const safe = fixture();
  const preflight = Object.assign(new Error("The exact amount no longer leaves the operating reserve"), { code: "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED" });
  safe.services.request = async () => { throw preflight; };
  const rejection = await executeOperatingCyclesConversion(quote, safe.services).catch((error) => error);
  expect(rejection).toBe(preflight);
  expect(isOperatingCyclesNotDispatched(rejection)).toBe(true);
  expect(isOperatingCyclesCancellation(rejection)).toBe(false);

  const unavailable = fixture(); unavailable.statusUnavailable = true;
  unavailable.services.request = async () => { throw preflight; };
  const unknownStatus = await executeOperatingCyclesConversion(quote, unavailable.services).catch((error) => error);
  expect(isOperatingCyclesNotDispatched(unknownStatus)).toBe(false);
  expect(unknownStatus).toMatchObject({ code: "CYCLES_CONVERSION_UNRESOLVED" });

  const abort = fixture();
  abort.services.request = async () => { throw Object.assign(new Error("Request canceled; outcome unknown"), { code: "REQUEST_CANCELLED" }); };
  const unknownAbort = await executeOperatingCyclesConversion(quote, abort.services).catch((error) => error);
  expect(isOperatingCyclesCancellation(unknownAbort)).toBe(false);
  expect(isOperatingCyclesNotDispatched(unknownAbort)).toBe(false);
  expect(unknownAbort).toMatchObject({ code: "CYCLES_CONVERSION_UNRESOLVED" });
});

test("an existing dispatched receipt wins over a pre-dispatch error classification", async () => {
  const h = fixture();
  h.saved = receipt(undefined, { result: null, chargedCyclesAtoms: null });
  h.services.request = async () => { throw Object.assign(new Error("No new dispatch"), { code: "ONE_TIME_CYCLE_CALL_NOT_DISPATCHED" }); };
  expect(await executeOperatingCyclesConversion(quote, h.services)).toMatchObject({ requestId, status: "pending", detailsAvailable: true });
});


test("quote-only omitted or null amount discovers Max with one Kernel quote and no approval", async () => {
  const descriptor = normalizeToolDescriptor({ name: "wallet_cycles_conversion_quote_v1", inputSchema: walletOperatingCyclesQuoteInputSchema, outputSchema: walletOperatingCyclesQuoteOutputSchema });
  const context = { kernel: { querySelf: async () => ({ snapshot: { owner, configured: true, ledgers: [] } }) } } as unknown as MsgBusToolContext;
  for (const args of [{ target: null, allowPartial: true }, { amountAtoms: null, target: null, allowPartial: false }] satisfies JsonObject[]) {
    expect(() => validateToolArguments(descriptor, args)).not.toThrow();
    const h = fixture();
    const result = await handleOperatingCyclesQuote(args, context, h.services);
    expect(result).toMatchObject({ amountAtoms: snapshot.maxCyclesAtoms, maxCyclesAtoms: snapshot.maxCyclesAtoms, balanceAtoms: snapshot.balanceAtoms,
      remainingCyclesAtoms: snapshot.reserveAtoms, expectedNetAtoms: "49999890000000", allowPartial: args.allowPartial, eligible: true, reason: null, ownerApprovalRequired: true });
    expect(() => validateToolResult(descriptor, result)).not.toThrow();
    expect(h.quoteReads).toBe(1); expect(h.feeReads).toBe(1); expect(h.requests).toBe(0); expect(h.ownerDialogs).toBe(0); expect(h.statuses).toBe(0);
  }
  const h = fixture();
  await expect(handleOperatingCyclesConversion({ requestId, amountAtoms: null, target: null, allowPartial: true }, context, h.services)).rejects.toThrow("positive number");
  expect(h.requests).toBe(0); expect(h.quoteReads).toBe(0);
});

test("Max discovery returns insufficient-capacity diagnostics instead of guessing or dispatching", async () => {
  const descriptor = normalizeToolDescriptor({ name: "wallet_cycles_conversion_quote_v1", inputSchema: walletOperatingCyclesQuoteInputSchema, outputSchema: walletOperatingCyclesQuoteOutputSchema });
  const context = { kernel: { querySelf: async () => ({ snapshot: { owner, configured: true, ledgers: [] } }) } } as unknown as MsgBusToolContext;
  for (const maxCyclesAtoms of ["0", feeAtoms]) {
    const h = fixture();
    const originalQuote = h.services.quote;
    h.services.quote = async (request) => ({ ...await originalQuote(request), balanceAtoms: "5000000000000", maxCyclesAtoms });
    const result = await handleOperatingCyclesQuote({ target: null, allowPartial: true }, context, h.services);
    expect(result).toMatchObject({ eligible: false, amountAtoms: maxCyclesAtoms, expectedNetAtoms: null, maxCyclesAtoms, remainingCyclesAtoms: "5000000000000" });
    expect(result.reason).toContain("No conversion currently fits");
    expect(() => validateToolResult(descriptor, result)).not.toThrow();
    expect(h.quoteReads).toBe(1); expect(h.requests).toBe(0); expect(h.ownerDialogs).toBe(0);
  }
});
