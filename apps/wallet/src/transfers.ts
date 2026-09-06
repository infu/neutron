import type { JsonValue, SelfCallObject } from "neutron-tools/app";

export type SavedWalletTransfer = {
  requestId: string;
  transfer: SelfCallObject;
  withdrawalQuote?: SelfCallObject;
};
export type WalletTransferOperation = {
  requestId: string;
  ledger: string;
  amount: string;
  destination: string;
  status: "pending" | "succeeded" | "rejected";
  message: string | null;
  receipt: JsonValue | null;
  native: boolean;
  settlement: { status: "pending" | "submitted" | "confirmed" | "failed" | "unknown"; message: string; transactionHash: string | null } | null;
};

function key(owner: string): string { return `wallet:transfers:v2:${owner}`; }
const pageCache = new Map<string, string>();
function readCache(owner: string): string | null {
  const cached = pageCache.get(owner);
  if (cached !== undefined) return cached;
  try { return localStorage.getItem(key(owner)); }
  catch { return null; }
}
function writeCache(owner: string, value: string): void {
  pageCache.set(owner, value);
  try { localStorage.setItem(key(owner), value); } catch { /* Backend prepare is authoritative in opaque-origin tiles. */ }
}
// Preserve ICRC subaccounts exactly; ordinary JSON turns Uint8Array into an
// object with numeric keys that the self-call encoder cannot interpret.
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array
    ? { walletTransferBlobV2: [...item] }
    : item);
}
function decode(text: string): unknown {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item) && "walletTransferBlobV2" in item) {
      const bytes = item.walletTransferBlobV2;
      if (Object.keys(item).length !== 1 || !Array.isArray(bytes) || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Invalid saved transfer subaccount");
      return Uint8Array.from(bytes);
    }
    return item;
  });
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new Error("Invalid saved transfer request ID");
  return value;
}
export function transferIdBytes(id: string): Uint8Array {
  return Uint8Array.from(requestId(id).match(/../g)!, (part) => Number.parseInt(part, 16));
}
export function loadSavedWalletTransfers(owner: string): SavedWalletTransfer[] {
  const raw = readCache(owner);
  if (raw === null) return [];
  const value = decode(raw);
  if (!Array.isArray(value)) throw new Error("Saved Wallet transfers cannot be read. Existing requests must be recovered before a fresh send.");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("requestId" in entry) || !("transfer" in entry) || !entry.transfer || typeof entry.transfer !== "object" || Array.isArray(entry.transfer)) {
      throw new Error("Invalid saved Wallet transfer. Keep the saved record for recovery.");
    }
    const quote = "withdrawalQuote" in entry ? entry.withdrawalQuote : undefined;
    if (quote !== undefined && (!quote || typeof quote !== "object" || Array.isArray(quote))) throw new Error("Invalid saved withdrawal review");
    return { requestId: requestId(entry.requestId), transfer: entry.transfer as SelfCallObject,
      ...(quote === undefined ? {} : { withdrawalQuote: quote as SelfCallObject }) };

  });
}
export function saveWalletTransfer(owner: string, transfer: SelfCallObject, withdrawalQuote?: SelfCallObject): SavedWalletTransfer {
  const saved = loadSavedWalletTransfers(owner);
  const intent = encode(transfer);
  const existing = saved.find((value) => encode(value.transfer) === intent);
  if (existing) return existing;
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const value = { requestId: id, transfer, ...(withdrawalQuote === undefined ? {} : { withdrawalQuote }) };
  writeCache(owner, encode([...saved, value]));
  return value;
}
export function finishSavedWalletTransfer(owner: string, id: string): void {
  writeCache(owner, encode(loadSavedWalletTransfers(owner).filter((entry) => entry.requestId !== id)));
}
export function savedTransferArgs(saved: SavedWalletTransfer): SelfCallObject {
  return { request_id: transferIdBytes(saved.requestId), transfer: saved.transfer,
    ...(saved.withdrawalQuote === undefined ? {} : { withdrawal_quote: saved.withdrawalQuote }) };
}
export function localTransferOperation(saved: SavedWalletTransfer): WalletTransferOperation {
  return {
    requestId: saved.requestId,
    ledger: String(saved.transfer.ledger),
    amount: String(saved.transfer.amount),
    destination: "Saved destination",
    status: "pending",
    message: "Request saved. Resume to recover its exact outcome.",
    receipt: null,
    native: !saved.transfer.network || typeof saved.transfer.network !== "object" || !("internet_computer" in saved.transfer.network),
    settlement: null,
  };
}
export function parseTransferOperation(value: unknown): WalletTransferOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Wallet transfer operation");
  const record = value as Record<string, unknown>;
  const bytes = record.request_id;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error("Invalid Wallet transfer operation ID");
  const status = record.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Invalid Wallet transfer status");
  const entries = Object.entries(status);
  const state = entries[0]?.[0];
  if (entries.length !== 1 || (state !== "pending" && state !== "succeeded" && state !== "rejected")) throw new Error("Invalid Wallet transfer status");
  if (typeof record.ledger !== "string" || typeof record.destination !== "string" || typeof record.amount !== "string" || !/^\d+$/.test(record.amount)) throw new Error("Invalid Wallet transfer summary");
  if (state === "succeeded") {
    const receipt = entries[0]![1];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
        !("duplicate" in receipt) || typeof receipt.duplicate !== "boolean" ||
        !("native" in receipt) || typeof receipt.native !== "boolean" ||
        !("block_index" in receipt) || typeof receipt.block_index !== "string" || !/^\d+$/.test(receipt.block_index)) {
      throw new Error("Invalid Wallet transfer receipt");
    }
  }
  return {
    requestId: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ledger: record.ledger,
    amount: record.amount,
    destination: record.destination,
    status: state,
    message: state === "rejected" ? String(entries[0]![1]) : typeof record.message === "string" ? record.message : null,
    receipt: state === "succeeded" ? entries[0]![1] as JsonValue : null,
    native: record.native === true,
    settlement: parseSettlement(record.settlement),
  };
}

function parseSettlement(value: unknown): WalletTransferOperation["settlement"] {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || !("status" in value) || !value.status || typeof value.status !== "object" || Array.isArray(value.status)) throw new Error("Invalid native withdrawal settlement");
  const entries = Object.entries(value.status);
  if (entries.length !== 1) throw new Error("Invalid native withdrawal settlement");
  const [status, payload] = entries[0]!;
  if (status === "confirmed" || status === "submitted") {
    if (!payload || typeof payload !== "object" || !("transaction_hash" in payload) || typeof payload.transaction_hash !== "string") throw new Error("Invalid native transaction hash");
    return { status, transactionHash: payload.transaction_hash,
      message: status === "confirmed" ? "Native withdrawal confirmed" : "Native transaction submitted; settlement pending" };
  }
  if ((status !== "pending" && status !== "failed" && status !== "unknown") || typeof payload !== "string") throw new Error("Invalid native withdrawal settlement");
  return { status, transactionHash: null, message: payload };
}
