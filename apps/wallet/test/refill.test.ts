import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { normalizeToolDescriptor, validateToolResult } from "neutron-tools/protocol";
import {
  ICP_LEDGER, TCYCLES_LEDGER, assertRefillMatches, maxRefillAmount, parseRefillOperation,
  quoteRefill, readRefillStatus, refillPrepareArgs, listRefillPage, type RefillCalls, type RefillSnapshot,
} from "../src/refill.ts";
import { walletRefillQuoteInputSchema, walletRefillQuoteOutputSchema } from "../src/refill_tools.ts";
import { transferIdBytes } from "../src/transfers.ts";
import { reservationActions, walletRefillReservationScopes } from "../src/reservations.ts";

const owner = "3rurp-vyaaa-aaaay-aacua-cai";
const other = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const requestId = "ab".repeat(16);
export const refillSnapshot: RefillSnapshot = {
  owner, observedAt: 1789100000000,
  icp: { ledger: ICP_LEDGER, symbol: "ICP", decimals: 8, balanceAtoms: "50000000", feeAtoms: "10000", error: null },
  tcycles: { ledger: TCYCLES_LEDGER, symbol: "TCYCLES", decimals: 12, balanceAtoms: "5000000000000", feeAtoms: "100000000", error: null },
  rate: { xdrPermyriadPerIcp: "20631", timestampSeconds: "1789100000" }, errors: [],
};
export function refillWire(overrides: Record<string, unknown> = {}) {
  return {
    id: transferIdBytes(requestId), kind: { icp_topup: null }, target: owner, amount: "10000000",
    icp_fee: "10000", cycles_fee: "100000000", estimated_cycles: "206310000000",
    created_at: "1789100000000000000", updated_at: "1789100000000000000", phase: { prepared: null },
    source_block: null, mint_block: null, forward_block: null, refund_block: null,
    credited_cycles: null, minted_cycles: null, duplicate: false, error: null, can_continue: false,
    ...overrides,
  };
}

test("ICP refill uses exact atomic rate conversion and charges ICP fee separately", () => {
  const quote = quoteRefill({ kind: "icp_topup", amountAtoms: "10000000", target: owner }, refillSnapshot);
  expect(quote).toMatchObject({ estimatedCycles: "206310000000", estimatedReceivedCycles: "206310000000", totalDebitAtoms: "10010000", sourceFeeAtoms: "10000", source: "ICP" });
  const descriptor = normalizeToolDescriptor({ name: "wallet_refill_quote_v1", inputSchema: walletRefillQuoteInputSchema, outputSchema: walletRefillQuoteOutputSchema });
  expect(() => validateToolResult(descriptor, quote)).not.toThrow();
  expect(refillPrepareArgs(quote, requestId)).toMatchObject({ id: transferIdBytes(requestId), amount: "10000000", icp_fee: "10000", cycles_fee: "0", estimated_cycles: "206310000000" });
});

test("ICP to TCYCLES distinguishes gross, mint fee, and optional delivery fee", () => {
  const input = { kind: "icp_to_tcycles" as const, amountAtoms: "10000000", target: owner };
  expect(quoteRefill(input, refillSnapshot)).toMatchObject({ estimatedCycles: "206310000000", estimatedReceivedCycles: "206210000000", totalDebitAtoms: "10010000" });
  expect(quoteRefill({ ...input, target: other }, refillSnapshot)).toMatchObject({ estimatedCycles: "206310000000", estimatedReceivedCycles: "206110000000", totalDebitAtoms: "10010000" });
  expect(() => quoteRefill({ ...input, amountAtoms: "100" }, refillSnapshot)).toThrow("too small");
});

test("TCYCLES delivers exact cycles, reserves its fee for Max, and needs no ICP rate", () => {
  const snapshot = { ...refillSnapshot, rate: null, icp: { ...refillSnapshot.icp, balanceAtoms: null, feeAtoms: null } };
  expect(maxRefillAmount(snapshot.tcycles)).toBe("4999900000000");
  expect(quoteRefill({ kind: "tcycles_topup", amountAtoms: maxRefillAmount(snapshot.tcycles), target: owner }, snapshot)).toMatchObject({ estimatedReceivedCycles: "4999900000000", totalDebitAtoms: "5000000000000", source: "TCYCLES" });
  expect(() => quoteRefill({ kind: "tcycles_topup", amountAtoms: "5000000000000", target: owner }, snapshot)).toThrow("transfer fee");
  expect(maxRefillAmount({ ...snapshot.tcycles, balanceAtoms: "5" })).toBe("0");
});

