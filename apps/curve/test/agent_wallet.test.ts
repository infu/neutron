import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Address } from "viem";
import type { JsonValue, MsgBusCallOptions, MsgBusToolCall, MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";
import { createServiceWallet } from "../src/agent_wallet.ts";
import { CHAINS, ROUTER_QUOTE, walletReader, type Pool } from "../src/contracts.ts";
import { parseInput, quoteSwap, type SwapInput } from "../src/plans.ts";

const address = getAddress("0x1111111111111111111111111111111111111111");
const account = { accountId: "main" as const, address, publicKey: `0x02${"dd".repeat(32)}`, keyFingerprint: `0x${"ee".repeat(32)}`, namespaceVersion: "1" };
function context(call: (call: MsgBusToolCall, options?: number | MsgBusCallOptions) => Promise<JsonValue>, signal?: AbortSignal): MsgBusToolContext {
  const kernel = { async callTool(input: MsgBusToolCall, options?: number | MsgBusCallOptions) {
    expect(this).toBe(kernel);
    return call(input, options);
  } };
  return { kernel: kernel as MsgBusToolContext["kernel"], agentMode: true, ...(signal ? { signal } : {}), reportProgress() {} };
}

test("a serial Agent swap compares every candidate and verifies an eight-coin pool under Kernel child capacity", async () => {
  const coins = Array.from({ length: 8 }, (_, index) => ({ chainId: "1" as const, address: getAddress(`0x${(index + 1).toString(16).padStart(40, "0")}`), decimals: 6, symbol: `USD${index}` }));
  const pools: Pool[] = Array.from({ length: 24 }, (_, index) => ({ chainId: "1", address: getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`), family: "stable-ng", id: String(index), name: `Pool ${index}`, coins, lpToken: getAddress(`0x${(index + 100).toString(16).padStart(40, "0")}`), tvlUsd: 1000, apiObservedAtMs: 0 }));
  const abi = parseAbi([ROUTER_QUOTE, "function get_coins(address pool) view returns (address[])", "function is_meta(address pool) view returns (bool)", "function coins(uint256 index) view returns (address)", "function totalSupply() view returns (uint256)", "function balances(uint256 index) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function allowance(address owner,address spender) view returns (uint256)"]);
  const input = parseInput({ kind: "swap", chainId: "1", tokenIn: coins[0]!.address, tokenOut: coins[1]!.address, amountIn: "1000000" }) as SwapInput;
  const options = { catalog: { pools, complete: true, errors: [], fetchedAtMs: 0 }, now: 1000 };
  const fixture = () => {
    let active = 0, maximum = 0;
    const quoted: Address[] = [];
    const invocation = context(async (call) => {
      if (call.name !== EVM_WALLET_TOOLS.callContract) throw new Error("Unexpected Wallet call");
      if (active === 4) throw new Error("Too many parallel agent calls");
      active++; maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const data = call.arguments!.data as `0x${string}`, decoded = decodeFunctionData({ abi, data });
        let output: unknown;
        if (decoded.functionName === "get_dy") {
          const [route, , amount] = decoded.args, pool = pools.findIndex((pool) => pool.address === route[1]);
          if (amount === 1000000n) quoted.push(route[1]);
          if (pool === 0) throw new Error("Pool has no executable liquidity");
          output = amount + BigInt(pool);
        } else if (decoded.functionName === "get_coins") output = coins.map((coin) => coin.address);
        else if (decoded.functionName === "is_meta") output = false;
        else if (decoded.functionName === "coins") output = coins[Number(decoded.args[0])]!.address;
        else if (decoded.functionName === "decimals") output = 6;
        else if (decoded.functionName === "symbol") output = "USD";
        else output = 1000000000000000000n;
        return { accountId: "main", chainId: "1", to: call.arguments!.to!, data, address, result: encodeFunctionResult({ abi, functionName: decoded.functionName, result: output as never }), blockNumber: "200", observedAtNs: "1000" };
      } finally { active--; }
    });
    return { invocation, quoted, maximum: () => maximum };
  };
  const prior = fixture();
  await expect(quoteSwap(walletReader(createEvmWalletClient(prior.invocation.kernel)), account, input, options)).rejects.toThrow("No executable Curve quote is available");
  const fixed = fixture();
  const plan = await quoteSwap(walletReader(createServiceWallet(fixed.invocation)), account, input, options);
  expect(fixed.maximum()).toBe(4);
  expect(fixed.quoted).toEqual(pools.map((pool) => pool.address));
  expect(plan.pool?.address).toBe(pools.at(-1)!.address);
  expect(plan.pool?.coins).toHaveLength(8);
  expect(plan.preview.outputs[0]!.amount).toBe("1000023");
  expect(plan.preview.warnings).toEqual(["Pool 0: Pool has no executable liquidity"]);
  expect(plan.steps).toHaveLength(1);
  expect(plan.steps[0]!.transaction.to).toBe(CHAINS["1"].router);
});
