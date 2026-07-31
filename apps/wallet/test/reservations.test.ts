import { expect, test } from "bun:test";
import type { CatalogLedger } from "../src/catalog.ts";
import {
  desiredWalletReservationScopes,
  parseWalletReservationScopes,
  reservationActions,
} from "../src/reservations.ts";

const catalog: CatalogLedger[] = [
  {
    principal: "mxzaz-hqaaa-aaaar-qaada-cai",
    index: "n5wcd-faaaa-aaaar-qaaea-cai",
    historyKind: "icrc",
    name: "Chain-key Bitcoin",
    symbol: "ckBTC",
    priceAsset: "BTC",
    networks: ["internet_computer", "bitcoin_mainnet"],
    nativeRoute: {
      kind: "ckbtc",
      originNetwork: "bitcoin_mainnet",
      minter: "mqygn-kiaaa-aaaar-qaadq-cai",
      contract: null,
      gasLedger: null,
      nativeActionsAvailable: true,
    },
  },
  {
    principal: "ss2fx-dyaaa-aaaar-qacoq-cai",
    index: "s3zol-vqaaa-aaaar-qacpa-cai",
    historyKind: "icrc",
    name: "Chain-key Ether",
    symbol: "ckETH",
    priceAsset: "ETH",
    networks: ["internet_computer", "ethereum_mainnet"],
    nativeRoute: {
      kind: "cketh",
      originNetwork: "ethereum_mainnet",
      minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
      contract: null,
      gasLedger: null,
      nativeActionsAvailable: true,
    },
  },
];

test("Wallet reserves ledgers broadly and minter mutations exactly", () => {
  expect(
    desiredWalletReservationScopes(
      catalog,
      new Set(catalog.map((ledger) => ledger.principal)),
    ),
  ).toEqual([
    { kind: "principal", principal: "mxzaz-hqaaa-aaaar-qaada-cai" },
    {
      kind: "exact",
      principal: "n5wcd-faaaa-aaaar-qaaea-cai",
      method: "get_account_transactions",
    },
    {
      kind: "exact",
      principal: "mqygn-kiaaa-aaaar-qaadq-cai",
      method: "get_btc_address",
    },
    {
      kind: "exact",
      principal: "mqygn-kiaaa-aaaar-qaadq-cai",
      method: "update_balance",
    },
    {
      kind: "exact",
      principal: "mqygn-kiaaa-aaaar-qaadq-cai",
      method: "retrieve_btc_with_approval",
    },
    { kind: "principal", principal: "ss2fx-dyaaa-aaaar-qacoq-cai" },
    {
      kind: "exact",
      principal: "s3zol-vqaaa-aaaar-qacpa-cai",
      method: "get_account_transactions",
    },
    {
      kind: "exact",
      principal: "sv3dd-oaaaa-aaaar-qacoa-cai",
      method: "withdraw_eth",
    },
  ]);
});

test("Wallet computes one reservation batch for selection changes", () => {
  const current = [
    { kind: "principal" as const, principal: catalog[0]!.principal },
    {
      kind: "exact" as const,
      principal: catalog[0]!.nativeRoute!.minter,
      method: "update_balance",
    },
  ];
  const desired = desiredWalletReservationScopes(
    catalog,
    new Set([catalog[1]!.principal]),
  );
  expect(reservationActions(current, desired)).toEqual([
    {
      kind: "reserve",
      scope: { kind: "principal", principal: catalog[1]!.principal },
    },
    {
      kind: "reserve",
      scope: {
        kind: "exact",
        principal: catalog[1]!.index!,
        method: "get_account_transactions",
      },
    },
    {
      kind: "reserve",
      scope: {
        kind: "exact",
        principal: catalog[1]!.nativeRoute!.minter,
        method: "withdraw_eth",
      },
    },
    { kind: "release", scope: current[0]! },
    { kind: "release", scope: current[1]! },
  ]);
});

test("Wallet gives a custom ledger only the required ICRC reservations", () => {
  const custom = "ryjl3-tyaaa-aaaaa-aaaba-cai";

  expect(
    desiredWalletReservationScopes(catalog, new Set([custom])),
  ).toEqual(
    [
      "icrc1_metadata",
      "icrc1_balance_of",
      "icrc1_fee",
      "icrc1_transfer",
      "icrc3_get_blocks",
    ].map((method) => ({ kind: "exact", principal: custom, method })),
  );
});

test("Wallet reserves both token and ckETH gas access for ckERC20", () => {
  const token: CatalogLedger = {
    principal: "xevnm-gaaaa-aaaar-qafnq-cai",
    index: "xrs4b-hiaaa-aaaar-qafoa-cai",
    historyKind: "icrc",
    name: "Chain-key USDC",
    symbol: "ckUSDC",
    priceAsset: "USDC",
    networks: ["internet_computer", "ethereum_mainnet"],
    nativeRoute: {
      kind: "ckerc20",
      originNetwork: "ethereum_mainnet",
      minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      gasLedger: "ss2fx-dyaaa-aaaar-qacoq-cai",
      nativeActionsAvailable: true,
    },
  };

  expect(
    desiredWalletReservationScopes([...catalog, token], new Set([token.principal])),
  ).toEqual([
    { kind: "principal", principal: token.principal },
    {
      kind: "exact",
      principal: token.index!,
      method: "get_account_transactions",
    },
    {
      kind: "exact",
      principal: token.nativeRoute!.minter,
      method: "eip_1559_transaction_price",
    },
    {
      kind: "exact",
      principal: token.nativeRoute!.minter,
      method: "withdraw_erc20",
    },
    {
      kind: "exact",
      principal: token.nativeRoute!.gasLedger!,
      method: "icrc1_fee",
    },
    {
      kind: "exact",
      principal: token.nativeRoute!.gasLedger!,
      method: "icrc2_approve",
    },
    {
      kind: "exact",
      principal: token.nativeRoute!.gasLedger!,
      method: "icrc1_balance_of",
    },
    {
      kind: "exact",
      principal: catalog[1]!.index!,
      method: "get_account_transactions",
    },
  ]);
});

test("Wallet parses exact reservation snapshots", () => {
  expect(
    parseWalletReservationScopes({
      reservations: [
        {
          scopeKind: "exact",
          principal: "mqygn-kiaaa-aaaar-qaadq-cai",
          method: "update_balance",
        },
      ],
    }),
  ).toEqual([
    {
      kind: "exact",
      principal: "mqygn-kiaaa-aaaar-qaadq-cai",
      method: "update_balance",
    },
  ]);
});
