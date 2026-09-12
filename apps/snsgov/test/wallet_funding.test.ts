import { expect, test } from "bun:test";
import type { JsonValue, MsgBusToolCall } from "neutron-tools/app";
import { decodeIcrcAccount, encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  invokeWalletFunding,
  parseWalletFundingResult,
  prepareWalletFundingRequest,
  rootFundingInstruction,
  verifyWalletFundingReceipt,
  readWalletTokenSelection,
  walletLedgerInstruction,
  invokeWalletLedgerAddition,
  type WalletFundingClient,
  type WalletFundingInput,
  type WalletFundingRequest,
} from "../src/data/wallet_funding";

const requestId = "ab".repeat(16);
const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const governance = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const subaccount = new Uint8Array(32).fill(7);
const destination = encodeIcrcAccount({ owner: decodeIcrcAccount(governance).owner, subaccount });
const input: WalletFundingInput = {
  requestId, ledger, amountAtoms: "900719925474099312345", validUntilNs: "1800000000000000000",
  destination: { owner: governance, subaccount }, memoHex: "0001ff",
};
const identity = { expectedCallerAppId: "snsgov" };
const request = prepareWalletFundingRequest(input);
const transferred = (caller = "snsgov") => ({
  status: "transferred" as const, commandId: `${caller}:${requestId}`, blockIndex: "900719925474099312345",
  duplicate: false, message: null,
});
const pending = () => ({
  status: "pending" as const, commandId: `snsgov:${requestId}`, blockIndex: null, duplicate: null,
  message: "Transfer outcome remains unknown",
});

function harness(reply: JsonValue | Error) {
  const calls: Array<{ call: MsgBusToolCall; timeout: unknown }> = [];
  const client: WalletFundingClient = {
    async callTool<T extends JsonValue = JsonValue>(call: MsgBusToolCall, timeout?: Parameters<WalletFundingClient["callTool"]>[1]): Promise<T> {
      calls.push({ call, timeout });
      if (reply instanceof Error) throw reply;
      return reply as T;
    },
  };
  return { client, calls };
}

test("funding preparation retains the explicit identity, exact atoms, and binary neuron destination", () => {
  expect(request).toEqual({
    requestId, ledger, amountAtoms: input.amountAtoms, validUntilNs: input.validUntilNs,
    route: { kind: "direct", to: destination, memoHex: "0001ff" },
  });
  expect(decodeIcrcAccount(request.route.to).subaccount).toEqual(subaccount);
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.route)).toBe(true);
  const original = request.route.to;
  const mutableSubaccount = new Uint8Array(32).fill(7);
  const prepared = prepareWalletFundingRequest({ ...input, destination: { owner: governance, subaccount: mutableSubaccount } });
  mutableSubaccount.fill(9);
  expect(prepared.route.to).toBe(original);
});

test("canonical textual accounts and default accounts use the shared codec", () => {
  expect(prepareWalletFundingRequest({ ...input, destination }).route.to).toBe(destination);
  expect(prepareWalletFundingRequest({ ...input, destination: { owner: governance } }).route.to).toBe(governance);
  expect(prepareWalletFundingRequest({ ...input, destination: { owner: governance, subaccount: null } }).route.to).toBe(governance);
  expect(() => prepareWalletFundingRequest({ ...input, destination: ` ${destination}` })).toThrow(/destination/);
  expect(() => prepareWalletFundingRequest({ ...input, destination: { owner: governance, subaccount: new Uint8Array(31) } })).toThrow(/destination/);
});

test("preparation rejects malformed IDs, noncanonical atoms, invalid ledger, and oversized timestamp", () => {
  for (const changes of [
    { requestId: "AB".repeat(16) }, { requestId: "ab" }, { amountAtoms: "0" }, { amountAtoms: "01" },
    { amountAtoms: "1e8" }, { amountAtoms: "9".repeat(81) }, { validUntilNs: "0" },
    { validUntilNs: "18446744073709551616" }, { ledger: ` ${ledger}` }, { ledger: destination },
    { memoHex: "a" }, { memoHex: "AB" }, { memoHex: "00".repeat(33) },
  ]) {
    expect(() => prepareWalletFundingRequest({ ...input, ...changes })).toThrow();
  }
});

