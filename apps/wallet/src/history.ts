import { Principal } from "@icp-sdk/core/principal";
import { isJsonObject, type JsonObject } from "neutron-tools/app";
import {
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";

export type HistoryOperation =
  | "transfer"
  | "mint"
  | "burn"
  | "approve"
  | "authorized_mint"
  | "authorized_burn";

export type HistoryVerification =
  | "pending"
  | "verified"
  | "prebaseline"
  | "unverified_scan_limit";

export type HistoryAddress =
  | { kind: "icrc"; value: string }
  | { kind: "icp_account_identifier"; value: string };

export type HistoryIntent = {
  contactId: string;
  addressId: string;
  contactName: string;
  addressLabel: string | null;
  network: string;
  destination: string;
  native: boolean;
};

export type NativeHistoryContext = {
  network: string;
  transactionId: string | null;
  outputIndex: string | null;
  relatedLedger: string | null;
  relatedBlockIndex: string | null;
};

export type HistoryTransaction = {
  kind: "transaction";
  ledger: string;
  symbol: string | null;
  decimals: number;
  logo: string | null;
  blockIndex: string;
  operation: HistoryOperation;
  timestampNs: string;
  amount: string;
  fee: string | null;
  balanceEffect: string;
  from: HistoryAddress | null;
  to: HistoryAddress | null;
  spender: HistoryAddress | null;
  memo: string | null;
  intent: HistoryIntent | null;
  native: NativeHistoryContext | null;
  provenance: "local_pending" | "index" | "ledger";
  verification: HistoryVerification;
};

export type HistoryAdjustmentKind =
  | "opening_balance"
  | "unexplained_balance"
  | "scan_limit"
  | "unsupported_operation";

export type HistoryAdjustment = {
  kind: "adjustment";
  adjustmentKind: HistoryAdjustmentKind;
  ledger: string;
  symbol: string | null;
  decimals: number;
  logo: string | null;
  id: string;
  timestampNs: string;
  balanceEffect: string;
  previousBalance: string;
  observedBalance: string;
  fromTipExclusive: string;
  toTipExclusive: string;
  detail: string;
};

export type HistoryRecord = HistoryTransaction | HistoryAdjustment;

export type HistoryCursor = {
  timestamp_ns: string;
  ledger: string;
  kind_order: string;
  id: string;
};

export type HistoryPage = {
  records: HistoryRecord[];
  next: HistoryCursor | null;
  hasMore: boolean;
  warning: string | null;
};

export type HistoryLedgerStatus = {
  ledger: string;
  symbol: string | null;
  enabled: boolean;
  source: "index" | "ledger" | "unavailable";
  state:
    | "idle"
    | "syncing"
    | "catching_up"
    | "waiting_for_index"
    | "permission_required"
    | "degraded";
  lastError: string | null;
  lastSuccessAt: string | null;
  transactionCount: string;
  adjustmentCount: string;
};

export type HistoryStatus = {
  running: boolean;
  ledgers: HistoryLedgerStatus[];
};

export type HistorySyncReport = {
  skippedOverlap: boolean;
  results: Array<{
    ledger: string;
    status: string;
    recordsAdded: string;
    error: string | null;
  }>;
};

const operations: HistoryOperation[] = [
  "transfer",
  "mint",
  "burn",
  "approve",
  "authorized_mint",
  "authorized_burn",
];
const verifications: HistoryVerification[] = [
  "pending",
  "verified",
  "prebaseline",
  "unverified_scan_limit",
];
const adjustmentKinds: HistoryAdjustmentKind[] = [
  "opening_balance",
  "unexplained_balance",
  "scan_limit",
  "unsupported_operation",
];

export function parseHistoryPage(value: unknown): HistoryPage {
  const record = requiredObject(value, "history page");
  if (!Array.isArray(record.records) || typeof record.has_more !== "boolean") {
    throw new Error("Invalid history page");
  }
  return {
    records: record.records.map(parseHistoryRecord),
    next: record.next == null ? null : parseCursor(record.next),
    hasMore: record.has_more,
    warning: optionalString(record.warning),
  };
}

export function parseHistoryStatus(value: unknown): HistoryStatus {
  const record = requiredObject(value, "history status");
  if (typeof record.running !== "boolean" || !Array.isArray(record.ledgers)) {
    throw new Error("Invalid history status");
  }
  return {
    running: record.running,
    ledgers: record.ledgers.map((candidate) => {
      const ledger = requiredObject(candidate, "ledger history status");
      if (
        typeof ledger.ledger !== "string" ||
        typeof ledger.enabled !== "boolean"
      ) {
        throw new Error("Invalid ledger history status");
      }
      return {
        ledger: ledger.ledger,
        symbol: optionalString(ledger.symbol),
        enabled: ledger.enabled,
        source: requiredVariant(
          ledger.source,
          ["index", "ledger", "unavailable"],
          "history source",
        ),
        state: requiredVariant(
          ledger.state,
          [
            "idle",
            "syncing",
            "catching_up",
            "waiting_for_index",
            "permission_required",
            "degraded",
          ],
          "history state",
        ),
        lastError: optionalString(ledger.last_error),
        lastSuccessAt: optionalInt(ledger.last_success_at),
        transactionCount: requiredNat(
          ledger.transaction_count,
          "history transaction count",
        ),
        adjustmentCount: requiredNat(
          ledger.adjustment_count,
          "history adjustment count",
        ),
      };
    }),
  };
}

export function parseHistorySyncReport(value: unknown): HistorySyncReport {
  const record = requiredObject(value, "history sync report");
  if (
    typeof record.skipped_overlap !== "boolean" ||
    !Array.isArray(record.ledgers)
  ) {
    throw new Error("Invalid history sync report");
  }
  return {
    skippedOverlap: record.skipped_overlap,
    results: record.ledgers.map((candidate) => {
      const result = requiredObject(candidate, "history sync result");
      if (typeof result.ledger !== "string" || typeof result.status !== "string") {
        throw new Error("Invalid history sync result");
      }
      return {
        ledger: result.ledger,
        status: result.status,
        recordsAdded: requiredNat(result.records_added, "history records added"),
        error: optionalString(result.error),
      };
    }),
  };
}

export function historyPageRequest(
  before: HistoryCursor | null,
  ledger: string | null,
  limit = 40,
): JsonObject {
  const request: JsonObject = { limit: String(limit) };
  if (ledger !== null) request.ledger = ledger;
  if (before !== null) {
    const kindOrder = Number(before.kind_order);
    if (!Number.isInteger(kindOrder) || kindOrder < 0 || kindOrder > 255) {
      throw new Error("Invalid history cursor kind");
    }
    request.before = {
      ...before,
      kind_order: kindOrder,
    };
  }
  return request;
}

export function historyRecordKey(record: HistoryRecord): string {
  return record.kind === "transaction"
    ? `${record.ledger}:transaction:${record.blockIndex}`
    : `${record.ledger}:adjustment:${record.id}`;
}

export function historyAddressText(address: HistoryAddress | null): string | null {
  if (!address) return null;
  return address.value;
}

function parseHistoryRecord(value: unknown): HistoryRecord {
  const [kind, payload] = variant(value, ["transaction", "adjustment"], "history record");
  const wrapper = requiredObject(payload, `${kind} history record`);
  if (kind === "transaction") {
    const transaction = requiredObject(wrapper.value, "history transaction");
    if (typeof wrapper.ledger !== "string") {
      throw new Error("Invalid history transaction ledger");
    }
    return {
      kind,
      ledger: wrapper.ledger,
      symbol: optionalString(wrapper.symbol),
      decimals: decimals(wrapper.decimals),
      logo: optionalString(wrapper.logo),
      blockIndex: requiredNat(transaction.block_index, "history block index"),
      operation: requiredVariant(
        transaction.operation,
        operations,
        "history operation",
      ),
      timestampNs: requiredNat(transaction.timestamp_ns, "history timestamp"),
      amount: requiredNat(transaction.amount, "history amount"),
      fee: optionalNat(transaction.fee),
      balanceEffect: requiredInt(transaction.balance_effect, "balance effect"),
      from: parseOptionalAddress(transaction.from),
      to: parseOptionalAddress(transaction.to),
      spender: parseOptionalAddress(transaction.spender),
      memo: optionalBlobHex(transaction.memo, "history memo"),
      intent: parseIntent(transaction.intent),
      native: parseNativeContext(transaction.native),
      provenance: requiredVariant(
        transaction.provenance,
        ["local_pending", "index", "ledger"],
        "history provenance",
      ),
      verification: requiredVariant(
        transaction.verification,
        verifications,
        "history verification",
      ),
    };
  }

  const adjustment = requiredObject(wrapper.value, "history adjustment");
  if (typeof adjustment.ledger !== "string" || typeof adjustment.detail !== "string") {
    throw new Error("Invalid history adjustment");
  }
  return {
    kind,
    adjustmentKind: requiredVariant(
      adjustment.kind,
      adjustmentKinds,
      "history adjustment kind",
    ),
    ledger: adjustment.ledger,
    symbol: optionalString(wrapper.symbol),
    decimals: decimals(wrapper.decimals),
    logo: optionalString(wrapper.logo),
    id: requiredNat(adjustment.id, "history adjustment id"),
    timestampNs: requiredNat(adjustment.timestamp_ns, "history adjustment timestamp"),
    balanceEffect: requiredInt(adjustment.balance_effect, "adjustment effect"),
    previousBalance: requiredNat(adjustment.previous_balance, "previous balance"),
    observedBalance: requiredNat(adjustment.observed_balance, "observed balance"),
    fromTipExclusive: requiredNat(
      adjustment.from_tip_exclusive,
      "adjustment start",
    ),
    toTipExclusive: requiredNat(adjustment.to_tip_exclusive, "adjustment end"),
    detail: adjustment.detail,
  };
}

function parseCursor(value: unknown): HistoryCursor {
  const record = requiredObject(value, "history cursor");
  if (typeof record.ledger !== "string") throw new Error("Invalid history cursor");
  return {
    timestamp_ns: requiredNat(record.timestamp_ns, "cursor timestamp"),
    ledger: record.ledger,
    kind_order: requiredNat(record.kind_order, "cursor kind"),
    id: requiredNat(record.id, "cursor id"),
  };
}

function parseOptionalAddress(value: unknown): HistoryAddress | null {
  if (value == null) return null;
  const [kind, payload] = variant(
    value,
    ["icrc", "icp_account_identifier"],
    "history address",
  );
  if (kind === "icp_account_identifier") {
    return {
      kind,
      value: fixedBlobHex(payload, 32, "ICP account id"),
    };
  }
  return { kind, value: parseIcrcAccount(payload) };
}

function parseIntent(value: unknown): HistoryIntent | null {
  if (value == null) return null;
  const record = requiredObject(value, "history intent");
  if (
    typeof record.contact_name !== "string" ||
    typeof record.network !== "string" ||
    typeof record.destination !== "string" ||
    typeof record.native !== "boolean"
  ) {
    throw new Error("Invalid history intent");
  }
  return {
    contactId: requiredNat(record.contact_id, "history contact id"),
    addressId: requiredNat(record.address_id, "history address id"),
    contactName: record.contact_name,
    addressLabel: optionalString(record.address_label),
    network: record.network,
    destination: record.destination,
    native: record.native,
  };
}

function parseNativeContext(value: unknown): NativeHistoryContext | null {
  if (value == null) return null;
  const record = requiredObject(value, "native history context");
  if (typeof record.network !== "string") {
    throw new Error("Invalid native history context");
  }
  return {
    network: record.network,
    transactionId: optionalString(record.transaction_id),
    outputIndex: optionalNat(record.output_index),
    relatedLedger: optionalString(record.related_ledger),
    relatedBlockIndex: optionalNat(record.related_block_index),
  };
}

function requiredVariant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  return variant(value, allowed, label)[0];
}

