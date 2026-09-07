import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserReadRpc } from "../src/browser_reads.ts";
import type { BrowserEvmChainId } from "../src/browser_rpc.ts";
import { amount, type Asset } from "../src/data.ts";
import { clearTokenMetadataCache, resolveTokenMetadata } from "../src/decoders/metadata.ts";

const tokenA = `0x${"ab".repeat(20)}`;
const tokenB = `0x${"cd".repeat(20)}`;
const owner = `0x${"12".repeat(20)}`;
const decimalsCall = "0x313ce567", symbolCall = "0x95d89b41";
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const uint = (value: bigint) => `0x${word(value)}`;
const utf8 = (value: string) => [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
// Independent ABI fixture encoding: offset, byte length, payload and word padding.
const string = (value: string) => {
  const bytes = utf8(value);
  return `0x${word(32n)}${word(BigInt(bytes.length / 2))}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0")}`;
};
const legacy = (value: string) => `0x${utf8(value).padEnd(64, "0")}`;
type Call = { chainId: string; method: string; params: readonly unknown[] };
type ContractReply = (chainId: string, address: string, data: string) => string | Promise<string>;
function fixture(reply: ContractReply = (_chain, _address, data) => data === decimalsCall ? uint(6n) : string("USDC")) {
  const calls: Call[] = [];
  const rpc: BrowserReadRpc = {
    async request<T>(chainId: BrowserEvmChainId, method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ chainId: String(chainId), method, params });
      if (method === "eth_blockNumber") return "0x20000000000001" as T;
      if (method === "eth_call") {
        const input = params[0] as { to: string; data: string };
        return await reply(String(chainId), input.to.toLowerCase(), input.data) as T;
      }
      throw new Error(`Metadata attempted non-read RPC ${method}`);
    },
  };
  return { rpc, calls };
}
const callsToContracts = (calls: Call[]) => calls.filter(call => call.method === "eth_call");
afterEach(clearTokenMetadataCache);

test("resolves exact on-chain scales and labels at one exact block without guessing decimals", async () => {
  const { rpc, calls } = fixture((_chain, address, data) => data === decimalsCall
    ? uint(address === tokenA ? 6n : 8n) : string(address === tokenA ? "USDC" : "WBTC"));
  const assets = await resolveTokenMetadata("1", [tokenA, tokenB], [], { rpc, from: owner });
  expect(assets.map(asset => ({ ...asset, address: asset.address.toLowerCase() }))).toEqual([
    { chainId: "1", address: tokenA, decimals: 6, symbol: "USDC" },
    { chainId: "1", address: tokenB, decimals: 8, symbol: "WBTC" },
  ]);
  expect(amount("9007199254740993123456789", assets[0]!.decimals)).toBe("9007199254740993123.456789");
  expect(callsToContracts(calls)).toHaveLength(4);
  for (const call of callsToContracts(calls)) {
    expect(call.params[1]).toBe("0x20000000000001");
    expect((call.params[0] as { from: string }).from).toBe(owner);
  }
  expect(new Set(calls.map(call => call.method))).toEqual(new Set(["eth_blockNumber", "eth_call"]));
});

test("known custom metadata wins, address case deduplicates, and chains remain distinct", async () => {
  const { rpc, calls } = fixture();
  const custom: Asset = { chainId: "1", address: tokenA.toUpperCase().replace("0X", "0x"), symbol: "My token", decimals: 3 };
  const original = { ...custom };
  const other: Asset = { chainId: "42161", address: tokenA, symbol: "Arbitrum token", decimals: 8 };
  const resolved = await resolveTokenMetadata("1", [tokenA, custom.address, tokenB, tokenB], [custom, other], { rpc });
  expect(resolved).toHaveLength(3);
  expect(resolved.slice(0, 2)).toEqual([custom, other]);
  expect(custom).toEqual(original);
  expect(callsToContracts(calls)).toHaveLength(2);
  expect((callsToContracts(calls)[0]!.params[0] as { to: string }).to.toLowerCase()).toBe(tokenB);

  const otherChain = await resolveTokenMetadata("42161", [tokenB], [], { rpc });
  expect(otherChain[0]!.chainId).toBe("42161");
  expect(callsToContracts(calls)).toHaveLength(4);
});

test("native sentinels and invalid addresses do not become metadata contract calls", async () => {
  const { rpc, calls } = fixture();
  expect(await resolveTokenMetadata("1", ["0x", "not-an-address", `0x${"00".repeat(20)}`, `0x${"Ee".repeat(20)}`], [], { rpc })).toEqual([]);
  expect(calls).toEqual([]);
  expect(await resolveTokenMetadata("wrong-chain", [tokenA], [], { rpc })).toEqual([]);
  expect(calls).toEqual([]);
});

test("success is cached per chain/address without exposing mutable cache entries", async () => {
  let decimals = 6n;
  const { rpc, calls } = fixture((_chain, _address, data) => data === decimalsCall ? uint(decimals) : string("TOKEN"));
  const first = await resolveTokenMetadata("1", [tokenA], [], { rpc });
  first[0]!.decimals = 18;
  first[0]!.symbol = "Changed by caller";
  decimals = 8n;
  expect(await resolveTokenMetadata("1", [tokenA.toUpperCase().replace("0X", "0x")], [], { rpc }))
    .toMatchObject([{ decimals: 6, symbol: "TOKEN" }]);
  expect(callsToContracts(calls)).toHaveLength(2);
  clearTokenMetadataCache();
  expect(await resolveTokenMetadata("1", [tokenA], [], { rpc })).toMatchObject([{ decimals: 8, symbol: "TOKEN" }]);
  expect(callsToContracts(calls)).toHaveLength(4);
});

