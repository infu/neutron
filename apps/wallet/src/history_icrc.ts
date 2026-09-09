import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { DirectLookup, HistoryQuery, IndexPageData, TransactionAddress, WalletTransaction } from "./history_transaction.ts";

const BlobType = IDL.Vec(IDL.Nat8), Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(BlobType) });
const common = { amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(BlobType) };
const Transaction = IDL.Record({
  kind: IDL.Text, timestamp: IDL.Nat64,
  transfer: IDL.Opt(IDL.Record({ ...common, from: Account, to: Account, spender: IDL.Opt(Account) })),
  mint: IDL.Opt(IDL.Record({ ...common, to: Account })),
  burn: IDL.Opt(IDL.Record({ ...common, from: Account, spender: IDL.Opt(Account) })),
  approve: IDL.Opt(IDL.Record({ ...common, from: Account, spender: Account })),
});
export const icrcIndexPageArgs = IDL.Record({ account: Account, start: IDL.Opt(IDL.Nat), max_results: IDL.Nat });
export const icrcIndexPageResult = IDL.Variant({ Ok: IDL.Record({ balance: IDL.Nat,
  transactions: IDL.Vec(IDL.Record({ id: IDL.Nat, transaction: Transaction })), oldest_tx_id: IDL.Opt(IDL.Nat) }), Err: IDL.Record({ message: IDL.Text }) });
const Value = IDL.Rec();
Value.fill(IDL.Variant({ Blob: BlobType, Text: IDL.Text, Nat: IDL.Nat, Int: IDL.Int,
  Array: IDL.Vec(Value), Map: IDL.Vec(IDL.Tuple(IDL.Text, Value)) }));
