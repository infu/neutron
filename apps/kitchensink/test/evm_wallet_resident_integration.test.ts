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
  }));
  await import(new URL("../../evm_wallet/src/service.ts", import.meta.url).href);

  const ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
  const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const FINGERPRINT = "ab".repeat(32);
  const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const UNAVAILABLE_TOKEN = "0x1111111111111111111111111111111111111111";
  const BLOCK_NUMBER = "0x1406f40";
  const OBSERVED_AT = "1800000000000000000";
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
        if (method === METHODS.accounts) return structuredClone({ ok: [account] });
        const request = args[0] as JsonObject;
        if (method === METHODS.balances) {
          if (options.rpcError) return { err: "RPC providers disagree on the requested block" };
          return {
            ok: {
              account_id: request.account_id, chain_id: options.wrongChain ? "1" : request.chain_id,
              address: ADDRESS, native_balance: "123456789012345678901234567890",
              tokens: (request.tokens as string[]).map((address) => address === TOKEN ? {
                address, balance: "1250000", decimals: "6", symbol: "USDC", error: null,
              } : {
                address, balance: null, decimals: null, symbol: null,
                error: "ERC20 balanceOf reverted for this token",
              }),
              block_number: BLOCK_NUMBER, observed_at: OBSERVED_AT, completeness: "requested_only",
            },
          };
        }
        if (method === METHODS.readContract) {
          if (options.rpcError) return { err: "RPC providers disagree on the requested block" };
          return {
            ok: {
              chain_id: options.wrongChain ? "1" : request.chain_id,
              to: request.to, data: request.data, result: `0x${"0".repeat(63)}6`,
              code: "0x60006000", block_number: BLOCK_NUMBER, observed_at: OBSERVED_AT,
            },
          };
        }
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
    return { client: createEvmWalletClient(transport), toolCalls, backendCalls, presentations, signal };
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
        { kind: "update", method: METHODS.accounts, args: [null], timeout: 120 },
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
        { address: UNAVAILABLE_TOKEN, balanceAtoms: null, decimals: null, symbol: null, error: "ERC20 balanceOf reverted for this token" },
      ]);
      expect(app.backendCalls.map((call) => call.args)).toEqual([
        [{ account_id: "main", chain_id: "1", tokens: [] }],
        [{ account_id: "main", chain_id: "42161", tokens: [TOKEN, UNAVAILABLE_TOKEN] }],
      ]);
      expect(app.backendCalls.every((call) => call.method === METHODS.balances)).toBe(true);
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
        { kind: "update", method: METHODS.accounts, args: [null], timeout: 120 },
        { kind: "update", method: METHODS.readContract, args: [{ chain_id: "42161", to: TOKEN, data: "0x313ce567", block: "latest" }], timeout: 120 },
      ]);
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
      expect(app.backendCalls.map((call) => call.method)).toEqual([METHODS.balances, METHODS.accounts, METHODS.readContract]);
      expect(app.presentations).toEqual([]);
    });

    test("backend results from another chain cannot satisfy the consumer request", async () => {
      const app = fixture({ wrongChain: true });
      await expect(app.client.balances({ accountId: "main", chainId: "42161", tokens: [] }))
        .rejects.toThrow("scope mismatch");
      await expect(app.client.readContract({ accountId: "main", chainId: "42161", to: TOKEN, data: "0x313ce567" }))
        .rejects.toThrow("network does not match the request");
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
