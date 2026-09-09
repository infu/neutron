import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import { Principal as AccountPrincipal } from "@icp-sdk/core/principal";
import type { DirectLookup, HistoryQuery, IndexPageData, TransactionAddress, WalletTransaction } from "./history_transaction.ts";

// ICP ledger/index DIDs: dfinity/ic, rs/ledger_suite/icp/{ledger.did,index/index.did}.
// Keep their distinct account and timestamp wire representations explicit.
const blob = IDL.Vec(IDL.Nat8);
const tokens = IDL.Record({ e8s: IDL.Nat64 });
const timestamp = IDL.Record({ timestamp_nanos: IDL.Nat64 });
function operationType(address: IDL.Type) {
  return IDL.Variant({
    Mint: IDL.Record({ to: address, amount: tokens }),
    Burn: IDL.Record({ from: address, amount: tokens, spender: IDL.Opt(address) }),
    Transfer: IDL.Record({ from: address, to: address, amount: tokens, fee: tokens, spender: IDL.Opt(address) }),
    Approve: IDL.Record({ from: address, spender: address, allowance: tokens, fee: tokens,
      expires_at: IDL.Opt(timestamp), expected_allowance: IDL.Opt(tokens) }),
  });
}
export const icpLedgerBlockType = IDL.Record({
  transaction: IDL.Record({ memo: IDL.Nat64, icrc1_memo: IDL.Opt(blob), operation: IDL.Opt(operationType(blob)), created_at_time: timestamp }),
  timestamp,
});
export const icpLedgerBlockArgsType = IDL.Record({ start: IDL.Nat64, length: IDL.Nat64 });
export const icpArchiveResultType = IDL.Variant({
  Ok: IDL.Record({ blocks: IDL.Vec(icpLedgerBlockType) }),
  Err: IDL.Variant({
    BadFirstBlockIndex: IDL.Record({ requested_index: IDL.Nat64, first_valid_index: IDL.Nat64 }),
    Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
  }),
});
export const icpLedgerResponseType = IDL.Record({
  chain_length: IDL.Nat64, first_block_index: IDL.Nat64, blocks: IDL.Vec(icpLedgerBlockType),
  archived_blocks: IDL.Vec(IDL.Record({ start: IDL.Nat64, length: IDL.Nat64,
    callback: IDL.Func([icpLedgerBlockArgsType], [icpArchiveResultType], ["query"]) })),
});
export const icpIndexAccountArgsType = IDL.Record({
  account: IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(blob) }), start: IDL.Opt(IDL.Nat), max_results: IDL.Nat,
});
export const icpIndexResponseType = IDL.Variant({
  Ok: IDL.Record({ balance: IDL.Nat64, oldest_tx_id: IDL.Opt(IDL.Nat64), transactions: IDL.Vec(IDL.Record({
    id: IDL.Nat64,
    transaction: IDL.Record({ memo: IDL.Nat64, icrc1_memo: IDL.Opt(blob), operation: operationType(IDL.Text),
      created_at_time: IDL.Opt(timestamp), timestamp: IDL.Opt(timestamp) }),
  })) }),
  Err: IDL.Record({ message: IDL.Text }),
});
export const icpIndexStatusType = IDL.Record({ num_blocks_synced: IDL.Nat64 });

