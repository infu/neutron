import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import type { EthereumFundingRecord } from "../src/ethereum.ts";
import type { PurchaseQuote } from "../src/view-types.ts";
import type { EthereumProviderConnection } from "neutron-tools/app";

if (process.env.NEUTRON_MARKETPLACE_TILE_TEST_CHILD !== "1") {
  test("browser checkout uses original transactions and mined evidence before verification", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_TILE_TEST_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  type Data = Record<string, any>;
  const events: string[] = [], calls: Array<{ name: string; method: string; params: Data }> = [], sends: Data[] = [];
  const journal = new Map<string, EthereumFundingRecord>();
  const OPERATION = "12".repeat(16), OWNER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const payer = "0x1111111111111111111111111111111111111111", helper = "0x2222222222222222222222222222222222222222", minter = "0x3333333333333333333333333333333333333333";
  let fundingRequired: boolean | undefined;
  let allowance: bigint, preparedResult: Data, approvalReceipt: "success" | "pending" | "reverted", depositReceipt: "success" | "pending" | "reverted", rejectSend: boolean;
  const copy = <T>(value: T): T => structuredClone(value);
  mock.module("neutron-tools/app", () => ({
    connectEthereumProvider: async () => { throw new Error("The client must receive the existing click-connected wallet."); },
    callTool: async (call: Data) => {
      const method = call.arguments.method, args = JSON.parse(call.arguments.paramsJson);
      calls.push({ name: call.name, method, params: args }); events.push(`app:${method}`);
      let result: any;
      if (method === "ethereumPrepareBrowser") result = { plan, result: preparedResult, fundingRequired };
      else if (method === "ethereumJournalRead") result = journal.get(args.kind) ?? null;
      else if (method === "ethereumJournalClaim") {
        const existing = journal.get(args.record.step.kind);
        result = { claimed: !existing, record: existing ?? args.record };
        if (!existing) journal.set(args.record.step.kind, copy(args.record));
      } else if (method === "ethereumJournalRecord") {
        expect(journal.get(args.previous.step.kind)).toEqual(args.previous);
        journal.set(args.previous.step.kind, copy(args.next)); result = args.next;
      } else if (method === "operation") {
        const record = journal.get("deposit") ?? journal.get("approval");
        result = { operationId: OPERATION, state: record?.state === "reverted" || record?.state === "rejected" ? "failed" : "pending", nextAction: record?.state === "unknown" ? "review" : "resume", ethereumWallet: "browser", entitled: false, message: record?.message ?? "Pending original payment" };
      } else if (method === "ethereumVerifyBrowser") {
        if (fundingRequired !== false) expect(journal.get("deposit")?.state).toBe("confirmed");
        events.push("protocol:verified");
        result = { operationId: OPERATION, state: "complete", nextAction: "none", ethereumWallet: "browser", entitled: true, settlement: { state: "pending", message: "Wrapping separately" }, message: "Apps available" };
      } else if (method === "purchase" || method === "resumeOperation") result = { operationId: OPERATION, state: "pending" };
      else throw new Error(`Unexpected app call ${method}`);
      return { resultJson: JSON.stringify(result) };
    },
  }));
  mock.module("../src/publication.ts", () => ({ base64: () => "", preparePublication: async () => null, publicationFiles: () => [], UPLOAD_CHUNK_BYTES: 1024 }));
  const actual = await import("../src/ethereum.ts");
  const originalPoll = actual.pollEthereumFundingReceipt;
  // Keep real call encoding, payer/route validation, durable driver and receipt
  // checks. Only the timer budget changes so pending tests do not sleep.
  mock.module("../src/ethereum.ts", () => ({ ...actual, pollEthereumFundingReceipt: (provider: Parameters<typeof actual.pollEthereumFundingReceipt>[0], record: EthereumFundingRecord, options: Parameters<typeof actual.pollEthereumFundingReceipt>[2]) => originalPoll(provider, record, { ...options, timeoutMs: 0 }) }));
  const route = { chainId: "1", tokenAddress: actual.ETHEREUM_USDC, helperAddress: helper, minterAddress: minter, recipientPrincipal: OWNER };
  const plan = actual.buildEthereumFundingPlan({ operationId: OPERATION, amountAtoms: "1010000", payerAddress: payer, principalWord: actual.principalToEthereumWord(OWNER), subaccountWord: `0x${"99".repeat(32)}`, route }, route, { approval: "34".repeat(16), deposit: "56".repeat(16) });
  const txHash = (kind: "approval" | "deposit"): Hex => `0x${(kind === "approval" ? "aa" : "bb").repeat(32)}`;
  const provider = {
    async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<any> {
      events.push(`rpc:${method}`);
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_requestAccounts") return [payer];
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_call") {
        const request = params[0] as Data;
        if (request.to.toLowerCase() === helper) return encodeFunctionResult({ abi: actual.DEPOSIT_HELPER_ABI, functionName: "getMinterAddress", result: minter });
        const decoded = decodeFunctionData({ abi: actual.ERC20_ABI, data: request.data });
        if (decoded.functionName === "allowance") return encodeFunctionResult({ abi: actual.ERC20_ABI, functionName: "allowance", result: allowance });
        if (decoded.functionName === "balanceOf") return encodeFunctionResult({ abi: actual.ERC20_ABI, functionName: "balanceOf", result: 10000000n });
        throw new Error("Unexpected contract read");
      }
      if (method === "eth_sendTransaction") {
        if (rejectSend) throw Object.assign(new Error("Declined"), { code: 4001 });
        const transaction = params[0] as Data, kind = transaction.to.toLowerCase() === helper ? "deposit" : "approval";
        expect(journal.get(kind)?.state).toBe("unknown");
        sends.push(copy(transaction)); events.push(`send:${kind}`); return txHash(kind);
      }
      if (method === "eth_getTransactionReceipt") {
        const kind = params[0] === txHash("approval") ? "approval" : "deposit", state = kind === "approval" ? approvalReceipt : depositReceipt;
        if (state === "pending") return null;
        if (kind === "approval" && state === "success") allowance = BigInt(plan.invoice.amountAtoms);
        events.push(`receipt:${kind}:${state}`);
        return { transactionHash: txHash(kind), from: payer, to: plan.steps[kind].transaction.to, blockNumber: "0x100", status: state === "success" ? "0x1" : "0x0" };
      }
      throw new Error(`Unexpected provider method ${method}`);
    },
  };
  const connection = { provider, close: async () => { events.push("close"); } } as unknown as EthereumProviderConnection;
  const quote = { operationId: OPERATION, appIds: ["editor"], ethereum: { wallet: "browser" } } as PurchaseQuote;
  const { createMarketplaceClient } = await import("../src/tile_client.ts");
  const client = createMarketplaceClient();
  function retained(kind: "approval" | "deposit", state: EthereumFundingRecord["state"], hash = true): EthereumFundingRecord {
    return { version: 1, invoiceId: OPERATION, source: "browser", step: plan.steps[kind], state, transactionHash: hash ? txHash(kind) : null, walletIntent: null, receipt: state === "confirmed" ? { status: "success", blockNumber: "256", finality: "included" } : null, message: "Original transaction" };
  }
  beforeEach(() => {
    events.length = 0; calls.length = 0; sends.length = 0; journal.clear(); fundingRequired = undefined; allowance = 0n; approvalReceipt = "success"; depositReceipt = "success"; rejectSend = false;
    preparedResult = { operationId: OPERATION, state: "pending", nextAction: "resume", entitled: false, ethereumWallet: "browser" };
  });
  test("approval and deposit are durable and mined before one charged verification", async () => {
    const result = await client.purchase(quote, connection);
    expect(sends).toHaveLength(2);
    expect(result).toMatchObject({ operationId: OPERATION, state: "complete", entitled: true, settlement: { state: "pending" } });
    expect(events.indexOf("receipt:approval:success")).toBeLessThan(events.indexOf("send:deposit"));
    expect(events.indexOf("receipt:deposit:success")).toBeLessThan(events.indexOf("app:ethereumVerifyBrowser"));
    expect(calls.filter(call => call.method === "ethereumVerifyBrowser")).toEqual([{ name: "ui_update", method: "ethereumVerifyBrowser", params: { operationId: OPERATION } }]);
    expect(calls.filter(call => call.method === "ethereumJournalRead").every(call => call.name === "ui_query")).toBe(true);
    expect(calls[0]?.params.quote.operationId).toBe(OPERATION);
  });
  test("approval success alone does not grant app access", async () => {
    depositReceipt = "pending";
    const result = await client.purchase(quote, connection);
    expect(journal.get("approval")?.state).toBe("confirmed");
    expect(journal.get("deposit")?.state).toBe("submitted");
    expect(result).toMatchObject({ operationId: OPERATION, state: "pending", entitled: false });
    expect(events).not.toContain("app:ethereumVerifyBrowser");
    expect(calls.at(-1)).toMatchObject({ name: "ui_query", method: "operation", params: { operationId: OPERATION } });
  });
  test("pending approval returns its original ID without dispatching a deposit", async () => {
    approvalReceipt = "pending";
    const result = await client.purchase(quote, connection);
    expect(result.operationId).toBe(OPERATION);
    expect(sends).toHaveLength(1);
    expect(journal.has("deposit")).toBe(false);
    expect(events).not.toContain("app:ethereumVerifyBrowser");
  });
  test("an exact existing USDC allowance skips the approval transaction", async () => {
    allowance = BigInt(plan.invoice.amountAtoms);
    const result = await client.purchase(quote, connection);
    expect(result.entitled).toBe(true);
    expect(sends).toEqual([plan.steps.deposit.transaction]);
    expect(journal.has("approval")).toBe(false);
  });
  test("an oversized allowance is bounded again before payment", async () => {
    allowance = BigInt(plan.invoice.amountAtoms) + 1n;
    await client.purchase(quote, connection);
    expect(sends[0]).toEqual(plan.steps.approval.transaction);
    const decoded = decodeFunctionData({ abi: actual.ERC20_ABI, data: sends[0]!.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args?.[1]).toBe(BigInt(plan.invoice.amountAtoms));
  });
  test("resume observes an existing deposit hash without another wallet send", async () => {
    journal.set("deposit", retained("deposit", "submitted"));
    const result = await client.resumeOperation(OPERATION, connection);
    expect(result.entitled).toBe(true);
    expect(sends).toHaveLength(0);
    expect(calls[0]).toMatchObject({ method: "ethereumPrepareBrowser", params: { operationId: OPERATION } });
    expect(events).not.toContain("rpc:eth_call");
    expect(calls.filter(call => call.method === "ethereumVerifyBrowser")).toHaveLength(1);
  });
  test("a still-pending retained deposit remains on the same invoice", async () => {
    journal.set("deposit", retained("deposit", "submitted")); depositReceipt = "pending";
    const result = await client.resumeOperation(OPERATION, connection);
    expect(result).toMatchObject({ operationId: OPERATION, state: "pending", entitled: false });
    expect(sends).toHaveLength(0);
    expect(events).not.toContain("app:ethereumVerifyBrowser");
    depositReceipt = "success";
    expect((await client.resumeOperation(OPERATION, connection)).entitled).toBe(true);
    expect(sends).toHaveLength(0);
  });
  test("unknown browser send without a hash never recreates its payment", async () => {
    journal.set("deposit", retained("deposit", "unknown", false));
    const result = await client.resumeOperation(OPERATION, connection);
    expect(result).toMatchObject({ operationId: OPERATION, state: "pending", nextAction: "review", entitled: false });
    expect(sends).toHaveLength(0);
    expect(events).not.toContain("rpc:eth_getTransactionReceipt");
    expect(events).not.toContain("app:ethereumVerifyBrowser");
  });
  test("a reverted deposit cannot grant ownership or resend", async () => {
    journal.set("deposit", retained("deposit", "submitted")); depositReceipt = "reverted";
    expect((await client.resumeOperation(OPERATION, connection)).state).toBe("failed");
    expect(journal.get("deposit")?.state).toBe("reverted");
    expect(sends).toHaveLength(0);
    expect(events).not.toContain("app:ethereumVerifyBrowser");
  });
  test("entitled or non-resumable invoices do not touch the wallet", async () => {
    for (const result of [{ ...preparedResult, state: "complete", entitled: true, nextAction: "none" }, { ...preparedResult, nextAction: "review" }]) {
      preparedResult = result;
      expect(await client.resumeOperation(OPERATION, connection)).toEqual(result);
    }
    expect(events.filter(event => event.startsWith("rpc:"))).toEqual([]);
    expect(calls.every(call => call.method === "ethereumPrepareBrowser")).toBe(true);
  });
  test("an invoice with retained protocol payment evidence never re-funds", async () => {
    fundingRequired = false;
    expect((await client.resumeOperation(OPERATION, connection)).entitled).toBe(true);
    expect(sends).toHaveLength(0);
    expect(journal.size).toBe(0);
    expect(events.filter(event => event.startsWith("rpc:"))).toEqual([]);
    expect(calls.map(call => call.method)).toEqual(["ethereumPrepareBrowser", "ethereumVerifyBrowser"]);
    expect(calls[1]?.params).toEqual({ operationId: OPERATION });
  });
  test("missing browser connection cannot fall back to a different funding rail", async () => {
    await expect(client.purchase(quote)).rejects.toThrow("original browser wallet");
    expect(calls).toHaveLength(0);
    await client.purchase({ ...quote, ethereum: { ...quote.ethereum!, wallet: "evm_wallet" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("purchase");
    expect(events.filter(event => event.startsWith("rpc:"))).toEqual([]);
  });
}