test("missing live fees, fractional atoms, and unknown balance cannot create an executable quote", () => {
  const input = { kind: "icp_topup" as const, amountAtoms: "10000000", target: owner };
  expect(() => quoteRefill(input, { ...refillSnapshot, icp: { ...refillSnapshot.icp, feeAtoms: null } })).toThrow("unavailable");
  expect(quoteRefill(input, { ...refillSnapshot, tcycles: { ...refillSnapshot.tcycles, balanceAtoms: null, feeAtoms: null } })).toMatchObject({ cyclesFeeAtoms: "0", estimatedReceivedCycles: "206310000000" });
  expect(() => quoteRefill(input, { ...refillSnapshot, rate: null })).toThrow("conversion rate");
  expect(() => quoteRefill({ ...input, amountAtoms: "0.1" }, refillSnapshot)).toThrow("amount");
  expect(() => quoteRefill({ ...input, amountAtoms: "0" }, refillSnapshot)).toThrow("greater than zero");
  expect(() => quoteRefill({ ...input, target: "2vxsx-fae" }, refillSnapshot)).toThrow("recipient principal");
});

test("withdrawal duplicate and forwarding evidence remain distinct from delivered cycles", () => {
  const duplicate = parseRefillOperation({ ok: refillWire({ kind: { tcycles_topup: null }, phase: { withdraw_pending: null }, duplicate: true, source_block: "10", error: "Original canister delivery outcome is unavailable" }) });
  expect(duplicate).toMatchObject({ phase: "withdraw_pending", duplicate: true, creditedCycles: null, canContinue: false });
  const forwarding = parseRefillOperation({ ok: refillWire({ kind: { icp_to_tcycles: null }, phase: { forward_pending: null }, minted_cycles: "206310000000", mint_block: "11", can_continue: true }) });
  expect(forwarding).toMatchObject({ phase: "forward_pending", mintedCycles: "206310000000", creditedCycles: null });
  expect(() => assertRefillMatches(duplicate, { requestId, kind: "tcycles_topup", amountAtoms: "20", target: owner })).toThrow("another refill");
});

test("only explicit absent status permits preparation; read errors remain errors", async () => {
  const calls = { querySelf: async () => ({ refill_status: { err: "Wallet refill was not found" } }), updateSelf: async () => { throw new Error("No update expected"); } } as RefillCalls;
  expect(await readRefillStatus(requestId, calls)).toBeNull();
  await expect(readRefillStatus(requestId, { ...calls, querySelf: async () => { throw new Error("connection replaced"); } })).rejects.toThrow("connection replaced");
});

test("removing tokens from Assets preserves exclusive refill ledger custody", () => {
  const scopes = walletRefillReservationScopes();
  expect(scopes).toEqual([
    { kind: "principal", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
    { kind: "principal", principal: "um5iw-rqaaa-aaaaq-qaaba-cai" },
    { kind: "principal", principal: "rkp4c-7iaaa-aaaaa-aaaca-cai" },
  ]);
  expect(reservationActions([...scopes, { kind: "principal", principal: "aaaaa-aa" }], [])).toEqual([{ kind: "release", scope: { kind: "principal", principal: "aaaaa-aa" } }]);
});


test("refill history carries an exact cursor and keeps pending discovery separate", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const before = { createdAtNs: "1789100000000000000", requestId };
  const nextId = "cd".repeat(16);
  const io: RefillCalls = {
    async querySelf(method, args) {
      calls.push({ method, args });
      return { refills: { operations: [refillWire({ phase: { notify_pending: null }, can_continue: true })], next_cursor: { created_at: "1789000000000000000", id: transferIdBytes(nextId) } } };
    },
    async updateSelf() { throw new Error("History is read-only"); },
  };
  const page = await listRefillPage({ before, limit: 20, pendingOnly: true }, io);
  expect(page.operations[0]?.phase).toBe("notify_pending");
  expect(page.nextCursor).toEqual({ createdAtNs: "1789000000000000000", requestId: nextId });
  expect(calls).toEqual([{ method: "wallet_read_v1", args: [{ refills: { before: { created_at: before.createdAtNs, id: transferIdBytes(requestId) }, limit: "20", pending_only: true } }] }]);
  await expect(listRefillPage({ limit: 1.5 }, io)).rejects.toThrow("positive refill page size");
  await expect(listRefillPage({ before }, { ...io, querySelf: async () => ({ refills: { operations: [], next_cursor: { created_at: before.createdAtNs, id: transferIdBytes(requestId) } } }) })).rejects.toThrow("did not advance");
});


test("quote validates canister destinations but accepts ordinary TCYCLES recipient accounts", () => {
  const userPrincipal = Principal.selfAuthenticating(new Uint8Array(32)).toText();
  const input = { kind: "icp_topup" as const, amountAtoms: "10000000", target: userPrincipal };
  expect(() => quoteRefill(input, refillSnapshot)).toThrow("canister ID");
  expect(() => quoteRefill({ ...input, kind: "tcycles_topup" }, refillSnapshot)).toThrow("canister ID");
  expect(quoteRefill({ ...input, kind: "icp_to_tcycles" }, refillSnapshot)).toMatchObject({ target: userPrincipal, estimatedReceivedCycles: "206110000000" });
  for (const kind of ["icp_topup", "tcycles_topup", "icp_to_tcycles"] as const) {
    expect(() => quoteRefill({ ...input, kind, target: "aaaaa-aa" }, refillSnapshot)).toThrow("management canister");
  }
});
