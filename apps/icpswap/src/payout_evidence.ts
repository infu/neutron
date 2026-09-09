import { Principal } from "@icp-sdk/core/principal";
import { type ScopedKernelClient } from "neutron-tools/app";
import type { ActionPrepared } from "./action_backend.ts";
import { buildLiquidityReceipt } from "./action_receipt.ts";
import { liquidityOwnerAccountIdentifier } from "./liquidity_reads.ts";
import { readWalletTool } from "./wallet.ts";

type ToolCaller = Pick<ScopedKernelClient, "callTool">;
type Address = { kind: "icrc"; owner: string; subaccountHex: string | null }
  | { kind: "icp_account_identifier"; accountIdentifierHex: string };
export type PayoutTransaction = {
  blockIndex: string; operation: "transfer" | "mint" | "burn" | "approve";
  timestampNs: string; amountAtoms: string; feeAtoms: string | null; balanceEffectAtoms: string;
  from: Address | null; to: Address | null; spender: Address | null;
  memoHex: string | null; memoComplete: boolean;
};
type Source = { kind: "index" | "ledger" | "unavailable"; canister: string | null; ledgerVerified: boolean; method?: string | null; archived?: boolean };
type Effect = { key: string; method: string; dispatchedAtNs: string; completedAtNs: string | null };
type Target = { ledger: string; purpose: "output" | "refund"; protocolAmountAtoms: string | null };
type Coverage = {
  observedAtNs: string; source: Source;
  pagination: { beforeBlock: string | null; nextBeforeBlock: string | null; oldestBlock: string | null; hasMore: boolean; completeToOldest: boolean };
  observation: { indexedAccountBalanceAtoms: string | null; newestAccountBlock: string | null; indexedBlocks: string | null; indexedBlocksError: string | null };
};
export type PayoutCandidate = {
  classification: "contextual_candidate"; operationLinkVerified: false;
  transaction: PayoutTransaction; source: Source;
  reason: string;
};
export type PayoutLedgerEvidence = Target & {
  status: "observed" | "partial" | "unavailable";
  coverage: Coverage | null; candidates: PayoutCandidate[];
  inspectedTransactions: number; excludedTransactions: number; errors: string[];
};
export type PayoutBlockReference = { ledger: string; blockIndex: string };
export type PayoutBlockEvidence = PayoutBlockReference & {
  status: "candidate" | "not_matched" | "unavailable";
  observedAtNs: string | null; source: Source | null; chainLength: string | null;
  transaction: PayoutTransaction | null; candidate: PayoutCandidate | null;
  diagnostics: string[]; reason: string;
};
export type PayoutEvidence = {
  version: 1; operationId: string;
  status: "not_required" | "not_applicable" | "observed" | "partial" | "unavailable";
  reason: string; settlementVerified: false; operationLinkVerified: false;
  effect: Effect | null; ledgers: PayoutLedgerEvidence[]; explicitBlocks: PayoutBlockEvidence[];
  errors: string[];
};