test("failed metadata is uncached and does not discard other tokens or existing assets", async () => {
  let fail = true;
  const { rpc, calls } = fixture((_chain, address, data) => {
    if (address === tokenA && fail) throw new Error("RPC temporarily unavailable");
    return data === decimalsCall ? uint(6n) : string("TOKEN");
  });
  const known: Asset = { chainId: "42161", address: tokenA, symbol: "CUSTOM", decimals: 4 };
  expect(await resolveTokenMetadata("1", [tokenA, tokenB], [known], { rpc })).toMatchObject([known, { address: expect.any(String), decimals: 6 }]);
  fail = false;
  expect(await resolveTokenMetadata("1", [tokenA, tokenB], [known], { rpc })).toHaveLength(3);
  expect(callsToContracts(calls)).toHaveLength(6);
});

test("current callers share in-flight reads and one cancelled view does not abort another", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { rpc, calls } = fixture(async (_chain, _address, data) => {
    await gate;
    return data === decimalsCall ? uint(6n) : string("USDC");
  });
  const controller = new AbortController();
  const cancelled = resolveTokenMetadata("1", [tokenA], [], { rpc, signal: controller.signal });
  const surviving = resolveTokenMetadata("1", [tokenA], [], { rpc });
  controller.abort(new Error("View changed"));
  await expect(cancelled).rejects.toThrow("View changed");
  release();
  expect(await surviving).toMatchObject([{ decimals: 6, symbol: "USDC" }]);
  expect(callsToContracts(calls)).toHaveLength(2);
  expect(await resolveTokenMetadata("1", [tokenA], [], { rpc })).toHaveLength(1);
  expect(callsToContracts(calls)).toHaveLength(2);
});

test("an already cancelled read starts no RPC work", async () => {
  const { rpc, calls } = fixture();
  const controller = new AbortController(); controller.abort();
  await expect(resolveTokenMetadata("1", [tokenA], [], { rpc, signal: controller.signal })).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("manual refresh invalidates pending cache writes from the previous observation", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const old = fixture(async (_chain, _address, data) => { await gate; return data === decimalsCall ? uint(6n) : string("OLD"); });
  const previous = resolveTokenMetadata("1", [tokenA], [], { rpc: old.rpc });
  clearTokenMetadataCache();
  const fresh = fixture((_chain, _address, data) => data === decimalsCall ? uint(8n) : string("NEW"));
  expect(await resolveTokenMetadata("1", [tokenA], [], { rpc: fresh.rpc })).toMatchObject([{ decimals: 8, symbol: "NEW" }]);
  release();
  expect(await previous).toMatchObject([{ decimals: 6, symbol: "OLD" }]);
  expect(await resolveTokenMetadata("1", [tokenA], [], { rpc: fresh.rpc })).toMatchObject([{ decimals: 8, symbol: "NEW" }]);
  expect(callsToContracts(fresh.calls)).toHaveLength(2);
});

test("legacy bytes32 symbols decode from the same response, including UTF-8", async () => {
  const { rpc, calls } = fixture((_chain, _address, data) => data === decimalsCall ? uint(18n) : legacy("ΞTOKEN"));
  expect(await resolveTokenMetadata("1", [tokenA], [], { rpc })).toMatchObject([{ symbol: "ΞTOKEN", decimals: 18 }]);
  expect(callsToContracts(calls).map(call => (call.params[0] as { data: string }).data)).toEqual([decimalsCall, symbolCall]);
});

test("uint8 decimals accepts its full domain without number conversion of amounts", async () => {
  const { rpc } = fixture((_chain, address, data) => data === decimalsCall ? uint(address === tokenA ? 0n : 255n) : string("EXACT"));
  const assets = await resolveTokenMetadata("1", [tokenA, tokenB], [], { rpc });
  expect(assets.map(asset => asset.decimals)).toEqual([0, 255]);
  expect(amount("9007199254740993123456789", assets[0]!.decimals)).toBe("9007199254740993123456789");
  expect(amount("1", assets[1]!.decimals)).toBe(`0.${"0".repeat(254)}1`);
});

test.each(["0x", "0x06", uint(256n), uint((1n << 256n) - 1n), `${uint(6n)}00`])(
  "invalid decimals ABI %s remains unknown instead of falling back to 18", async invalid => {
    const { rpc } = fixture((_chain, _address, data) => data === decimalsCall ? invalid : string("TOKEN"));
    expect(await resolveTokenMetadata("1", [tokenA], [], { rpc })).toEqual([]);
  },
);

test.each(["0x", "0x01", `0x${"ff".repeat(32)}`, `${string("TOKEN")}00`, `0x${word(64n)}${word(1n)}${word(0n)}`])(
  "invalid symbol ABI %s does not produce an invented label", async invalid => {
    const { rpc } = fixture((_chain, _address, data) => data === decimalsCall ? uint(6n) : invalid);
    expect(await resolveTokenMetadata("1", [tokenA], [], { rpc })).toEqual([]);
  },
);

test("symbol data remains text with no arbitrary size cap or HTML interpretation", async () => {
  const symbol = `<img src=x onerror=alert(1)>${"long token symbol ".repeat(256)}`;
  const { rpc } = fixture((_chain, _address, data) => data === decimalsCall ? uint(6n) : string(symbol));
  const assets = await resolveTokenMetadata("1", [tokenA], [], { rpc });
  expect(assets[0]!.symbol).toBe(symbol);
  const rendered = renderToStaticMarkup(createElement("span", null, assets[0]!.symbol));
  expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(rendered).not.toContain("<img");
});
