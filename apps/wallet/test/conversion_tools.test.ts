import { expect, test } from "bun:test";
import type { MsgBusToolContext, SelfCallObject } from "neutron-tools/app";
import { normalizeToolDescriptor, validateToolResult } from "neutron-tools/protocol";
import { handleWalletUnwrap, handleWalletUnwrapStatus, unwrapResult, walletUnwrapOperationId, walletUnwrapInputSchema, walletUnwrapOutputSchema } from "../src/conversion_tools.ts";
import { transferIdBytes, type WalletTransferOperation } from "../src/transfers.ts";

const ledger = "xevnm-gaaaa-aaaar-qafnq-cai";
const gasLedger = "ss2fx-dyaaa-aaaar-qacoq-cai";
const minter = "sv3dd-oaaaa-aaaar-qacoa-cai";
const address = `0x${"11".repeat(20)}`;
const requestId = "ab".repeat(16);
const args = { requestId, ledger, amountAtoms: "3000000", ethereumAddress: address };

function harness() {
  const calls: string[] = [];
  let request: SelfCallObject | null = null;
  let state: "pending" | "succeeded" | "rejected" = "pending";
  let confirmed = false;
  let loseResume = false;
  let gasSufficient = true;
  const context = {
    audience: "agent_root", agentMode: true, caller: { appId: "agent", installationUid: "51" },
    reportProgress() {},
    kernel: {
      async querySelf(method: string) {
        calls.push(method);
        if (method === "wallet_transfer_status_v2") { if (!request) throw new Error("Transfer request was not found"); return operation(); }
        throw new Error(`Unexpected query ${method}`);
      },
      async updateSelf(method: string, values: SelfCallObject[]) {
        calls.push(method);
        if (method === "wallet_withdrawal_quote_v1") return {
          ledger, minter, observed_at_ns: "1", amount: "3000000", asset_fee: "10000",
          asset_allowance: "3000000", asset_total_debit: "3010000", asset_balance: "9000000", asset_sufficient: true,
          gas: { ledger: gasLedger, budget: "1000000", ledger_fee: "2000", allowance: "1000000", total_debit: "1002000", balance: gasSufficient ? "9999999999" : "0", sufficient: gasSufficient },
          authorization: { asset_fee: "10000", gas: { ledger: gasLedger, minter, budget: "1000000", ledger_fee: "2000" } },
        };
        if (method === "wallet_ethereum_withdraw_prepare_v1") { request = values[0]!; return operation(); }
        if (method === "wallet_transfer_resume_v2") {
          state = "succeeded";
          if (loseResume) throw new Error("Response lost after burn");
          return operation();
        }
        if (method === "wallet_transfer_refresh_v2") { confirmed = state === "succeeded"; return operation(); }
        throw new Error(`Unexpected update ${method}`);
      },
      async callTool() { throw new Error("Explicit Ethereum destinations require no EVM signing or account call"); },
    },
  } as unknown as MsgBusToolContext;
  const opId = walletUnwrapOperationId(context, requestId);
  function operation() {
    return {
      request_id: transferIdBytes(opId), ledger, amount: "3000000", destination: address, native: true,
      status: { [state]: state === "succeeded" ? { duplicate: false, native: true, block_index: "77" } : state === "rejected" ? "Rejected" : null },
      ...(confirmed ? { settlement: { checked_at: "2", status: { confirmed: { transaction_hash: `0x${"ee".repeat(32)}` } } } } : {}),
    };
  }
  return { context, calls, opId, get request() { return request; }, set loseResume(value: boolean) { loseResume = value; }, set gasSufficient(value: boolean) { gasSufficient = value; } };
}

test("root unwrap executes a reviewed ckERC20 withdrawal and follows actual settlement", async () => {
  const h = harness();
  const result = await handleWalletUnwrap(args, h.context);
  expect(result).toMatchObject({ requestId, operationId: h.opId, ledger, amountAtoms: "3000000", ethereumAddress: address, phase: "completed", burnBlockIndex: "77", nextAction: "none" });
  expect(h.calls).toEqual(["wallet_transfer_status_v2", "wallet_withdrawal_quote_v1", "wallet_ethereum_withdraw_prepare_v1", "wallet_transfer_resume_v2", "wallet_transfer_refresh_v2"]);
  expect(h.request?.withdrawal_quote).toEqual({ asset_fee: "10000", gas: { ledger: gasLedger, minter, budget: "1000000", ledger_fee: "2000" } });
  const descriptor = normalizeToolDescriptor({ name: "wallet_test_unwrap", inputSchema: walletUnwrapInputSchema, outputSchema: walletUnwrapOutputSchema });
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
});

test("accepted withdrawal replay never requotes, approves or withdraws again", async () => {
  const h = harness();
  await handleWalletUnwrap(args, h.context);
  h.calls.length = 0;
  expect((await handleWalletUnwrap(args, h.context)).phase).toBe("completed");
  expect(h.calls).toEqual(["wallet_transfer_status_v2"]);
  await expect(handleWalletUnwrap({ ...args, amountAtoms: "4000000" }, h.context)).rejects.toThrow("different withdrawal");
});

test("lost burn response returns the durable operation, and status never dispatches a new withdrawal", async () => {
  const h = harness(); h.loseResume = true;
  const result = await handleWalletUnwrap(args, h.context);
  expect(result).toMatchObject({ phase: "withdrawing", nextAction: "check_status", operationId: h.opId, burnBlockIndex: "77" });
  expect(result.message).toContain("Response lost after burn");
  h.calls.length = 0;
  expect((await handleWalletUnwrapStatus({ operationId: h.opId }, h.context)).phase).toBe("completed");
  expect(h.calls).toEqual(["wallet_transfer_status_v2", "wallet_transfer_refresh_v2"]);
});

test("root attestation and sufficient ckETH are checked before preparing effects", async () => {
  const h = harness();
  await expect(handleWalletUnwrap(args, { ...h.context, audience: undefined } as unknown as MsgBusToolContext)).rejects.toThrow("root-agent attestation");
  expect(h.calls).toEqual([]);
  h.gasSufficient = false;
  await expect(handleWalletUnwrap(args, h.context)).rejects.toThrow("Insufficient ckETH");
  expect(h.calls).toEqual(["wallet_transfer_status_v2", "wallet_withdrawal_quote_v1"]);
});

test("original caller installation scopes withdrawal IDs", () => {
  const h = harness();
  expect(walletUnwrapOperationId(h.context, requestId)).toBe(h.opId);
  expect(walletUnwrapOperationId({ ...h.context, caller: { ...h.context.caller!, installationUid: "52" } }, requestId)).not.toBe(h.opId);
});

test("approval or burn alone is never reported as Ethereum completion", () => {
  const operation: WalletTransferOperation = { requestId, ledger, amount: "3", destination: address, native: true, status: "pending", message: null, receipt: null, settlement: null };
  expect(unwrapResult(operation, requestId).phase).toBe("pending");
  expect(unwrapResult({ ...operation, status: "succeeded", receipt: { block_index: "1" } }, requestId).phase).toBe("withdrawing");
  expect(unwrapResult({ ...operation, settlement: { status: "unknown", transactionHash: null, message: "Unknown burn" } }, requestId)).toMatchObject({ phase: "unresolved", nextAction: "resume_same_request" });
});