test("restoration does not extend an expired deadline or invent a new request ID", () => {
  const restored = prepareWalletFundingRequest({ ...input, validUntilNs: "1" });
  expect(restored.requestId).toBe(requestId);
  expect(restored.validUntilNs).toBe("1");
  expect(rootFundingInstruction(restored).arguments).toEqual(restored);
});

test("normal funding dispatches once through the injected scoped client", async () => {
  const h = harness(transferred());
  const result = await invokeWalletFunding(h.client, request, { root: false, ...identity });
  expect(h.calls).toEqual([{
    call: { target: "app:wallet:background", name: "wallet_fund_v1", arguments: request }, timeout: 180,
  }]);
  expect(result).toEqual(transferred());
  expect(Object.isFrozen(result)).toBe(true);
});

test("root handoff preserves exact funding arguments without dispatching", async () => {
  const instruction = rootFundingInstruction(request);
  expect(instruction).toEqual({ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: request });
  expect(Object.isFrozen(instruction.arguments.route)).toBe(true);
  const h = harness(transferred("agent"));
  const result = await invokeWalletFunding(h.client, request, { root: true, expectedCallerAppId: "agent" });
  expect(h.calls[0]?.call).toEqual(instruction);
  expect(result.commandId).toBe(`agent:${requestId}`);
});

test("pending replies do not auto-retry and explicit retry sends the original deadline and ID", async () => {
  const h = harness(pending());
  expect(await invokeWalletFunding(h.client, request, { root: false, ...identity })).toEqual(pending());
  expect(h.calls).toHaveLength(1);
  expect(await invokeWalletFunding(h.client, request, { root: false, ...identity })).toEqual(pending());
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.call.arguments).toEqual(h.calls[0]?.call.arguments);
});

test("transport rejection is preserved as ambiguous and never changes the request or retries", async () => {
  const lostReply = new Error("Wallet reply was lost after dispatch");
  const h = harness(lostReply);
  await expect(invokeWalletFunding(h.client, request, { root: true, expectedCallerAppId: "agent" })).rejects.toBe(lostReply);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.call.arguments).toEqual(request);
});

test("receipt validation requires exact caller namespace and request ID", () => {
  expect(parseWalletFundingResult(transferred(), request, identity)).toEqual(transferred());
  for (const commandId of [`agent:${requestId}`, `snsgov:${"cd".repeat(16)}`, requestId, `other:snsgov:${requestId}`]) {
    expect(() => parseWalletFundingResult({ ...transferred(), commandId }, request, identity)).toThrow(/another command/);
  }
  expect(() => parseWalletFundingResult(transferred(), request, {} as typeof identity)).toThrow(/expected caller/);
});

test("successful receipts preserve ledger duplicate evidence and reject imprecise or missing blocks", () => {
  expect(parseWalletFundingResult({ ...transferred(), duplicate: true, blockIndex: "0" }, request, identity))
    .toEqual({ ...transferred(), duplicate: true, blockIndex: "0" });
  for (const blockIndex of [null, 42, "01", "-1", "1e20", "9".repeat(81)]) {
    expect(() => parseWalletFundingResult({ ...transferred(), blockIndex }, request, identity)).toThrow(/block index/);
  }
  expect(() => parseWalletFundingResult({ ...transferred(), duplicate: null }, request, identity)).toThrow(/receipt/);
  expect(() => parseWalletFundingResult({ ...transferred(), message: "unexpected" }, request, identity)).toThrow(/receipt/);
});

