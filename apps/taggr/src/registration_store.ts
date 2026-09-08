// A registration payment must keep its original Wallet request after a lost
// reply or a background reload. This journal contains payment instructions and
// receipt evidence only; the identity and settings storage remain separate.
import { Principal } from "@icp-sdk/core/principal";
import {
  ICP_LEDGER,
  invoiceAccountText,
  isFundingBlockIndex,
  type WalletFundingRequest,
} from "./wallet.ts";

export type RegistrationFundingScope = {
  taggrCanister: string;
  principal: string;
};

export type RegistrationFundingRecord = {
  version: 1;
  request: WalletFundingRequest;
  status: "requested" | "transferred" | "rejected";
  blockIndex: string | null;
};

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class RegistrationFundingStorageError extends Error {}

const storage = (provided?: JournalStorage): JournalStorage => {
  if (provided) return provided;
  try {
    const value = globalThis.localStorage;
    if (value) return value;
  } catch {
    // Access to localStorage itself can fail, before any getItem/setItem call.
  }
  throw new RegistrationFundingStorageError(
    "Persistent storage is unavailable. The registration payment cannot safely start or resume.",
  );
};

const journalKey = (scope: RegistrationFundingScope): string => {
  try {
    const canister = Principal.fromText(scope.taggrCanister).toText();
    const principal = Principal.fromText(scope.principal).toText();
    return `taggr.registration-funding.v1:${canister}:${principal}`;
  } catch {
    throw new RegistrationFundingStorageError("The registration payment identity is invalid.");
  }
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const invalidRecord = (): never => {
  throw new RegistrationFundingStorageError(
    "The saved registration payment is not readable. Keep its saved data and reconcile the original Wallet request before making another payment.",
  );
};

const validate = (
  scope: RegistrationFundingScope,
  value: unknown,
): RegistrationFundingRecord => {
  if (
    !object(value) ||
    !onlyKeys(value, ["version", "request", "status", "blockIndex"]) ||
    value.version !== 1 ||
    !object(value.request) ||
    !["requested", "transferred", "rejected"].includes(value.status as string)
  ) return invalidRecord();

  const request = value.request;
  if (
    !onlyKeys(request, ["requestId", "ledger", "amountAtoms", "validUntilNs", "route"]) ||
    typeof request.requestId !== "string" ||
    !/^[0-9a-f]{32}$/.test(request.requestId) ||
    request.ledger !== ICP_LEDGER ||
    typeof request.amountAtoms !== "string" ||
    !/^[1-9][0-9]{0,79}$/.test(request.amountAtoms) ||
    typeof request.validUntilNs !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(request.validUntilNs) ||
    BigInt(request.validUntilNs) > 18_446_744_073_709_551_615n ||
    !object(request.route) ||
    !onlyKeys(request.route, ["kind", "to", "memoHex"]) ||
    request.route.kind !== "direct" ||
    request.route.to !== invoiceAccountText(scope) ||
    (request.route.memoHex !== undefined && (
      typeof request.route.memoHex !== "string" ||
      !/^[0-9a-f]{0,64}$/.test(request.route.memoHex)
    ))
  ) return invalidRecord();

  if (value.status === "transferred") {
    if (!isFundingBlockIndex(value.blockIndex)) return invalidRecord();
  } else if (value.blockIndex !== null) {
    return invalidRecord();
  }

  // Do not compare validUntilNs to the clock: Wallet resolves known requests
  // before checking whether a new request would still be valid.
  return value as RegistrationFundingRecord;
};

export const loadRegistrationFunding = (
  scope: RegistrationFundingScope,
  provided?: JournalStorage,
): RegistrationFundingRecord | null => {
  const key = journalKey(scope);
  let raw: string | null;
  try {
    raw = storage(provided).getItem(key);
  } catch {
    throw new RegistrationFundingStorageError(
      "The saved registration payment could not be read. Try again before starting another payment.",
    );
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidRecord();
  }
  return validate(scope, value);
};

export const saveRegistrationFunding = (
  scope: RegistrationFundingScope,
  record: RegistrationFundingRecord,
  provided?: JournalStorage,
): void => {
  const key = journalKey(scope);
  const serialized = JSON.stringify(validate(scope, record));
  const target = storage(provided);
  const previous = loadRegistrationFunding(scope, target);
  if (previous && previous.status !== "rejected") {
    if (JSON.stringify(previous.request) !== JSON.stringify(record.request)) {
      throw new RegistrationFundingStorageError(
        "The original registration payment must be reconciled before a different payment can be saved.",
      );
    }
    if (previous.status === "transferred" && (
      record.status !== "transferred" || record.blockIndex !== previous.blockIndex
    )) {
      throw new RegistrationFundingStorageError("The confirmed registration payment cannot be replaced.");
    }
  }
  try {
    target.setItem(key, serialized);
    if (target.getItem(key) !== serialized) throw new Error("Payment was not saved");
  } catch {
    throw new RegistrationFundingStorageError(
      "The registration payment could not be saved. Keep the original Wallet request and retry it before starting another payment.",
    );
  }
};

/** Remove only after the registration is reconciled, never on a timeout. */
export const removeRegistrationFunding = (
  scope: RegistrationFundingScope,
  provided?: JournalStorage,
): void => {
  const key = journalKey(scope);
  const target = storage(provided);
  try {
    target.removeItem(key);
    if (target.getItem(key) !== null) throw new Error("Payment was not removed");
  } catch {
    throw new RegistrationFundingStorageError(
      "The registration payment record could not be cleared. Its original request remains safe to reconcile.",
    );
  }
};
