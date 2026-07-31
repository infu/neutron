import { Principal } from "@dfinity/principal";
import { isPriceAsset, type PriceAsset } from "./prices.ts";

export const WALLET_LEDGER_LIMIT = 16;

export type CatalogLedger = {
  principal: string;
  index: string | null;
  historyKind: "icp" | "icrc";
  name: string;
  symbol: string;
  priceAsset: PriceAsset | null;
  networks: CatalogNetwork[];
  nativeRoute: CatalogNativeRoute | null;
};

export type CatalogNetwork =
  | "internet_computer"
  | "bitcoin_mainnet"
  | "dogecoin_mainnet"
  | "ethereum_mainnet"
  | "solana_mainnet";

export type CatalogNativeRoute = {
  kind: "ckbtc" | "cketh" | "ckerc20" | "ckdoge" | "cksol";
  originNetwork:
    | "bitcoin_mainnet"
    | "dogecoin_mainnet"
    | "ethereum_mainnet"
    | "solana_mainnet";
  minter: string;
  contract: string | null;
  gasLedger: string | null;
  nativeActionsAvailable: boolean;
};

export function filterCatalog(
  catalog: CatalogLedger[],
  search: string,
): CatalogLedger[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return catalog;
  return catalog.filter((ledger) =>
    `${ledger.name} ${ledger.symbol} ${ledger.principal}`
      .toLocaleLowerCase()
      .includes(query),
  );
}

export function parseCustomLedgerPrincipal(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a ledger canister ID");
  let principal: Principal;
  try {
    principal = Principal.fromText(trimmed);
  } catch {
    throw new Error("Enter a valid IC principal");
  }
  if (principal.isAnonymous()) {
    throw new Error("The anonymous principal cannot be a ledger");
  }
  if (principal.toText() === Principal.managementCanister().toText()) {
    throw new Error("The management canister cannot be a ledger");
  }
  return principal.toText();
}

export function parseCatalogPriceAsset(value: unknown): PriceAsset | null {
  if (value === undefined || value === null) return null;
  if (!isPriceAsset(value)) throw new Error("Invalid wallet catalog price asset");
  return value;
}