test("pending and rejected replies cannot carry success evidence; approvals are not transfers", () => {
  const rejected = { ...pending(), status: "rejected" as const, message: "Owner declined" };
  expect(parseWalletFundingResult(rejected, request, identity)).toEqual(rejected);
  for (const changes of [
    { blockIndex: "42" }, { duplicate: false }, { message: null }, { message: "" }, { status: "approved" }, { extra: true },
  ]) {
    expect(() => parseWalletFundingResult({ ...pending(), ...changes }, request, identity)).toThrow();
  }
});

test("invalid caller identity or route fails before dispatch; tool input cannot choose root mode", async () => {
  const h = harness(transferred());
  await expect(invokeWalletFunding(h.client, request, { root: false, expectedCallerAppId: "" })).rejects.toThrow(/expected caller/);
  await expect(invokeWalletFunding(h.client, request, { ...identity } as { root: boolean; expectedCallerAppId: string })).rejects.toThrow(/explicit trusted route/);
  const extraRoot = { ...request, root: true } as WalletFundingRequest;
  await expect(invokeWalletFunding(h.client, extraRoot, { root: false, ...identity })).rejects.toThrow(/request/);
  const allowance = { ...request, route: { kind: "allowance", spender: destination } } as unknown as WalletFundingRequest;
  await expect(invokeWalletFunding(h.client, allowance, { root: false, ...identity })).rejects.toThrow(/route/);
  expect(h.calls).toHaveLength(0);
});

const sourceOwner = "3rurp-vyaaa-aaaay-aacua-cai";
function ledgerEvidence() {
  return {
    version: 1, ledger, owner: sourceOwner, blockIndex: transferred().blockIndex,
    observedAtNs: "1800000000000000001", available: true, error: null,
    source: { kind: "ledger", canister: ledger, method: "icrc3_get_blocks", ledgerVerified: true, archived: false },
    transaction: {
      blockIndex: transferred().blockIndex, operation: "transfer", timestampNs: "1799999999999999999",
      amountAtoms: request.amountAtoms, feeAtoms: "10000", balanceEffectAtoms: "-900719925474099322345",
      from: { kind: "icrc", owner: sourceOwner, subaccountHex: null as string | null },
      to: { kind: "icrc", owner: governance, subaccountHex: "07".repeat(32) }, spender: null,
      memoHex: "0001ff" as string | null, memoComplete: true,
    },
    chainLength: "900719925474099312346", diagnostics: [],
  };
}
const parsedReceipt = () => parseWalletFundingResult(transferred(), request, identity);

test("untrusted root receipts require a live exact ledger lookup matching every transfer field", async () => {
  const h = harness(ledgerEvidence());
  const verified = await verifyWalletFundingReceipt(h.client, request, parsedReceipt(), { expectedSourceAccount: sourceOwner });
  expect(h.calls).toEqual([{
    call: { target: "app:wallet:background", name: "wallet_transaction_v1", arguments: { ledger, blockIndex: transferred().blockIndex, source: "ledger" } },
    timeout: 60,
  }]);
  expect(verified).toMatchObject({ ledgerVerified: true, blockIndex: transferred().blockIndex, sourceAccount: sourceOwner,
    destinationAccount: request.route.to, amountAtoms: request.amountAtoms, memoHex: "0001ff" });
  expect(Object.isFrozen(verified)).toBe(true);
});

test("ledger-returned archives and equivalent zero source subaccounts preserve exact evidence", async () => {
  const evidence = ledgerEvidence();
  evidence.source.archived = true;
  evidence.source.canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  evidence.transaction.from.subaccountHex = "00".repeat(32);
  const h = harness(evidence);
  expect(await verifyWalletFundingReceipt(h.client, request, parsedReceipt(), { expectedSourceAccount: sourceOwner }))
    .toMatchObject({ ledgerVerified: true, sourceAccount: sourceOwner, source: { archived: true, canister: evidence.source.canister } });
});

