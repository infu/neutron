import { expect, test } from "bun:test";
import { createEvmPriceWatcher } from "../src/evm_price_watch.ts";
import type { EvmPriceAsset, EvmPricesResult, EvmUsdPrice } from "../src/evm_wallet.ts";

const eth = { chainId: "1", address: null };
const usdc = { chainId: "1", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" };
function result(assets: EvmPriceAsset[], now: number): EvmPricesResult {
  return { source: "defillama", prices: assets.map((asset) => ({ ...asset, priceUsd: asset.address ? 0.99 : 2000,
    observedAtMs: now, fetchedAtMs: now, status: "available", basis: "market", sourceId: "fixture", error: null })) };
}
function fixture() {
  let now = 1_000_000, active = false, sequence = 0;
  const events = new EventTarget();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: EvmPriceAsset[][] = [];
  let respond = async (assets: EvmPriceAsset[]) => result(assets, now);
  const watcher = createEvmPriceWatcher({ prices: async ({ assets }) => { calls.push(assets); return respond(assets); } }, {
    now: () => now, active: () => active, events: [events],
    schedule: (callback, delay) => {
      const id = ++sequence; timers.set(id, { at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => { timers.delete(id as unknown as number); },
  });
  return {
    watcher, calls, timers,
    setActive(value: boolean) { active = value; events.dispatchEvent(new Event(value ? "focus" : "blur")); },
    respond(fn: typeof respond) { respond = fn; },
    async tick(ms = 0) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

test("USD polling starts only in an active app, batches subscribers and stops on blur or last unsubscribe", async () => {
  const f = fixture();
  let displayed: EvmUsdPrice[] = [];
  const stopA = f.watcher.subscribe([eth], (prices) => { displayed = prices; });
  const stopB = f.watcher.subscribe([eth, usdc], () => {});
  await f.tick(120_000);
  expect(f.calls).toHaveLength(0);
  expect(f.timers.size).toBe(0);
  f.setActive(true); await f.tick();
  expect(f.calls).toEqual([[eth, usdc]]);
  await f.tick(59_999); expect(f.calls).toHaveLength(1);
  await f.tick(1); expect(f.calls).toHaveLength(2);
  f.setActive(false); await f.tick(120_000);
  expect(f.calls).toHaveLength(2);
  expect(f.timers.size).toBe(0);
  f.setActive(true);
  expect(displayed[0]?.status).toBe("stale");
  f.setActive(false);
  stopA(); f.setActive(true); await f.tick();
  expect(f.calls).toHaveLength(3);
  stopB(); await f.tick(120_000);
  expect(f.calls).toHaveLength(3);
  expect(f.timers.size).toBe(0);
});

test("price read failure preserves known values as stale and retries only on the next minute", async () => {
  const f = fixture();
  let displayed: EvmUsdPrice[] = [];
  f.setActive(true);
  const stop = f.watcher.subscribe([eth], (prices) => { displayed = prices; });
  await f.tick(); expect(displayed[0]?.priceUsd).toBe(2000);
  f.respond(async () => { throw new Error("Price service unavailable"); });
  await f.tick(60_000);
  expect(displayed[0]).toMatchObject({ priceUsd: 2000, status: "stale", error: "Price service unavailable" });
  await f.tick(59_999); expect(f.calls).toHaveLength(2);
  await f.tick(1); expect(f.calls).toHaveLength(3);
  stop();
});

test("hidden app accepts an already running price response without starting another poll", async () => {
  const f = fixture();
  let resolve!: (value: EvmPricesResult) => void;
  f.respond(() => new Promise((done) => { resolve = done; }));
  f.setActive(true);
  const stop = f.watcher.subscribe([usdc], () => {});
  await f.tick(); expect(f.calls).toHaveLength(1);
  f.setActive(false);
  resolve(result([usdc], 1_000_000)); await f.tick();
  expect(f.watcher.read([usdc])[0]?.priceUsd).toBe(0.99);
  expect(f.timers.size).toBe(0);
  await f.tick(120_000); expect(f.calls).toHaveLength(1);
  stop();
});
