import { expect, test } from "bun:test";
import type { SelfCallValue } from "neutron-tools/app";
import {
  createEthereumWithdrawalAttempt,
  executeEthereumWithdrawal,
  isNativeSettlementPending,
  refreshSubmittedWithdrawals,
} from "../src/ethereum_withdrawal_controller.ts";
import { parseTransferOperation, transferIdBytes, type WalletTransferOperation } from "../src/transfers.ts";
import type { WalletWithdrawalQuote } from "../src/withdrawal_quote.ts";

const requestId = "12".repeat(16);
const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const address = "0x52908400098527886E0F7030069857D2E4169EE7";
const input = { ledger, address, amountAtoms: "1000000" };

function wireOperation(status: WalletTransferOperation["status"], id = requestId, native = true) {
  return {
    request_id: transferIdBytes(id), ledger, amount: "1000000", destination: address.toLowerCase(), native,
    status: status === "pending" ? { pending: null } : status === "rejected" ? { rejected: "Insufficient funds" }
      : { succeeded: { block_index: "91", duplicate: false, native, amount: "1000000" } },
  };
}

test("review freezes the exact address, amount, quote and ID before asynchronous preparation", () => {
  const quote = { ledger, amount: "1000000", authorization: {
    assetFee: "10000", gas: { ledger, minter: "aaaaa-aa", budget: "20", ledgerFee: "2" },
  } } as WalletWithdrawalQuote;
  const attempt = createEthereumWithdrawalAttempt({ ...input, quote }, requestId);
  quote.authorization.assetFee = "99999";
  quote.authorization.gas!.budget = "99999";
  const bytes = attempt.args.request_id as Uint8Array;
  bytes.fill(0);
  expect(attempt.requestId).toBe(requestId);
  expect(attempt.args).toEqual({
    request_id: transferIdBytes(requestId), ledger, address: address.toLowerCase(), amount: "1000000",
    withdrawal_quote: { asset_fee: "10000", gas: { ledger, minter: "aaaaa-aa", budget: "20", ledger_fee: "2" } },
  });
  expect(() => { attempt.args.amount = "2000000"; }).toThrow();
  expect(() => createEthereumWithdrawalAttempt({ ...input, address: "0xnope" })).toThrow("Ethereum address");
  expect(() => createEthereumWithdrawalAttempt({ ...input, amountAtoms: "0" })).toThrow("positive");
  expect(() => createEthereumWithdrawalAttempt({ ...input, amountAtoms: "2", quote })).toThrow("quote");
  expect(() => createEthereumWithdrawalAttempt(input, "bad-id")).toThrow("request ID");
});

test("a route-only fee quote authorizes the selected amount while preserving the exact reviewed fees", () => {
  const quote = { ledger, amount: null, authorization: {
    assetFee: "10000", gas: { ledger, minter: "aaaaa-aa", budget: "20", ledgerFee: "2" },
  } } as WalletWithdrawalQuote;
  const attempt = createEthereumWithdrawalAttempt({ ...input, quote }, requestId);
  quote.authorization.assetFee = "99999";
  quote.authorization.gas!.budget = "99999";
  expect(attempt.args.amount).toBe(input.amountAtoms);
  expect(attempt.args.withdrawal_quote).toEqual({
    asset_fee: "10000", gas: { ledger, minter: "aaaaa-aa", budget: "20", ledger_fee: "2" },
  });
  expect(() => createEthereumWithdrawalAttempt({ ...input, quote: { ...quote, amount: "2" } })).toThrow("quote");
  expect(() => createEthereumWithdrawalAttempt({ ...input, quote: { ...quote, ledger: "aaaaa-aa" } })).toThrow("quote");
});