function variant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): [T, unknown] {
  const record = requiredObject(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw new Error(`Invalid ${label}`);
  }
  const key = keys[0] as T;
  return [key, record[key] ?? null];
}

function parseIcrcAccount(value: unknown): string {
  const account = requiredObject(value, "ICRC history account");
  const owner = requiredPrincipal(account.owner, "ICRC history account owner");
  const subaccount = account.subaccount == null
    ? undefined
    : requiredBytes(
      account.subaccount,
      32,
      "ICRC history account subaccount",
    );
  return encodeIcrcAccount({
    owner,
    ...(subaccount === undefined ? {} : { subaccount }),
  });
}

function requiredPrincipal(value: unknown, label: string): Principal {
  try {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("missing principal");
    }
    const principal = Principal.fromText(value);
    if (principal.toText() !== value) throw new Error("noncanonical principal");
    return principal;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function optionalBlobHex(value: unknown, label: string): string | null {
  return value == null ? null : blobHex(value, label);
}

function fixedBlobHex(
  value: unknown,
  byteLength: number,
  label: string,
): string {
  return bytesToHex(requiredBytes(value, byteLength, label));
}

function blobHex(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array)) throw new Error(`Invalid ${label}`);
  return bytesToHex(value);
}

function requiredBytes(
  value: unknown,
  byteLength: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    throw new Error(`Invalid ${label}`);
  }
  return Uint8Array.from(value);
}

function bytesToHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNat(value: unknown): string | null {
  return value == null ? null : requiredNat(value, "natural number");
}

function optionalInt(value: unknown): string | null {
  return value == null ? null : requiredInt(value, "integer");
}

function requiredNat(value: unknown, label: string): string {
  const result = requiredInt(value, label);
  if (result.startsWith("-")) throw new Error(`Invalid ${label}`);
  return result;
}

function requiredInt(value: unknown, label: string): string {
  try {
    return BigInt(value as string | number | bigint).toString();
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function decimals(value: unknown): number {
  const parsed = optionalNat(value);
  if (parsed === null || BigInt(parsed) > 255n) return 0;
  return Number(parsed);
}
