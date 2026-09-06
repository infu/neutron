import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { MsgBusToolContext } from "neutron-tools/app";
import {
  effectIntent,
  handleHumanEffect,
  handleRootEffect,
  operationReceipt,
  OWNER_REVIEW_TOOLS,
  prepareEffect,
} from "../src/provider.ts";
import {
  acceptPrompt,
  checkPrompt,
  declinePrompt,
  getPrompts,
  getPreparations,
  presentEffect,
  presentOwnEffect,
  refreshPromptEvidence,
} from "../src/prompts.ts";
import { atomicAmount, parseBalance, parseOperation } from "../src/data.ts";
import { assertLocalAccount } from "../src/local_intent.ts";
import { browserEvmRpc } from "../src/browser_rpc.ts";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentOperation } from "../src/presentation.ts";

let rpc: ReturnType<typeof spyOn<typeof browserEvmRpc, "request">>;
beforeEach(() => {
  rpc = spyOn(browserEvmRpc, "request").mockImplementation(async (_chain, method) => {
    throw new Error(`Unexpected browser RPC ${method}`);
  });
});
afterEach(() => { rpc.mockRestore(); });
const caller = {
  appId: "kitchensink",
  installationUid: "9",
  endpoint: "app:kitchensink:tile:main",
};
const request = {
  requestId: "ab".repeat(16),
  accountId: "main" as const,
  chainId: "1",
  to: `0x${"11".repeat(20)}`,
  valueWei: "7",
  data: "0x",
};
function wire(overrides: Record<string, unknown> = {}) {
  return {
    ok: {
      caller: {
        app_id: caller.appId,
        installation_uid: caller.installationUid,
        endpoint: caller.endpoint,
      },
      operation_id: "1",
      request_id: request.requestId,
      account_id: "main",
      chain_id: "1",
      kind: "transaction",
      status: "prepared",
      address: `0x${"22".repeat(20)}`,
      transaction_hash: null,
      signature: null,
      message: null,
      review_revision: "1",
      review: {
        nonce: "0",
        gas_limit: "21000",
        max_fee_per_gas: "2",
        max_priority_fee_per_gas: "1",
        gas_price: null,
        balance: "999999",
        simulation: "0x",
        observed_at: "1000000",
      },
      receipt_json: null,
      finality: null,
      created_at: "1000000",
      updated_at: "1000000",
      intent: effectIntent("transaction", request),
      prepared_transaction: {
        to: request.to,
        value: request.valueWei,
        data: request.data,
        access_list: [],
        chain_id: request.chainId,
        nonce:
          (overrides.review as { nonce: string } | undefined)?.nonce ?? "0",
        gas_limit: "21000",
        transaction_type: "eip1559",
        max_fee_per_gas: "2",
        max_priority_fee_per_gas: "1",
        gas_price: null,
      },
      ...overrides,
    },
  };
}
type SelfCall = (method: string, args: unknown[]) => Promise<unknown>;
function context(
  update: SelfCall,
  extra: Partial<MsgBusToolContext> = {},
  query?: SelfCall,
): MsgBusToolContext {
  const provenance = extra.caller ?? caller;
  const identity = {
    caller: {
      app_id: provenance.appId,
      installation_uid: provenance.installationUid,
      endpoint: provenance.endpoint,
    },
    request_id: request.requestId,
  };
  return {
    caller,
    audience: "foreground_tile",
    kernel: {
      querySelf: async (method: string, args: unknown[]) => {
        expect(["evm_wallet_operation_v1", "evm_wallet_superseding_v1"]).toContain(method);
        expect(args).toEqual([{ identity }]);
        // These provider tests start from a saved exact review. Fresh RPC
        // preparation and candidate completion are covered by browser_operations.
        return query ? query(method, args) : method === "evm_wallet_superseding_v1" ? { ok: null } : wire({ caller: identity.caller });
      },
      updateSelf: async (method: string, args: unknown[]) => {
        if (method === "evm_wallet_prepare_browser_v1") {
          expect(args).toHaveLength(1);
          expect(args[0]).toMatchObject({
            request: { identity },
            observation: {
              block_number: "0", balance: "0", pending_nonce: "0", mined_nonce: "0",
              gas_price: "0", max_priority_fee_per_gas: "0", base_fee_per_gas: "0",
            },
          });
        }
        return update(method, args);
      },
    },
    ...extra,
  } as unknown as MsgBusToolContext;
}
async function promptReady() {
  for (let i = 0; i < 100; i++) {
    if (getPrompts().length) return getPrompts()[0]!;
    await Promise.resolve();
  }
  throw new Error("No prompt");
}
test("preparation is visible while backend work waits and clears before exact review", async () => {
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const completion = presentEffect("transaction", request, context(async (method) => {
    if (method === "evm_wallet_prepare_browser_v1") {
      await gate;
      return wire();
    }
    if (method === "evm_wallet_reject_v1") return wire({ status: "rejected" });
    throw new Error(`Unexpected effect ${method}`);
  }));
  expect(getPreparations()).toHaveLength(1);
  expect(getPreparations()[0]?.request).toEqual(request);
  expect(getPrompts()).toHaveLength(0);
  ready();
  const prompt = await promptReady();
  expect(getPreparations()).toHaveLength(0);
  await declinePrompt(prompt);
  expect((await completion).status).toBe("rejected");
});
test("fresh preparation stays visible until browser estimation and simulation finish", async () => {
  let estimateStarted!: () => void;
  const estimating = new Promise<void>((resolve) => { estimateStarted = resolve; });
  let finishEstimate!: () => void;
  const estimated = new Promise<void>((resolve) => { finishEstimate = resolve; });
  const calls: string[] = [];
  const identity = {
    caller: { app_id: caller.appId, installation_uid: caller.installationUid, endpoint: caller.endpoint },
    request_id: request.requestId,
  };
  rpc.mockImplementation(async <T>(_chain: string | number | bigint, method: string): Promise<T> => {
    let value: unknown;
    switch (method) {
      case "eth_getBlockByNumber": value = { number: "0x10", baseFeePerGas: "0x1" }; break;
      case "eth_getTransactionCount": value = "0x0"; break;
      case "eth_gasPrice": value = "0x2"; break;
      case "eth_maxPriorityFeePerGas": value = "0x1"; break;
      case "eth_getBalance": value = "0xf423f"; break;
      case "eth_estimateGas": estimateStarted(); await estimated; value = "0x5208"; break;
      case "eth_call": value = "0x"; break;
      default: throw new Error(`Unexpected browser RPC ${method}`);
    }
    return value as T;
  });
  const ctx = {
    caller,
    audience: "foreground_tile",
    kernel: {
      querySelf: async (method: string, args: unknown[]) => {
        calls.push(method);
        expect(method).toBe("evm_wallet_operation_v1");
        expect(args).toEqual([{ identity }]);
        return { err: "not_found" };
      },
      updateSelf: async (method: string, args: unknown[]) => {
        calls.push(method);
        if (method === "evm_wallet_accounts_v1") {
          expect(args).toEqual([null]);
          return { ok: [{ id: "main", slot: "main", address: wire().ok.address, public_key: new Uint8Array([2]), namespace_version: "1" }] };
        }
        if (method === "evm_wallet_prepare_browser_v1") {
          expect(args).toEqual([{
            request: { identity, intent: effectIntent("transaction", request) },
            observation: {
              block_number: "0x10", balance: "999999", pending_nonce: "0", mined_nonce: "0",
              gas_price: "2", max_priority_fee_per_gas: "1", base_fee_per_gas: "1",
            },
          }]);
          return wire({ status: "preparing" });
        }
        if (method === "evm_wallet_finish_prepare_browser_v1") {
          expect(args[0]).toMatchObject({ identity, review_revision: "1", gas_estimate: "21000", gas_limit: "21000", simulation: "0x" });
          return wire();
        }
        if (method === "evm_wallet_reject_v1") return wire({ status: "rejected" });
        throw new Error(`Unexpected effect ${method}`);
      },
    },
  } as unknown as MsgBusToolContext;
  const completion = presentEffect("transaction", request, ctx);
  await estimating;
  expect(getPreparations()).toHaveLength(1);
  expect(getPreparations()[0]?.request).toEqual(request);
  expect(getPrompts()).toHaveLength(0);
  expect(calls).toEqual(["evm_wallet_operation_v1", "evm_wallet_accounts_v1", "evm_wallet_prepare_browser_v1"]);
  finishEstimate();
  const prompt = await promptReady();
  expect(getPreparations()).toHaveLength(0);
  expect(prompt.phase).toBe("review");
  expect(prompt.prepared.operation.review?.simulation).toBe("0x");
  await declinePrompt(prompt);
  expect((await completion).status).toBe("rejected");
  expect(calls).not.toContain("evm_wallet_execute_v1");
  expect(rpc.mock.calls.some((call) => call[1] === "eth_sendRawTransaction")).toBe(false);
});
test("failed preparation clears its progress without opening an approval", async () => {
  await expect(presentEffect("transaction", request, context(async () => {
    throw new Error("Network unavailable");
  }))).rejects.toThrow("Network unavailable");
  expect(getPreparations()).toHaveLength(0);
  expect(getPrompts()).toHaveLength(0);
});
test("exact typed JSON and explicit transaction fields reach backend unchanged", () => {
  const typedDataJson =
    '{"types":{"EIP712Domain":[],"Permit":[{"name":"amount","type":"uint256"}]},"primaryType":"Permit","domain":{},"message":{"amount":9007199254740993}}';
  expect(
    effectIntent("typed_data", {
      requestId: request.requestId,
      accountId: "main",
      chainId: "1",
      typedDataJson,
    }),
  ).toEqual({
    account_id: "main",
    chain_id: "1",
    operation: { typed_data: { json: typedDataJson } },
  });
  expect(
    effectIntent("transaction", {
      ...request,
      transactionType: "legacy",
      gasPriceWei: "5",
      gasLimit: "40000",
    }),
  ).toMatchObject({
    operation: {
      transaction: {
        transaction_type: "legacy",
        gas_price: "5",
        gas_limit: "40000",
        access_list: [],
      },
    },
  });
});
test("missing installation provenance and nested root callers fail before backend work", async () => {
  let calls = 0;
  const ctx = context(async () => {
    calls++;
    return wire();
  });
  await expect(
    prepareEffect("transaction", request, {
      ...ctx,
      caller: { appId: caller.appId, endpoint: caller.endpoint },
    }),
  ).rejects.toThrow("installation identity");
  await expect(handleRootEffect("transaction", request, ctx)).rejects.toThrow(
    "root-agent",
  );
  expect(calls).toBe(0);
});
test("public provider delegates privately without preparing or signing", async () => {
  let calls = 0;
  const presentations: unknown[] = [];
  const ctx = context(
    async () => {
      calls++;
      return wire();
    },
    {
      presentUserInterface: async (request: unknown) => {
        presentations.push(request);
        return { ok: true };
      },
    } as unknown as Partial<MsgBusToolContext>,
  );
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual({
    ok: true,
  });
  expect(calls).toBe(0);
  expect(presentations).toEqual([
    {
      tileId: "evm_wallet",
      tool: "evm_transaction_present_v1",
      arguments: request,
    },
  ]);
});
test("nested Agent provider executes only after the exact caller-scoped transaction review is approved", async () => {
  const calls: string[] = [];
  let approved = false;
  const ctx = context(async (method, args) => {
    calls.push(method);
    if (method === "evm_wallet_prepare_browser_v1") return wire();
    expect(method).toBe("evm_wallet_execute_v1");
    expect(approved).toBe(true);
    expect(args).toEqual([{
      identity: {
        caller: { app_id: caller.appId, installation_uid: caller.installationUid, endpoint: caller.endpoint },
        request_id: request.requestId,
      },
      review_revision: "1",
    }]);
    return wire({ status: "submitted", transaction_hash: `0x${"aa".repeat(32)}` });
  }, {
    agentMode: true,
    requestApproval: async (review) => {
      expect(calls).toEqual(["evm_wallet_prepare_browser_v1"]);
      expect(review).toMatchObject({
        provider: "EVM Wallet", kind: "transaction", caller,
        operationId: "1", requestId: request.requestId, reviewRevision: "1",
        accountId: "main", chainId: "1", signingAddress: wire().ok.address,
        transaction: {
          to: request.to, valueWei: "7", data: "0x", accessList: [], nonce: "0",
          gasLimit: "21000", transactionType: "eip1559", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "1", gasPriceWei: null,
        },
        observations: { nativeBalanceWei: "999999", maximumNetworkFeeWei: "42000", simulation: "0x", observedAtNs: "1000000" },
        personalMessageHex: null, typedDataJson: null, replacement: null,
      });
      approved = true;
    },
    presentUserInterface: async () => { throw new Error("Agent must use the exact Kernel review"); },
  });
  delete ctx.audience;
  expect((await handleHumanEffect("transaction", request, ctx)).status).toBe("submitted");
  expect(calls).toEqual(["evm_wallet_prepare_browser_v1", "evm_wallet_execute_v1"]);
  expect(getPrompts()).toHaveLength(0);
});
test("Agent flag without an authenticated provider callback cannot prepare or execute", async () => {
  const ctx = context(async () => { throw new Error("Unexpected wallet operation"); }, { agentMode: true });
  await expect(handleHumanEffect("transaction", request, ctx)).rejects.toThrow("Kernel provider approval support");
});
test("denied or cancelled Agent review leaves the unsigned request without executing", async () => {
  for (const cancelled of [false, true]) {
    const calls: string[] = [];
    const abort = new AbortController();
    const ctx = context(async (method) => {
      calls.push(method);
      if (method !== "evm_wallet_prepare_browser_v1") throw new Error("Unexpected effect");
      return wire();
    }, {
      agentMode: true,
      signal: abort.signal,
      requestApproval: async () => {
        if (cancelled) abort.abort(new Error("Owner cancelled"));
        else throw new Error("Owner intent does not authorize this transaction");
      },
    });
    await expect(handleHumanEffect("transaction", request, ctx)).rejects.toThrow(cancelled ? "Owner cancelled" : "does not authorize");
    expect(calls).toEqual(["evm_wallet_prepare_browser_v1"]);
  }
});
test("Agent token approval review includes exact spender and observed allowance before approval", async () => {
  const spender = `0x${"44".repeat(20)}` as const;
  const tokenRequest = { ...request, valueWei: "0", data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 3_000_000n] }) };
  const saved = wire({
    intent: effectIntent("transaction", tokenRequest),
    prepared_transaction: { ...wire().ok.prepared_transaction, value: "0", data: tokenRequest.data },
  });
  const calls: string[] = [];
  const ctx = context(async (method) => {
    calls.push(method);
    if (method === "evm_wallet_prepare_browser_v1") return saved;
    expect(method).toBe("evm_wallet_review_evidence_v1");
    return { operation: saved.ok, token_evidence: {
      chain_id: "1", contract: request.to, method: "approve", owner: saved.ok.address,
      spender, recipient: null, amount: "3000000", recognition: "erc20_calldata",
      block_number: "0x10", block_hash: `0x${"55".repeat(32)}`, block_error: null,
      observed_at: "1000000", balance: { value: "7000030" }, allowance: { value: "0" },
    } };
  }, {
    agentMode: true,
    requestApproval: async (review) => {
      expect(calls).toEqual(["evm_wallet_prepare_browser_v1", "evm_wallet_review_evidence_v1"]);
      expect(review).toMatchObject({
        transaction: { to: request.to, valueWei: "0", data: tokenRequest.data },
        decodedTokenCall: { name: "ERC-20 approval", details: [
          { label: "Spender", value: spender }, { label: "Allowance (atomic units)", value: "3000000" },
        ] },
        tokenEvidence: { contract: request.to, owner: saved.ok.address, spender, amount: "3000000", balance: { value: "7000030" }, allowance: { value: "0" } },
      });
      throw new Error("Declined token approval");
    },
  });
  await expect(handleHumanEffect("transaction", tokenRequest, ctx)).rejects.toThrow("Declined token approval");
  expect(calls).toHaveLength(2);
});
test("Agent swap review uses the owner dialog's decoded input and minimum output", async () => {
  const router = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const recipient = `0x${"22".repeat(20)}` as const;
  const abi = parseAbi([
    "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])",
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
    "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  ]);
  const data = encodeFunctionData({ abi, functionName: "multicall", args: [2_000_000_000n, [
    encodeFunctionData({ abi, functionName: "exactInputSingle", args: [{ tokenIn: usdc, tokenOut: weth, fee: 3000, recipient: router, amountIn: 3_000_000n, amountOutMinimum: 10n ** 14n, sqrtPriceLimitX96: 0n }] }),
    encodeFunctionData({ abi, functionName: "unwrapWETH9", args: [10n ** 14n, recipient] }),
  ]] });
  const swapRequest = { ...request, to: router, valueWei: "0", data };
  const ctx = context(async (method) => {
    expect(method).toBe("evm_wallet_prepare_browser_v1");
    return wire({ intent: effectIntent("transaction", swapRequest), prepared_transaction: { ...wire().ok.prepared_transaction, to: router, value: "0", data } });
  }, {
    agentMode: true,
    requestApproval: async (review) => {
      expect(review).toMatchObject({
        summary: { title: "Swap tokens", amount: "3 USDC", parties: [
          { label: "Minimum received", value: "0.0001 ETH" }, { label: "Recipient", value: recipient },
        ], swap: {
          tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          amountIn: "3000000", amountOutMinimum: "100000000000000", recipient,
          deadline: "2000000000", poolFee: "3000", inputNative: false, outputNative: true,
        } },
        transaction: { data, valueWei: "0" },
      });
      throw new Error("Review inspected");
    },
  });
  await expect(handleHumanEffect("transaction", swapRequest, ctx)).rejects.toThrow("Review inspected");
});
test("Agent liquidity and Permit2 reviews carry the same limits and details as the owner dialog", async () => {
  const manager = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const recipient = `0x${"22".repeat(20)}` as const;
  const abi = parseAbi([
    "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable",
    "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  ]);
  for (const candidate of [
    { to: manager, data: encodeFunctionData({ abi, functionName: "mint", args: [{ token0: usdc, token1: weth, fee: 3000, tickLower: -120, tickUpper: 120, amount0Desired: 3_000_000n, amount1Desired: 10n ** 15n, amount0Min: 2_970_000n, amount1Min: 99n * 10n ** 13n, recipient, deadline: 2_000_000_000n }] }) },
    { to: "0x000000000022d473030f116ddee9f6b43ac78ba3", data: encodeFunctionData({ abi, functionName: "approve", args: [usdc, manager, 3_000_000n, 2_000_000_000] }) },
  ]) {
    const effect = { ...request, ...candidate, valueWei: "0" };
    const saved = wire({ intent: effectIntent("transaction", effect), prepared_transaction: { ...wire().ok.prepared_transaction, ...candidate, value: "0" } });
    const ownerSummary = presentOperation(parseOperation(saved.ok), mergeEvmAssets([]));
    const ctx = context(async method => {
      expect(method).toBe("evm_wallet_prepare_browser_v1");
      return saved;
    }, {
      agentMode: true,
      requestApproval: async review => {
        expect(review).toMatchObject({ summary: {
          title: ownerSummary.title, amount: ownerSummary.amount, parties: ownerSummary.parties,
          liquidity: ownerSummary.liquidity ?? null,
          permit2Approval: ownerSummary.permit2Approval ?? null,
          advancedDetails: ownerSummary.advancedDetails ?? [],
        }, transaction: { data: candidate.data, valueWei: "0" } });
        throw new Error("Review inspected");
      },
    });
    await expect(handleHumanEffect("transaction", effect, ctx)).rejects.toThrow("Review inspected");
  }
});
test("Agent review changes return unsigned and need a new call with a fresh approval", async () => {
  let approvals = 0;
  let executes = 0;
  let saved = wire();
  const ctx = context(async (method, args) => {
    if (method === "evm_wallet_prepare_browser_v1") return saved;
    expect(method).toBe("evm_wallet_execute_v1");
    executes++;
    expect(approvals).toBe(executes);
    expect(args[0]).toMatchObject({ review_revision: String(executes) });
    saved = executes === 1
      ? wire({ review_revision: "2", review: { ...wire().ok.review, nonce: "1" }, message: "Review changed" })
      : wire({ status: "submitted", review_revision: "2", review: { ...wire().ok.review, nonce: "1" }, transaction_hash: `0x${"aa".repeat(32)}` });
    return saved;
  }, {
    agentMode: true,
    requestApproval: async (review) => {
      approvals++;
      expect(review).toMatchObject({ reviewRevision: String(approvals), transaction: { nonce: String(approvals - 1) } });
    },
  });
  expect((await handleHumanEffect("transaction", request, ctx)).status).toBe("prepared");
  expect(executes).toBe(1);
  expect((await handleHumanEffect("transaction", request, ctx)).status).toBe("submitted");
  expect(executes).toBe(2);
});
test("a saved submitted Agent provider request returns without another review or execution", async () => {
  const calls: string[] = [];
  const ctx = context(async (method) => {
    calls.push(method);
    return wire({ status: "submitted", transaction_hash: `0x${"aa".repeat(32)}` });
  }, {
    agentMode: true,
    requestApproval: async () => { throw new Error("Already submitted operation must not request fresh approval"); },
  });
  expect((await handleHumanEffect("transaction", request, ctx)).status).toBe("submitted");
  expect(calls).toEqual(["evm_wallet_prepare_browser_v1"]);
});
test("Agent signature reviews retain the complete personal message and exact typed data", async () => {
  for (const kind of ["message", "typed_data"] as const) {
    const signatureRequest = kind === "message"
      ? { requestId: request.requestId, accountId: "main" as const, chainId: "1", messageHex: "0x48656c6c6f" }
      : { requestId: request.requestId, accountId: "main" as const, chainId: "1", typedDataJson: JSON.stringify({ domain: { chainId: 1 }, types: { Permit: [{ name: "value", type: "uint256" }] }, primaryType: "Permit", message: { value: "3000000" } }) };
    let approved = false;
    const ctx = context(async (method) => {
      if (method === "evm_wallet_execute_v1") expect(approved).toBe(true);
      else expect(method).toBe("evm_wallet_prepare_browser_v1");
      return wire({
        kind, intent: effectIntent(kind, signatureRequest), prepared_transaction: null, review: null,
        ...(approved ? { status: "signed", signature: `0x${"aa".repeat(65)}` } : {}),
      });
    }, {
      agentMode: true,
      requestApproval: async (review) => {
        expect(review).toMatchObject({ kind, transaction: null, observations: null, signingAddress: wire().ok.address, chainId: "1" });
        expect(kind === "message" ? review.personalMessageHex : review.typedDataJson).toBe(kind === "message" ? signatureRequest.messageHex! : signatureRequest.typedDataJson!);
        approved = true;
      },
    });
    expect((await handleHumanEffect(kind, signatureRequest, ctx)).status).toBe("signed");
  }
});
const ownerTile = {
  appId: "evm_wallet",
  installationUid: "12",
  role: "tile",
  endpoint: "app:evm_wallet:tile:evm_wallet:instance:owner-7",
};
const ownerResident = { ...ownerTile, role: "background", endpoint: "app:evm_wallet:background" };
function humanOwnerContext(
  update: (method: string, args: unknown[]) => Promise<unknown>,
  extra: Partial<MsgBusToolContext> = {},
): MsgBusToolContext {
  const ctx = context(update, extra);
  delete ctx.audience;
  return ctx;
}
test("own requests route to their exact tile without provider presentation or backend effects", async () => {
  const forwarded: unknown[] = [];
  const ctx = humanOwnerContext(async () => { throw new Error("Resident must not prepare or sign"); }, {
    caller: ownerTile,
    kernel: {
      callTool: async (call: unknown) => { forwarded.push(call); return { routed: true }; },
    } as unknown as MsgBusToolContext["kernel"],
  });
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual({ routed: true });
  expect(forwarded).toEqual([{ target: ownerTile.endpoint, name: OWNER_REVIEW_TOOLS.transaction, arguments: request }]);
  expect(ctx.presentUserInterface).toBeUndefined();
});
test("own route rejects missing provenance, non-tile endpoints and Agent invocation before dispatch", async () => {
  let forwarded = 0;
  const ctx = humanOwnerContext(async () => { throw new Error("Unexpected backend work"); }, {
    caller: ownerTile,
    kernel: { callTool: async () => { forwarded++; } } as unknown as MsgBusToolContext["kernel"],
  });
  for (const changed of [
    { caller: { appId: ownerTile.appId, role: ownerTile.role, endpoint: ownerTile.endpoint } },
    { caller: ownerResident },
    { caller: { ...ownerTile, role: "background" } },
    { caller: { ...ownerTile, endpoint: "app:evm_wallet:tile:evm_wallet" } },
    { caller: { ...ownerTile, endpoint: "app:kitchensink:tile:main:instance:owner-7" } },
    { agentMode: true },
  ]) await expect(handleHumanEffect("transaction", request, { ...ctx, ...changed })).rejects.toThrow();
  await expect(handleHumanEffect("transaction", request, { ...ctx, caller })).rejects.toThrow("provider presentation");
  expect(forwarded).toBe(0);
});
test("owner review only accepts the authenticated resident without Agent invocation", async () => {
  let prepares = 0;
  const ctx = humanOwnerContext(async () => { prepares++; return wire(); }, { caller: ownerResident });
  for (const changed of [
    { caller },
    { caller: ownerTile },
    { caller: { appId: ownerResident.appId, role: ownerResident.role, endpoint: ownerResident.endpoint } },
    { caller: { ...ownerResident, role: "tile" } },
    { caller: { ...ownerResident, endpoint: "app:evm_wallet:background:other" } },
    { agentMode: true },
  ]) await expect(presentOwnEffect("transaction", request, { ...ctx, ...changed })).rejects.toThrow();
  // Existing external private tools still require Kernel foreground attestation.
  await expect(presentEffect("transaction", request, ctx)).rejects.toThrow("foreground-tile attestation");
  expect(prepares).toBe(0);
  expect(getPrompts()).toHaveLength(0);
});
test("own two-leg review preserves request identity, explicit approval and saved-result replay", async () => {
  const calls: string[] = [];
  let submitted = false;
  const ownerContext = humanOwnerContext(async (method, args) => {
    calls.push(method);
    const payload = args[0] as Record<string, unknown>;
    expect(method === "evm_wallet_prepare_browser_v1" ? (payload.request as Record<string, unknown>).identity : payload.identity).toEqual({
      caller: { app_id: ownerResident.appId, installation_uid: ownerResident.installationUid, endpoint: ownerResident.endpoint },
      request_id: request.requestId,
    });
    if (method.endsWith("execute_v1")) submitted = true;
    return wire({
      caller: { app_id: ownerResident.appId, installation_uid: ownerResident.installationUid, endpoint: ownerResident.endpoint },
      ...(submitted ? { status: "submitted", transaction_hash: `0x${"aa".repeat(32)}` } : {}),
    });
  }, { caller: ownerResident });
  const ctx = humanOwnerContext(async () => { throw new Error("Unexpected resident backend call"); }, {
    caller: ownerTile,
    kernel: { callTool: async (call: { target: string; name: string; arguments: typeof request }) => {
      expect(call.target).toBe(ownerTile.endpoint);
      expect(call.name).toBe(OWNER_REVIEW_TOOLS.transaction);
      return presentOwnEffect("transaction", call.arguments, ownerContext);
    } } as unknown as MsgBusToolContext["kernel"],
  });
  const pending = handleHumanEffect("transaction", request, ctx);
  const prompt = await promptReady();
  expect(calls).toEqual(["evm_wallet_prepare_browser_v1"]);
  expect(prompt.context.audience).toBeUndefined();
  expect(prompt.prepared.request.requestId).toBe(request.requestId);
  await acceptPrompt(prompt);
  const result = await pending;
  expect(result.status).toBe("submitted");
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual(result);
  expect(calls).toEqual(["evm_wallet_prepare_browser_v1", "evm_wallet_execute_v1", "evm_wallet_prepare_browser_v1"]);
  expect(getPrompts()).toHaveLength(0);
});
test("decline durably rejects without executing", async () => {
  const calls: string[] = [];
  const ctx = context(async (method) => {
    calls.push(method);
    return wire(method.endsWith("reject_v1") ? { status: "rejected" } : {});
  });
  const pending = presentEffect("transaction", request, ctx);
  await declinePrompt(await promptReady());
  expect((await pending).status).toBe("rejected");
  expect(calls).toEqual(["evm_wallet_prepare_browser_v1", "evm_wallet_reject_v1"]);
});
test("concurrent nonce allocation requires approving the changed review", async () => {
  let executes = 0;
  const ctx = context(async (method, args) => {
    if (method.endsWith("execute_v1")) {
      executes++;
      expect((args[0] as Record<string, unknown>).review_revision).toBe(
        String(executes),
      );
      return executes === 1
        ? wire({
            review_revision: "2",
            review: { ...wire().ok.review, nonce: "1" },
            message: "Review changed",
          })
        : wire({
            review_revision: "2",
            status: "submitted",
            transaction_hash: `0x${"aa".repeat(32)}`,
          });
    }
    return wire();
  });
  const pending = presentEffect("transaction", request, ctx),
    prompt = await promptReady();
  await acceptPrompt(prompt);
  expect(executes).toBe(1);
  expect(prompt.phase).toBe("review");
  expect(prompt.prepared.operation.review?.nonce).toBe("1");
  await acceptPrompt(prompt);
  expect((await pending).status).toBe("submitted");
  expect(executes).toBe(2);
});
test("lost response checks saved status and browser observations without automatically executing again", async () => {
  const calls: string[] = [];
  const hash = `0x${"aa".repeat(32)}`;
  let executed = false;
  rpc.mockImplementation(async <T>(_chain: string | number | bigint, method: string): Promise<T> => {
    if (method === "eth_getTransactionByHash") return { hash } as T;
    if (method === "eth_getTransactionReceipt") return null as T;
    throw new Error(`Unexpected browser RPC ${method}`);
  });
  const ctx = context(async (method, args) => {
    calls.push(method);
    if (method === "evm_wallet_execute_v1") {
      executed = true;
      throw new Error("response lost");
    }
    if (method === "evm_wallet_observe_browser_v1") {
      expect(args).toEqual([{
        identity: { caller: { app_id: caller.appId, installation_uid: caller.installationUid, endpoint: caller.endpoint }, request_id: request.requestId },
        transaction_hash: hash,
        transaction_json: JSON.stringify({ hash }),
      }]);
      return wire({ status: "submitted", transaction_hash: hash });
    }
    return wire();
  }, {}, async (method) => {
    calls.push(method);
    if (method === "evm_wallet_superseding_v1") return { ok: null };
    return wire(executed ? { status: "submitted", transaction_hash: hash } : {});
  });
  const pending = presentEffect("transaction", request, ctx),
    prompt = await promptReady();
  await acceptPrompt(prompt);
  expect(prompt.phase).toBe("uncertain");
  await checkPrompt(prompt);
  expect((await pending).status).toBe("submitted");
  expect(calls).toEqual([
    "evm_wallet_operation_v1",
    "evm_wallet_prepare_browser_v1",
    "evm_wallet_execute_v1",
    "evm_wallet_operation_v1",
    "evm_wallet_superseding_v1",
    "evm_wallet_observe_browser_v1",
  ]);
  expect(rpc.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
    ["1", "eth_getTransactionByHash", [hash]],
    ["1", "eth_getTransactionReceipt", [hash]],
  ]);
});
test("cancellation removes review and prevents a late click signing", async () => {
  const controller = new AbortController();
  let executes = 0;
  const pending = presentEffect(
    "transaction",
    request,
    context(
      async (method) => {
        if (method.endsWith("execute_v1")) executes++;
        return wire();
      },
      { signal: controller.signal },
    ),
  );
  const caught = pending.catch((e) => e);
  const prompt = await promptReady();
  controller.abort(new Error("Caller cancelled"));
  await acceptPrompt(prompt);
  expect((await caught).message).toBe("Caller cancelled");
  expect(executes).toBe(0);
  expect(getPrompts()).toHaveLength(0);
});
test("changed recipient or explicit gas limits fail review matching", async () => {
  await expect(
    prepareEffect(
      "transaction",
      request,
      context(async () =>
        wire({
          intent: effectIntent("transaction", {
            ...request,
            to: `0x${"33".repeat(20)}`,
          }),
        }),
      ),
    ),
  ).rejects.toThrow("does not match");
  await expect(
    prepareEffect(
      "transaction",
      { ...request, gasLimit: "21000" },
      context(async () =>
        wire({
          intent: effectIntent("transaction", {
            ...request,
            gasLimit: "90000",
          }),
        }),
      ),
    ),
  ).rejects.toThrow("does not match");
});
test("block quantities remain exact and missing balances stay unavailable", () => {
  const r = parseBalance({
    ok: {
      account_id: "main",
      chain_id: "1",
      address: `0x${"22".repeat(20)}`,
      native_balance: "90071992547409931234",
      tokens: [
        {
          address: request.to,
          balance: null,
          decimals: null,
          symbol: null,
          error: "provider disagreement",
        },
      ],
      block_number: "0x20000000000001",
      observed_at: "123456789",
      completeness: "requested_only",
    },
  });
  expect(r.blockNumber).toBe("9007199254740993");
  expect(r.nativeBalance).toBe("90071992547409931234");
  expect(r.tokens[0]!.balance).toBeNull();
  expect(() => atomicAmount("0.0000001", 6)).toThrow();
  expect(atomicAmount("1.000001", 6)).toBe("1000001");
});
test("missing receipt remains pending and finality is not invented", () => {
  const operation = parseOperation(wire({ receipt_json: "null" }));
  expect(operationReceipt(operation)).toBeNull();
  const raw = {
    blockNumber: "0x1",
    blockHash: `0x${"11".repeat(32)}`,
    status: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x2",
    logs: [],
  };
  expect(
    operationReceipt({
      ...operation,
      receiptJson: JSON.stringify(raw),
      finality: "included",
    }),
  ).toMatchObject({
    gasUsed: "21000",
    effectiveGasPriceWei: "2",
    finality: "included",
  });
});
test("live request account checking needs no browser storage", () => {
  const intent = { request, expectedAddress: `0x${"22".repeat(20)}` };
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Opaque origin", "SecurityError");
    },
  });
  try {
    expect(() =>
      assertLocalAccount(intent, intent.expectedAddress),
    ).not.toThrow();
    expect(() => assertLocalAccount(intent, `0x${"33".repeat(20)}`)).toThrow(
      "account changed",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a stale network token never falls back to a native transfer", async () => {
  const { localTransferRequest } = await import("../src/local_intent.ts");
  const token = {
    chainId: "1",
    address: `0x${"33".repeat(20)}`,
    symbol: "USDC",
    decimals: 6,
  };
  expect(() =>
    localTransferRequest({
      requestId: request.requestId,
      chainId: "42161",
      token: token.address,
      assets: [token],
      to: request.to,
      amount: "2",
    }),
  ).toThrow("not on this network");
  const transfer = localTransferRequest({
    requestId: request.requestId,
    chainId: "1",
    token: token.address,
    assets: [token],
    to: request.to,
    amount: "2.000001",
  });
  expect(transfer.to).toBe(token.address);
  expect(transfer.valueWei).toBe("0");
  expect(transfer.data).toEndWith(2000001n.toString(16).padStart(64, "0"));
});
test("replacement review requires the exact resolved transaction and preserves backend warnings", async () => {
  const replacement = {
    requestId: request.requestId,
    accountId: "main" as const,
    chainId: "1",
    operationId: "7",
    cancel: true,
    maxFeePerGasWei: "2",
    maxPriorityFeePerGasWei: "1",
  };
  const replacementIntent = effectIntent("replacement", replacement);
  await expect(
    prepareEffect(
      "replacement",
      replacement,
      context(async () =>
        wire({ intent: replacementIntent, prepared_transaction: null }),
      ),
    ),
  ).rejects.toThrow("prepared transaction fields");
  const message = "Replacement is a same-nonce zero-value self transfer.";
  const operation = await prepareEffect(
    "replacement",
    replacement,
    context(async () =>
      wire({
        intent: replacementIntent,
        message,
        prepared_transaction: {
          ...wire().ok.prepared_transaction,
          to: wire().ok.address,
          value: "0",
        },
      }),
    ),
  );
  expect(operation.operation.preparedTransaction?.to).toBe(wire().ok.address);
  expect(operation.operation.preparedTransaction?.value).toBe("0");
  expect(operation.operation.message).toBe(message);
});

test("refreshing token observations uses the revised review without signing or changing the request", async () => {
  let finishRead!: () => void;
  const waitForRead = new Promise<void>((resolve) => { finishRead = resolve; });
  let executions = 0;
  const ctx = context(async (method, args) => {
    if (method === "evm_wallet_prepare_browser_v1") return wire();
    if (method === "evm_wallet_review_evidence_v1") {
      expect(args).toEqual([{
        identity: { caller: { app_id: caller.appId, installation_uid: caller.installationUid, endpoint: caller.endpoint }, request_id: request.requestId },
        review_revision: "1",
        refresh: false,
      }]);
      await waitForRead;
      return { operation: wire({ review_revision: "2" }).ok, token_evidence: null };
    }
    if (method === "evm_wallet_execute_v1") {
      executions++;
      expect((args[0] as { review_revision: string }).review_revision).toBe("2");
      return wire({ status: "submitted", review_revision: "2", transaction_hash: `0x${"33".repeat(32)}` });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const completion = presentEffect("transaction", request, ctx);
  const prompt = await promptReady();
  const refreshing = refreshPromptEvidence(prompt);
  await acceptPrompt(prompt);
  expect(executions).toBe(0);
  expect(prompt.phase).toBe("checking");
  finishRead();
  await refreshing;
  expect(prompt.prepared.operation.reviewRevision).toBe("2");
  expect(prompt.prepared.request).toEqual(request);
  await acceptPrompt(prompt);
  expect(executions).toBe(1);
  expect((await completion).status).toBe("submitted");
});

test("failed token refresh keeps the saved review available and never executes an effect", async () => {
  let executions = 0;
  const ctx = context(async (method) => {
    if (method === "evm_wallet_prepare_browser_v1") return wire();
    if (method === "evm_wallet_review_evidence_v1") throw new Error("Transport reply lost");
    if (method === "evm_wallet_reject_v1") return wire({ status: "rejected" });
    if (method === "evm_wallet_execute_v1") executions++;
    throw new Error(`Unexpected method ${method}`);
  });
  const completion = presentEffect("transaction", request, ctx);
  const prompt = await promptReady();
  await refreshPromptEvidence(prompt);
  expect(prompt.phase).toBe("review");
  expect(prompt.error).toContain("could not be refreshed");
  expect(prompt.prepared.operation.reviewRevision).toBe("1");
  expect(executions).toBe(0);
  await declinePrompt(prompt);
  expect((await completion).status).toBe("rejected");
});
