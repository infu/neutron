import { expect, test } from "bun:test";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import type { CatalogLedger } from "../src/catalog.ts";
import type { HistoryRecord } from "../src/history.ts";
import {
  createWalletProjection,
  parseWalletProjection,
  walletProjectionForTool,
  walletProjectionInputSchema,
  walletProjectionSchema,
  walletTileView,
} from "../src/wallet_projection.ts";
import type { WalletSnapshot } from "../src/wallet_data.ts";

const snapshot: WalletSnapshot = {
  owner: "aaaaa-aa",
  configured: true,
  ledgers: [
    {
      id: "1",
      principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      name: "Internet Computer",
      symbol: "ICP",
      decimals: 8,
      fee: "10000",
      balance: "125000000",
      logo: null,
      metadataUpdatedAt: "1700000000000000000",
      balanceUpdatedAt: "1700000001000000000",
      metadataError: null,
      balanceError: null,
      nativeAddress: null,
      nativeAddressUpdatedAt: null,
      nativeAddressError: null,
      nativeRefreshUpdatedAt: null,
      nativeRefreshError: null,
      nativeDepositProgress: null,
    },
  ],
};

const catalog: CatalogLedger[] = [
  {
    principal: snapshot.ledgers[0]!.principal,
    index: "qhbym-qaaaa-aaaaa-aaafq-cai",
    historyKind: "icp",
    name: "Internet Computer",
    symbol: "ICP",
    priceAsset: "ICP",
    networks: ["internet_computer"],
    nativeRoute: null,
  },
];

const activity: HistoryRecord = {
  kind: "transaction",
  ledger: snapshot.ledgers[0]!.principal,
  symbol: "ICP",
  decimals: 8,
  logo: null,
  blockIndex: "9",
  operation: "transfer",
  timestampNs: "1700000000000000000",
  amount: "50000000",
  fee: "10000",
  balanceEffect: "50000000",
  from: { kind: "icp_account_identifier", value: "source-account" },
  to: null,
  spender: null,
  memo: null,
  intent: null,
  native: null,
  provenance: "ledger",
  verification: "verified",
};

test("Wallet projection is bounded, exact, and round-trips its strict parser", () => {
  const projection = createWalletProjection(3, snapshot, catalog, [activity], {
    capturedAt: 1_700_000_000_000,
  });
  expect(parseWalletProjection(projection)).toEqual(projection);
  expect(projection.assets[0]).toMatchObject({
    balance: "125000000",
    priceAsset: "ICP",
    balanceUpdatedAt: "1700000001000000000",
  });
  expect(projection.activity[0]).toMatchObject({
    label: "Received",
    direction: "incoming",
    amount: "+0.5",
    detail: "source-account",
  });
});

test("Wallet projection schemas pass shared tool hardening", () => {
  expect(() =>
    normalizeToolDescriptor({
      name: "wallet_overview",
      inputSchema: walletProjectionInputSchema,
      outputSchema: walletProjectionSchema,
    }),
  ).not.toThrow();
});

test("Wallet projection round-trips index lag and partial synchronization without marking empty activity complete", () => {
  const checkpoint = { tipExclusive: "90071992547409939999", balance: "123456789000000000", checkedAt: "1800000000000000001" };
  const projection = createWalletProjection(4, snapshot, catalog, [], {
    historyStatus: { running: false, ledgers: [{
      ledger: snapshot.ledgers[0]!.principal, symbol: "ICP", enabled: true,
      source: "index", index: "qhbym-qaaaa-aaaaa-aaafq-cai", state: "waiting_for_index",
      checkpoint, lastAttemptAt: "1800000000000000002", lastSuccessAt: checkpoint.checkedAt,
      lastError: null, transactionCount: "2", adjustmentCount: "0",
    }] },
    activitySync: { requested: true, error: null, report: {
      startedAt: "1800000000000000002", finishedAt: "1800000000000000003", skippedOverlap: false,
      results: [{ ledger: snapshot.ledgers[0]!.principal, status: "waiting_for_index", recordsAdded: "0", checkpoint, error: null }],
    } },
  });
  expect(parseWalletProjection(projection)).toEqual(projection);
  expect(projection.activity).toEqual([]);
  expect(projection.historyError).toBeNull();
  expect(projection.historyStatus?.ledgers[0]?.state).toBe("waiting_for_index");
  expect(projection.activitySync.report?.results[0]?.status).toBe("waiting_for_index");
  const { activitySync: _sync, historyStatus: _status, historyStatusError: _error, ...oldProjection } = projection;
  expect(parseWalletProjection(oldProjection)).toMatchObject({ historyStatus: null, historyStatusError: null, activitySync: { requested: false, report: null, error: null } });
});

test("Wallet tool projections omit repeated images without changing balances, activity, or visual projections", () => {
  const logo = `data:image/png;base64,${"A".repeat(20_000)}`;
  const projection = createWalletProjection(
    3,
    { ...snapshot, ledgers: snapshot.ledgers.map((ledger) => ({ ...ledger, logo })) },
    catalog,
    [{ ...activity, logo }],
    { capturedAt: 1_700_000_000_000 },
  );
  const compact = walletProjectionForTool(projection);
  expect(compact.assets[0]?.logo).toBeNull();
  expect(compact.activity[0]?.logo).toBeNull();
  expect(parseWalletProjection(compact)).toEqual(compact);
  expect(compact.assets[0]).toEqual({ ...projection.assets[0]!, logo: null });
  expect(compact.activity[0]).toEqual({ ...projection.activity[0]!, logo: null });
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(projection).length - 39_000);
  expect(walletProjectionForTool(projection, false)).toEqual(compact);
  expect(walletProjectionForTool(projection, true)).toEqual(projection);
  expect(projection.assets[0]?.logo).toBe(logo);
  expect(projection.activity[0]?.logo).toBe(logo);
});

test("Wallet tile views are bounded navigation, not financial commands", () => {
  expect(walletTileView("assets")).toBe("assets");
  expect(walletTileView("activity")).toBe("activity");
  expect(walletTileView("approvals")).toBe("approvals");
  expect(walletTileView("setup")).toBe("setup");
  expect(walletTileView("receive", "7")).toBe("receive/7");
  expect(walletTileView("send", "7")).toBe("send/7");
  expect(walletTileView("send", "not-a-ledger-id")).toBe("assets");
});
