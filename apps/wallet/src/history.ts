import { isJsonObject, type JsonObject } from "neutron-tools/app";
import {
  bytesToHex,
  parseCandidIcrcAccount,
  parseFixedBytes,
} from "./icrc_account.ts";

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
  index: string | null;
  state:
    | "idle"
    | "syncing"
    | "catching_up"
    | "waiting_for_index"
    | "permission_required"
    | "degraded";
  lastError: string | null;
  checkpoint: HistoryCheckpoint | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  transactionCount: string;
  adjustmentCount: string;
};

export type HistoryCheckpoint = {
  tipExclusive: string;
  balance: string;
  checkedAt: string;
};

export type HistoryStatus = {
  running: boolean;
  ledgers: HistoryLedgerStatus[];
};

export type HistorySyncReport = {
  startedAt: string | null;
  finishedAt: string | null;
  skippedOverlap: boolean;
  results: Array<{
    ledger: string;
    status: string;
    recordsAdded: string;
    checkpoint: HistoryCheckpoint | null;
    error: string | null;
  }>;
};

const nullableTextSchema: JsonObject = { oneOf: [{ type: "string" }, { type: "null" }] };
const natSchema: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]{0,79}$" };
const intSchema: JsonObject = { type: "string", pattern: "^-?0$|^-?[1-9][0-9]{0,79}$" };
const nullableIntSchema: JsonObject = { oneOf: [intSchema, { type: "null" }] };
const checkpointSchema: JsonObject = {
  description: "Last committed reconciliation checkpoint. checkedAt is nanoseconds and can advance after an unchanged-balance check without reading history. For an index, tipExclusive is the newest committed account block plus one; for direct ledger scans it is the captured ledger boundary. It is not proof of complete history or an absent payout.",
  oneOf: [{ type: "null" }, {
    type: "object",
    required: ["tipExclusive", "balance", "checkedAt"],
    properties: { tipExclusive: natSchema, balance: natSchema, checkedAt: intSchema },
    additionalProperties: false,
  }],
};

