import { describe, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validate, type Schema } from "jsonschema";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from "viem";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { parseEvmCallContractRequest, parseEvmEstimateTransactionRequest, parseEvmOperationResult, parseEvmSendTransactionRequest, parseEvmTransactionRequest, type EvmOperationResult, type EvmReceipt, type EvmTransactionResult } from "neutron-tools/evm_wallet";
import { normalizeToolDescriptor, validateToolArguments, validateToolResult, type ExposedToolOptions, type JsonObject, type JsonValue, type MsgBusToolContext, type MsgBusToolDescriptor, type MsgBusToolHandler } from "neutron-tools/protocol";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

// Only the child process imports the resident module and replaces exposeTool.
// Other app tests keep the real neutron-tools/app module and its singleton.
if (process.env.NEUTRON_UNISWAP_SERVICE_TEST_CHILD !== "1") {
  test("Uniswap resident registers every tool through the real SDK validator", async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--eval",
      `await import(${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)});
       const { listExposedTools } = await import("neutron-tools/app");
       console.log(JSON.stringify(listExposedTools().map(tool => tool.name)));
       process.exit(0);`,
    ], { cwd: new URL("..", import.meta.url).pathname });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout).sort()).toEqual([
      "uniswap_action_status_v1", "uniswap_actions_page_v1", "uniswap_import_position_v1",
      "uniswap_liquidity_quote_v1",
      "uniswap_list_page_v1", "uniswap_list_v1", "uniswap_next_action_v1", "uniswap_prepare_v1",
      "uniswap_manage_liquidity_v1", "uniswap_pool_v1", "uniswap_position_v1", "uniswap_positions_v1",
      "uniswap_quote_v1", "uniswap_quote_v2", "uniswap_record_result_v1", "uniswap_status_v1", "uniswap_swap_v1", "uniswap_swap_v2",
    ].sort());
  });

  test("resident Uniswap handlers satisfy wallet and managed-journal contracts in an isolated process", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_UNISWAP_SERVICE_TEST_CHILD: "1" },
        timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
      expect(result.stderr).toContain("resident service");
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
    querySelf() { throw new Error("Resident tools must use their invocation-scoped Kernel client"); },
    updateSelf() { throw new Error("Resident tools must use their invocation-scoped Kernel client"); },
  }));
  const residentModuleUrl = new URL("../src/service.ts", import.meta.url).href;
  await import(residentModuleUrl);
  const walletModuleUrl = new URL("../src/agent_wallet.ts", import.meta.url).href;
  const { createServiceWallet } = await import(walletModuleUrl);

  const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
  const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
  const POOL = getAddress("0x3333333333333333333333333333333333333333");
  const OTHER = getAddress("0x4444444444444444444444444444444444444444");
  const ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
  const QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
  const FACTORY = getAddress("0x1f98431c8ad98523631ae4a59f267346ea31f984");
  const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  const WETH = getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
  const SWAP_ID = "aa".repeat(16);
  const HASH = `0x${"bb".repeat(32)}`;
  const BLOCK_HASH = `0x${"cc".repeat(32)}`;
  const account = { accountId: "main", address: ACCOUNT, publicKey: `0x02${"dd".repeat(32)}`, keyFingerprint: `0x${"ee".repeat(32)}`, namespaceVersion: "1" };
  const tokenAbi = parseAbi(["function decimals() view returns(uint8)", "function symbol() view returns(string)", "function allowance(address owner,address spender) view returns(uint256)"]);
  const quoteAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
  const factoryAbi = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns(address pool)"]);
  const poolAbi = parseAbi(["function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"]);
  const manifest = JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
  const methodSchemas = generateAppMethodSchemaArtifact(
    manifest,
    readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"),
  );
  type WireRecord = Record<string, JsonValue>;
  type WalletCall = { target: string; name: string; arguments: JsonObject };
  // Kernel 344's install grants bypass routing decisions for declared tools.
  // Exercise the real guard only when a call still requires routing consent.
  async function withAgentConsent(run: (authorize: (call: WalletCall) => Promise<void>, errors: string[]) => Promise<void>) {
    const moduleUrl = new URL("../../kernel/src/ui_attention/agent.ts", import.meta.url).href;
    const agent = await import(moduleUrl);
    const ownerPrincipal = "2muv7-iopdh-zcmmn-yb3ls-ane4w-ei7h2-gketm-rnyra-cxzmm-y6qy2-wqe";
    const endpoint = (appId: string, role: "tile" | "background") => ({
      endpointId: `app:${appId}:${role}`, source: {},
      context: { role, appId, ...(role === "tile" ? { tileId: "chat", instanceId: "root", workspace: 1 } : {}) },
      sessionId: `${appId}-${role}-session`, appScope: { appId, installationUid: appId === "agent" ? "17" : "18" },
    });
    agent.clearAgentModeForAuth();
    const granted = agent.requestAgentGrant({ appId: "agent", appName: "Agent", version: 100, installationUid: "17", entrypoint: "agent_chat", ownerPrincipal });
    agent.approveAgentGrant(); await granted;
    const root = agent.beginAgentRoot({ caller: endpoint("agent", "tile"), target: endpoint("agent", "background"), tool: "agent_chat", ownerPrincipal, installedVersion: 100 });
    const child = agent.createChildInvocation(root, endpoint("uniswap", "background"), "uniswap_quote_v1");
    const errors: string[] = [];
    const authorize = async (call: WalletCall) => {
      const granted = manifest.capabilities?.frontend_tools?.targets.some(
        (target) => target.app === "evm_wallet" && target.tools.includes(call.name),
      );
      if (granted) return;
      try {
        await agent.requestAgentConsent(child, { kind: "frontend_tool", persistence: "none", risk: "low", action: { provider: "evm_wallet", tool: call.name } }, async () => {
          await Promise.resolve();
          return { decision: "allow", reason: "Read required for the requested swap" };
        });
      } catch (error) {
        errors.push(String((error as { code?: string }).code));
        throw error;
      }
    };
    try { await run(authorize, errors); }
    finally { agent.clearAgentModeForAuth(); }
  }
  function validateInput(method: string, args: JsonValue[]) {
    const result = validateAppMethodArgs(methodSchemas, method, args);
    expect(result.errors).toEqual([]); expect(result.valid).toBe(true);
  }
  function validateOutput<T extends JsonValue>(method: string, result: T): T {
    expect(validate(result, methodSchemas.methods[method]!.output as Schema).errors.map((error) => error.stack)).toEqual([]);
    return structuredClone(result);
  }
  function receipt(): EvmReceipt {
    return { blockNumber: "21000001", blockHash: BLOCK_HASH, status: "success", gasUsed: "45000", effectiveGasPriceWei: "2500000000", logs: [], finality: "safe", observedAtNs: "1800000000000000000" };
  }
  function fixture(options: { quotesUnavailable?: boolean; allowance?: bigint; authorize?: (call: WalletCall) => Promise<void>; estimatesAvailable?: boolean; failApprovalEstimate?: boolean; failQuoteFee?: number; bestQuoteFee?: number; providerEffects?: boolean; abortAfterApproval?: AbortController } = {}) {
    const rows = new Map<string, WireRecord>();
    const walletCalls: WalletCall[] = [], mutations: { method: string; args: JsonValue[] }[] = [], queries: { method: string; args: JsonValue[] }[] = [];
    let chainEvidence: EvmTransactionResult | null = null;
    const providerOperations = new Map<string, EvmOperationResult>();
    let providerAborted = false;
    const kernel = {
      async querySelf(method: string, args: JsonValue[]) {
        validateInput(method, args); queries.push({ method, args: structuredClone(args) });
        if (method === "uniswap_get_v1") return validateOutput(method, rows.get(String(args[0])) ?? null);
        if (method === "uniswap_list_v1") return validateOutput(method, [...rows.values()]);
        if (method === "uniswap_history_v1") {
          const input = args[0] as { cursor?: string; limit: string };
          const ordered = [...rows.values()].sort((a, b) => BigInt(String(a.created_at)) === BigInt(String(b.created_at)) ? String(b.id).localeCompare(String(a.id)) : BigInt(String(a.created_at)) > BigInt(String(b.created_at)) ? -1 : 1);
          const start = input.cursor === undefined ? 0 : ordered.findIndex((row) => row.id === input.cursor) + 1;
          const page = ordered.slice(start, start + Number(input.limit));
          return validateOutput(method, { rows: page, ...(start + page.length < ordered.length ? { next_cursor: page.at(-1)!.id! } : {}) });
        }
        throw new Error(`Unexpected journal query ${method}`);
      },
      async updateSelf(method: string, args: JsonValue[]) {
        validateInput(method, args); mutations.push({ method, args: structuredClone(args) });
        const input = args[0] as WireRecord, id = String(input.id);
        if (method === "uniswap_begin_v1") {
          if (rows.has(id)) throw new Error("Unexpected repeated immutable begin");
          const saved = { ...input, phase: "queued", revision: "0", created_at: "100", updated_at: "100" };
          rows.set(id, saved); return validateOutput(method, saved);
        }
        if (method === "uniswap_update_v1") {
          const saved = rows.get(id);
          if (!saved) throw new Error("Journal record missing");
          if (input.expected_revision !== saved.revision) throw new Error("Journal revision conflict");
          const stage = String(input.stage);
          expect(["approval", "swap"]).toContain(stage);
          expect(input.account_id).toBe(saved.account_id); expect(input.chain_id).toBe(saved.chain_id);
          expect(input.request_id).toBe(saved[`${stage}_request_id`]);
          const next = { ...saved, phase: input.phase!, revision: String(BigInt(String(saved.revision)) + 1n), updated_at: "200", ...(input.operation_json ? { [`${stage}_operation_json`]: input.operation_json } : {}) };
          rows.set(id, next); return validateOutput(method, next);
        }
        throw new Error(`Unexpected journal mutation ${method}`);
      },
      async callTool(call: WalletCall): Promise<JsonValue> {
        await options.authorize?.(call);
        walletCalls.push(structuredClone(call));
        expect(call.target).toBe("app:evm_wallet:background");
        if (call.name === "evm_accounts_v1") return { accounts: [account] };
        if (options.providerEffects && call.name === "evm_operation_status_v1") return (providerOperations.get(String(call.arguments.requestId)) ?? { ...call.arguments, status: "not_found" }) as unknown as JsonValue;
        if (options.providerEffects && call.name === "evm_send_transaction_v1") {
          const request = parseEvmSendTransactionRequest(call.arguments);
          const approval = request.to.toLowerCase() !== ROUTER.toLowerCase();
          const operation: EvmOperationResult = { ...request, operationId: String(providerOperations.size + 1), kind: "transaction", status: "confirmed", address: ACCOUNT, transactionHash: `0x${(approval ? "dd" : "bb").repeat(32)}`, signature: null, message: null, reviewRevision: "1", receipt: receipt() };
          // Effect requests include transaction fields that are absent from the
          // closed operation-result schema; project the real Wallet result shape.
          const result = { requestId: operation.requestId, accountId: operation.accountId, chainId: operation.chainId, operationId: operation.operationId, kind: operation.kind, status: operation.status, address: operation.address, transactionHash: operation.transactionHash, signature: operation.signature, message: operation.message, reviewRevision: operation.reviewRevision, receipt: operation.receipt };
          providerOperations.set(request.requestId, result);
          if (approval && options.abortAfterApproval && !providerAborted) { providerAborted = true; options.abortAfterApproval.abort(new Error("Pause after Wallet approval")); throw new Error("Wallet reply interrupted after approval"); }
          return result as unknown as JsonValue;
        }
        if (call.name === "evm_call_contract_v1") {
          const request = parseEvmCallContractRequest(call.arguments);
          expect(request.accountId).toBe("main"); expect(request.chainId).toBe("1");
          let result: `0x${string}`;
          if (request.to === QUOTER.toLowerCase()) {
            if (options.quotesUnavailable) throw new Error("Providers disagree on the current pool state");
            const decoded = decodeFunctionData({ abi: quoteAbi, data: request.data as `0x${string}` });
            if (decoded.args[0].fee === options.failQuoteFee) throw new Error("This pool has no liquidity");
            result = encodeFunctionResult({ abi: quoteAbi, functionName: "quoteExactInputSingle", result: [decoded.args[0].fee === (options.bestQuoteFee ?? 500) ? 2_000_000n : 1_800_000n, 2n ** 96n, 1, 90_000n] });
          } else if (request.to === FACTORY.toLowerCase()) result = encodeFunctionResult({ abi: factoryAbi, functionName: "getPool", result: POOL });
          else if (request.to === POOL.toLowerCase()) result = encodeFunctionResult({ abi: poolAbi, functionName: "slot0", result: [2n ** 96n, 0, 0, 1, 1, 0, true] });
          else {
            expect([USDC.toLowerCase(), WETH.toLowerCase(), OTHER.toLowerCase()]).toContain(request.to);
            const decoded = decodeFunctionData({ abi: tokenAbi, data: request.data as `0x${string}` });
            if (decoded.functionName === "decimals") result = encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: request.to === OTHER.toLowerCase() ? 8 : request.to === USDC.toLowerCase() ? 6 : 18 });
            else if (decoded.functionName === "symbol") result = encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: request.to === OTHER.toLowerCase() ? "CUSTOM" : request.to === USDC.toLowerCase() ? "USDC" : "WETH" });
            else result = encodeFunctionResult({ abi: tokenAbi, functionName: "allowance", result: options.allowance ?? 0n });
          }
          return { accountId: request.accountId, chainId: request.chainId, to: request.to, data: request.data, address: ACCOUNT, result, blockNumber: "21000000", observedAtNs: "1800000000000000000" };
        }
        if (call.name === "evm_transaction_v1") {
          parseEvmTransactionRequest(call.arguments);
          if (!chainEvidence) throw new Error("No independent chain evidence configured");
          return structuredClone(chainEvidence) as unknown as JsonValue;
        }
        if (call.name === "evm_estimate_transaction_v1") {
          if (!options.estimatesAvailable) throw new Error("Fee estimation is unavailable from this fixture provider");
          const request = parseEvmEstimateTransactionRequest(call.arguments);
          const approval = request.to !== ROUTER.toLowerCase(), gas = approval ? 50_000n : 130_000n;
          if (approval && options.failApprovalEstimate) throw new Error("Approval fee provider unavailable");
          return { ...request, address: ACCOUNT, status: "available", gasLimit: gas.toString(), gasPriceWei: "3000000000", baseFeePerGasWei: "2999999999", maxPriorityFeePerGasWei: "1", maxFeePerGasWei: "5999999999", estimatedFeeWei: (gas * 3_000_000_000n).toString(), maximumFeeWei: (gas * 5_999_999_999n).toString(), blockNumber: "21000000", observedAtNs: "1800000000000000000", source: "evm_rpc", feeBasis: "base_fee_plus_priority", postingCosts: "not_applicable", reasons: [] };
        }
        throw new Error(`Resident Uniswap attempted an unexpected wallet tool or effect: ${call.name}`);
      },
    };
    function context(uid: string | null = "17"): MsgBusToolContext {
      return { kernel: kernel as unknown as MsgBusToolContext["kernel"], caller: { endpoint: "app:agent:tile:chat:instance:root", appId: "agent", ...(uid === null ? {} : { installationUid: uid }), role: "chat" }, audience: "agent_root", agentMode: true, reportProgress() {} };
    }
    async function invoke(name: string, args: JsonObject, invocation = context()): Promise<JsonObject> {
      const exposed = handlers.get(name);
      if (!exposed) throw new Error(`Missing resident handler ${name}`);
      validateToolArguments(exposed.descriptor, args);
      const result = await exposed.handler(args, invocation);
      validateToolResult(exposed.descriptor, result);
      return result as JsonObject;
    }
    async function quote(approval = false) {
      return invoke("uniswap_quote_v1", { chainId: "1", accountId: "main", tokenIn: approval ? USDC : null, tokenOut: approval ? WETH : USDC, amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT, deadline: String(Math.floor(Date.now() / 1000) + 3600) });
    }
    async function prepared(approval = false) {
      const quoted = await quote(approval);
      return invoke("uniswap_prepare_v1", { swapId: SWAP_ID, quoteJson: quoted.quoteJson! });
    }
    function configureEvidence(stage: "approval" | "swap" = "swap", patch: Partial<EvmTransactionResult> = {}) {
      const saved = rows.get(SWAP_ID)!;
      const request = parseEvmSendTransactionRequest(JSON.parse(String(saved[`${stage}_request_json`])));
      chainEvidence = { chainId: request.chainId, transactionHash: HASH, walletRequestMatches: true, transaction: { from: ACCOUNT, to: request.to, valueWei: request.valueWei, data: request.data, nonce: "7", blockNumber: "21000001", blockHash: BLOCK_HASH }, receipt: receipt(), observedAtNs: "1800000000000000000", source: "evm_rpc", ...patch };
      const claim: EvmOperationResult = { requestId: request.requestId, accountId: request.accountId, chainId: request.chainId, operationId: "1", kind: "transaction", status: "confirmed", address: ACCOUNT, transactionHash: HASH, signature: null, message: "Caller says successful", reviewRevision: "1", receipt: { ...receipt(), gasUsed: "1", finality: "finalized" } };
      return { claim, evidence: chainEvidence };
    }
    return { rows, walletCalls, mutations, queries, context, invoke, quote, prepared, configureEvidence };
  }

  describe("resident service", () => {
    test("exposes quote, prepare, status, list and independently verified result handlers", () => {
      expect([...handlers.keys()].sort()).toEqual([
        "uniswap_swap_v1", "uniswap_quote_v1", "uniswap_prepare_v1", "uniswap_next_action_v1", "uniswap_status_v1", "uniswap_list_v1", "uniswap_list_page_v1", "uniswap_record_result_v1",
        "uniswap_quote_v2", "uniswap_swap_v2", "uniswap_liquidity_quote_v1", "uniswap_manage_liquidity_v1", "uniswap_action_status_v1", "uniswap_actions_page_v1", "uniswap_positions_v1", "uniswap_position_v1", "uniswap_import_position_v1", "uniswap_pool_v1",
      ].sort());
      expect(handlers.get("uniswap_quote_v1")!.descriptor.annotations?.["neutron:effects"]).toEqual(["read", "network"]);
    });

    test("one swap tool handles public Wallet approval and swap, including an interrupted approval reply", async () => {
      const cancellation = new AbortController(), app = fixture({ providerEffects: true, abortAfterApproval: cancellation });
      const args = { swapId: SWAP_ID, chainId: "1", tokenIn: USDC, tokenOut: null, amountIn: "3000000" };
      const paused = await app.invoke("uniswap_swap_v1", args, { ...app.context(), signal: cancellation.signal });
      expect(paused).toMatchObject({ state: "pending", flowId: SWAP_ID, swapId: SWAP_ID, phase: "approval_requested" });
      const saved = structuredClone(app.rows.get(SWAP_ID)!);
      const completed = await app.invoke("uniswap_swap_v1", args);
      expect(completed).toMatchObject({ state: "complete", flowId: SWAP_ID, swapId: SWAP_ID, transactionHash: HASH });
      const effects = app.walletCalls.filter((call) => call.name === "evm_send_transaction_v1");
      expect(effects).toHaveLength(2);
      expect(effects.map((call) => call.arguments.requestId)).toEqual([saved.approval_request_id, saved.swap_request_id]);
      expect(app.walletCalls.some((call) => call.name.endsWith("_root_v1"))).toBe(false);
      expect(app.rows.size).toBe(1);
      expect(JSON.parse(String(saved.quote_json))).toMatchObject({ executionMode: "provider", providerFlow: { caller: { appId: "agent", installationUid: "17" }, agentMode: true } });
    });

    test("quotes use real wallet SDK contract reads and perform no signature, transaction, or journal mutation", async () => {
      const app = fixture();
      const response = await app.quote();
      const quote = JSON.parse(String(response.quoteJson));
      expect(quote).toMatchObject({ chainId: "1", accountId: "main", amountIn: "1000000", amountOut: "2000000", minimumOut: "1990000", fee: 500, recipient: RECIPIENT, router: ROUTER });
      expect(quote.networkFees).toMatchObject({ approval: null, swap: { estimatedFeeWei: null, maximumFeeWei: null, gasLimit: null, postingCosts: "unavailable" } });
      expect(typeof quote.networkFees.swap.reason).toBe("string");
      const reads = app.walletCalls.filter((call) => call.name === "evm_call_contract_v1");
      expect(reads.filter((call) => call.arguments.to === QUOTER.toLowerCase())).toHaveLength(4);
      expect(reads.filter((call) => [FACTORY.toLowerCase(), POOL.toLowerCase()].includes(String(call.arguments.to))).map((call) => call.arguments.blockTag)).toEqual(["21000000", "21000000"]);
      expect(reads).toHaveLength(6);
      expect(app.walletCalls.every((call) => ["evm_accounts_v1", "evm_call_contract_v1", "evm_estimate_transaction_v1"].includes(call.name))).toBe(true);
      expect(app.mutations).toHaveLength(0);
    });

    test("unknown token metadata still resolves through read-only calls", async () => {
      const app = fixture();
      const response = await app.invoke("uniswap_quote_v1", {
        chainId: "1", accountId: "main", tokenIn: null, tokenOut: OTHER,
        amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT,
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
      });
      expect(JSON.parse(String(response.quoteJson)).tokenOut).toEqual({
        chainId: "1", address: OTHER, symbol: "CUSTOM", decimals: 8,
      });
      const metadataCalls = app.walletCalls.filter((call) => call.arguments.to === OTHER.toLowerCase());
      expect(metadataCalls.map((call) => decodeFunctionData({ abi: tokenAbi, data: call.arguments.data as `0x${string}` }).functionName)).toEqual(["decimals", "symbol"]);
      expect(metadataCalls.every((call) => call.name === "evm_call_contract_v1")).toBe(true);
      expect(app.mutations).toHaveLength(0);
    });

    test("Agent quotes compare all four fee tiers and estimate both transactions through declared install grants", async () => {
      await withAgentConsent(async (authorize, errors) => {
        const app = fixture({ authorize, estimatesAvailable: true, bestQuoteFee: 10000 });
        const response = await app.quote(true), quote = JSON.parse(String(response.quoteJson));
        const poolReads = app.walletCalls.filter((call) => call.arguments.to === QUOTER.toLowerCase());
        expect(poolReads.map((call) => decodeFunctionData({ abi: quoteAbi, data: call.arguments.data as `0x${string}` }).args[0].fee)).toEqual([100, 500, 3000, 10000]);
        expect(quote).toMatchObject({ fee: 10000, amountOut: "2000000", networkFees: {
          approval: { estimatedFeeWei: "150000000000000", reason: null },
          swap: { estimatedFeeWei: "390000000000000", reason: null },
        } });
        expect(errors).toEqual([]);
        expect(app.mutations).toHaveLength(0);
        expect(app.walletCalls.some((call) => /send_transaction|sign_/.test(call.name))).toBe(false);
      });
    });

    test("Agent custom-token decimals and symbol both resolve through declared read grants", async () => {
      await withAgentConsent(async (authorize, errors) => {
        const app = fixture({ authorize, estimatesAvailable: true });
        const response = await app.invoke("uniswap_quote_v1", {
          chainId: "1", accountId: "main", tokenIn: OTHER, tokenOut: null,
          amountIn: "1000000", slippageBps: 50, recipient: RECIPIENT,
          deadline: String(Math.floor(Date.now() / 1000) + 3600),
        });
        expect(JSON.parse(String(response.quoteJson)).tokenIn).toEqual({ chainId: "1", address: OTHER, symbol: "CUSTOM", decimals: 8 });
        const metadata = app.walletCalls.filter((call) => call.name === "evm_call_contract_v1" && call.arguments.to === OTHER.toLowerCase());
        expect(metadata.map((call) => decodeFunctionData({ abi: tokenAbi, data: call.arguments.data as `0x${string}` }).functionName)).toEqual(["decimals", "symbol", "allowance"]);
        expect(errors).toEqual([]);
        expect(app.mutations).toHaveLength(0);
      });
    });

    test("a failed Agent pool or approval fee read does not prevent other installed reads", async () => {
      await withAgentConsent(async (authorize, errors) => {
        const app = fixture({ authorize, estimatesAvailable: true, failQuoteFee: 100, bestQuoteFee: 10000, failApprovalEstimate: true });
        const response = await app.quote(true), quote = JSON.parse(String(response.quoteJson));
        expect(app.walletCalls.filter((call) => call.arguments.to === QUOTER.toLowerCase())).toHaveLength(4);
        expect(quote.fee).toBe(10000);
        expect(quote.networkFees.approval).toMatchObject({ estimatedFeeWei: null, reason: "Approval fee provider unavailable" });
        expect(quote.networkFees.swap).toMatchObject({ estimatedFeeWei: "390000000000000", reason: null });
        expect(app.walletCalls.filter((call) => call.name === "evm_estimate_transaction_v1")).toHaveLength(2);
        expect(errors).toEqual([]);
        expect(app.mutations).toHaveLength(0);
      });
    });

    test.each(["context", "request"])("queued ungranted Agent reads respect %s cancellation before dispatch", async (cancellation) => {
      const controller = new AbortController();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const calls: unknown[] = [], progress = () => {};
      const kernel = { async callTool(_call: unknown, options: unknown) {
        expect(this).toBe(kernel); calls.push(options);
        await held; return { networks: [] };
      } };
      const wallet = createServiceWallet({ kernel, agentMode: true, ...(cancellation === "context" ? { signal: controller.signal } : {}), reportProgress() {} });
      const first = wallet.networks({ timeout: 3210, onProgress: progress });
      const queued = wallet.networks(cancellation === "request" ? { signal: controller.signal } : undefined);
      const outcome = queued.then(() => null, (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toEqual([{ timeout: 3210, onProgress: progress, ...(cancellation === "context" ? { signal: controller.signal } : {}) }]);
      controller.abort(new Error("Cancelled queued wallet read"));
      release(); await first;
      expect(await outcome).toMatchObject({ message: "Cancelled queued wallet read" });
      expect(calls).toHaveLength(1);
      if (cancellation === "request") {
        await wallet.networks();
        expect(calls).toHaveLength(2);
      }
    });

    test("non-Agent service reads retain parallel dispatch", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      const wallet = createServiceWallet({ kernel: { async callTool() { calls += 1; await held; return { accounts: [account] }; } }, agentMode: false, reportProgress() {} });
      const first = wallet.accounts(), second = wallet.accounts();
      expect(calls).toBe(2);
      release(); await Promise.all([first, second]);
    });

    test("provider disagreement produces an unavailable quote and no saved or executed work", async () => {
      const app = fixture({ quotesUnavailable: true });
      await expect(app.quote()).rejects.toThrow("No direct V3 pool quote");
      expect(app.rows.size).toBe(0); expect(app.mutations).toHaveLength(0);
    });

    test("prepare saves the authenticated caller and immutable requests without forwarding EVM effects", async () => {
      const app = fixture();
      const response = await app.prepared(true);
      const saved = JSON.parse(String(response.recordJson));
      const intent = JSON.parse(saved.quote_json);
      expect(intent).toMatchObject({ executionMode: "agent", walletCaller: { appId: "agent", installationUid: "17" } });
      const approval = parseEvmSendTransactionRequest(JSON.parse(String(response.approvalRequestJson)));
      const swap = parseEvmSendTransactionRequest(JSON.parse(String(response.swapRequestJson)));
      expect(approval).toMatchObject({ accountId: "main", chainId: "1", to: USDC.toLowerCase(), valueWei: "0" });
      expect(approval.data.slice(0, 10)).toBe("0x095ea7b3"); expect(swap.to).toBe(ROUTER.toLowerCase());
      expect(swap.data.slice(0, 10)).toBe("0x5ae401dc"); expect(approval.requestId).not.toBe(swap.requestId);
      expect(app.mutations.map(({ method }) => method)).toEqual(["uniswap_begin_v1"]);
      expect(app.walletCalls.some((call) => /send_transaction|sign_|replace_transaction/.test(call.name))).toBe(false);
    });

    test("identical prepare retries reuse every request ID while another installation cannot claim that swap ID", async () => {
      const app = fixture();
      const quoted = await app.quote(true);
      const args = { swapId: SWAP_ID, quoteJson: quoted.quoteJson! };
      const initial = await app.invoke("uniswap_prepare_v1", args);
      const calls = app.walletCalls.length;
      expect(await app.invoke("uniswap_prepare_v1", args)).toEqual(initial);
      expect(app.walletCalls).toHaveLength(calls); expect(app.mutations).toHaveLength(1);
      await expect(app.invoke("uniswap_prepare_v1", args, app.context("18"))).rejects.toThrow("different quote");
      expect(app.mutations).toHaveLength(1);
    });

    test("preparation without a Kernel-authenticated installation identity fails before persistence", async () => {
      const app = fixture(), quoted = await app.quote();
      for (const uid of [null, "0", "not-an-installation"]) {
        await expect(app.invoke("uniswap_prepare_v1", { swapId: SWAP_ID, quoteJson: quoted.quoteJson! }, app.context(uid))).rejects.toThrow("Kernel-authenticated caller installation identity");
      }
      expect(app.rows.size).toBe(0); expect(app.mutations).toHaveLength(0);
    });

    test("status and list restore native-swap options without querying or invoking the wallet", async () => {
      const app = fixture();
      await app.prepared();
      const calls = app.walletCalls.length, writes = app.mutations.length;
      const status = await app.invoke("uniswap_status_v1", { swapId: SWAP_ID });
      const saved = JSON.parse(String(status.recordJson));
      expect(saved).toMatchObject({ phase: "queued", approval_request_id: null, approval_request_json: null, approval_operation_json: null, swap_operation_json: null });
      const list = await app.invoke("uniswap_list_v1", {});
      expect(JSON.parse(String(list.recordsJson))).toEqual([saved]);
      expect(await app.invoke("uniswap_status_v1", { swapId: "missing" })).toEqual({ recordJson: null });
      expect(app.queries.find(({ method }) => method === "uniswap_history_v1")?.args).toEqual([{ limit: "32" }]);
      expect(app.walletCalls).toHaveLength(calls); expect(app.mutations).toHaveLength(writes);
    });

    test("paged history returns complete immutable records with an explicit continuation and no wallet calls", async () => {
      const app = fixture();
      await app.prepared();
      const first = [...app.rows.values()][0]!;
      app.rows.set("older", { ...first, id: "older", created_at: "1" });
      const writes = app.mutations.length, walletCalls = app.walletCalls.length;
      const head = await app.invoke("uniswap_list_page_v1", { cursor: null, limit: 1 });
      expect(JSON.parse(String(head.recordsJson))).toHaveLength(1);
      expect(head.nextCursor).toBe(SWAP_ID);
      const tail = await app.invoke("uniswap_list_page_v1", { cursor: head.nextCursor!, limit: 1 });
      expect(JSON.parse(String(tail.recordsJson))[0].id).toBe("older");
      expect(tail.nextCursor).toBeNull();
      expect(app.walletCalls).toHaveLength(walletCalls); expect(app.mutations).toHaveLength(writes);
    });

    test("recording a root result verifies the saved caller/request and stores the actual chain receipt", async () => {
      const app = fixture();
      await app.prepared();
      const { claim } = app.configureEvidence();
      const response = await app.invoke("uniswap_record_result_v1", { swapId: SWAP_ID, stage: "swap", operationJson: JSON.stringify(claim) });
      const saved = JSON.parse(String(response.recordJson)), observed = parseEvmOperationResult(JSON.parse(saved.swap_operation_json));
      expect(response.phase).toBe("swap_confirmed"); expect(observed.receipt).toEqual(receipt());
      const lookup = app.walletCalls.find((call) => call.name === "evm_transaction_v1")!;
      expect(lookup.arguments).toEqual({ chainId: "1", transactionHash: HASH, walletRequest: { callerAppId: "agent", callerInstallationUid: "17", requestId: saved.swap_request_id } });
      expect(app.walletCalls.some((call) => /send_transaction|sign_|replace_transaction/.test(call.name))).toBe(false);
      expect(app.mutations.map(({ method }) => method)).toEqual(["uniswap_begin_v1", "uniswap_update_v1"]);
    });

    test.each([false, null])("a wallet request binding of %s leaves even a matching public transaction unresolved", async (walletRequestMatches) => {
      const app = fixture(); await app.prepared();
      const { claim } = app.configureEvidence("swap", { walletRequestMatches });
      await expect(app.invoke("uniswap_record_result_v1", { swapId: SWAP_ID, stage: "swap", operationJson: JSON.stringify(claim) })).rejects.toThrow();
      expect(app.mutations).toHaveLength(1); expect(app.rows.get(SWAP_ID)!.swap_operation_json).toBeUndefined();
    });

    test("a different public transaction or a relabeled hash cannot satisfy a root success claim", async () => {
      for (const tamper of ["to", "hash"] as const) {
        const app = fixture(); await app.prepared();
        const { claim, evidence } = app.configureEvidence();
        if (tamper === "to") evidence.transaction!.to = OTHER;
        else evidence.transactionHash = `0x${"ff".repeat(32)}`;
        await expect(app.invoke("uniswap_record_result_v1", { swapId: SWAP_ID, stage: "swap", operationJson: JSON.stringify(claim) })).rejects.toThrow();
        expect(app.mutations).toHaveLength(1); expect(app.rows.get(SWAP_ID)!.phase).toBe("queued");
      }
    });

    test("a confirmed approval is recorded separately using its own immutable request ID", async () => {
      const app = fixture(); await app.prepared(true);
      const { claim } = app.configureEvidence("approval");
      const response = await app.invoke("uniswap_record_result_v1", { swapId: SWAP_ID, stage: "approval", operationJson: JSON.stringify(claim) });
      const saved = JSON.parse(String(response.recordJson));
      expect(saved.phase).toBe("approval_confirmed"); expect(saved.swap_operation_json).toBeNull();
      expect(JSON.parse(saved.approval_operation_json).requestId).toBe(saved.approval_request_id);
      expect(app.walletCalls.find((call) => call.name === "evm_transaction_v1")?.arguments.walletRequest).toEqual({ callerAppId: "agent", callerInstallationUid: "17", requestId: saved.approval_request_id });
    });
  });
}
