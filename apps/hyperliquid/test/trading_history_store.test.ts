import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { IndexedTradingStore, MemoryTradingStore, tradingCallerFromScope, tradingScope, type JournalRecord, type TradingBinding, type TradingCaller, type TradingStore } from "../src/trading_store";

const wallet = "0xaBcDEf0123456789012345678901234567890123";
const caller: TradingCaller = { appId: "agent", installationUid: "agent-installation", role: "background" };

function record(key: string, scope: string): JournalRecord {
  return { key, scope, operationId: key, revision: 1, createdAt: 1, updatedAt: 1 };
}

for (const [name, create] of [
  ["memory", () => new MemoryTradingStore()],
  ["indexedDB", () => new IndexedTradingStore()],
] as const) {
  describe(`${name} history binding`, () => {
    test("includes every caller only within the exact wallet, environment and installation", async () => {
      const store: TradingStore = create();
      const binding: TradingBinding = { walletAddress: wallet, environment: "mainnet", installationId: `${name}-history` };
      const own = tradingScope(binding, caller);
      const otherCaller = tradingScope(binding, { appId: "hyperliquid", installationUid: "ui-installation", role: "foreground_tile" });
      const excluded = [
        tradingScope({ ...binding, environment: "testnet" }, caller),
        tradingScope({ ...binding, walletAddress: "0x0000000000000000000000000000000000000001" }, caller),
        tradingScope({ ...binding, installationId: `${binding.installationId}-suffix` }, caller),
        tradingScope({ ...binding, installationId: binding.installationId.slice(0, -1) }, caller),
        tradingScope({ ...binding, installationId: `prefix-${binding.installationId}` }, caller),
        JSON.stringify([binding.environment, wallet.toLowerCase(), binding.installationId]),
        JSON.stringify([...JSON.parse(own), "extra"]),
        JSON.stringify([binding.environment, wallet.toLowerCase(), binding.installationId, "agent", {}, "background"]),
        `prefix:${own}`,
        "invalid-json",
      ];
      await store.add(record(`${name}-own`, own));
      await store.add(record(`${name}-other`, otherCaller));
      for (const [index, scope] of excluded.entries()) await store.add(record(`${name}-excluded-${index}`, scope));

      const all = await store.listBinding(binding);
      expect(all.map(value => value.key).sort()).toEqual([`${name}-other`, `${name}-own`]);
      expect((await store.list(own)).map(value => value.key)).toEqual([`${name}-own`]);
      expect(tradingCallerFromScope(all.find(value => value.key === `${name}-own`)!.scope)).toEqual(caller);
    });
  });
}

test("scope caller parsing rejects malformed scope instead of inventing ownership", () => {
  for (const scope of ["null", "{}", "[]", "not json", '["mainnet","invalid-wallet","installation","agent","uid","background"]']) {
    expect(() => tradingCallerFromScope(scope)).toThrow("Invalid trading journal scope");
  }
});