export const icrcBlockArgs = IDL.Vec(IDL.Record({ start: IDL.Nat, length: IDL.Nat }));
export const icrcBlocksResult = IDL.Rec();
icrcBlocksResult.fill(IDL.Record({ log_length: IDL.Nat, blocks: IDL.Vec(IDL.Record({ id: IDL.Nat, block: Value })),
  archived_blocks: IDL.Vec(IDL.Record({ args: icrcBlockArgs, callback: IDL.Func([icrcBlockArgs], [icrcBlocksResult], ["query"]) })) }));

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`Invalid ${label}`); return value; }
function optional(value: unknown): unknown | null { const values = list(value, "Candid option"); if (values.length > 1) throw new Error("Invalid Candid option"); return values[0] ?? null; }
function nat(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Invalid ${label}`); return value;
}
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) && (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))) throw new Error("Invalid byte vector");
  return Uint8Array.from(value as ArrayLike<number>);
}
function hex(value: unknown): string { return Array.from(bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function principal(value: unknown): string {
  if (!value || typeof value !== "object" || !("toText" in value) || typeof value.toText !== "function") throw new Error("Invalid principal");
  return Principal.fromText(value.toText()).toText();
}
function address(owner: string, subaccount: unknown | null): TransactionAddress {
  const sub = subaccount === null ? null : bytes(subaccount);
  if (sub && sub.length !== 32) throw new Error("Invalid ICRC subaccount length");
  return { kind: "icrc", owner, subaccountHex: sub === null || sub.every((byte) => byte === 0) ? null : hex(sub) };
}
function indexAccount(value: unknown): TransactionAddress { const valueRecord = record(value, "account"); return address(principal(valueRecord.owner), optional(valueRecord.subaccount)); }
function belongs(value: TransactionAddress | null, owner: string): boolean { return value?.kind === "icrc" && value.owner === owner && value.subaccountHex === null; }
function transaction(args: {
  block: bigint; operation: WalletTransaction["operation"]; timestamp: bigint; amount: bigint; fee: bigint | null;
  from: TransactionAddress | null; to: TransactionAddress | null; spender: TransactionAddress | null; memo: unknown | null; owner: string;
}): WalletTransaction {
  const { block, operation, timestamp, amount, fee, from, to, spender, memo, owner } = args;
  const sent = belongs(from, owner), received = belongs(to, owner);
  if (!sent && !received) throw new Error("Transaction does not affect this Wallet default account");
  if ((operation === "transfer" || operation === "approve") && sent && fee === null) throw new Error("Outgoing transaction fee is unavailable; exact balance effect cannot be established");
  if (operation === "mint" && (fee ?? 0n) > amount) throw new Error("Mint fee exceeds amount");
  const effect = operation === "approve" ? -(fee ?? 0n)
    : operation === "mint" ? amount - (fee ?? 0n)
    : operation === "burn" ? -(amount + (fee ?? 0n))
    : sent ? -(received ? fee ?? 0n : amount + (fee ?? 0n)) : amount;
  return { blockIndex: block.toString(), operation, timestampNs: timestamp.toString(), amountAtoms: amount.toString(),
    feeAtoms: fee?.toString() ?? null, balanceEffectAtoms: effect.toString(), from, to, spender,
    memoHex: memo === null ? null : hex(memo), memoComplete: true };
}
function indexTransaction(value: unknown, owner: string): WalletTransaction {
  const item = record(value, "indexed transaction"), tx = record(item.transaction, "transaction");
  const kind = tx.kind;
  if (kind !== "transfer" && kind !== "mint" && kind !== "burn" && kind !== "approve") throw new Error(`Unsupported indexed operation: ${String(kind)}`);
  const body = record(optional(tx[kind]), `${kind} transaction`);
  for (const other of ["transfer", "mint", "burn", "approve"]) if (other !== kind && optional(tx[other]) !== null) throw new Error("Indexed transaction has conflicting operations");
  const fee = optional(body.fee), memo = optional(body.memo);
  return transaction({ block: nat(item.id, "block index"), operation: kind, timestamp: nat(tx.timestamp, "transaction timestamp"),
    amount: nat(body.amount, "transaction amount"), fee: fee === null ? null : nat(fee, "transaction fee"), owner,
    from: kind === "mint" ? null : indexAccount(body.from), to: kind === "mint" || kind === "transfer" ? indexAccount(body.to) : null,
    spender: kind === "approve" ? indexAccount(body.spender) : body.spender === undefined || optional(body.spender) === null ? null : indexAccount(optional(body.spender)), memo });
}

export async function readIcrcAccountPage(query: HistoryQuery, index: string, owner: string, before: bigint | null, limit: bigint, signal?: AbortSignal): Promise<IndexPageData> {
  const reply = record(await query({ canister: index, method: "get_account_transactions", args: [{ account: { owner: Principal.fromText(owner), subaccount: [] }, start: before === null ? [] : [before], max_results: limit }],
    argTypes: [icrcIndexPageArgs], resultType: icrcIndexPageResult, ...(signal ? { signal } : {}) }), "index reply");
  if (reply.Err) throw new Error(String(record(reply.Err, "index error").message));
  const page = record(reply.Ok, "index page"), rows = list(page.transactions, "transactions");
  if (BigInt(rows.length) > limit) throw new Error("Index returned more transactions than requested");
  const oldest = optional(page.oldest_tx_id), oldestBlock = oldest === null ? null : nat(oldest, "oldest block");
  const transactions = rows.map((item) => indexTransaction(item, owner));
  let previous = before;
  for (const item of transactions) { const block = BigInt(item.blockIndex); if (previous !== null && block >= previous) throw new Error("Index transaction IDs overlap their descending exclusive cursor"); previous = block; }
  if (transactions.length && oldestBlock !== null && oldestBlock > BigInt(transactions.at(-1)!.blockIndex)) throw new Error("Index oldest transaction is after its returned page");
  if (transactions.length && oldestBlock === null) throw new Error("Index omitted its oldest account transaction");
  if (!transactions.length && before === null && oldestBlock !== null) throw new Error("Index omitted its newest account transaction");
  const completeToOldest = transactions.length === 0 ? oldestBlock === null || (before !== null && before <= oldestBlock) : BigInt(transactions.at(-1)!.blockIndex) === oldestBlock;
  if (!transactions.length && !completeToOldest) throw new Error("Index returned no progress before its oldest account transaction");
  return { transactions, indexedAccountBalanceAtoms: nat(page.balance, "indexed account balance").toString(),
    oldestBlock: oldestBlock?.toString() ?? null, nextBeforeBlock: completeToOldest ? null : transactions.at(-1)!.blockIndex,
    hasMore: !completeToOldest, completeToOldest, newestAccountBlock: before === null ? transactions[0]?.blockIndex ?? null : null };
}

export async function readIcrcIndexedBlocks(query: HistoryQuery, index: string, signal?: AbortSignal): Promise<string> {
  const reply = record(await query({ canister: index, method: "status", args: [], argTypes: [], resultType: IDL.Record({ num_blocks_synced: IDL.Nat }), ...(signal ? { signal } : {}) }), "index status");
  return nat(reply.num_blocks_synced, "indexed block count").toString();
}

function fields(value: unknown, label: string): Map<string, unknown> {
  const variant = record(value, label), entries = list(variant.Map, `${label} map`), output = new Map<string, unknown>();
  for (const entry of entries) { const pair = list(entry, "map entry"); if (pair.length !== 2 || typeof pair[0] !== "string" || output.has(pair[0])) throw new Error(`Invalid or duplicate ${label} field`); output.set(pair[0], pair[1]); }
  return output;
}
function valueNat(value: unknown, label: string): bigint {
  const variant = record(value, label), keys = Object.keys(variant);
  if (keys.length !== 1 || (keys[0] !== "Nat" && keys[0] !== "Int")) throw new Error(`Invalid ${label}`);
  return nat(variant[keys[0]], label);
}
function valueText(value: unknown): string { const v = record(value, "text value"); if (Object.keys(v).length !== 1 || typeof v.Text !== "string") throw new Error("Invalid text value"); return v.Text; }
function valueBlob(value: unknown): Uint8Array { const v = record(value, "blob value"); if (Object.keys(v).length !== 1 || !Object.hasOwn(v, "Blob")) throw new Error("Invalid blob value"); return bytes(v.Blob); }
function ledgerAccount(value: unknown): TransactionAddress {
  const v = record(value, "account value"), entries = list(v.Array, "account elements");
  if (entries.length < 1 || entries.length > 2) throw new Error("Invalid ICRC account elements");
  return address(Principal.fromUint8Array(valueBlob(entries[0])).toText(), entries.length === 1 ? null : valueBlob(entries[1]));
}
export function decodeIcrcBlock(value: unknown, blockIndex: bigint, owner: string): WalletTransaction {
  const block = fields(value, "block"), tx = fields(block.get("tx"), "transaction");
  const blockType = block.has("btype") ? valueText(block.get("btype")) : null;
  const kinds: Record<string, WalletTransaction["operation"]> = { "1mint": "mint", "1burn": "burn", "1xfer": "transfer", "2xfer": "transfer", "2approve": "approve", mint: "mint", burn: "burn", xfer: "transfer", approve: "approve" };
  const name = blockType ?? valueText(tx.get("op")), operation = kinds[name];
  if (!operation || (blockType !== null && !/^[12]/u.test(blockType))) throw new Error(`Unsupported ICRC block type: ${name}`);
  if (tx.has("fee") && block.has("fee")) throw new Error("Block contains both transaction and effective fees");
  return transaction({ block: blockIndex, operation, owner, timestamp: valueNat(block.get("ts"), "block timestamp"),
    amount: valueNat(tx.get("amt"), "transaction amount"), fee: tx.has("fee") ? valueNat(tx.get("fee"), "transaction fee") : block.has("fee") ? valueNat(block.get("fee"), "effective fee") : null,
    from: operation === "mint" ? null : ledgerAccount(tx.get("from")), to: operation === "mint" || operation === "transfer" ? ledgerAccount(tx.get("to")) : null,
    spender: operation === "approve" || tx.has("spender") ? ledgerAccount(tx.get("spender")) : null,
    memo: tx.has("memo") ? valueBlob(tx.get("memo")) : null });
}

export async function readIcrcTransaction(query: HistoryQuery, ledger: string, owner: string, block: bigint, signal?: AbortSignal): Promise<DirectLookup> {
  let canister = ledger, method = "icrc3_get_blocks", archived = false, chainLength: string | null = null;
  const visited = new Set<string>();
  for (;;) {
    const identity = `${canister}:${method}:${block}`;
    if (visited.has(identity)) throw new Error("Ledger archive callbacks form a cycle for the requested block");
    visited.add(identity);
    const reply = record(await query({ canister, method, args: [[{ start: block, length: 1n }]], argTypes: [icrcBlockArgs], resultType: icrcBlocksResult, ...(signal ? { signal } : {}) }), "ledger blocks");
    const length = nat(reply.log_length, "ledger log length");
    chainLength ??= length.toString();
    // A DFINITY archive's log_length counts its local stored blocks; returned
    // block IDs include its global offset. Only the root ledger's length is a
    // global bound for the requested ID throughout this callback chain.
    const ledgerLength = BigInt(chainLength);
    const blocks = list(reply.blocks, "ledger blocks"), archives = list(reply.archived_blocks, "archive ranges");
    if (blocks.length > 1 || archives.length > 1 || (blocks.length && archives.length)) throw new Error("Ledger returned conflicting data outside the exact block request");
    if (blocks.length) {
      const item = record(blocks[0], "ledger block");
      if (nat(item.id, "ledger block ID") !== block || block >= ledgerLength) throw new Error("Ledger returned the wrong exact block");
      return { transaction: decodeIcrcBlock(item.block, block, owner), chainLength, sourceCanister: canister, sourceMethod: method, archived };
    }
    if (!archives.length) {
      if (block < ledgerLength || archived) throw new Error("Ledger omitted the requested existing block and its archive range");
      return { transaction: null, chainLength, sourceCanister: canister, sourceMethod: method, archived };
    }
    const range = record(archives[0], "archive range"), args = list(range.args, "archive arguments"), target = list(range.callback, "archive callback");
    const arg = args.length === 1 ? record(args[0], "archive argument") : null;
    if (!arg || nat(arg.start, "archive start") !== block || nat(arg.length, "archive length") !== 1n || block >= ledgerLength || target.length !== 2 || typeof target[1] !== "string" || !target[1]) throw new Error("Ledger archive callback does not match the exact requested block");
    canister = principal(target[0]); method = target[1]; archived = true;
  }
}
