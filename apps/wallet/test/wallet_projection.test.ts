import { expect, test } from "bun:test";
import { normalizeToolDescriptor } from "neutron-tools/src/app.ts";
import type { CatalogLedger } from "../src/catalog.ts";
import type { HistoryRecord } from "../src/history.ts";
import {
  createWalletProjection,
  parseWalletProjection,
  walletProjectionEmptyInputSchema,
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
      inputSchema: walletProjectionEmptyInputSchema,
      outputSchema: walletProjectionSchema,
    }),
  ).not.toThrow();
});

test("Wallet tile views are bounded navigation, not financial commands", () => {
  expect(walletTileView("assets")).toBe("assets");
  expect(walletTileView("activity")).toBe("activity");
  expect(walletTileView("setup")).toBe("setup");
  expect(walletTileView("receive", "7")).toBe("receive/7");
  expect(walletTileView("send", "7")).toBe("send/7");
  expect(walletTileView("send", "not-a-ledger-id")).toBe("assets");
});
