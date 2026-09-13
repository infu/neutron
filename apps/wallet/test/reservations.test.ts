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

test("Wallet reserves ledger and native minter principals exclusively while keeping history indexes exact", () => {
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
    { kind: "principal", principal: "mqygn-kiaaa-aaaar-qaadq-cai" },
    { kind: "principal", principal: "ss2fx-dyaaa-aaaar-qacoq-cai" },
    {
      kind: "exact",
      principal: "s3zol-vqaaa-aaaar-qacpa-cai",
      method: "get_account_transactions",
    },
    { kind: "principal", principal: "sv3dd-oaaaa-aaaar-qacoa-cai" },
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
        kind: "principal",
        principal: catalog[1]!.nativeRoute!.minter,
      },
    },
    { kind: "release", scope: current[0]! },
    { kind: "release", scope: current[1]! },
  ]);
});

test("Wallet reserves every method of a custom ledger exclusively", () => {
  const custom = "ryjl3-tyaaa-aaaaa-aaaba-cai";

  expect(
    desiredWalletReservationScopes(catalog, new Set([custom])),
  ).toEqual([{ kind: "principal", principal: custom }]);
});

test("reapplying a selected custom ledger replaces partial access with one principal reservation", () => {
  const custom = "togwv-zqaaa-aaaal-qr7aa-cai";
  const current = ["icrc1_fee", "icrc1_transfer", "icrc2_approve"].map(
    (method) => ({ kind: "exact" as const, principal: custom, method }),
  );
  const desired = desiredWalletReservationScopes(catalog, new Set([custom]));
  expect(reservationActions(current, desired)).toEqual([
    { kind: "reserve", scope: { kind: "principal", principal: custom } },
    ...current.map((scope) => ({ kind: "release", scope })),
  ]);
});

test("Wallet reserves ckERC20 token, minter and gas principals and shares minter access with ckETH", () => {
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
      kind: "principal",
      principal: token.nativeRoute!.minter,
    },
    {
      kind: "principal",
      principal: token.nativeRoute!.gasLedger!,
    },
    {
      kind: "exact",
      principal: catalog[1]!.index!,
      method: "get_account_transactions",
    },
  ]);

  const combined = desiredWalletReservationScopes(
    [...catalog, token],
    new Set([catalog[1]!.principal, token.principal]),
  );
  expect(combined).toEqual([
    { kind: "principal", principal: catalog[1]!.principal },
    { kind: "exact", principal: catalog[1]!.index!, method: "get_account_transactions" },
    { kind: "principal", principal: token.nativeRoute!.minter },
    { kind: "principal", principal: token.principal },
    { kind: "exact", principal: token.index!, method: "get_account_transactions" },
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

test("selected Bitcoin, Dogecoin and Solana routes reserve every method of their minter exclusively", () => {
  const routes = [
    { kind: "ckbtc" as const, network: "bitcoin_mainnet" as const },
    { kind: "ckdoge" as const, network: "dogecoin_mainnet" as const },
    { kind: "cksol" as const, network: "solana_mainnet" as const },
  ];
  for (const route of routes) {
    const ledger: CatalogLedger = {
      ...catalog[0]!,
      networks: ["internet_computer", route.network],
      nativeRoute: { ...catalog[0]!.nativeRoute!, kind: route.kind, originNetwork: route.network },
    };
    const scopes = desiredWalletReservationScopes([ledger], new Set([ledger.principal]));
    expect(scopes).toEqual([
      { kind: "principal", principal: ledger.principal },
      { kind: "exact", principal: ledger.index!, method: "get_account_transactions" },
      { kind: "principal", principal: ledger.nativeRoute!.minter },
    ]);
  }
});