for (const lostAt of ["prepare", "resume"] as const) test(`a lost ${lostAt} reply retains the same intent and reconciles without a second burn`, async () => {
  const attempt = createEthereumWithdrawalAttempt(input, requestId);
  const calls: { method: string; args: SelfCallValue[] }[] = [];
  let stored: ReturnType<typeof wireOperation> | null = null;
  let loseReply = true;
  let burns = 0;
  const backend = { updateSelf: async (method: string, args: SelfCallValue[]) => {
    calls.push({ method, args });
    if (method === "wallet_ethereum_withdraw_prepare_v1") {
      expect(args).toEqual([attempt.args]);
      stored ??= wireOperation("pending");
      if (lostAt === "prepare" && loseReply) { loseReply = false; throw new Error("Reply lost"); }
      return stored;
    }
    expect(method).toBe("wallet_transfer_resume_v2");
    expect(args).toEqual([transferIdBytes(requestId)]);
    burns++;
    stored = wireOperation("succeeded");
    if (lostAt === "resume" && loseReply) { loseReply = false; throw new Error("Reply lost"); }
    return stored;
  } };
  await expect(executeEthereumWithdrawal(attempt, backend)).rejects.toThrow("Reply lost");
  expect(attempt.operation?.status ?? null).toBe(lostAt === "prepare" ? null : "pending");
  const result = await executeEthereumWithdrawal(attempt, backend);
  expect(result.status).toBe("succeeded");
  expect(burns).toBe(1);
  expect(calls.filter((call) => call.method === "wallet_ethereum_withdraw_prepare_v1")).toHaveLength(2);
  expect(attempt.requestId).toBe(requestId);
});

test("received operations are saved before callbacks, so a failing UI callback cannot resubmit a successful burn", async () => {
  const attempt = createEthereumWithdrawalAttempt(input, requestId);
  const calls: string[] = [];
  const backend = { updateSelf: async (method: string) => {
    calls.push(method);
    return wireOperation(method === "wallet_ethereum_withdraw_prepare_v1" ? "pending" : "succeeded");
  } };
  await expect(executeEthereumWithdrawal(attempt, backend, (operation) => {
    expect(attempt.operation).toBe(operation);
    if (operation.status === "succeeded") throw new Error("UI stopped");
  })).rejects.toThrow("UI stopped");
  expect(attempt.operation?.status).toBe("succeeded");
  await executeEthereumWithdrawal(attempt, backend);
  expect(calls).toEqual(["wallet_ethereum_withdraw_prepare_v1", "wallet_transfer_resume_v2", "wallet_transfer_refresh_v2"]);
});

test("rejected and completed nonnative attempts do not issue further financial calls", async () => {
  for (const status of ["rejected", "succeeded"] as const) {
    const attempt = createEthereumWithdrawalAttempt(input, requestId);
    const operation = parseTransferOperation(wireOperation(status, requestId, false));
    attempt.operation = operation;
    expect(await executeEthereumWithdrawal(attempt, { updateSelf: async () => { throw new Error("Unexpected call"); } })).toBe(operation);
  }
});

test("settlement polling refreshes pending and submitted native requests without resume, preserves failed reads, and continues sequentially", async () => {
  const operations: WalletTransferOperation[] = [];
  for (const native of [false, true]) for (const status of ["pending", "succeeded", "rejected"] as const) {
    for (const settlement of [null, "pending", "submitted", "unknown", "confirmed", "failed"] as const) {
      operations.push({ ...parseTransferOperation(wireOperation(status, operations.length.toString(16).padStart(32, "0"), native)),
        settlement: settlement === null ? null : { status: settlement, message: "", transactionHash: null },
      });
    }
  }
  const eligible = operations.filter(isNativeSettlementPending);
  expect(eligible).toHaveLength(8);
  const calls: string[] = [];
  let active = false;
  const result = await refreshSubmittedWithdrawals(operations, async (method, args) => {
    expect(method).toBe("wallet_transfer_refresh_v2");
    expect(active).toBe(false);
    active = true;
    await Promise.resolve();
    active = false;
    const id = [...args[0] as Uint8Array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    calls.push(id);
    if (id === eligible[1]!.requestId) throw new Error("Temporary status failure");
    return { ...wireOperation("succeeded", id), settlement: { status: { confirmed: { transaction_hash: `0x${"ab".repeat(32)}` } } } };
  });
  expect(calls).toEqual(eligible.map((operation) => operation.requestId));
  expect(result).toHaveLength(operations.length);
  for (let index = 0; index < operations.length; index++) {
    const original = operations[index]!;
    if (!isNativeSettlementPending(original) || original === eligible[1]) expect(result[index]).toBe(original);
    else expect(result[index]!.settlement?.status).toBe("confirmed");
  }
});
