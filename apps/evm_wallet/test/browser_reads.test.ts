import { expect, test } from "bun:test";
import { browserBalances, browserTransaction, type BrowserReadRpc } from "../src/browser_reads.ts";
import type { BrowserEvmChainId } from "../src/browser_rpc.ts";

const owner = `0x${"12".repeat(20)}`;
const aWeth = "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8";
const other = `0x${"34".repeat(20)}`;
const transactionHash = `0x${"56".repeat(32)}`;
const blockHash = `0x${"78".repeat(32)}`;
const uint = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const symbol = (text: string) => {
  const bytes = Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${uint(32n)}${uint(BigInt(bytes.length / 2)).slice(2)}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0")}`;
};
type Call = { chainId: string; method: string; params: readonly unknown[] };
function fixture(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const rpc: BrowserReadRpc = {
    async request<T>(chainId: BrowserEvmChainId, method: string, params: readonly unknown[] = []): Promise<T> {
      const call = { chainId: String(chainId), method, params };
      calls.push(call);
      return await reply(call) as T;
    },
  };
  return { rpc, calls };
}
function balanceFixture(reply: (token: string, data: string) => unknown) {
  return fixture(({ method, params }) => {
    if (method === "eth_blockNumber") return "0x20000000000001";
    if (method === "eth_getBalance") return "0x100";
    if (method === "eth_call") {
      const call = params[0] as { to: string; data: string };
      return reply(call.to, call.data);
    }
    throw new Error(`Unexpected balance RPC ${method}`);
  });
}

test("requested untracked aWETH keeps its exact balance and obtains decimals/symbol at the same block", async () => {
  const amount = 200000004297146n;
  const { rpc, calls } = balanceFixture((_token, data) => data === "0x313ce567" ? uint(18n)
    : data === "0x95d89b41" ? symbol("aEthWETH") : uint(amount));
  const result = await browserBalances({ accountId: "main", chainId: "1", tokens: [aWeth] }, owner, [], rpc);
  expect(result.tokens).toEqual([{ address: aWeth, balanceAtoms: amount.toString(), decimals: "18", symbol: "aEthWETH", error: null }]);
  expect(result.blockNumber).toBe("9007199254740993");
  expect(result.completeness).toBe("requested_only");
  expect(calls.filter(call => call.method === "eth_call")).toHaveLength(3);
  for (const call of calls.filter(call => call.method !== "eth_blockNumber")) {
    expect(call.params[1]).toBe("0x20000000000001");
    expect(call.chainId).toBe("1");
  }
});

test("optional metadata errors preserve successful balances and identify unavailable fields", async () => {
  const { rpc } = balanceFixture((token, data) => {
    if (data === "0x313ce567") return token === aWeth ? uint(18n) : uint(256n);
    if (data === "0x95d89b41") {
      if (token === aWeth) throw new Error("execution reverted");
      return symbol("OTHER");
    }
    return uint(123n);
  });
  const result = await browserBalances({ accountId: "main", chainId: "1", tokens: [aWeth, other] }, owner, [], rpc);
  expect(result.tokens[0]).toEqual({ address: aWeth, balanceAtoms: "123", decimals: "18", symbol: null, error: "symbol: execution reverted" });
  expect(result.tokens[1]).toEqual({ address: other, balanceAtoms: "123", decimals: null, symbol: "OTHER", error: "decimals: Invalid ERC20 decimals return value" });
});

test("balance failures preserve metadata and do not hide another requested token", async () => {
  const { rpc } = balanceFixture((token, data) => {
    if (data === "0x313ce567") return uint(6n);
    if (data === "0x95d89b41") return symbol("TOKEN");
    return token === aWeth ? "0x" : uint(7n);
  });
  const result = await browserBalances({ accountId: "main", chainId: "1", tokens: [aWeth, other] }, owner, [], rpc);
  expect(result.tokens[0]).toEqual({ address: aWeth, balanceAtoms: null, decimals: "6", symbol: "TOKEN", error: "balanceOf: ERC20 balanceOf returned an invalid uint256 word" });
  expect(result.tokens[1]).toEqual({ address: other, balanceAtoms: "7", decimals: "6", symbol: "TOKEN", error: null });
});

test("known asset metadata avoids redundant reads and legacy bytes32 symbols remain supported", async () => {
  const { rpc, calls } = balanceFixture((_token, data) => data === "0x313ce567" ? uint(8n)
    : data === "0x95d89b41" ? `0x${"4f4c44".padEnd(64, "0")}` : uint(7n));
  const known = [{ chainId: "1", address: aWeth, symbol: "My aWETH", decimals: 18 }];
  const result = await browserBalances({ accountId: "main", chainId: "1", tokens: [aWeth, other] }, owner, known, rpc);
  expect(result.tokens[0]).toMatchObject({ symbol: "My aWETH", decimals: "18", error: null });
  expect(result.tokens[1]).toMatchObject({ symbol: "OLD", decimals: "8", error: null });
  expect(calls.filter(call => call.method === "eth_call" && (call.params[0] as { to: string }).to === aWeth)).toHaveLength(1);
  expect(known).toEqual([{ chainId: "1", address: aWeth, symbol: "My aWETH", decimals: 18 }]);
});

function transactionFixture(gas = "0x6c000") {
  return fixture(({ method, params }) => {
    if (method === "eth_getTransactionByHash") return { hash: transactionHash, chainId: "0x1", from: owner, to: aWeth,
      input: "0xaabb", value: "0x0", nonce: "0x2", gas, blockNumber: "0x64", blockHash };
    if (method === "eth_getTransactionReceipt") return { transactionHash, blockNumber: "0x64", blockHash,
      status: "0x0", gasUsed: "0x6bbac", effectiveGasPrice: "0x100", logs: [] };
    if (method === "eth_getBlockByNumber") return params[0] === "0x64" ? { number: "0x64", hash: blockHash } : { number: "0x63" };
    throw new Error(`Unexpected transaction RPC ${method}`);
  });
}

test("gas diagnostics expose submitted gas independently of reverted receipt gasUsed only when requested", async () => {
  const { rpc, calls } = transactionFixture();
  const result = await browserTransaction({ chainId: "1", transactionHash, includeGasLimit: true }, null, rpc);
  expect(result.transaction?.gasLimit).toBe("442368");
  expect(result.receipt).toMatchObject({ status: "reverted", gasUsed: "441260", finality: "included" });
  expect(result.transaction?.gasLimit).not.toBe(result.receipt?.gasUsed);
  expect(calls.every(call => ["eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber"].includes(call.method))).toBe(true);
  for (const includeGasLimit of [undefined, false]) {
    const old = await browserTransaction({ chainId: "1", transactionHash, ...(includeGasLimit === undefined ? {} : { includeGasLimit }) }, null, rpc);
    expect(Object.keys(old.transaction!).sort()).toEqual(["from", "to", "data", "valueWei", "nonce", "blockNumber", "blockHash"].sort());
    expect(old.receipt).toMatchObject({ status: "reverted", gasUsed: "441260" });
  }
});

test("invalid submitted gas cannot become valid diagnostic evidence", async () => {
  for (const gas of ["0x0", "0x", `0x1${"0".repeat(64)}`]) {
    const { rpc } = transactionFixture(gas);
    await expect(browserTransaction({ chainId: "1", transactionHash, includeGasLimit: true }, null, rpc)).rejects.toThrow();
  }
});
