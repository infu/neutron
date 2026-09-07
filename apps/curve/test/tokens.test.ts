import { expect, test } from "bun:test";
import { getAddress } from "viem";
import { catalogTokens } from "../src/pools.ts";
import { describeToken, searchTokens } from "../src/tokens.ts";
import { tokenKey, type Pool, type Token } from "../src/contracts.ts";

const usdc = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const usdt = getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7");
const fakeUsdc = getAddress("0x0000000000000000000000000000000000000011");
const fakeUsdt = getAddress("0x0000000000000000000000000000000000000012");
const coin = (address: Token["address"], symbol: string, chainId: Token["chainId"] = "1"): Token => ({ chainId, address, symbol, decimals: 6 });
const pool = (address: string, coins: Token[], tvlUsd: number): Pool => ({ chainId: "1", address: getAddress(address), family: "stable-ng", id: address, name: "Pool", lpToken: getAddress(address), coins, tvlUsd, apiObservedAtMs: 1 });

test("symbols, copied metadata and enormous pool TVL cannot confer listing or priority", () => {
  const spoof = { ...coin(fakeUsdc, "USDC"), listed: true, name: "Circle · native USDC", sourceUrl: "https://example.org" };
  const pools = [pool(fakeUsdt, [spoof, coin(fakeUsdt, "USDT")], 1e15), pool(fakeUsdc, [coin(usdc, "Fake API label"), coin(usdt, "USDT")], 1)];
  const tokens = searchTokens(catalogTokens("1", pools), "");
  const firstUnlisted = tokens.findIndex((token) => !token.listed);
  expect(firstUnlisted).toBeGreaterThan(0);
  expect(tokens.slice(firstUnlisted).every((token) => !token.listed)).toBe(true);
  expect(tokens.findIndex((token) => token.address === usdc)).toBeLessThan(firstUnlisted);
  expect(searchTokens(catalogTokens("1", pools), "USDC").map(({ address, listed }) => ({ address, listed })))
    .toEqual([{ address: usdc, listed: true }, { address: fakeUsdc, listed: false }]);
  expect(searchTokens(catalogTokens("1", pools), "USDT").map(({ address, listed }) => ({ address, listed })))
    .toEqual([{ address: usdt, listed: true }, { address: fakeUsdt, listed: false }]);
  expect(describeToken(spoof)).toMatchObject({ listed: false, name: null, sourceUrl: null });
});

test("listing matches the exact chain and contract, independent of symbol and casing", () => {
  expect(describeToken(coin(usdc.toLowerCase() as Token["address"], "Something else"))).toMatchObject({ listed: true, symbol: "USDC" });
  expect(describeToken(coin(usdc, "USDC", "42161")).listed).toBe(false);
  expect(describeToken(coin(fakeUsdc, "ETH")).listed).toBe(false);
  expect(describeToken(coin(null, "ETH")).listed).toBe(true);
  expect(describeToken(coin("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb49", "USDC")).listed).toBe(false);
});

test("Arbitrum native USDC, bridged USDC.e and USDT0 have distinct address-backed names", () => {
  const tokens = searchTokens(catalogTokens("42161"), "USDC");
  expect(tokens.map(({ symbol, address, decimals }) => ({ symbol, address, decimals }))).toEqual([
    { symbol: "USDC", address: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), decimals: 6 },
    { symbol: "USDC.e", address: getAddress("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8"), decimals: 6 },
  ]);
  expect(tokens.every((token) => token.listed)).toBe(true);
  expect(tokens[0]!.name).toBe("Circle · native USDC");
  expect(tokens[1]!.name).toBe("Bridged USDC from Ethereum");
  expect(searchTokens(catalogTokens("42161"), "USDT")[0]).toMatchObject({ symbol: "USDT0", listed: true, address: getAddress("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9") });
});

test("full address searches never match a different contract advertising that address in its symbol", () => {
  const tokens = [...catalogTokens("1"), coin(fakeUsdc, usdc)];
  expect(searchTokens(tokens, `  ${usdc.toUpperCase()}  `).map(tokenKey)).toEqual([`1:${usdc.toLowerCase()}`]);
  expect(searchTokens([coin(fakeUsdc, usdc)], usdc)).toEqual([]);
  expect(searchTokens(tokens, fakeUsdc)[0]).toMatchObject({ address: fakeUsdc, listed: false });
});

test("search includes listed names and duplicate symbols retain distinct, deterministic addresses", () => {
  const tokens = [...catalogTokens("1"), coin(fakeUsdt, "USDC"), coin(fakeUsdc, "USDC")];
  expect(searchTokens(tokens, "circle").map((token) => token.address)).toEqual([usdc]);
  expect(searchTokens(tokens, "USDC").map((token) => token.address)).toEqual([usdc, fakeUsdc, fakeUsdt]);
  expect(searchTokens([...tokens].reverse(), "USDC")).toEqual(searchTokens(tokens, "USDC"));
  const repeated = pool(fakeUsdc, [coin(fakeUsdc, "USDC"), coin(fakeUsdc, "USDC")], 100);
  expect(catalogTokens("1", [repeated]).filter((token) => token.address === fakeUsdc)).toHaveLength(1);
});
