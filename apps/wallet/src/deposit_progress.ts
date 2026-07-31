import { isJsonObject, type JsonObject } from "neutron-tools/app";

const MAX_ACTIVE_DEPOSITS = 64;
const MAX_RECENT_MINTED = 20;

export type WalletPendingDeposit = {
  txid: string;
  vout: string;
  value: string;
  confirmations: string;
  requiredConfirmations: string;
};

export type WalletProcessingDeposit = {
  txid: string;
  vout: string;
  value: string;
};

export type WalletMintedDeposit = WalletProcessingDeposit & {
  mintedAmount: string;
  blockIndex: string;
  mintedAt: string;
};

export type WalletDepositIssueKind =
  | "value_too_small"
  | "tainted"
  | "quarantined";

export type WalletDepositIssue = WalletProcessingDeposit & {
  kind: WalletDepositIssueKind;
  earliestRetry: string | null;
};

export type WalletNativeDepositProgress = {
  checkedAt: string;
  currentConfirmations: string | null;
  requiredConfirmations: string | null;
  pending: WalletPendingDeposit[];
  processing: WalletProcessingDeposit[];
  recentMinted: WalletMintedDeposit[];
  issues: WalletDepositIssue[];
};

export function parseNativeDepositProgress(
  value: unknown,
): WalletNativeDepositProgress | null {
  if (value === null || value === undefined) return null;
  const record = requiredObject(value, "native deposit progress");
  return {
    checkedAt: requiredInt(record.checked_at, "deposit check time"),
    currentConfirmations: optionalNat(record.current_confirmations),
    requiredConfirmations: optionalNat(record.required_confirmations),
    pending: boundedArray(
      record.pending,
      MAX_ACTIVE_DEPOSITS,
      "pending deposits",
    ).map(parsePending),
    processing: boundedArray(
      record.processing,
      MAX_ACTIVE_DEPOSITS,
      "processing deposits",
    ).map(parseProcessing),
    recentMinted: boundedArray(
      record.recent_minted,
      MAX_RECENT_MINTED,
      "recent minted deposits",
    ).map(parseMinted),
    issues: boundedArray(
      record.issues,
      MAX_ACTIVE_DEPOSITS,
      "deposit issues",
    ).map(parseIssue),
  };
}

export function depositOutpoint(deposit: {
  txid: string;
  vout: string;
}): string {
  const txid =
    deposit.txid.length > 18
      ? `${deposit.txid.slice(0, 10)}...${deposit.txid.slice(-6)}`
      : deposit.txid;
  return `${txid}:${deposit.vout}`;
}

export function confirmationPercent(
  confirmations: string,
  requiredConfirmations: string,
): number {
  const current = BigInt(confirmations);
  const required = BigInt(requiredConfirmations);
  if (required === 0n || current >= required) return 100;
  return Number((current * 100n) / required);
}

export function confirmationsRemaining(
  confirmations: string,
  requiredConfirmations: string,
): string {
  const current = BigInt(confirmations);
  const required = BigInt(requiredConfirmations);
  return (current >= required ? 0n : required - current).toString();
}

function parsePending(value: unknown): WalletPendingDeposit {
  const record = requiredObject(value, "pending deposit");
  return {
    ...parseOutpointValue(record),
    confirmations: requiredNat(record.confirmations, "confirmations"),
    requiredConfirmations: requiredNat(
      record.required_confirmations,
      "required confirmations",
    ),
  };
}

function parseProcessing(value: unknown): WalletProcessingDeposit {
  return parseOutpointValue(requiredObject(value, "processing deposit"));
}

function parseMinted(value: unknown): WalletMintedDeposit {
  const record = requiredObject(value, "minted deposit");
  return {
    ...parseOutpointValue(record),
    mintedAmount: requiredNat(record.minted_amount, "minted amount"),
    blockIndex: requiredNat(record.block_index, "mint block index"),
    mintedAt: requiredInt(record.minted_at, "mint time"),
  };
}

function parseIssue(value: unknown): WalletDepositIssue {
  const record = requiredObject(value, "deposit issue");
  const kindRecord = requiredObject(record.kind, "deposit issue kind");
  const kinds = Object.keys(kindRecord);
  if (
    kinds.length !== 1 ||
    (kinds[0] !== "value_too_small" &&
      kinds[0] !== "tainted" &&
      kinds[0] !== "quarantined")
  ) {
    throw new Error("Invalid deposit issue kind");
  }
  return {
    ...parseOutpointValue(record),
    kind: kinds[0],
    earliestRetry: optionalNat(record.earliest_retry),
  };
}

function parseOutpointValue(record: JsonObject): WalletProcessingDeposit {
  if (
    typeof record.txid !== "string" ||
    record.txid.length === 0 ||
    record.txid.length > 96
  ) {
    throw new Error("Invalid deposit transaction id");
  }
  return {
    txid: record.txid,
    vout: requiredNat(record.vout, "deposit output index"),
    value: requiredNat(record.value, "deposit value"),
  };
}

function boundedArray(
  value: unknown,
  limit: number,
  label: string,
): unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function requiredNat(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalNat(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredNat(value, "optional natural number");
}

function requiredInt(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
