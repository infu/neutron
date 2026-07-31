import { isJsonObject, type JsonObject, type JsonValue } from "neutron-tools/app";
import {
  parseCatalogPriceAsset,
  type CatalogLedger,
  type CatalogNetwork,
  type CatalogNativeRoute,
} from "./catalog.ts";
import {
  parseNativeDepositProgress,
  type WalletNativeDepositProgress,
} from "./deposit_progress.ts";

export type WalletLedger = {
  id: string;
  principal: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  fee: string | null;
  balance: string | null;
  logo: string | null;
  metadataUpdatedAt: string | null;
  balanceUpdatedAt: string | null;
  metadataError: string | null;
  balanceError: string | null;
  nativeAddress: string | null;
  nativeAddressUpdatedAt: string | null;
  nativeAddressError: string | null;
  nativeRefreshUpdatedAt: string | null;
  nativeRefreshError: string | null;
  nativeDepositProgress: WalletNativeDepositProgress | null;
};

export type WalletSnapshot = {
  owner: string;
  configured: boolean;
  ledgers: WalletLedger[];
};

export function parseWalletSnapshotResult(value: JsonValue): WalletSnapshot {
  if (isJsonObject(value) && isJsonObject(value.snapshot)) {
    return parseWalletSnapshot(value.snapshot as JsonValue);
  }
  return parseWalletSnapshot(value);
}

export function parseWalletSnapshot(value: JsonValue): WalletSnapshot {
  const record = requiredObject(value, "wallet snapshot");
  if (
    typeof record.owner !== "string" ||
    typeof record.configured !== "boolean" ||
    !Array.isArray(record.ledgers)
  ) {
    throw new Error("Invalid wallet snapshot");
  }
  return {
    owner: record.owner,
    configured: record.configured,
    ledgers: record.ledgers.map(parseWalletLedger),
  };
}

export function parseWalletCatalog(value: JsonValue): CatalogLedger[] {
  if (!Array.isArray(value)) throw new Error("Invalid wallet catalog");
  return value.map((candidate) => {
    const record = requiredObject(candidate, "wallet catalog ledger");
    const priceAsset = parseCatalogPriceAsset(record.price_asset);
    if (
      typeof record.principal !== "string" ||
      (record.index !== null && typeof record.index !== "string") ||
      (record.history_kind !== "icp" && record.history_kind !== "icrc") ||
      typeof record.name !== "string" ||
      typeof record.symbol !== "string"
    ) {
      throw new Error("Invalid wallet catalog ledger");
    }
    return {
      principal: record.principal,
      index: record.index,
      historyKind: record.history_kind,
      name: record.name,
      symbol: record.symbol,
      priceAsset,
      networks: parseCatalogNetworks(record.networks),
      nativeRoute: parseCatalogRoute(record.native_route),
    };
  });
}

export function walletLedgerIssue(ledger: WalletLedger): string | null {
  return (
    ledger.balanceError ??
    ledger.metadataError ??
    ledger.nativeRefreshError ??
    ledger.nativeAddressError
  );
}

function parseCatalogNetworks(value: unknown): CatalogNetwork[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Invalid wallet catalog networks");
  }
  const networks = value.map((network) => {
    if (
      network !== "internet_computer" &&
      network !== "bitcoin_mainnet" &&
      network !== "dogecoin_mainnet" &&
      network !== "ethereum_mainnet" &&
      network !== "solana_mainnet"
    ) {
      throw new Error("Invalid wallet catalog network");
    }
    return network;
  });
  if (new Set(networks).size !== networks.length) {
    throw new Error("Duplicate wallet catalog network");
  }
  return networks;
}

function parseCatalogRoute(value: unknown): CatalogNativeRoute | null {
  if (value === undefined || value === null) return null;
  const record = requiredObject(value, "wallet native route");
  if (
    record.kind !== "ckbtc" &&
    record.kind !== "cketh" &&
    record.kind !== "ckerc20" &&
    record.kind !== "ckdoge" &&
    record.kind !== "cksol"
  ) {
    throw new Error("Invalid wallet native route kind");
  }
  if (
    record.origin_network !== "bitcoin_mainnet" &&
    record.origin_network !== "dogecoin_mainnet" &&
    record.origin_network !== "ethereum_mainnet" &&
    record.origin_network !== "solana_mainnet"
  ) {
    throw new Error("Invalid wallet native route network");
  }
  if (
    typeof record.minter !== "string" ||
    typeof record.native_actions_available !== "boolean"
  ) {
    throw new Error("Invalid wallet native route");
  }
  return {
    kind: record.kind,
    originNetwork: record.origin_network,
    minter: record.minter,
    contract: optionalString(record.contract),
    gasLedger: optionalString(record.gas_ledger),
    nativeActionsAvailable: record.native_actions_available,
  };
}

function parseWalletLedger(value: JsonValue): WalletLedger {
  const record = requiredObject(value, "wallet ledger");
  if (typeof record.principal !== "string") {
    throw new Error("Invalid wallet ledger principal");
  }
  const decimals = optionalNat(record.decimals);
  return {
    id: requiredNat(record.id, "wallet ledger id"),
    principal: record.principal,
    name: optionalString(record.name),
    symbol: optionalString(record.symbol),
    decimals:
      decimals === null || BigInt(decimals) > 255n ? null : Number(decimals),
    fee: optionalNat(record.fee),
    balance: optionalNat(record.balance),
    logo: optionalString(record.logo),
    metadataUpdatedAt: optionalInt(record.metadata_updated_at),
    balanceUpdatedAt: optionalInt(record.balance_updated_at),
    metadataError: optionalString(record.metadata_error),
    balanceError: optionalString(record.balance_error),
    nativeAddress: optionalString(record.native_address),
    nativeAddressUpdatedAt: optionalInt(record.native_address_updated_at),
    nativeAddressError: optionalString(record.native_address_error),
    nativeRefreshUpdatedAt: optionalInt(record.native_refresh_updated_at),
    nativeRefreshError: optionalString(record.native_refresh_error),
    nativeDepositProgress: parseNativeDepositProgress(
      record.native_deposit_progress,
    ),
  };
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNat(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredNat(value, "natural number");
}

function optionalInt(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value as string | number | bigint).toString();
  } catch {
    throw new Error("Invalid integer");
  }
}

function requiredNat(value: unknown, label: string): string {
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed < 0n) throw new Error("negative");
    return parsed.toString();
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}