export async function readIcpTransaction(
  query: HistoryQuery, ledger: string, owner: string, block: bigint, signal?: AbortSignal,
): Promise<DirectLookup> {
  nat64(block, "requested block");
  const wallet = walletIdentifier(owner);
  const args = { start: block, length: 1n };
  const response = record(await query({ canister: ledger, method: "query_blocks", args: [args],
    argTypes: [icpLedgerBlockArgsType], resultType: icpLedgerResponseType, ...(signal ? { signal } : {}) }), "ledger response");
  const chainLength = nat64(response.chain_length, "chain length");
  const blocks = vector(response.blocks, "ledger blocks");
  const archived = vector(response.archived_blocks, "archive ranges");
  if (blocks.length > 1 || archived.length > 1 || (blocks.length && archived.length)) {
    throw new Error("ICP ledger returned conflicting data or data outside the exact block request");
  }
  const observation = { chainLength: chainLength.toString(), sourceCanister: ledger, sourceMethod: "query_blocks", archived: false };
  if (blocks.length === 1) {
    if (nat64(response.first_block_index, "first block index") !== block || block >= chainLength) {
      throw new Error("ICP ledger returned the wrong block index");
    }
    return { ...observation, transaction: ledgerTransaction(blocks[0], block, wallet) };
  }
  if (archived.length === 1) {
    const range = record(archived[0], "archive range");
    if (nat64(range.start, "archive start") !== block || nat64(range.length, "archive length") !== 1n || block >= chainLength) {
      throw new Error("ICP ledger archive range does not match the exact block request");
    }
    const callback = range.callback;
    if (!Array.isArray(callback) || callback.length !== 2 || typeof callback[1] !== "string" || !callback[1]) {
      throw new Error("ICP ledger returned an invalid archive callback");
    }
    const canister = Principal.from(callback[0]).toText();
    const method = callback[1];
    // The callback comes exclusively from this exact ledger response. The
    // caller cannot supply an archive destination, and this is a query only.
    const archive = unwrap(await query({ canister, method, args: [args], argTypes: [icpLedgerBlockArgsType],
      resultType: icpArchiveResultType, ...(signal ? { signal } : {}) }), "archive");
    const values = vector(archive.blocks, "archive blocks");
    if (values.length !== 1) throw new Error("ICP archive did not return the exact requested block");
    return { chainLength: chainLength.toString(), sourceCanister: canister, sourceMethod: method, archived: true,
      transaction: ledgerTransaction(values[0], block, wallet) };
  }
  if (block < chainLength) throw new Error("ICP ledger omitted the requested existing block and archive range");
  return { ...observation, transaction: null };
}

export async function readIcpAccountPage(
  query: HistoryQuery, index: string, owner: string, before: bigint | null, limit: bigint, signal?: AbortSignal,
): Promise<IndexPageData> {
  if (before !== null && before < 0n) throw new Error("Invalid ICP index cursor");
  if (limit <= 0n) throw new Error("Invalid ICP index page length");
  const wallet = walletIdentifier(owner);
  const response = unwrap(await query({ canister: index, method: "get_account_transactions",
    args: [{ account: { owner: Principal.fromText(owner), subaccount: [] }, start: before === null ? [] : [before], max_results: limit }],
    argTypes: [icpIndexAccountArgsType], resultType: icpIndexResponseType, ...(signal ? { signal } : {}) }), "index");
  const values = vector(response.transactions, "index transactions");
  if (BigInt(values.length) > limit) throw new Error("ICP index returned more transactions than requested");
  const oldest = optional(response.oldest_tx_id, "oldest transaction", value => nat64(value, "oldest transaction"));
  let previous = before;
  let newest: bigint | null = null;
  const transactions: WalletTransaction[] = [];
  for (const value of values) {
    const entry = record(value, "indexed transaction");
    const id = nat64(entry.id, "index block id");
    if (previous !== null && id >= previous) throw new Error("ICP index transaction ids overlap the cursor or are not strictly descending");
    if (oldest === null || id < oldest) throw new Error("ICP index returned an invalid oldest transaction id");
    newest ??= id;
    previous = id;
    const transaction = record(entry.transaction, "index transaction");
    const observed = optional(transaction.timestamp, "transaction timestamp", value => timestampNs(value));
    const created = optional(transaction.created_at_time, "transaction creation timestamp", value => timestampNs(value));
    if (observed === null && created === null) throw new Error("ICP index transaction timestamp is unavailable");
    const normalized = normalize(transaction, transaction.operation, id, observed ?? created!, wallet, "text");
    if (normalized) transactions.push(normalized);
  }
  if (values.length === 0 && oldest !== null && (before === null || before > oldest)) {
    throw new Error("ICP index omitted the requested account transactions");
  }
  const completeToOldest = values.length === 0 || previous === oldest;
  return { transactions, indexedAccountBalanceAtoms: nat64(response.balance, "index balance").toString(),
    oldestBlock: oldest?.toString() ?? null, nextBeforeBlock: completeToOldest ? null : previous!.toString(),
    hasMore: !completeToOldest, completeToOldest, newestAccountBlock: before === null ? newest?.toString() ?? null : null };
}

export async function readIcpIndexedBlocks(query: HistoryQuery, index: string, signal?: AbortSignal): Promise<string> {
  const response = record(await query({ canister: index, method: "status", args: [], argTypes: [], resultType: icpIndexStatusType, ...(signal ? { signal } : {}) }), "index status");
  return nat64(response.num_blocks_synced, "indexed block count").toString();
}

function ledgerTransaction(value: unknown, block: bigint, wallet: string): WalletTransaction | null {
  const recordValue = record(value, "ledger block");
  const transaction = record(recordValue.transaction, "ledger transaction");
  const operation = optional(transaction.operation, "ledger operation", value => value);
  if (operation === null) throw new Error("ICP ledger block operation is unavailable or unsupported");
  return normalize(transaction, operation, block, timestampNs(recordValue.timestamp), wallet, "bytes");
}

