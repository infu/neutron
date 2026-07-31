import { expect, test } from "bun:test";
import {
  parseWalletCatalog,
  parseWalletSnapshot,
  parseWalletSnapshotResult,
  walletLedgerIssue,
} from "../src/wallet_data.ts";

const ledger = {
  id: "7",
  principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  name: "Internet Computer",
  symbol: "ICP",
  decimals: "8",
  fee: "10000",
  balance: "123456789",
  logo: null,
  metadata_updated_at: "1700000000000000000",
  balance_updated_at: "1700000001000000000",
  metadata_error: null,
  balance_error: null,
  native_address: null,
  native_address_updated_at: null,
  native_address_error: null,
  native_refresh_updated_at: null,
  native_refresh_error: null,
  native_deposit_progress: null,
};

test("shared Wallet snapshot parsing preserves exact balances and freshness", () => {
  const snapshot = parseWalletSnapshot({
    owner: "aaaaa-aa",
    configured: true,
    ledgers: [ledger],
  });

  expect(snapshot.ledgers[0]).toMatchObject({
    id: "7",
    decimals: 8,
    balance: "123456789",
    metadataUpdatedAt: "1700000000000000000",
    balanceUpdatedAt: "1700000001000000000",
  });
  expect(walletLedgerIssue(snapshot.ledgers[0]!)).toBeNull();
});

test("shared Wallet parser accepts update wrappers and reports ledger issues", () => {
  const snapshot = parseWalletSnapshotResult({
    stale: [],
    snapshot: {
      owner: "aaaaa-aa",
      configured: true,
      ledgers: [{ ...ledger, balance: null, balance_error: "Ledger offline" }],
    },
  });
  expect(walletLedgerIssue(snapshot.ledgers[0]!)).toBe("Ledger offline");
  expect(snapshot.ledgers[0]?.balance).toBeNull();
});

test("shared Wallet catalog parsing retains price and native route metadata", () => {
  const catalog = parseWalletCatalog([
    {
      principal: "mxzaz-hqaaa-aaaar-qaada-cai",
      index: "n5wcd-faaaa-aaaar-qaaea-cai",
      history_kind: "icrc",
      name: "Chain-key Bitcoin",
      symbol: "ckBTC",
      price_asset: "BTC",
      networks: ["internet_computer", "bitcoin_mainnet"],
      native_route: {
        kind: "ckbtc",
        origin_network: "bitcoin_mainnet",
        minter: "mqygn-kiaaa-aaaar-qaadq-cai",
        contract: null,
        gas_ledger: null,
        native_actions_available: false,
      },
    },
  ]);
  expect(catalog[0]).toMatchObject({
    priceAsset: "BTC",
    networks: ["internet_computer", "bitcoin_mainnet"],
    nativeRoute: { kind: "ckbtc", nativeActionsAvailable: false },
  });
});

test("shared Wallet parsing rejects unsafe numeric shapes", () => {
  expect(() =>
    parseWalletSnapshot({
      owner: "aaaaa-aa",
      configured: true,
      ledgers: [{ ...ledger, balance: "1.5" }],
    }),
  ).toThrow("natural number");
  expect(
    parseWalletSnapshot({
      owner: "aaaaa-aa",
      configured: true,
      ledgers: [{ ...ledger, decimals: "256" }],
    }).ledgers[0]?.decimals,
  ).toBeNull();
});