const CANDIDATE_REASON = "The transfer is from this pool's default account to this Neutron's default account at or after the retained protocol dispatch. This is contextual evidence; amount, time and memo do not establish linkage to this operation.";
const OBSERVATION_REASON = "Recent index pages and explicitly requested ledger blocks are observations only. An empty page, equal amount or absent candidate does not prove settlement or a missing payout. For older records call Wallet wallet_account_transactions_v1 with that ledger and beforeBlock=coverage.pagination.nextBeforeBlock; repeat until nextBeforeBlock is null. Verify discovered blocks with wallet_transaction_v1, or pass them as payoutBlocks to icpswap_reconcile_v1. Reconcile itself has no pagination input.";
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(path: string): never { throw new Error(`Wallet payout evidence has an invalid ${path}.`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(path);
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string { return typeof value === "string" ? value : fail(path); }
function flag(value: unknown, path: string): boolean { return typeof value === "boolean" ? value : fail(path); }
function nat(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return fail(path);
  return value;
}
function nullable<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T | null {
  return value === null ? null : parse(value, path);
}
function optionalNat(value: unknown): string | null {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? value : null;
}
function principal(value: unknown, path: string): string {
  const result = text(value, path);
  try { if (Principal.fromText(result).toText() === result) return result; } catch {}
  return fail(path);
}
function hex(value: unknown, path: string, bytes?: number): string {
  const result = text(value, path);
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(result) || (bytes !== undefined && result.length !== bytes * 2)) return fail(path);
  return result;
}
function address(value: unknown, path: string): Address | null {
  if (value === null) return null;
  const raw = object(value, path);
  if (raw.kind === "icrc") return { kind: "icrc", owner: principal(raw.owner, `${path}.owner`), subaccountHex: nullable(raw.subaccountHex, `${path}.subaccountHex`, (v, p) => hex(v, p, 32)) };
  if (raw.kind === "icp_account_identifier") return { kind: "icp_account_identifier", accountIdentifierHex: hex(raw.accountIdentifierHex, `${path}.accountIdentifierHex`, 32) };
  return fail(`${path}.kind`);
}
function transaction(value: unknown): PayoutTransaction {
  const raw = object(value, "transaction");
  if (!["transfer", "mint", "burn", "approve"].includes(String(raw.operation))) return fail("transaction.operation");
  const balance = text(raw.balanceEffectAtoms, "transaction.balanceEffectAtoms");
  if (!/^-?(0|[1-9][0-9]*)$/u.test(balance)) return fail("transaction.balanceEffectAtoms");
  return {
    blockIndex: nat(raw.blockIndex, "transaction.blockIndex"), operation: raw.operation as PayoutTransaction["operation"],
    timestampNs: nat(raw.timestampNs, "transaction.timestampNs"), amountAtoms: nat(raw.amountAtoms, "transaction.amountAtoms"),
    feeAtoms: nullable(raw.feeAtoms, "transaction.feeAtoms", nat), balanceEffectAtoms: balance,
    from: address(raw.from, "transaction.from"), to: address(raw.to, "transaction.to"), spender: address(raw.spender, "transaction.spender"),
    memoHex: nullable(raw.memoHex, "transaction.memoHex", hex), memoComplete: flag(raw.memoComplete, "transaction.memoComplete"),
  };
}
function validateIdentity(value: unknown, ledger: string, owner: string): Record<string, unknown> {
  const raw = object(value, "reply");
  if (raw.version !== 1) return fail("reply.version");
  if (raw.ledger !== ledger) return fail("reply.ledger (different ledger)");
  if (raw.owner !== owner) return fail("reply.owner (different Neutron)");
  nat(raw.observedAtNs, "reply.observedAtNs");
  flag(raw.available, "reply.available");
  nullable(raw.error, "reply.error", text);
  return raw;
}
function source(value: unknown, indexOnly = false): Source {
  const raw = object(value, "source");
  if (!["index", "ledger", "unavailable"].includes(String(raw.kind)) || (indexOnly && raw.kind !== "index")) return fail("source.kind");
  const verified = flag(raw.ledgerVerified, "source.ledgerVerified");
  if (verified && raw.kind !== "ledger") return fail("source.ledgerVerified (index data is not ledger-verified)");
  const result: Source = { kind: raw.kind as Source["kind"], canister: nullable(raw.canister, "source.canister", principal), ledgerVerified: verified };
  if (!indexOnly) { result.method = nullable(raw.method, "source.method", text); result.archived = flag(raw.archived, "source.archived"); }
  return result;
}
function isDefaultAccount(value: Address | null, owner: string): boolean {
  if (value?.kind === "icrc") return value.owner === owner && (value.subaccountHex === null || /^0{64}$/u.test(value.subaccountHex));
  return value?.kind === "icp_account_identifier" && value.accountIdentifierHex.toLowerCase() === liquidityOwnerAccountIdentifier(owner);
}
function mismatch(tx: PayoutTransaction, pool: string, owner: string, effect: Effect): string | null {
  if (tx.operation !== "transfer") return "The block is not a transfer.";
  if (BigInt(tx.amountAtoms) === 0n) return "The transfer amount is zero.";
  if (!isDefaultAccount(tx.from, pool)) return "The sender is not this pool's default account.";
  if (!isDefaultAccount(tx.to, owner)) return "The recipient is not this Neutron's default account.";
  if (BigInt(tx.timestampNs) < BigInt(effect.dispatchedAtNs)) return "The transfer predates this protocol dispatch.";
  return null;
}
function candidate(tx: PayoutTransaction, observedSource: Source): PayoutCandidate {
  return { classification: "contextual_candidate", operationLinkVerified: false, transaction: tx, source: observedSource, reason: CANDIDATE_REASON };
}

type Selection = { effect: Effect; pool: string; targets: Target[]; knownLedgers: string[]; noPayout: boolean };
function select(prepared: ActionPrepared, owner: string): Selection | null {
  const { operation, plan } = prepared;
  const pool = principal(plan.pool, "saved pool");
  const receipt = buildLiquidityReceipt(prepared);
  let retained: Record<string, unknown> | undefined;
  let targets: Target[], knownLedgers: string[], noPayout = false;
  if (receipt) {
    if (receipt.owner !== owner) return fail("saved owner (different Neutron)");
    const ledgers = [principal(receipt.token0.address, "token0 ledger"), principal(receipt.token1.address, "token1 ledger")];
    knownLedgers = ledgers;
    retained = operation.effects.find(effect => effect.key === receipt.protocol.effectKey);
    noPayout = receipt.settlement.status === "not_required";
    if (receipt.action === "mint" || receipt.action === "increase") targets = ledgers.map(ledger => ({ ledger, purpose: "refund", protocolAmountAtoms: null }));
    else if (receipt.action === "withdraw") {
      const request = object(plan.request, "saved request"), ledger = principal(request.withdraw_token, "withdraw ledger");
      if (!ledgers.includes(ledger)) return fail("withdraw ledger (not a saved pool token)");
      knownLedgers = [ledger];
      targets = [{ ledger, purpose: "output", protocolAmountAtoms: optionalNat(retained?.result_nat) }];
    } else targets = ledgers.flatMap((ledger, index): Target[] => {
      const amount = optionalNat(retained?.[`result_amount${index}`]);
      return amount === "0" ? [] : [{ ledger, purpose: "output", protocolAmountAtoms: amount }];
    });
  } else {
    if (plan.request !== undefined || operation.state === "uncertain" || operation.state === "stopped") return null;
    const matching = operation.effects.filter(effect => effect.key === "swap");
    if (matching.length !== 1) return null;
    retained = matching[0];
    if (retained?.state !== "succeeded" || retained.canister !== pool || retained.method !== "depositFromAndSwap") return null;
    const ledger = principal(plan.output_address, "saved swap output ledger");
    knownLedgers = [ledger];
    const amount = optionalNat(retained.result_nat);
    targets = amount === "0" ? [] : [{ ledger, purpose: "output", protocolAmountAtoms: amount }];
  }
  if (!retained) return null;
  return { pool, targets, knownLedgers, noPayout, effect: {
    key: text(retained.key, "retained effect key"), method: text(retained.method, "retained effect method"),
    dispatchedAtNs: nat(retained.dispatched_at, "retained dispatch time"), completedAtNs: optionalNat(retained.completed_at),
  } };
}

async function indexEvidence(kernel: ToolCaller, target: Target, selected: Selection, owner: string, signal?: AbortSignal): Promise<PayoutLedgerEvidence> {
  const result: PayoutLedgerEvidence = { ...target, status: "unavailable", coverage: null, candidates: [], inspectedTransactions: 0, excludedTransactions: 0, errors: [] };
  try {
    const raw = validateIdentity(await readWalletTool(kernel, "wallet_account_transactions_v1", { ledger: target.ledger, limit: 25 }, signal), target.ledger, owner);
    const observedSource = source(raw.source, true), pagination = object(raw.pagination, "pagination"), observation = object(raw.observation, "observation");
    result.coverage = {
      observedAtNs: nat(raw.observedAtNs, "observedAtNs"), source: observedSource,
      pagination: { beforeBlock: nullable(pagination.beforeBlock, "pagination.beforeBlock", nat), nextBeforeBlock: nullable(pagination.nextBeforeBlock, "pagination.nextBeforeBlock", nat), oldestBlock: nullable(pagination.oldestBlock, "pagination.oldestBlock", nat), hasMore: flag(pagination.hasMore, "pagination.hasMore"), completeToOldest: flag(pagination.completeToOldest, "pagination.completeToOldest") },
      observation: { indexedAccountBalanceAtoms: nullable(observation.indexedAccountBalanceAtoms, "observation.indexedAccountBalanceAtoms", nat), newestAccountBlock: nullable(observation.newestAccountBlock, "observation.newestAccountBlock", nat), indexedBlocks: nullable(observation.indexedBlocks, "observation.indexedBlocks", nat), indexedBlocksError: nullable(observation.indexedBlocksError, "observation.indexedBlocksError", text) },
    };
    if (result.coverage.pagination.beforeBlock !== null) return fail("pagination.beforeBlock (unexpected page)");
    if (!raw.available) { result.errors.push(typeof raw.error === "string" ? raw.error : "Wallet account history is unavailable."); return result; }
    if (!observedSource.canister || !Array.isArray(raw.transactions)) return fail("index transactions/source");
    for (const item of raw.transactions) {
      result.inspectedTransactions++;
      try {
        const tx = transaction(item);
        if (mismatch(tx, selected.pool, owner, selected.effect) === null) result.candidates.push(candidate(tx, observedSource));
        else result.excludedTransactions++;
      } catch (error) { result.errors.push(errorMessage(error)); }
    }
    if (raw.error) result.errors.push(text(raw.error, "error"));
    if (result.coverage.observation.indexedBlocksError) result.errors.push(result.coverage.observation.indexedBlocksError);
    result.status = result.errors.length ? "partial" : "observed";
  } catch (error) { result.errors.push(errorMessage(error)); }
  return result;
}

async function blockEvidence(kernel: ToolCaller, reference: PayoutBlockReference, selected: Selection, owner: string, signal?: AbortSignal): Promise<PayoutBlockEvidence> {
  const result: PayoutBlockEvidence = { ...reference, status: "unavailable", observedAtNs: null, source: null, chainLength: null, transaction: null, candidate: null, diagnostics: [], reason: "The requested block is unavailable." };
  try {
    principal(reference.ledger, "requested block ledger"); nat(reference.blockIndex, "requested block index");
    const raw = validateIdentity(await readWalletTool(kernel, "wallet_transaction_v1", { ...reference, source: "auto" }, signal), reference.ledger, owner);
    if (raw.blockIndex !== reference.blockIndex) return fail("reply.blockIndex (different block)");
    result.source = source(raw.source); result.observedAtNs = nat(raw.observedAtNs, "observedAtNs");
    result.chainLength = nullable(raw.chainLength, "chainLength", nat);
    if (!Array.isArray(raw.diagnostics)) return fail("diagnostics");
    result.diagnostics = raw.diagnostics.map((value, index) => text(value, `diagnostics[${index}]`));
    if (!raw.available || raw.transaction === null) { result.reason = typeof raw.error === "string" ? raw.error : result.reason; return result; }
    if (!result.source.canister || result.source.kind === "unavailable") return fail("available transaction source");
    const tx = transaction(raw.transaction);
    if (tx.blockIndex !== reference.blockIndex) return fail("transaction.blockIndex (different block)");
    result.transaction = tx;
    const reason = selected.knownLedgers.includes(reference.ledger) ? mismatch(tx, selected.pool, owner, selected.effect) : "This ledger is not a saved output or refund token for the operation.";
    result.reason = reason ?? CANDIDATE_REASON;
    result.status = reason === null ? "candidate" : "not_matched";
    if (reason === null) result.candidate = candidate(tx, result.source);
  } catch (error) { result.reason = errorMessage(error); }
  return result;
}

/** Read Wallet observations without dispatching financial calls or changing the
 * operation journal. Even a verified ledger transfer remains an unlinked
 * candidate unless the protocol supplies an operation-specific payout receipt.
 */
export async function readPayoutEvidence({ prepared, kernel, owner, payoutBlocks = [], signal }: {
  prepared: ActionPrepared; kernel: ToolCaller; owner: string; payoutBlocks?: PayoutBlockReference[]; signal?: AbortSignal;
}): Promise<PayoutEvidence> {
  const result: PayoutEvidence = { version: 1, operationId: prepared.operation.id, status: "not_applicable", reason: "No matching retained successful protocol effect is available for payout observation.", settlementVerified: false, operationLinkVerified: false, effect: null, ledgers: [], explicitBlocks: [], errors: [] };
  let selected: Selection | null;
  try { principal(owner, "Neutron owner"); selected = select(prepared, owner); }
  catch (error) { result.status = "unavailable"; result.reason = errorMessage(error); result.errors.push(result.reason); return result; }
  if (!selected) return result;
  result.effect = selected.effect;
  if (selected.noPayout) { result.status = "not_required"; result.reason = "The retained successful claim returned exactly 0/0, so no payout is required for that claim."; return result; }
  if (selected.targets.length === 0 && payoutBlocks.length === 0) {
    result.reason = "The retained result has no positive output leg to inspect. No Wallet observation was requested; this does not establish settlement.";
    return result;
  }
  for (const target of selected.targets) result.ledgers.push(await indexEvidence(kernel, target, selected, owner, signal));
  for (const reference of payoutBlocks) result.explicitBlocks.push(await blockEvidence(kernel, reference, selected, owner, signal));
  result.errors = [...result.ledgers.flatMap(ledger => ledger.errors.map(error => `${ledger.ledger}: ${error}`)), ...result.explicitBlocks.filter(block => block.status === "unavailable").map(block => `${block.ledger}:${block.blockIndex}: ${block.reason}`)];
  const available = result.ledgers.some(ledger => ledger.status !== "unavailable") || result.explicitBlocks.some(block => block.status !== "unavailable");
  result.status = result.errors.length ? available ? "partial" : "unavailable" : "observed";
  result.reason = OBSERVATION_REASON;
  return result;
}