function normalize(
  transaction: Record<string, unknown>, rawOperation: unknown, block: bigint, time: bigint, wallet: string, addressFormat: "text" | "bytes",
): WalletTransaction | null {
  const operation = record(rawOperation, "operation");
  const keys = Object.keys(operation);
  if (keys.length !== 1 || !["Transfer", "Mint", "Burn", "Approve"].includes(keys[0]!)) throw new Error("Unsupported ICP ledger operation");
  const kind = keys[0]!;
  const value = record(operation[kind], "operation fields");
  const from = kind === "Mint" ? null : address(value.from, addressFormat);
  const to = kind === "Transfer" || kind === "Mint" ? address(value.to, addressFormat) : null;
  const spender = kind === "Approve" ? address(value.spender, addressFormat)
    : kind === "Transfer" || kind === "Burn" ? optional(value.spender, "spender", value => address(value, addressFormat)) : null;
  const fromWallet = from?.accountIdentifierHex === wallet;
  const toWallet = to?.accountIdentifierHex === wallet;
  if (!fromWallet && !toWallet) {
    if (kind === "Approve" && spender?.accountIdentifierHex === wallet) return null;
    throw new Error("ICP transaction is unrelated to the Wallet account");
  }
  const amount = nat64(record(kind === "Approve" ? value.allowance : value.amount, "token amount").e8s, "token amount");
  const fee = kind === "Transfer" || kind === "Approve" ? nat64(record(value.fee, "fee").e8s, "fee") : null;
  const effect = kind === "Approve" ? -fee! : fromWallet ? -(amount + (fee ?? 0n)) + (toWallet ? amount : 0n) : amount;
  const memo = optional(transaction.icrc1_memo, "ICRC memo", value => bytesHex(value, "ICRC memo"));
  return { blockIndex: block.toString(), operation: kind.toLowerCase() as WalletTransaction["operation"], timestampNs: time.toString(),
    amountAtoms: amount.toString(), feeAtoms: fee?.toString() ?? null, balanceEffectAtoms: effect.toString(), from, to, spender,
    memoHex: memo ?? nat64(transaction.memo, "memo").toString(16).padStart(16, "0"), memoComplete: true };
}

function walletIdentifier(owner: string): string {
  return AccountIdentifier.fromPrincipal({ principal: AccountPrincipal.fromText(owner) }).toHex();
}
function address(value: unknown, format: "text" | "bytes"): Extract<TransactionAddress, { kind: "icp_account_identifier" }> {
  const hex = format === "bytes" ? bytesHex(value, "account identifier") : value;
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Invalid ICP account identifier");
  return { kind: "icp_account_identifier", accountIdentifierHex: AccountIdentifier.fromHex(hex).toHex() };
}
function bytesHex(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array) && !(Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))) {
    throw new Error(`Invalid ICP ${label}`);
  }
  return Array.from(value as Uint8Array, byte => byte.toString(16).padStart(2, "0")).join("");
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) throw new Error(`Invalid ICP ${label}`);
  return value as Record<string, unknown>;
}
function vector(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ICP ${label}`);
  return value;
}
function optional<T>(value: unknown, label: string, parse: (value: unknown) => T): T | null {
  if (!Array.isArray(value) || value.length > 1) throw new Error(`Invalid ICP optional ${label}`);
  return value.length === 0 ? null : parse(value[0]);
}
function nat64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 18_446_744_073_709_551_615n) throw new Error(`Invalid ICP ${label}`);
  return value;
}
function timestampNs(value: unknown): bigint {
  return nat64(record(value, "timestamp").timestamp_nanos, "timestamp");
}
function unwrap(value: unknown, label: string): Record<string, unknown> {
  const response = record(value, `${label} response`);
  if (Object.keys(response).length !== 1) throw new Error(`Invalid ICP ${label} response`);
  if ("Ok" in response) return record(response.Ok, `${label} result`);
  if ("Err" in response) {
    const error = record(response.Err, `${label} error`);
    if (typeof error.message === "string") throw new Error(`ICP ${label}: ${error.message}`);
    const other = error.Other ? record(error.Other, "archive error") : null;
    if (other && typeof other.error_message === "string") throw new Error(`ICP archive: ${other.error_message}`);
    throw new Error(`ICP ${label} rejected the block request: ${Object.keys(error).join(", ")}`);
  }
  throw new Error(`Invalid ICP ${label} response`);
}