test("index-only or unavailable history never confirms root funding and never sends funds", async () => {
  for (const changes of [
    { source: { ...ledgerEvidence().source, kind: "index", ledgerVerified: false } },
    { source: { ...ledgerEvidence().source, kind: "index", ledgerVerified: true } },
    { available: false, transaction: null }, { error: "Ledger unavailable" },
  ]) {
    const h = harness({ ...ledgerEvidence(), ...changes });
    await expect(verifyWalletFundingReceipt(h.client, request, parsedReceipt(), { expectedSourceAccount: sourceOwner })).rejects.toThrow(/unresolved/);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.call.name).toBe("wallet_transaction_v1");
  }
});

test("foreign ledger, owner, block, payer, recipient, subaccount, amount, operation, or memo is rejected", async () => {
  const original = ledgerEvidence();
  const changedTransactions = [
    { blockIndex: "1" }, { amountAtoms: "1" }, { operation: "mint" }, { memoHex: null },
    { memoHex: "01ff" }, { memoComplete: false }, { spender: original.transaction.from },
    { from: { ...original.transaction.from, owner: governance } },
    { from: { ...original.transaction.from, subaccountHex: "01".repeat(32) } },
    { to: { ...original.transaction.to, owner: sourceOwner } },
    { to: { ...original.transaction.to, subaccountHex: "08".repeat(32) } },
    { to: { ...original.transaction.to, subaccountHex: "07".repeat(31) } },
  ];
  for (const changed of [
    { ...original, ledger: governance }, { ...original, owner: governance }, { ...original, blockIndex: "1" },
    ...changedTransactions.map(changes => ({ ...original, transaction: { ...original.transaction, ...changes } })),
  ]) {
    const h = harness(changed);
    await expect(verifyWalletFundingReceipt(h.client, request, parsedReceipt(), { expectedSourceAccount: sourceOwner })).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
  }
});

test("an omitted memo and a present empty memo remain distinct when checking ledger evidence", async () => {
  const { memoHex: _memo, ...inputWithoutMemo } = input;
  const withoutMemo = prepareWalletFundingRequest(inputWithoutMemo);
  const evidence = ledgerEvidence();
  evidence.transaction.memoHex = null;
  const good = harness(evidence);
  expect(await verifyWalletFundingReceipt(good.client, withoutMemo, parsedReceipt(), { expectedSourceAccount: sourceOwner })).toMatchObject({ memoHex: null });
  const emptyMemo = prepareWalletFundingRequest({ ...input, memoHex: "" });
  await expect(verifyWalletFundingReceipt(good.client, emptyMemo, parsedReceipt(), { expectedSourceAccount: sourceOwner })).rejects.toThrow(/exact funding/);
});

test("pending receipts and failed evidence reads cannot trigger a financial retry", async () => {
  const h = harness(new Error("Ledger evidence unavailable"));
  await expect(verifyWalletFundingReceipt(h.client, request, parseWalletFundingResult(pending(), request, identity), { expectedSourceAccount: sourceOwner }))
    .rejects.toThrow(/no transferred receipt/);
  expect(h.calls).toHaveLength(0);
  await expect(verifyWalletFundingReceipt(h.client, request, parsedReceipt(), { expectedSourceAccount: sourceOwner })).rejects.toThrow(/evidence unavailable/);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.call.name).toBe("wallet_transaction_v1");
});

function overview(ledgers: string[]) {
  return { revision: "1", capturedAt: 1800000000000, configured: ledgers.length > 0, assetCount: ledgers.length,
    assets: ledgers.map(principal => ({ principal, balance: null, issue: "Metadata unavailable" })),
    activity: [], historyError: "Index unavailable" };
}

