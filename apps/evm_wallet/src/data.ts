import {
  isAddress,
  getAddress,
  formatUnits,
  parseUnits,
  decodeFunctionData,
  erc20Abi,
} from "viem";
import type { SelfCallObject } from "neutron-tools/app";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";

export type Account = {
  id: string;
  slot: string;
  address: string;
  publicKey: Uint8Array;
  namespaceVersion: string;
};
export type Network = {
  chainId: string;
  name: string;
  nativeSymbol: string;
  explorerUrl: string;
  testnet: boolean;
  finalityDescription: string;
};
export type Asset = {
  chainId: string;
  address: string;
  symbol: string;
  decimals: number;
};
export type Snapshot = {
  accounts: Account[];
  networks: Network[];
  assets: Asset[];
  lifecycle: string;
};
export type Balance = {
  accountId: string;
  chainId: string;
  address: string;
  nativeBalance: string;
  blockNumber: string;
  observedAtNs: string;
  completeness: string;
  tokens: Array<{
    address: string;
    balance: string | null;
    decimals: number | null;
    symbol: string | null;
    error: string | null;
  }>;
};
export type Review = {
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  balance: string;
  simulation: string;
  observedAtNs: string;
};
export type TransactionIntent = {
  transactionType: string | null;
  gasLimit: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  to: string;
  value: string;
  data: string;
  accessList: Array<{ address: string; storageKeys: string[] }>;
};
export type TokenEvidenceValue = { value: string | null; error: string | null };
export type TokenEvidence = {
  chainId: string;
  contract: string;
  method: "approve" | "transfer" | "transferFrom";
  owner: string;
  spender: string | null;
  recipient: string | null;
  amount: string;
  recognition: "erc20_calldata";
  blockNumber: string | null;
  blockHash: string | null;
  blockError: string | null;
  observedAtNs: string;
  balance: TokenEvidenceValue;
  allowance: TokenEvidenceValue | null;
};
export type Operation = {
  tokenEvidence: TokenEvidence | null;
  preparedTransaction:
    | (TransactionIntent & { chainId: string; nonce: string })
    | null;
  caller: { appId: string; installationUid: string; endpoint: string };
  operationId: string;
  requestId: string;
  accountId: string;
  chainId: string;
  kind: string;
  status: string;
  address: string;
  transactionHash: string | null;
  replacementTransactionHash: string | null;
  signature: string | null;
  message: string | null;
  reviewRevision: string;
  review: Review | null;
  receiptJson: string | null;
  finality: string | null;
  createdAtNs: string;
  updatedAtNs: string;
  intent: {
    transaction?: TransactionIntent;
    messageHex?: string;
    typedDataJson?: string;
    replacement?: {
      operationId: string;
      cancel: boolean;
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    };
  };
};
export const METHODS = {
  snapshot: "evm_wallet_snapshot_v1",
  accounts: "evm_wallet_accounts_v1",
  prepare: "evm_wallet_prepare_v1",
  execute: "evm_wallet_execute_v1",
  reject: "evm_wallet_reject_v1",
  status: "evm_wallet_status_v1",
  history: "evm_wallet_history_v1",
  assetSet: "evm_wallet_asset_set_v1",
  reviewEvidence: "evm_wallet_review_evidence_v1",
} as const;
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}
export function quantity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !(/^(0|[1-9][0-9]*)$/.test(value) || /^0x[0-9a-f]+$/i.test(value))
  )
    throw new Error(`Invalid ${label}`);
  return BigInt(value).toString();
}
export function natural(value: unknown, label: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  const s = text(value, label);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`Invalid ${label}`);
  return s;
}
function integer(value: unknown, label: string): string {
  const s = typeof value === "bigint" ? value.toString() : text(value, label);
  if (!/^-?(0|[1-9][0-9]*)$/.test(s)) throw new Error(`Invalid ${label}`);
  return s;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function optionalText(value: unknown, label: string): string | null {
  return value == null ? null : text(value, label);
}
function optionalNat(value: unknown, label: string): string | null {
  return value == null ? null : natural(value, label);
}
export function address(value: unknown): string {
  const s = text(value, "EVM address");
  if (!isAddress(s, { strict: false })) throw new Error("Invalid EVM address");
  return getAddress(s);
}
export function hex(value: unknown, label = "hex data"): `0x${string}` {
  const s = text(value, label);
  if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(s)) throw new Error(`Invalid ${label}`);
  return s as `0x${string}`;
}
export function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const r = record(value, "backend result");
  if (Object.hasOwn(r, "err")) throw new Error(text(r.err, "backend error"));
  return Object.hasOwn(r, "ok") ? r.ok : value;
}
export function parseSnapshot(value: unknown): Snapshot {
  const r = record(unwrap(value), "snapshot");
  return {
    accounts: list(r.accounts, "accounts").map(parseAccount),
    networks: list(r.networks, "networks").map((v) => {
      const n = record(v, "network");
      return {
        chainId: natural(n.chain_id, "chain"),
        name: text(n.name, "network name"),
        nativeSymbol: text(n.native_symbol, "native symbol"),
        explorerUrl: text(n.explorer_url, "explorer"),
        testnet: bool(n.testnet, "testnet"),
        finalityDescription: text(n.finality_description, "finality"),
      };
    }),
    assets: mergeEvmAssets(list(r.assets, "assets").map((v) => {
      const a = record(v, "asset");
      return {
        chainId: natural(a.chain_id, "asset chain"),
        address: address(a.address),
        symbol: text(a.symbol, "asset symbol"),
        decimals: decimals(a.decimals),
      };
    })),
    lifecycle: text(r.lifecycle, "lifecycle"),
  };
}
export function parseAccount(value: unknown): Account {
  const a = record(value, "account");
  if (!(a.public_key instanceof Uint8Array))
    throw new Error("Invalid public key");
  return {
    id: text(a.id, "account id"),
    slot: text(a.slot, "slot"),
    address: address(a.address),
    publicKey: a.public_key,
    namespaceVersion: natural(a.namespace_version, "namespace version"),
  };
}
export function parseAccounts(value: unknown): Account[] {
  return list(unwrap(value), "accounts").map(parseAccount);
}
export function parseBalance(value: unknown): Balance {
  const r = record(unwrap(value), "balance");
  return {
    accountId: text(r.account_id, "account"),
    chainId: natural(r.chain_id, "chain"),
    address: address(r.address),
    nativeBalance: natural(r.native_balance, "native balance"),
    blockNumber: quantity(r.block_number, "block"),
    observedAtNs: integer(r.observed_at, "observation time"),
    completeness: text(r.completeness, "balance coverage"),
    tokens: list(r.tokens, "tokens").map((v) => {
      const t = record(v, "token balance");
      return {
        address: address(t.address),
        balance: optionalNat(t.balance, "token balance"),
        decimals: t.decimals == null ? null : decimals(t.decimals),
        symbol: optionalText(t.symbol, "symbol"),
        error: optionalText(t.error, "token error"),
      };
    }),
  };
}
export function parseOperation(value: unknown): Operation {
  return parseOperationRecord(unwrap(value));
}
export function parseReviewEvidence(value: unknown): Operation {
  const r = record(unwrap(value), "review evidence response");
  return {
    ...parseOperationRecord(r.operation),
    tokenEvidence: parseTokenEvidence(r.token_evidence),
  };
}
export function parseTokenEvidence(value: unknown): TokenEvidence | null {
  if (value == null) return null;
  const r = record(value, "token review evidence");
  const method = text(r.method, "token method");
  if (!["approve", "transfer", "transferFrom"].includes(method))
    throw new Error("Invalid token review method");
  if (r.recognition !== "erc20_calldata")
    throw new Error("Invalid token review recognition");
  const observation = (value: unknown): TokenEvidenceValue => {
    const v = record(value, "token observation");
    const observed = optionalNat(v.value, "observed token amount");
    const error = optionalText(v.error, "token observation error");
    if ((observed === null) === (error === null))
      throw new Error("Token observation must contain a value or an error");
    return { value: observed, error };
  };
  return {
    chainId: natural(r.chain_id, "token evidence chain"),
    contract: address(r.contract),
    method: method as TokenEvidence["method"],
    owner: address(r.owner),
    spender: r.spender == null ? null : address(r.spender),
    recipient: r.recipient == null ? null : address(r.recipient),
    amount: natural(r.amount, "token amount"),
    recognition: "erc20_calldata",
    blockNumber: r.block_number == null ? null : quantity(r.block_number, "token evidence block"),
    blockHash: optionalText(r.block_hash, "token evidence block hash"),
    blockError: optionalText(r.block_error, "token evidence block error"),
    observedAtNs: integer(r.observed_at, "token evidence observed at"),
    balance: observation(r.balance),
    allowance: r.allowance == null ? null : observation(r.allowance),
  };
}
export function parseOperationRecord(value: unknown): Operation {
  const r = record(value, "operation");
  const i = record(r.intent, "intent");
  const v = record(i.operation, "operation intent");
  const intent: Operation["intent"] = {};
  if (v.transaction) {
    const t = record(v.transaction, "transaction");
    intent.transaction = {
      transactionType: optionalText(t.transaction_type, "transaction type"),
      gasLimit: optionalNat(t.gas_limit, "requested gas limit"),
      maxFeePerGas: optionalNat(t.max_fee_per_gas, "requested max fee"),
      maxPriorityFeePerGas: optionalNat(
        t.max_priority_fee_per_gas,
        "requested priority fee",
      ),
      gasPrice: optionalNat(t.gas_price, "requested gas price"),
      to: address(t.to),
      value: natural(t.value, "value"),
      data: hex(t.data),
      accessList: list(t.access_list, "access list").map((x) => {
        const a = record(x, "access entry");
        return {
          address: address(a.address),
          storageKeys: list(a.storageKeys, "storage keys").map((s) => hex(s)),
        };
      }),
    };
  } else if (v.personal_message)
    intent.messageHex = hex(record(v.personal_message, "message").message);
  else if (v.typed_data)
    intent.typedDataJson = text(
      record(v.typed_data, "typed data").json,
      "typed data JSON",
    );
  else if (v.replacement) {
    const x = record(v.replacement, "replacement");
    intent.replacement = {
      operationId: natural(x.operation_id, "replaced operation"),
      cancel: bool(x.cancel, "cancel"),
      maxFeePerGas: natural(x.max_fee_per_gas, "max fee"),
      maxPriorityFeePerGas: natural(x.max_priority_fee_per_gas, "priority fee"),
    };
  } else throw new Error("Unsupported operation intent");
  const q = r.review == null ? null : record(r.review, "review");
  const caller = record(r.caller, "caller");
  const p =
    r.prepared_transaction == null
      ? null
      : record(r.prepared_transaction, "prepared transaction");
  const preparedTransaction = p
    ? {
        transactionType: optionalText(p.transaction_type, "transaction type"),
        gasLimit: optionalNat(p.gas_limit, "gas limit"),
        maxFeePerGas: optionalNat(p.max_fee_per_gas, "max fee"),
        maxPriorityFeePerGas: optionalNat(
          p.max_priority_fee_per_gas,
          "priority fee",
        ),
        gasPrice: optionalNat(p.gas_price, "gas price"),
        to: p.to == null ? "Contract creation" : address(p.to),
        value: natural(p.value, "value"),
        data: hex(p.data),
        chainId: natural(p.chain_id, "prepared chain"),
        nonce: natural(p.nonce, "prepared nonce"),
        accessList: list(p.access_list, "prepared access list").map((x) => {
          const a = record(x, "access entry");
          return {
            address: address(a.address),
            storageKeys: list(a.storageKeys, "storage keys").map((v) => hex(v)),
          };
        }),
      }
    : null;
  return {
    tokenEvidence: null,
    preparedTransaction,
    caller: {
      appId: text(caller.app_id, "caller app"),
      installationUid: natural(caller.installation_uid, "caller installation"),
      endpoint: text(caller.endpoint, "caller endpoint"),
    },
    operationId: natural(r.operation_id, "operation id"),
    requestId: text(r.request_id, "request id"),
    accountId: text(r.account_id, "account id"),
    chainId: natural(r.chain_id, "chain id"),
    kind: text(r.kind, "kind"),
    status: text(r.status, "status"),
    address: r.address === "" ? "" : address(r.address),
    transactionHash: optionalText(r.transaction_hash, "transaction hash"),
    replacementTransactionHash: optionalText(
      r.replacement_hash,
      "replacement transaction hash",
    ),
    signature: optionalText(r.signature, "signature"),
    message: optionalText(r.message, "message"),
    reviewRevision: natural(r.review_revision, "review revision"),
    review: q
      ? {
          nonce: natural(q.nonce, "nonce"),
          gasLimit: natural(q.gas_limit, "gas limit"),
          maxFeePerGas: optionalNat(q.max_fee_per_gas, "fee"),
          maxPriorityFeePerGas: optionalNat(
            q.max_priority_fee_per_gas,
            "priority fee",
          ),
          gasPrice: optionalNat(q.gas_price, "gas price"),
          balance: natural(q.balance, "balance"),
          simulation: text(q.simulation, "simulation"),
          observedAtNs: integer(q.observed_at, "observed at"),
        }
      : null,
    receiptJson: optionalText(r.receipt_json, "receipt"),
    finality: optionalText(r.finality, "finality"),
    createdAtNs: integer(r.created_at, "created at"),
    updatedAtNs: integer(r.updated_at, "updated at"),
    intent,
  };
}
export function parseHistory(value: unknown): {
  operations: Operation[];
  total: string;
} {
  const r = record(unwrap(value), "history");
  return {
    operations: list(r.operations, "operations").map(parseOperationRecord),
    total: natural(r.total, "total"),
  };
}
export function decimals(value: unknown): number {
  const n = Number(natural(value, "decimals"));
  if (!Number.isInteger(n) || n < 0 || n > 255)
    throw new Error("Invalid token decimals");
  return n;
}
export function amount(value: string, places = 18): string {
  return formatUnits(BigInt(value), places);
}
export function atomicAmount(value: string, places = 18): string {
  if (
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) ||
    (value.split(".")[1]?.length ?? 0) > places
  )
    throw new Error(
      `Enter an exact amount with at most ${places} decimal places`,
    );
  return parseUnits(value, places).toString();
}
export function when(value: string): string {
  const ms = Number(BigInt(value) / 1_000_000n);
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())
    ? new Date(ms).toLocaleString()
    : value;
}
export function shortAddress(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function decodeKnownCall(
  data: string,
): { name: string; details: Array<[string, string]> } | null {
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: hex(data) });
    if (d.functionName === "approve")
      return {
        name: "ERC-20 approval",
        details: [
          ["Spender", String(d.args[0])],
          ["Allowance (atomic units)", String(d.args[1])],
        ],
      };
    if (d.functionName === "transfer")
      return {
        name: "ERC-20 transfer",
        details: [
          ["Recipient", String(d.args[0])],
          ["Amount (atomic units)", String(d.args[1])],
        ],
      };
    if (d.functionName === "transferFrom")
      return {
        name: "ERC-20 transfer from",
        details: [
          ["Token owner", String(d.args[0])],
          ["Recipient", String(d.args[1])],
          ["Amount (atomic units)", String(d.args[2])],
        ],
      };
    return null;
  } catch {
    return null;
  }
}
export function maxFee(review: Review): string {
  return (
    BigInt(review.gasLimit) *
    BigInt(review.maxFeePerGas ?? review.gasPrice ?? "0")
  ).toString();
}
export function identityArgs(
  caller: { appId: string; installationUid: string; endpoint: string },
  id: string,
): SelfCallObject {
  return {
    caller: {
      app_id: caller.appId,
      installation_uid: caller.installationUid,
      endpoint: caller.endpoint,
    },
    request_id: id,
  };
}
