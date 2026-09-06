import { expect, test } from "bun:test";
import { curatedEvmTokens, evmAssetKey, mergeEvmAssets } from "../src/evm_assets.ts";
import { evmTokenIcon, evmTokenInitials } from "../src/evm_token_icons.ts";

test("catalog separates native ETH, Ethereum ckERC20 counterparts, and Arbitrum assets", () => {
  const ethereum = curatedEvmTokens("1"), arbitrum = curatedEvmTokens("42161");
  expect(ethereum.find((token) => token.symbol === "ETH")?.address).toBeNull();
  expect(ethereum.map((token) => token.symbol)).toEqual(["ETH", "USDC", "WETH", "USDT", "EURC", "WBTC", "wstETH", "LINK", "UNI", "SHIB", "PEPE", "XAUT", "OCT"]);
  expect(ethereum.find((token) => token.symbol === "WBTC")?.decimals).toBe(8);
  expect(ethereum.find((token) => token.symbol === "USDT")?.address).not.toBe(arbitrum.find((token) => token.symbol === "USDT0")?.address);
  for (const tokens of [ethereum, arbitrum]) {
    expect(new Set(tokens.map((token) => token.address)).size).toBe(tokens.length);
    expect(tokens.filter((token) => token.address !== null).every((token) => /^0x[0-9a-f]{40}$/.test(token.address!))).toBe(true);
    expect(tokens.some((token) => ["BTC", "DOGE", "SOL"].includes(token.symbol))).toBe(false);
  }
  expect(curatedEvmTokens("11155111")).toEqual([]);
  expect(evmTokenIcon("1", null)).toStartWith("data:image/svg+xml;base64,");
  expect(evmTokenIcon("1", ethereum.find((token) => token.symbol === "USDC")!.address)).toStartWith("data:image/svg+xml;base64,");
  expect(evmTokenIcon("42161", ethereum.find((token) => token.symbol === "USDC")!.address)).toBeNull();
  expect(evmTokenIcon("1", "0x1111111111111111111111111111111111111111")).toBeNull();
  expect(evmTokenIcon("1", ethereum.find((token) => token.symbol === "PEPE")!.address)).toBeNull();
  expect(evmTokenInitials("pepe")).toBe("PE");
});

test("catalog display overlay preserves installed custom metadata without writing or duplicating it", () => {
  const saved = [
    { chainId: "1", address: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "My USDC", decimals: 6 },
    { chainId: "1", address: "0x1111111111111111111111111111111111111111", symbol: "CUSTOM", decimals: 9 },
  ];
  const before = structuredClone(saved), merged = mergeEvmAssets(saved);
  expect(saved).toEqual(before);
  expect(merged.filter((asset) => evmAssetKey(asset) === evmAssetKey(saved[0]!))).toEqual([saved[0]!]);
  expect(merged).toContainEqual(saved[1]!);
  expect(merged.some((asset) => asset.symbol === "USDT")).toBe(true);
  expect(merged.some((asset) => asset.symbol === "EURC")).toBe(true);
});

test("explicit hidden-asset preferences survive the display overlay", () => {
  const usdt = mergeEvmAssets([]).find((asset) => asset.chainId === "1" && asset.symbol === "USDT")!;
  const hidden = new Set([evmAssetKey(usdt)]);
  expect(mergeEvmAssets([usdt], hidden).some((asset) => evmAssetKey(asset) === evmAssetKey(usdt))).toBe(false);
});
