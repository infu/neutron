import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { createTradingEngine, type TradeIntent } from "../src/trading";
import { MemoryTradingStore, tradingScope } from "../src/trading_store";

const binding = { walletAddress: `0x${"11".repeat(20)}`, installationId: "audit-fixture", environment: "testnet" as const };
const caller = { appId: "agent", installationUid: "audit-agent", role: "background" };
const operationId = "12".repeat(16);
// Public synthetic signing key. Every exchange request below is an injected fixture.
const signer = privateKeyToAccount(`0x${"22".repeat(32)}`);

function fixture(intent: TradeIntent, exchange: () => Promise<Response>) {
  const store = new MemoryTradingStore();
  let status: unknown = { status: "unknownOid" };
  let fills: unknown[] = [];
  const engine = () => createTradingEngine({
    binding, caller, store, signer: async () => signer, authorize: async () => {},
    now: () => 1_780_000_000_000,
    data: { info: async <T>(body: Record<string, unknown>): Promise<T> => {
      if (body.type === "meta") return { universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] } as T;
      if (body.type === "orderStatus") return status as T;
      if (body.type === "userFillsByTime") return fills as T;
      if (body.type === "clearinghouseState") return { assetPositions: [] } as T;
      throw new Error(`Unexpected read: ${body.type}`);
    } },
    fetcher: (async () => exchange()) as unknown as typeof fetch,
  });
  return { store, engine, execute: () => engine().execute({ operationId, intent }),
    setStatus(value: unknown) { status = value; }, setFills(value: unknown[]) { fills = value; } };
}

test("reload recovers an interrupted margin-configuration submission as uncertain", async () => {
  const state = fixture({ kind: "leverage", coin: "ETH", leverage: 3, isCross: true },
    async () => Response.json({ status: "ok", response: { type: "default" } }));
  await state.execute();
  const [saved] = await state.store.list(tradingScope(binding, caller));
  // A browser crash after the pre-dispatch write leaves this exact durable state.
  await state.store.update({ ...saved!, state: "submitting", response: undefined, revision: saved!.revision + 1 }, saved!.revision);
  const recovered = await state.engine().reconcile(operationId);
  expect(recovered.state).toBe("uncertain");
  expect(recovered.canRetryExact).toBe(true);
});

test("an open target order does not prove an interrupted cancellation succeeded", async () => {
  const state = fixture({ kind: "cancel", coin: "ETH", oid: 42 }, async () => { throw new Error("Request never reached the venue"); });
  state.setStatus({ status: "order", order: { order: { coin: "ETH", oid: 42, origSz: "0.1", sz: "0.1" }, status: "open" } });
  const result = await state.execute();
  expect(result.state).toBe("uncertain");
  expect(result.canRetryExact).toBe(true);
});

test("truncated fill history cannot downgrade retained complete execution evidence", async () => {
  const state = fixture({ kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.1", price: "2000" },
    async () => Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 42, totalSz: "0.1", avgPx: "2000" } }] } } }));
  expect((await state.execute()).state).toBe("filled");
  state.setStatus({ status: "order", order: { order: { coin: "ETH", oid: 42, origSz: "0.1", sz: "0" }, status: "filled" } });
  state.setFills([{ coin: "ETH", oid: 42, tid: 1, hash: "0xaudit", sz: "0.04", px: "2000" }]);
  const recovered = await state.engine().reconcile(operationId);
  expect(recovered.orders[0]?.filledSize).toBe("0.1");
  expect(recovered.state).toBe("filled");
});

test("a stale open observation cannot erase a complete fill acknowledged by exchange", async () => {
  const state = fixture({ kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.1", price: "2000" },
    async () => Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 42, totalSz: "0.1", avgPx: "2000" } }] } } }));
  await state.execute();
  state.setStatus({ status: "order", order: { order: { coin: "ETH", oid: 42, origSz: "0.1", sz: "0.06" }, status: "open" } });
  state.setFills([{ coin: "ETH", oid: 42, tid: 1, hash: "0xaudit", sz: "0.04", px: "2000" }]);
  const recovered = await state.engine().reconcile(operationId);
  expect(recovered.orders[0]?.filledSize).toBe("0.1");
  expect(recovered.state).toBe("filled");
});

test("a stale open observation cannot reopen an acknowledged cancellation", async () => {
  const state = fixture({ kind: "cancel", coin: "ETH", oid: 42 },
    async () => Response.json({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } }));
  expect((await state.execute()).state).toBe("canceled");
  state.setStatus({ status: "order", order: { order: { coin: "ETH", oid: 42, origSz: "0.1", sz: "0.1" }, status: "open" } });
  expect((await state.engine().reconcile(operationId)).state).toBe("canceled");
});
