import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "neutron-tools/app";
import type { CatalogLedger } from "./catalog.ts";
import { formatTokenAmount } from "./format.ts";
import {
  historyAddressText,
  historyRecordKey,
  type HistoryRecord,
} from "./history.ts";
import { PRICE_ASSETS, type PriceAsset } from "./prices.ts";
import { safeTokenLogo } from "./logo.ts";
import {
  walletLedgerIssue,
  type WalletLedger,
  type WalletSnapshot,
} from "./wallet_data.ts";

export const WALLET_PROJECTION_TOPIC = "wallet_projection";
export const WALLET_PROJECTION_TOOLS = {
  overview: "wallet_overview",
  refresh: "wallet_refresh",
} as const;

export const WALLET_PROJECTION_ASSET_LIMIT = 64;
export const WALLET_PROJECTION_ACTIVITY_LIMIT = 5;

export type WalletProjectionAsset = {
  id: string;
  principal: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  balance: string | null;
  logo: string | null;
  priceAsset: PriceAsset | null;
  balanceUpdatedAt: string | null;
  issue: string | null;
};

export type WalletProjectionActivity = {
  key: string;
  label: string;
  detail: string;
  direction: "incoming" | "outgoing" | "neutral";
  amount: string;
  symbol: string | null;
  logo: string | null;
  timestampNs: string;
};

export type WalletProjection = {
  revision: string;
  capturedAt: number;
  configured: boolean;
  assetCount: number;
  warningCount: number;
  assets: WalletProjectionAsset[];
  activity: WalletProjectionActivity[];
  hasMoreActivity: boolean;
  historyError: string | null;
};

const nullableShortStringSchema: JsonObject = {
  oneOf: [
    { type: "string", maxLength: 240 },
    { type: "null" },
  ],
};
const nullableLogoSchema: JsonObject = {
  oneOf: [
    { type: "string", maxLength: 32_768 },
    { type: "null" },
  ],
};
const nullableNatSchema: JsonObject = {
  oneOf: [
    { type: "string", pattern: "^0$|^[1-9][0-9]{0,79}$" },
    { type: "null" },
  ],
};
const nullableIntSchema: JsonObject = {
  oneOf: [
    { type: "string", pattern: "^-?0$|^-?[1-9][0-9]{0,79}$" },
    { type: "null" },
  ],
};

const projectionAssetSchema: JsonObject = {
  type: "object",
  required: [
    "id",
    "principal",
    "name",
    "symbol",
    "decimals",
    "balance",
    "logo",
    "priceAsset",
    "balanceUpdatedAt",
    "issue",
  ],
  properties: {
    id: { type: "string", pattern: "^0$|^[1-9][0-9]{0,79}$" },
    principal: { type: "string", minLength: 1, maxLength: 128 },
    name: nullableShortStringSchema,
    symbol: nullableShortStringSchema,
    decimals: {
      oneOf: [
        { type: "integer", minimum: 0, maximum: 255 },
        { type: "null" },
      ],
    },
    balance: nullableNatSchema,
    logo: nullableLogoSchema,
    priceAsset: {
      oneOf: [
        { type: "string", enum: [...PRICE_ASSETS] },
        { type: "null" },
      ],
    },
    balanceUpdatedAt: nullableIntSchema,
    issue: nullableShortStringSchema,
  },
  additionalProperties: false,
};

const projectionActivitySchema: JsonObject = {
  type: "object",
  required: [
    "key",
    "label",
    "detail",
    "direction",
    "amount",
    "symbol",
    "logo",
    "timestampNs",
  ],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 180 },
    label: { type: "string", minLength: 1, maxLength: 80 },
    detail: { type: "string", minLength: 1, maxLength: 180 },
    direction: {
      type: "string",
      enum: ["incoming", "outgoing", "neutral"],
    },
    amount: { type: "string", minLength: 1, maxLength: 180 },
    symbol: nullableShortStringSchema,
    logo: nullableLogoSchema,
    timestampNs: {
      type: "string",
      pattern: "^0$|^[1-9][0-9]{0,79}$",
    },
  },
  additionalProperties: false,
};

export const walletProjectionSchema: JsonObject = {
  type: "object",
  required: [
    "revision",
    "capturedAt",
    "configured",
    "assetCount",
    "warningCount",
    "assets",
    "activity",
    "hasMoreActivity",
    "historyError",
  ],
  properties: {
    revision: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
    capturedAt: { type: "integer", minimum: 1 },
    configured: { type: "boolean" },
    assetCount: {
      type: "integer",
      minimum: 0,
      maximum: WALLET_PROJECTION_ASSET_LIMIT,
    },
    warningCount: {
      type: "integer",
      minimum: 0,
      maximum: WALLET_PROJECTION_ASSET_LIMIT,
    },
    assets: {
      type: "array",
      maxItems: WALLET_PROJECTION_ASSET_LIMIT,
      items: projectionAssetSchema,
    },
    activity: {
      type: "array",
      maxItems: WALLET_PROJECTION_ACTIVITY_LIMIT,
      items: projectionActivitySchema,
    },
    hasMoreActivity: { type: "boolean" },
    historyError: nullableShortStringSchema,
  },
  additionalProperties: false,
};

export const walletProjectionEmptyInputSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function createWalletProjection(
  revision: number,
  snapshot: WalletSnapshot,
  catalog: CatalogLedger[],
  records: HistoryRecord[],
  options: {
    capturedAt?: number;
    hasMoreActivity?: boolean;
    historyError?: string | null;
  } = {},
): WalletProjection {
  const catalogByPrincipal = new Map(
    catalog.map((ledger) => [ledger.principal, ledger]),
  );
  const assets = snapshot.ledgers
    .slice(0, WALLET_PROJECTION_ASSET_LIMIT)
    .map((ledger) => projectAsset(ledger, catalogByPrincipal.get(ledger.principal)));

  return {
    revision: String(Math.max(1, Math.trunc(revision))),
    capturedAt: options.capturedAt ?? Date.now(),
    configured: snapshot.configured,
    assetCount: assets.length,
    warningCount: assets.filter((asset) => asset.issue !== null).length,
    assets,
    activity: records
      .slice(0, WALLET_PROJECTION_ACTIVITY_LIMIT)
      .map(projectActivity),
    hasMoreActivity:
      Boolean(options.hasMoreActivity) ||
      records.length > WALLET_PROJECTION_ACTIVITY_LIMIT,
    historyError: bounded(options.historyError ?? null, 240),
  };
}

export function parseWalletProjection(value: JsonValue): WalletProjection {
  if (!isJsonObject(value)) throw new Error("Invalid wallet overview");
  const assets = requiredArray(value.assets, "wallet overview assets").map(
    parseProjectionAsset,
  );
  const activity = requiredArray(
    value.activity,
    "wallet overview activity",
  ).map(parseProjectionActivity);
  const revision = requiredPattern(
    value.revision,
    /^[1-9][0-9]{0,15}$/,
    "wallet overview revision",
  );
  if (
    typeof value.capturedAt !== "number" ||
    !Number.isSafeInteger(value.capturedAt) ||
    value.capturedAt < 1 ||
    typeof value.configured !== "boolean" ||
    typeof value.assetCount !== "number" ||
    !Number.isInteger(value.assetCount) ||
    value.assetCount !== assets.length ||
    typeof value.warningCount !== "number" ||
    !Number.isInteger(value.warningCount) ||
    value.warningCount !== assets.filter((asset) => asset.issue !== null).length ||
    typeof value.hasMoreActivity !== "boolean"
  ) {
    throw new Error("Invalid wallet overview");
  }
  if (
    assets.length > WALLET_PROJECTION_ASSET_LIMIT ||
    activity.length > WALLET_PROJECTION_ACTIVITY_LIMIT
  ) {
    throw new Error("Wallet overview exceeds its bounds");
  }
  return {
    revision,
    capturedAt: value.capturedAt,
    configured: value.configured,
    assetCount: value.assetCount,
    warningCount: value.warningCount,
    assets,
    activity,
    hasMoreActivity: value.hasMoreActivity,
    historyError: nullableString(value.historyError, 240),
  };
}

export function walletTileView(
  action: "assets" | "activity" | "approvals" | "setup" | "receive" | "send",
  ledgerId?: string,
): string {
  if (
    action === "assets" ||
    action === "activity" ||
    action === "approvals" ||
    action === "setup"
  ) {
    return action;
  }
  if (!ledgerId || !/^(0|[1-9][0-9]{0,39})$/.test(ledgerId)) {
    return "assets";
  }
  return `${action}/${ledgerId}`;
}

function projectAsset(
  ledger: WalletLedger,
  catalog: CatalogLedger | undefined,
): WalletProjectionAsset {
  return {
    id: ledger.id,
    principal: ledger.principal,
    name: bounded(ledger.name ?? catalog?.name ?? null, 120),
    symbol: bounded(ledger.symbol ?? catalog?.symbol ?? null, 32),
    decimals: ledger.decimals,
    balance: ledger.balance,
    logo: safeTokenLogo(ledger.logo),
    priceAsset: catalog?.priceAsset ?? null,
    balanceUpdatedAt: ledger.balanceUpdatedAt,
    issue: bounded(walletLedgerIssue(ledger), 240),
  };
}