test("token selection reads the actual Wallet overview tool without metadata or balance mutations", async () => {
  const selected = harness(overview([governance, ledger]));
  expect(await readWalletTokenSelection(selected.client, ledger)).toEqual({ ledger, selected: true });
  expect(selected.calls).toEqual([{
    call: { target: "app:wallet:background", name: "wallet_overview", arguments: { includeLogos: false } }, timeout: 60,
  }]);
  const missing = harness(overview([governance]));
  expect(await readWalletTokenSelection(missing.client, ledger)).toEqual({ ledger, selected: false });
  const empty = harness(overview([]));
  expect(await readWalletTokenSelection(empty.client, ledger)).toEqual({ ledger, selected: false });
});

test("failed or malformed selection reads never become an unselected answer or trigger setup", async () => {
  for (const reply of [
    new Error("Wallet unavailable"), {}, { ...overview([]), assets: null },
    { ...overview([ledger]), assetCount: 2 }, { ...overview([]), configured: "false" },
    { ...overview([ledger]), assets: [{}] }, { ...overview([ledger]), assets: [{ principal: "invalid" }] },
  ]) {
    const h = harness(reply);
    await expect(readWalletTokenSelection(h.client, ledger)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.call.name).toBe("wallet_overview");
  }
});

test("ledger selection instructions choose the exact normal or root endpoint without dispatch", () => {
  expect(walletLedgerInstruction(ledger, { root: false })).toEqual({
    target: "app:wallet:background", name: "wallet_add_ledger_v1", arguments: { ledger },
  });
  const root = walletLedgerInstruction(ledger, { root: true });
  expect(root).toEqual({ target: "app:wallet:background", name: "wallet_add_ledger_root_v1", arguments: { ledger } });
  expect(Object.isFrozen(root)).toBe(true);
  expect(Object.isFrozen(root.arguments)).toBe(true);
  expect(() => walletLedgerInstruction(ledger, {} as { root: boolean })).toThrow(/explicit trusted route/);
  expect(() => walletLedgerInstruction(` ${ledger}`, { root: true })).toThrow(/canonical/);
});

test("reviewed normal ledger addition preserves confirmed selection even when later metadata fails", async () => {
  for (const alreadySelected of [false, true]) {
    const h = harness({ ledger, selected: true, alreadySelected, tokenInfo: null, metadataError: "Metadata unavailable" });
    expect(await invokeWalletLedgerAddition(h.client, ledger)).toEqual({ ledger, selected: true, alreadySelected, metadataError: "Metadata unavailable" });
    expect(h.calls).toEqual([{
      call: { target: "app:wallet:background", name: "wallet_add_ledger_v1", arguments: { ledger } }, timeout: 180,
    }]);
  }
});

test("ledger addition verifies exact saved selection and never retries a lost response itself", async () => {
  const success = { ledger, selected: true, alreadySelected: false, tokenInfo: null, metadataError: null };
  for (const reply of [
    new Error("Selection reply lost"), { ...success, ledger: governance }, { ...success, selected: false },
    { ...success, alreadySelected: "false" }, { ...success, metadataError: 1 },
  ]) {
    const h = harness(reply);
    await expect(invokeWalletLedgerAddition(h.client, ledger)).rejects.toThrow();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.call.name).toBe("wallet_add_ledger_v1");
  }
  const h = harness(success);
  await expect(invokeWalletLedgerAddition(h.client, "not-a-principal")).rejects.toThrow(/canonical/);
  expect(h.calls).toHaveLength(0);
});

test("root ledger addition is verified by rereading saved selection on continuation", async () => {
  const before = harness(overview([]));
  expect((await readWalletTokenSelection(before.client, ledger)).selected).toBe(false);
  expect(walletLedgerInstruction(ledger, { root: true }).name).toBe("wallet_add_ledger_root_v1");
  expect(before.calls).toHaveLength(1);
  const after = harness(overview([ledger]));
  expect((await readWalletTokenSelection(after.client, ledger)).selected).toBe(true);
  expect(after.calls.map(value => value.call.name)).toEqual(["wallet_overview"]);
});
