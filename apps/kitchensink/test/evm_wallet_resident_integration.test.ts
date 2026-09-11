import { describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import {
  createEvmWalletClient,
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
} from "neutron-tools/evm_wallet";
import {
  normalizeToolDescriptor,
  validateToolArguments,
  validateToolResult,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusClient,
  type MsgBusToolCall,
  type MsgBusToolContext,
  type MsgBusToolDescriptor,
  type MsgBusToolHandler,
} from "neutron-tools/protocol";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { METHODS } from "../../evm_wallet/src/data.ts";
import { readEvmWalletSelection } from "../src/evm_wallet_demo.ts";

// Replacing exposeTool must not affect any other app's singleton in Bun's
// shared test process. Only the child imports the actual resident module.
if (process.env.NEUTRON_KITCHEN_EVM_RESIDENT_TEST_CHILD !== "1") {
  test("Kitchen Sink consumes the actual EVM Wallet resident in an isolated process", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_KITCHEN_EVM_RESIDENT_TEST_CHILD: "1" },
        timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
      expect(result.stderr).toContain("resident wallet integration");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const handlers = new Map<string, { descriptor: MsgBusToolDescriptor; handler: MsgBusToolHandler }>();
  mock.module("neutron-tools/app", () => ({
    exposeTool(name: string, options: ExposedToolOptions, handler: MsgBusToolHandler) {
      if (handlers.has(name)) throw new Error(`Duplicate resident tool: ${name}`);
      handlers.set(name, { descriptor: normalizeToolDescriptor({ name, ...options }), handler });
    },
    publishAppStateChange: async () => undefined,
    querySelf() { throw new Error("Resident tools must use their invocation-scoped Kernel client"); },
    updateSelf() { throw new Error("Resident tools must use their invocation-scoped Kernel client"); },
    onAppStateChange() { throw new Error("Resident tools must not subscribe through the tile singleton"); },
  }));
  // Any unconfigured transport is a fixture error; this suite never uses a public RPC.
  globalThis.fetch = async () => { throw new Error("Unexpected unmocked network request"); };
  const { browserEvmRpc, createBrowserEvmRpc } = await import("../../evm_wallet/src/browser_rpc.ts");
  await import(new URL("../../evm_wallet/src/service.ts", import.meta.url).href);

  const ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
  const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const FINGERPRINT = "ab".repeat(32);
  const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const UNAVAILABLE_TOKEN = "0x1111111111111111111111111111111111111111";
  const BLOCK_NUMBER = "0x1406f40";
  const OBSERVED_AT = expect.stringMatching(/^[0-9]+$/);
  const account = {
    id: "main", slot: "main", address: ADDRESS,
    public_key: Uint8Array.from(Buffer.from(PUBLIC_KEY, "hex")),
    key_fingerprint: Uint8Array.from(Buffer.from(FINGERPRINT, "hex")),
    namespace_version: "1",
  };
  const networkRows = [
    { chain_id: "1", name: "Ethereum", native_symbol: "ETH", explorer_url: "https://etherscan.io", testnet: false, finality_description: "Ethereum finality" },
    { chain_id: "42161", name: "Arbitrum", native_symbol: "ETH", explorer_url: "https://arbiscan.io", testnet: false, finality_description: "Arbitrum sequencer and L1 finality" },
  ];
  const methodSchemas = generateAppMethodSchemaArtifact(
    JSON.parse(readFileSync(new URL("../../evm_wallet/neutron.json", import.meta.url), "utf8")) as NeutronManifest,
    readFileSync(new URL("../../evm_wallet/backend/main.mo", import.meta.url), "utf8"),
  );
  type BackendCall = { kind: "query" | "update"; method: string; args: JsonValue[]; timeout?: number };

  function fixture(options: {
    missingWallet?: boolean;
    rpcError?: boolean;
    wrongChain?: boolean;
    audience?: MsgBusToolContext["audience"];
    agentMode?: boolean;
    callerEndpoint?: string;
  } = {}) {
    const toolCalls: MsgBusToolCall[] = [];
    const backendCalls: BackendCall[] = [];
    const presentations: unknown[] = [];
    const signal = new AbortController().signal;
    const rpcCalls: { chainId: string; method: string; params: unknown[] }[] = [];
    browserEvmRpc.request = createBrowserEvmRpc({
      fetch: (async (url, init) => {
        const chainId = String(url).includes("arbitrum") ? "42161" : "1";
        const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
        rpcCalls.push({ chainId, method: request.method, params: structuredClone(request.params) });
        const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: request.id, result });
        const failure = (message: string) => Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
        if (request.method === "eth_chainId") return reply(options.wrongChain ? "0x1" : `0x${BigInt(chainId).toString(16)}`);
        if (options.rpcError) return failure("RPC providers disagree on the requested block");
        if (request.method === "eth_blockNumber") return reply(BLOCK_NUMBER);
        if (request.method === "eth_getBalance") return reply(`0x${123456789012345678901234567890n.toString(16)}`);
        if (request.method === "eth_getCode") return reply("0x60006000");
        if (request.method === "eth_call") {
          const call = request.params[0] as { to: string; data: string };
          if (call.to === UNAVAILABLE_TOKEN) return failure("ERC20 read reverted for this token");
          if (call.to !== TOKEN) throw new Error(`Unexpected RPC target ${call.to}`);
          if (call.data.startsWith("0x70a08231")) return reply(`0x${1250000n.toString(16).padStart(64, "0")}`);
          if (call.data === "0x313ce567") return reply(`0x${"0".repeat(63)}6`);
          if (call.data === "0x95d89b41") return reply(`0x${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`);
        }
        throw new Error(`Unexpected RPC request ${request.method}`);
      }) as typeof fetch,
    }).request;
    const note = (kind: BackendCall["kind"], method: string, args: JsonValue[], timeout?: number) => {
      const validation = validateAppMethodArgs(methodSchemas, method, args);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
      backendCalls.push({ kind, method, args: structuredClone(args), timeout });
    };
    const kernel = {
      async querySelf(method: string, args: JsonValue[] = [], timeout?: number) {
        note("query", method, args, timeout);
        if (method !== METHODS.snapshot) throw new Error(`Unexpected backend query ${method}`);
        return structuredClone({ ok: { accounts: [account], networks: networkRows, assets: [], lifecycle: "active" } });
      },
      async updateSelf(method: string, args: JsonValue[] = [], timeout?: number) {
        note("update", method, args, timeout);
        throw new Error(`Unexpected backend mutation ${method}`);
      },
      async callTool() { throw new Error("Resident must not forward a wallet read to another app"); },
    };
    const context: MsgBusToolContext = {
      caller: {
        appId: "kitchensink", installationUid: "17",
        endpoint: options.callerEndpoint ?? "app:kitchensink:tile:main:instance:demo",
      },
      audience: options.audience ?? "foreground_tile",
      agentMode: options.agentMode ?? false,
      signal,
      kernel: kernel as unknown as MsgBusToolContext["kernel"],
      reportProgress() {},
      async presentUserInterface(request) {
        presentations.push(structuredClone(request));
        throw new Error("Unexpected provider presentation");
      },
    };
    const transport = {
      async callTool(call: MsgBusToolCall): Promise<JsonValue> {
        toolCalls.push(structuredClone(call));
        expect(call.target).toBe(EVM_WALLET_TARGET);
        if (options.missingWallet) throw new Error("No installed EVM Wallet provider");
        const exposed = handlers.get(call.name);
        if (!exposed) throw new Error(`No resident handler ${call.name}`);
        const args = call.arguments ?? {};
        validateToolArguments(exposed.descriptor, args);
        const result = await exposed.handler(args, context);
        validateToolResult(exposed.descriptor, result);
        return structuredClone(result);
      },
    } as Pick<MsgBusClient, "callTool">;
    return { client: createEvmWalletClient(transport), toolCalls, backendCalls, rpcCalls, presentations, signal };
  }

  describe("resident wallet integration", () => {
    test("Kitchen Sink discovers chain-key account bytes and configured networks through actual handlers", async () => {
      const app = fixture();
      const selection = await readEvmWalletSelection(app.client);
      expect(selection.accountResult).toEqual({ accounts: [{
        accountId: "main", address: ADDRESS, publicKey: `0x${PUBLIC_KEY}`,
        keyFingerprint: `0x${FINGERPRINT}`, namespaceVersion: "1",
      }] });
      expect(selection.networkResult.networks.map((network) => ({ chainId: network.chainId, finalityKind: network.finalityKind })))
        .toEqual([{ chainId: "1", finalityKind: "ethereum" }, { chainId: "42161", finalityKind: "arbitrum" }]);
      expect(app.toolCalls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.networks]);
      expect(app.backendCalls).toEqual([
        { kind: "query", method: METHODS.snapshot, args: [null], timeout: undefined },
        { kind: "query", method: METHODS.snapshot, args: [null], timeout: undefined },
      ]);
      expect(app.presentations).toEqual([]);
    });

    test("native and requested ERC20 balances retain network and block evidence with partial token errors", async () => {
      const app = fixture();
      const native = await app.client.balances({ accountId: "main", chainId: "1", tokens: [] });
      expect(native).toMatchObject({
        accountId: "main", chainId: "1", address: ADDRESS,
        nativeBalanceWei: "123456789012345678901234567890", tokens: [],
        blockNumber: "21000000", observedAtNs: OBSERVED_AT, completeness: "requested_only",
      });
      const result = await app.client.balances({ accountId: "main", chainId: "42161", tokens: [TOKEN, UNAVAILABLE_TOKEN] });
      expect(result).toMatchObject({
        accountId: "main", chainId: "42161", address: ADDRESS,
        nativeBalanceWei: native.nativeBalanceWei, blockNumber: "21000000",
        observedAtNs: OBSERVED_AT, completeness: "requested_only",
      });
      expect(result.tokens).toEqual([
        { address: TOKEN, balanceAtoms: "1250000", decimals: "6", symbol: "USDC", error: null },
        { address: UNAVAILABLE_TOKEN, balanceAtoms: null, decimals: null, symbol: null, error: expect.stringContaining("ERC20 read reverted for this token") },
      ]);
      expect(app.backendCalls.map((call) => call.args)).toEqual([[null], [null]]);
      expect(app.backendCalls.every((call) => call.kind === "query" && call.method === METHODS.snapshot)).toBe(true);
      expect(app.rpcCalls.filter((call) => call.method === "eth_getBalance").map((call) => call.chainId)).toEqual(["1", "42161"]);
      expect(app.presentations).toEqual([]);
    });

    test("contract reads preserve explicit chain, account, target, calldata and observation evidence", async () => {
      const app = fixture();
      const request = { accountId: "main" as const, chainId: "42161", to: TOKEN, data: "0x313CE567" };
      const result = await app.client.readContract(request);
      expect(result).toEqual({
        accountId: request.accountId, chainId: request.chainId, address: ADDRESS,
        to: TOKEN, data: "0x313ce567", result: `0x${"0".repeat(63)}6`, code: "0x60006000",
        blockNumber: "21000000", observedAtNs: OBSERVED_AT,
      });
      expect(request.data).toBe("0x313CE567");
      expect(app.backendCalls).toEqual([
        { kind: "query", method: METHODS.snapshot, args: [null], timeout: undefined },
      ]);
      expect(app.rpcCalls.find((call) => call.method === "eth_call")).toEqual({
        chainId: "42161", method: "eth_call", params: [{ from: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", to: TOKEN, data: "0x313ce567" }, BLOCK_NUMBER],
      });
      expect(app.presentations).toEqual([]);
    });

    test("an absent wallet stops discovery before network reads or backend calls", async () => {
      const app = fixture({ missingWallet: true });
      await expect(readEvmWalletSelection(app.client)).rejects.toThrow("No installed EVM Wallet provider");
      expect(app.toolCalls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
      expect(app.backendCalls).toEqual([]);
      expect(app.presentations).toEqual([]);
    });

    test("read-only RPC failures propagate without fabricated balances or contract results", async () => {
      const app = fixture({ rpcError: true });
      await expect(app.client.balances({ accountId: "main", chainId: "42161", tokens: [TOKEN] }))
        .rejects.toThrow("RPC providers disagree");
      await expect(app.client.readContract({ accountId: "main", chainId: "42161", to: TOKEN, data: "0x313ce567" }))
        .rejects.toThrow("RPC providers disagree");
      expect(app.backendCalls.map((call) => call.method)).toEqual([METHODS.snapshot, METHODS.snapshot]);
      expect(app.presentations).toEqual([]);
    });

    test("a browser RPC provider on another chain cannot satisfy the consumer request", async () => {
      const app = fixture({ wrongChain: true });
      await expect(app.client.balances({ accountId: "main", chainId: "42161", tokens: [] }))
        .rejects.toThrow("does not match requested chain");
      await expect(app.client.readContract({ accountId: "main", chainId: "42161", to: TOKEN, data: "0x313ce567" }))
        .rejects.toThrow("does not match requested chain");
      expect(app.presentations).toEqual([]);
    });

    test("ordinary and nested Agent callers are denied by the actual root handler before backend work", async () => {
      for (const nestedAgent of [false, true]) {
        const app = fixture({
          audience: "foreground_tile", agentMode: nestedAgent,
          callerEndpoint: nestedAgent ? "app:kitchensink:background" : "app:kitchensink:tile:main:instance:demo",
        });
        await expect(app.client.sendTransactionRoot({
          requestId: "01".repeat(16), accountId: "main", chainId: "42161",
          to: UNAVAILABLE_TOKEN, valueWei: "7", data: "0x",
        })).rejects.toThrow("Kernel root-agent attestation");
        expect(app.signal.aborted).toBe(false);
        expect(app.toolCalls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.sendTransactionRoot]);
        expect(app.backendCalls).toEqual([]);
        expect(app.presentations).toEqual([]);
      }
    });
  });
}
