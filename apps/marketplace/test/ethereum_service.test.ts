import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Service registration mocks stay in a child process so the app's real client,
// signing and durable journal tests keep their production implementations.
if (process.env.NEUTRON_MARKETPLACE_SERVICE_TEST_CHILD !== "1") {
  test("Ethereum service preserves payment rail, caller and recovery identities", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_SERVICE_TEST_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${output.message}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  type Data = Record<string, any>;
  const OPERATION = "12".repeat(16);
  const registered = new Map<string, { specification: Data; handler: (args: Data, context: Data) => Promise<Data> }>();
  const calls: Array<{ name: string; args: any[] }> = [];
  const stored = new Map<string, Data>();
  let ethereum: Data | null, original: Data | null, ethereumCursor: string | null;
  let icRecent: Data[], ethereumRecent: Data[];
  const invoke = (name: string, value: unknown = null) => async (...args: any[]) => { calls.push({ name, args }); return value; };
  const quote = (wallet = "evm_wallet") => ({ operationId: OPERATION, appIds: ["editor"], token: "ckUSDC", affiliateCode: "", ethereum: { wallet, payerAddress: "0x1111111111111111111111111111111111111111" } });
  const output = () => ({ operationId: OPERATION, state: "complete", entitled: true, nextAction: "none", message: "Apps available", settlement: { state: "pending", message: "Wrapping pending" } });
  mock.module("neutron-tools/app", () => ({
    exposeTool: (name: string, specification: Data, handler: (args: Data, context: Data) => Promise<Data>) => registered.set(name, { specification, handler }),
    publishAppStateChange: async () => undefined,
  }));
  mock.module("../src/client.ts", () => ({
    initialize: invoke("initialize"), configured: invoke("configured"), connect: invoke("connect"), randomId: () => OPERATION,
    protocolClient: async () => ({ quotePurchase: invoke("icQuote", quote()), quoteWithdrawal: invoke("withdrawQuote"), query: invoke("icQuery", []), update: invoke("update") }),
  }));
  mock.module("../src/store.ts", () => ({ loadIntent: async (_kernel: unknown, key: string) => stored.get(key) ?? null }));
  mock.module("../src/actions.ts", () => ({
    runPurchase: invoke("icPurchase"), runWithdrawal: invoke("icWithdrawal"), operationStatus: invoke("icStatus", { operationId: OPERATION, state: "pending" }),
    operationHistory: invoke("icHistory", { purchases: [], withdrawals: [], nextPurchaseCursor: "done", nextWithdrawalCursor: "done" }),
    recentOperations: async () => icRecent, resumeOperation: invoke("icResume"),
  }));
  mock.module("../src/ethereum_actions.ts", () => ({
    quoteEthereumPurchase: invoke("ethQuote", quote()), runEthereumPurchase: invoke("ethPurchase", output()), resumeEthereumPurchase: invoke("ethResume", output()),
    ethereumSavedStatus: async () => ethereum, recentEthereumPurchases: async () => ethereumRecent,
    prepareEthereumBrowser: invoke("browserPrepare"), ethereumJournalRead: invoke("journalRead"), ethereumJournalClaim: invoke("journalClaim"),
    ethereumJournalRecord: invoke("journalRecord"), finishEthereumBrowser: invoke("browserVerify"), settleEthereumPurchase: invoke("ethSettle"), cancelEthereumPurchase: invoke("ethCancel"), verifyEthereumTransaction: invoke("ethVerifyOriginal"),
  }));
  mock.module("../src/ethereum_client.ts", () => ({
    ethereumInvoiceStatus: async () => original,
    ethereumHistory: async (...args: any[]) => { calls.push({ name: "ethHistory", args }); return { items: ethereum ? [ethereum] : [], nextCursor: ethereumCursor }; },
  }));
  mock.module("../src/install.ts", () => ({ quoteInstallation: invoke("installQuote"), installApplications: invoke("installApps"), prepareInstallationForTile: invoke("installTile"), installationStatus: async () => null, recentInstallations: async () => [], markInstallationOpened: invoke("installationOpened"), resumeInstallation: async () => null }));
  mock.module("../src/publishing.ts", () => Object.fromEntries(["beginPublication", "beginArtifact", "writeArtifact", "finishPublication", "quotePublication"].map(name => [name, invoke(name)])));
  await import("../src/service.ts");
  const tile = { agentMode: false, caller: { appId: "marketplace", role: "tile" }, kernel: {} };
  const root = { agentMode: true, caller: { appId: "agent", role: "background" }, kernel: {} };
  const normalAgent = { agentMode: false, caller: { appId: "agent", role: "background" }, kernel: {} };
  const tool = async (name: string, args: Data, context = root) => registered.get(name)!.handler(args, context);
  const ui = async (write: boolean, method: string, args: Data, context = tile) => JSON.parse((await tool(write ? "ui_update" : "ui_query", { method, paramsJson: JSON.stringify(args) }, context)).resultJson);
  beforeEach(() => { calls.length = 0; stored.clear(); ethereum = null; original = null; ethereumCursor = null; icRecent = []; ethereumRecent = []; });

  test("agent Ethereum quote selects EVM Wallet only and carries the original request", async () => {
    await tool("marketplace_ethereum_quote_v1", { operationId: OPERATION, appIds: ["editor"], affiliateCode: "CODE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "ethQuote", args: [root, { operationId: OPERATION, appIds: ["editor"], affiliateCode: "CODE", ethereum: { wallet: "evm_wallet" } }] });
    const definition = registered.get("marketplace_ethereum_quote_v1")!.specification;
    expect(definition.inputSchema.additionalProperties).toBe(false);
    expect(definition.inputSchema.properties.ethereum).toBeUndefined();
    expect(definition.annotations["neutron:effects"]).not.toContain("write");
  });
  test("both agent modes reach the reviewed EVM purchase workflow", async () => {
    for (const context of [root, normalAgent]) {
      await tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"] }, context);
      expect(calls.at(-1)).toMatchObject({ name: "ethPurchase", args: [context, quote()] });
    }
    expect(registered.get("marketplace_ethereum_purchase_v1")!.specification.annotations["neutron:consent"]).toBe("provider_once");
  });
  test("browser quote and journal mutations require the owner tile", async () => {
    for (const context of [root, normalAgent, { ...tile, caller: { appId: "marketplace", role: "background" } }]) {
      await expect(ui(false, "quotePurchase", { appIds: ["editor"], ethereum: { wallet: "browser" } }, context)).rejects.toThrow("marketplace tile");
      for (const method of ["ethereumPrepareBrowser", "ethereumJournalClaim", "ethereumJournalRecord", "ethereumVerifyBrowser", "ethereumVerifyOriginal"]) {
        await expect(ui(true, method, { operationId: OPERATION }, context)).rejects.toThrow("marketplace tile");
      }
    }
    expect(calls).toHaveLength(0);
    await ui(false, "quotePurchase", { appIds: ["editor"], affiliateCode: "", ethereum: { wallet: "browser", payerAddress: quote().ethereum.payerAddress } });
    expect(calls.at(-1)?.name).toBe("ethQuote");
  });
  test("generic purchase cannot dispatch the tile browser wallet", async () => {
    await expect(ui(true, "purchase", { quote: quote("browser") })).rejects.toThrow("browser-wallet checkout");
    expect(calls).toHaveLength(0);
    await ui(true, "purchase", { quote: quote() });
    expect(calls.at(-1)?.name).toBe("ethPurchase");
  });
  test("browser journal steps retain exact claimed records", async () => {
    const previous = { version: 1, invoiceId: OPERATION, step: { kind: "deposit" }, state: "unknown" }, next = { ...previous, state: "submitted", transactionHash: "0x01" };
    await ui(true, "ethereumPrepareBrowser", { operationId: OPERATION });
    expect(calls.at(-1)).toMatchObject({ name: "browserPrepare", args: [tile, undefined, OPERATION] });
    await ui(true, "ethereumJournalClaim", { operationId: OPERATION, record: previous });
    expect(calls.at(-1)).toMatchObject({ name: "journalClaim", args: [tile, OPERATION, previous] });
    await ui(true, "ethereumJournalRecord", { operationId: OPERATION, previous, next });
    expect(calls.at(-1)).toMatchObject({ name: "journalRecord", args: [tile, OPERATION, previous, next] });
    await ui(false, "ethereumJournalRead", { operationId: OPERATION, kind: "deposit" });
    expect(calls.at(-1)).toMatchObject({ name: "journalRead", args: [tile, OPERATION, "deposit"] });
    await expect(ui(false, "ethereumJournalRead", { operationId: OPERATION, kind: "refund" })).rejects.toThrow("approval or deposit");
    await ui(true, "ethereumVerifyBrowser", { operationId: OPERATION });
    expect(calls.at(-1)).toMatchObject({ name: "browserVerify", args: [tile, OPERATION] });
  });
  test("saved Ethereum inputs cannot silently switch apps, affiliate or wallet", async () => {
    stored.set(`ethereum:operation:${OPERATION}`, { quote: quote() });
    await tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"] });
    expect(calls.at(-1)?.name).toBe("ethResume");
    for (const args of [{ appIds: ["other"] }, { appIds: ["editor"], affiliateCode: "NEW" }]) await expect(tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, ...args })).rejects.toThrow("different saved");
    stored.set(`ethereum:operation:${OPERATION}`, { quote: quote("browser") });
    await expect(tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"] })).rejects.toThrow("wallet");
    expect(calls.filter(call => call.name === "ethQuote" || call.name === "ethPurchase")).toHaveLength(0);
  });
  test("durable protocol history resumes the original invoice after local loss", async () => {
    original = { quote: { request: { appIds: ["editor"], referralCode: ["CODE"] } } };
    await expect(tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"] })).rejects.toThrow("original Ethereum invoice");
    await tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"], affiliateCode: "CODE" });
    expect(calls).toEqual([{ name: "ethResume", args: [root, OPERATION] }]);
  });
  test("an existing payment ID cannot cross between IC and Ethereum", async () => {
    stored.set(`operation:${OPERATION}`, { quote: quote(), kind: "purchase" });
    await expect(tool("marketplace_ethereum_purchase_v1", { operationId: OPERATION, appIds: ["editor"] })).rejects.toThrow("original route");
    stored.clear(); ethereum = output();
    await expect(tool("marketplace_purchase_v1", { operationId: OPERATION, appIds: ["editor"], token: "ckUSDC" })).rejects.toThrow("Ethereum purchase");
    await expect(tool("marketplace_withdraw_v1", { operationId: OPERATION, token: "ckUSDC", amountAtoms: "1", destination: "owner" })).rejects.toThrow("Ethereum purchase");
    await expect(ui(true, "purchase", { quote: { ...quote(), ethereum: undefined } })).rejects.toThrow("Ethereum purchase");
    expect(calls).toHaveLength(0);
  });
  test("common status keeps app entitlement separate from wrapping", async () => {
    ethereum = output();
    const result = await tool("marketplace_operation_v1", { operationId: OPERATION });
    expect(result.result).toMatchObject({ state: "complete", entitled: true, settlement: { state: "pending" } });
    expect(calls).toHaveLength(0);
    ethereum = null;
    await tool("marketplace_operation_v1", { operationId: OPERATION });
    expect(calls.at(-1)?.name).toBe("icStatus");
  });
  test("generic continuation never substitutes EVM Wallet for a browser payer", async () => {
    ethereum = { ...output(), state: "pending", ethereumWallet: "browser" };
    await expect(ui(true, "resumeOperation", { operationId: OPERATION })).rejects.toThrow("original browser wallet");
    expect(calls).toHaveLength(0);
    ethereum.ethereumWallet = "evm_wallet";
    await ui(true, "resumeOperation", { operationId: OPERATION });
    expect(calls.at(-1)?.name).toBe("ethResume");
  });
  test("history forwards each stream cursor and skips an exhausted Ethereum stream", async () => {
    ethereum = output(); ethereumCursor = "22";
    const page = (await tool("marketplace_history_v1", { purchaseCursor: "done", withdrawalCursor: "18", ethereumCursor: "42" })).result;
    expect(page).toMatchObject({ ethereumPurchases: [output()], nextEthereumCursor: "22" });
    expect(calls.find(call => call.name === "ethHistory")?.args).toEqual([root, "42"]);
    calls.length = 0;
    const empty = (await tool("marketplace_history_v1", { ethereumCursor: "done" })).result;
    expect(empty.ethereumPurchases).toEqual([]);
    expect(empty.nextEthereumCursor).toBe("done");
    expect(calls.some(call => call.name === "ethHistory")).toBe(false);
  });
  test("recent operation display deduplicates the shared IC order using Ethereum status", async () => {
    icRecent = [{ operationId: OPERATION, state: "pending" }, { operationId: "different", state: "complete" }];
    ethereumRecent = [output()];
    const recent = await ui(false, "recentOperations", {});
    expect(recent).toHaveLength(2);
    expect(recent.find((item: Data) => item.operationId === OPERATION)).toMatchObject({ entitled: true, settlement: { state: "pending" } });
  });
  test("original-hash verification preserves the invoice and never invokes a payment sender", async () => {
    const transactionHash = `0x${"ab".repeat(32)}`;
    await tool("marketplace_ethereum_verify_v1", { operationId: OPERATION, transactionHash });
    expect(calls).toEqual([{ name: "ethVerifyOriginal", args: [root, OPERATION, transactionHash] }]);
    await ui(true, "ethereumVerifyOriginal", { operationId: OPERATION, transactionHash });
    expect(calls.at(-1)).toEqual({ name: "ethVerifyOriginal", args: [tile, OPERATION, transactionHash] });
    const definition = registered.get("marketplace_ethereum_verify_v1")!.specification;
    expect(definition.annotations["neutron:consent"]).toBe("provider_once");
    expect(definition.inputSchema.properties.transactionHash.pattern).toBe("^0x[0-9a-fA-F]{64}$");
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });
  test("settlement and cancellation are explicit original-ID operations", async () => {
    await tool("marketplace_ethereum_settle_v1", { operationId: OPERATION });
    await tool("marketplace_ethereum_cancel_v1", { operationId: OPERATION });
    expect(calls).toEqual([{ name: "ethSettle", args: [root, OPERATION] }, { name: "ethCancel", args: [root, OPERATION] }]);
  });
}