export const historyStatusSchema: JsonObject = {
  type: "object",
  description: "Cached per-ledger reconciliation status. lastSuccessAt records a successful checkpoint action, including baseline, unchanged-balance, or incomplete scan-limit reconciliation; it does not establish complete or freshly indexed transaction history.",
  required: ["running", "ledgers"],
  properties: {
    running: { type: "boolean" },
    ledgers: {
      type: "array",
      items: {
        type: "object",
        required: ["ledger", "symbol", "enabled", "source", "index", "state", "checkpoint", "lastAttemptAt", "lastSuccessAt", "lastError", "transactionCount", "adjustmentCount"],
        properties: {
          ledger: { type: "string" },
          symbol: nullableTextSchema,
          enabled: { type: "boolean" },
          source: { type: "string", enum: ["index", "ledger", "unavailable"] },
          index: nullableTextSchema,
          state: { type: "string", enum: ["idle", "syncing", "catching_up", "waiting_for_index", "permission_required", "degraded"] },
          checkpoint: checkpointSchema,
          lastAttemptAt: nullableIntSchema,
          lastSuccessAt: nullableIntSchema,
          lastError: nullableTextSchema,
          transactionCount: natSchema,
          adjustmentCount: natSchema,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const historySyncReportSchema: JsonObject = {
  type: "object",
  description: "One history synchronization attempt. unchanged means no history-source scan was needed by balance reconciliation; baseline does not backfill prior history. skippedOverlap means another attempt was already running. Inspect each status and error; a finished attempt does not prove complete history.",
  required: ["startedAt", "finishedAt", "skippedOverlap", "results"],
  properties: {
    startedAt: nullableIntSchema,
    finishedAt: nullableIntSchema,
    skippedOverlap: { type: "boolean" },
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["ledger", "status", "recordsAdded", "checkpoint", "error"],
        properties: {
          ledger: { type: "string" },
          status: { type: "string" },
          recordsAdded: natSchema,
          checkpoint: checkpointSchema,
          error: nullableTextSchema,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
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
  return parseStatus(value, false);
}

export function parseNormalizedHistoryStatus(value: unknown): HistoryStatus {
  return parseStatus(value, true);
}

function parseStatus(value: unknown, normalized: boolean): HistoryStatus {
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
      const source = requiredVariant(
        normalized ? { [String(ledger.source)]: ledger.index } : ledger.source,
        ["index", "ledger", "unavailable"],
        "history source",
      );
      const index = source === "index"
        ? optionalString(normalized ? ledger.index : (ledger.source as JsonObject).index)
        : null;
      const field = (wire: string, camel: string): unknown => ledger[normalized ? camel : wire];
      return {
        ledger: ledger.ledger,
        symbol: optionalString(ledger.symbol),
        enabled: ledger.enabled,
        source,
        index,
        state: requiredVariant(
          normalized ? { [String(ledger.state)]: null } : ledger.state,
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
        checkpoint: parseCheckpoint(ledger.checkpoint, normalized),
        lastAttemptAt: optionalInt(field("last_attempt_at", "lastAttemptAt")),
        lastError: optionalString(field("last_error", "lastError")),
        lastSuccessAt: optionalInt(field("last_success_at", "lastSuccessAt")),
        transactionCount: requiredNat(
          field("transaction_count", "transactionCount"),
          "history transaction count",
        ),
        adjustmentCount: requiredNat(
          field("adjustment_count", "adjustmentCount"),
          "history adjustment count",
        ),
      };
    }),
  };
}

export function parseHistorySyncReport(value: unknown): HistorySyncReport {
  return parseSyncReport(value, false);
}

export function parseNormalizedHistorySyncReport(value: unknown): HistorySyncReport {
  return parseSyncReport(value, true);
}

function parseSyncReport(value: unknown, normalized: boolean): HistorySyncReport {
  const record = requiredObject(value, "history sync report");
  const skippedOverlap = record[normalized ? "skippedOverlap" : "skipped_overlap"];
  const results = record[normalized ? "results" : "ledgers"];
  if (
    typeof skippedOverlap !== "boolean" ||
    !Array.isArray(results)
  ) {
    throw new Error("Invalid history sync report");
  }
  return {
    startedAt: optionalInt(record[normalized ? "startedAt" : "started_at"]),
    finishedAt: optionalInt(record[normalized ? "finishedAt" : "finished_at"]),
    skippedOverlap,
    results: results.map((candidate) => {
      const result = requiredObject(candidate, "history sync result");
      if (typeof result.ledger !== "string" || typeof result.status !== "string") {
        throw new Error("Invalid history sync result");
      }
      return {
        ledger: result.ledger,
        status: result.status,
        recordsAdded: requiredNat(result[normalized ? "recordsAdded" : "records_added"], "history records added"),
        checkpoint: parseCheckpoint(result.checkpoint, normalized),
        error: optionalString(result.error),
      };
    }),
  };
}

function parseCheckpoint(value: unknown, normalized = false): HistoryCheckpoint | null {
  if (value == null) return null;
  const checkpoint = requiredObject(value, "history checkpoint");
  return {
    tipExclusive: requiredNat(checkpoint[normalized ? "tipExclusive" : "tip_exclusive"], "history checkpoint tip"),
    balance: requiredNat(checkpoint.balance, "history checkpoint balance"),
    checkedAt: requiredInt(checkpoint[normalized ? "checkedAt" : "checked_at"], "history checkpoint time"),
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
  return {
    kind,
    value: parseCandidIcrcAccount(payload, "ICRC history account"),
  };
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

function optionalBlobHex(value: unknown, label: string): string | null {
  return value == null ? null : blobHex(value, label);
}

function fixedBlobHex(
  value: unknown,
  byteLength: number,
  label: string,
): string {
  return bytesToHex(parseFixedBytes(value, byteLength, label));
}

function blobHex(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array)) throw new Error(`Invalid ${label}`);
  return bytesToHex(value);
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