function projectActivity(record: HistoryRecord): WalletProjectionActivity {
  const effect = BigInt(record.balanceEffect);
  const direction = effect > 0n ? "incoming" : effect < 0n ? "outgoing" : "neutral";
  const units =
    record.kind === "adjustment" ||
    (record.kind === "transaction" && record.operation === "approve")
      ? (effect < 0n ? -effect : effect).toString()
      : record.amount;
  const sign = effect > 0n ? "+" : effect < 0n ? "-" : "";
  const detail = bounded(activityDetail(record), 180);
  return {
    key: bounded(historyRecordKey(record), 180) ?? "activity",
    label: activityLabel(record),
    detail: detail && detail.trim() ? detail : "Wallet activity",
    direction,
    amount: `${sign}${formatTokenAmount(units, record.decimals)}`,
    symbol: bounded(record.symbol, 32),
    logo: safeTokenLogo(record.logo),
    timestampNs: record.timestampNs,
  };
}

function activityLabel(record: HistoryRecord): string {
  if (record.kind === "adjustment") {
    return record.adjustmentKind === "opening_balance"
      ? "Opening balance"
      : "Balance adjustment";
  }
  if (record.operation === "approve") return "Approval fee";
  if (record.operation === "mint" || record.operation === "authorized_mint") {
    return "Minted";
  }
  if (record.operation === "burn" || record.operation === "authorized_burn") {
    return record.intent?.native ? "Withdrawn" : "Burned";
  }
  return BigInt(record.balanceEffect) > 0n ? "Received" : "Sent";
}

function activityDetail(record: HistoryRecord): string {
  if (record.kind === "adjustment") return record.detail;
  if (record.intent) {
    return record.intent.addressLabel
      ? `${record.intent.contactName} / ${record.intent.addressLabel}`
      : record.intent.contactName;
  }
  const address =
    BigInt(record.balanceEffect) > 0n
      ? historyAddressText(record.from)
      : historyAddressText(record.to);
  return address ?? networkLabel(record.native?.network);
}

function networkLabel(value: string | undefined): string {
  return (value ?? "internet_computer")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseProjectionAsset(value: JsonValue): WalletProjectionAsset {
  if (!isJsonObject(value)) throw new Error("Invalid wallet overview asset");
  const decimals = value.decimals;
  if (
    decimals !== null &&
    (typeof decimals !== "number" ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255)
  ) {
    throw new Error("Invalid wallet overview asset decimals");
  }
  const priceAsset = value.priceAsset;
  if (priceAsset !== null && !PRICE_ASSETS.includes(priceAsset as PriceAsset)) {
    throw new Error("Invalid wallet overview price asset");
  }
  return {
    id: requiredPattern(value.id, /^(0|[1-9][0-9]{0,79})$/, "asset id"),
    principal: requiredString(value.principal, 128, "asset principal"),
    name: nullableString(value.name, 240),
    symbol: nullableString(value.symbol, 240),
    decimals: decimals as number | null,
    balance: nullablePattern(value.balance, /^(0|[1-9][0-9]{0,79})$/),
    logo: nullableString(value.logo, 32_768),
    priceAsset: priceAsset as PriceAsset | null,
    balanceUpdatedAt: nullablePattern(
      value.balanceUpdatedAt,
      /^-?(0|[1-9][0-9]{0,79})$/,
    ),
    issue: nullableString(value.issue, 240),
  };
}

function parseProjectionActivity(value: JsonValue): WalletProjectionActivity {
  if (!isJsonObject(value)) throw new Error("Invalid wallet overview activity");
  if (
    value.direction !== "incoming" &&
    value.direction !== "outgoing" &&
    value.direction !== "neutral"
  ) {
    throw new Error("Invalid wallet activity direction");
  }
  return {
    key: requiredString(value.key, 180, "activity key"),
    label: requiredString(value.label, 80, "activity label"),
    detail: requiredString(value.detail, 180, "activity detail"),
    direction: value.direction,
    amount: requiredString(value.amount, 180, "activity amount"),
    symbol: nullableString(value.symbol, 240),
    logo: nullableString(value.logo, 32_768),
    timestampNs: requiredPattern(
      value.timestampNs,
      /^(0|[1-9][0-9]{0,79})$/,
      "activity timestamp",
    ),
  };
}

function bounded(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function nullableString(value: JsonValue | undefined, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error("Invalid wallet overview text");
  }
  return value;
}

function nullablePattern(
  value: JsonValue | undefined,
  pattern: RegExp,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error("Invalid wallet overview number");
  }
  return value;
}

function requiredString(value: JsonValue | undefined, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Invalid wallet overview ${label}`);
  }
  return value;
}

function requiredPattern(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}
