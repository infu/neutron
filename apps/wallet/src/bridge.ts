import { querySelf, updateSelf, type SelfCallValue } from "neutron-tools/app";
import { bytesToHex, hexToBytes, parseFixedBytes } from "./icrc_account.ts";
import {
  EthereumReceiptRevertedError, requireSuccessfulReceipt, submitEthereumDeposit,
  validateEthereumDepositHelper, buildApproveData, buildEthDepositData, buildErc20DepositData, buildLegacyEthDepositData, buildLegacyErc20DepositData,
  type EthereumDepositExecution, type EthereumDepositPhase, type EthereumDepositStep,
  type EthereumProvider, type EthereumTransaction,
} from "./ethereum.ts";
import { getAddress, type Hex } from "viem";

export type BridgeQuote = {
  chainId: "1"; ledger: string; minter: string; helperAddress: string;
  helperMode: "subaccount" | "legacy"; minterAddress: string; tokenAddress: string | null;
  recipient: string; principalWord: string; subaccountWord: string;
};
export type BridgeStep = {
  kind: EthereumDepositStep; state: "ready" | "unknown" | "submitted" | "confirmed" | "failed";
  operationId: string | null; transactionHash: Hex | null; error: string | null;
};
export type BridgeSource = "external" | "evm" | { appId: string; installationUid: string };
export type BridgeIntent = {
  id: string; quote: BridgeQuote; source: BridgeSource; account: string; amount: string;
  steps: BridgeStep[]; revision: string; createdAt: string; updatedAt: string;
  eventCursor: string; acceptedDeposit: { logIndex: string; blockNumber: string; eventIndex: string } | null;
  mint: { ledgerBlockIndex: string; eventIndex: string; verifiedLedger: boolean } | null; error: string | null;
};
export type BridgeBackend = {
  query(method: string, args: SelfCallValue[]): Promise<unknown>;
  update(method: string, args: SelfCallValue[]): Promise<unknown>;
};
const selfBackend: BridgeBackend = {
  query: (method, args) => querySelf(method, args),
  update: (method, args) => updateSelf(method, args, 120),
};
export function createBridgeClient(backend: BridgeBackend = selfBackend) {
  const idWire = (id: string) => hexToBytes(id, "bridge id");
  return {
    async quote(ledger: string) { return parseBridgeQuote(await backend.update("wallet_bridge_quote_v1", [ledger])); },
    async prepare(input: { id: string; ledger: string; source: BridgeSource; account: string; amount: string }) {
      return parseBridgeIntent(await backend.update("wallet_bridge_prepare_v1", [{ id: idWire(input.id), ledger: input.ledger, source: typeof input.source === "string" ? { [input.source]: null } : { evm_agent: { app_id: input.source.appId, installation_uid: input.source.installationUid } }, account: input.account, amount: input.amount }]));
    },
    async list(ledger: string | null) {
      const records: BridgeIntent[] = [];
      let after: string | null = null;
      do {
        const page = object(await backend.query("wallet_bridge_list_v1", [{ ...(ledger === null ? {} : { ledger }), ...(after === null ? {} : { after: idWire(after) }), limit: "40" }]));
        if (!Array.isArray(page.records)) throw new Error("Invalid bridge page");
        records.push(...page.records.map(parseBridgeIntent));
        const next = page.next == null ? null : bytesToHex(parseFixedBytes(page.next, 16, "bridge cursor"));
        if (next !== null && after !== null && next <= after) throw new Error("Bridge cursor did not advance");
        after = next;
      } while (after !== null);
      return records;
    },
    async status(id: string) { return parseBridgeIntent(await backend.query("wallet_bridge_status_v1", [idWire(id)])); },
    async claim(intent: BridgeIntent, step: EthereumDepositStep, operationId: string | null) {
      return parseBridgeIntent(await backend.update("wallet_bridge_claim_v1", [{ id: idWire(intent.id), revision: intent.revision, step: { [step]: null }, ...(operationId === null ? {} : { operation_id: operationId }) }]));
    },
    async record(intent: BridgeIntent, kind: EthereumDepositStep, state: Exclude<BridgeStep["state"], "ready">, hash: Hex | null, error: string | null = null) {
      return parseBridgeIntent(await backend.update("wallet_bridge_record_step_v1", [{ id: idWire(intent.id), revision: intent.revision, step: { [kind]: null }, state: { [state]: null }, ...(hash === null ? {} : { transaction_hash: hash }), ...(error === null ? {} : { error }) }]));
    },
    async refresh(id: string) { return parseBridgeIntent(await backend.update("wallet_bridge_refresh_v1", [{ id: idWire(id), event_page_length: "100" }])); },
  };
}
export type BridgeClient = ReturnType<typeof createBridgeClient>;
export type BridgeExecutionOptions = {
  intent: BridgeIntent; client: BridgeClient; provider: EthereumProvider;
  // EVM Wallet has durable idempotent commands. Browser wallets do not expose
  // an equivalent request identity; an unknown browser reply is never resent.
  evm?: {
    send(requestId: string, transaction: EthereumTransaction, beforeFreshSend?: () => Promise<void>): Promise<Hex>;
    confirm(requestId: string, hash: Hex): Promise<void>;
  };
  onChange?: (intent: BridgeIntent) => void;
  onProgress?: (phase: EthereumDepositPhase) => void;
  confirmationTimeoutMs?: number; pollIntervalMs?: number;
};

/** Resume the same durable bridge and preserve every completed approval. */
export async function executeBridgeDeposit(options: BridgeExecutionOptions): Promise<BridgeIntent> {
  const { client, provider, evm, onChange = () => undefined } = options;
  let current = await client.status(options.intent.id);
  if (typeof current.source !== "string") throw new Error("This deposit is controlled by its original root Agent. Resume it there; Wallet can refresh the recorded transaction and mint status.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== current.account.toLowerCase()) throw new Error("Connect the saved source account to resume this deposit");
  if (await provider.request({ method: "eth_chainId" }) !== "0x1") {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    if (await provider.request({ method: "eth_chainId" }) !== "0x1") throw new Error("Resume this deposit on Ethereum Mainnet");
  }
  const update = (next: BridgeIntent) => { current = next; onChange(next); };
  const stepOf = (kind: EthereumDepositStep) => {
    const step = current.steps.find((candidate) => candidate.kind === kind);
    if (!step) throw new Error(`Missing bridge ${kind} step`);
    return step;
  };
  const confirm = async (kind: EthereumDepositStep, hash: Hex, browserConfirm?: (hash: Hex) => Promise<void>) => {
    const step = stepOf(kind);
    try {
      if (current.source === "evm") {
        if (!evm || !step.operationId) throw new Error("Reconnect EVM Wallet to reconcile this deposit");
        await evm.confirm(step.operationId, hash);
      } else if (browserConfirm) await browserConfirm(hash);
      else await requireSuccessfulReceipt(provider, hash, options.confirmationTimeoutMs ?? 300_000, options.pollIntervalMs ?? 1_500, kind === "deposit" ? "Deposit" : "Approval");
      update(await client.record(current, kind, "confirmed", hash));
    } catch (error) {
      if (error instanceof EthereumReceiptRevertedError) update(await client.record(current, kind, "failed", hash, error.message));
      throw error;
    }
  };
  // Reconcile saved submitted approvals first. A changed live allowance alone
  // cannot explain whether an earlier signature/submission succeeded.
  for (const saved of [...current.steps]) {
    if (saved.state === "failed") throw new Error(saved.error ?? "A transaction in this deposit reverted");
    if (saved.state === "confirmed" || saved.state === "ready") continue;
    if (saved.transactionHash) await confirm(saved.kind, saved.transactionHash);
    else if (current.source === "external") throw new Error("The browser wallet reply was lost. This saved deposit is unresolved; check the source wallet before creating another deposit. It will not be resent.");
    else {
      if (!evm || !saved.operationId) throw new Error("Reconnect EVM Wallet to reconcile this saved request");
      try {
        const hash = await evm.send(saved.operationId, bridgeTransaction(current, saved.kind), async () => {
          assertBridgeQuoteCurrent(current.quote, await client.quote(current.quote.ledger));
          await validateEthereumDepositHelper(provider, current.quote.helperAddress, current.quote.minterAddress, current.quote.tokenAddress);
        });
        update(await client.record(current, saved.kind, "submitted", hash));
        await confirm(saved.kind, hash);
      } catch (error) {
        if (error instanceof EthereumReceiptRevertedError && error.transactionHash) update(await client.record(current, saved.kind, "failed", error.transactionHash, error.message));
        else if (isUserRejected(error)) update(await client.record(current, saved.kind, "failed", null, "EVM Wallet declined this request"));
        throw error;
      }
    }
  }
  if (stepOf("deposit").state === "confirmed") return current;
  const execute = async ({ step: kind, transaction, send, confirm: browserConfirm }: EthereumDepositExecution): Promise<Hex> => {
    let step = stepOf(kind);
    if (step.state === "failed") throw new Error(step.error ?? "This deposit transaction failed");
    if (step.state === "confirmed" && step.transactionHash) return step.transactionHash;
    if (step.state === "ready") {
      // A distinct deterministic EVM request per step is frozen before the
      // wallet prompt. CAS prevents two Wallet tiles dispatching one step.
      assertBridgeQuoteCurrent(current.quote, await client.quote(current.quote.ledger));
      update(await client.claim(current, kind, current.source === "evm" ? bridgeEvmRequestId(current.id, kind) : null));
      step = stepOf(kind);
    } else if (current.source === "external" && !step.transactionHash) {
      throw new Error("This browser wallet request has an unresolved outcome and cannot safely be resent");
    }
    let hash = step.transactionHash;
    if (!hash) {
      try {
        if (current.source === "evm") {
          if (!evm || !step.operationId) throw new Error("EVM Wallet is unavailable");
          hash = await evm.send(step.operationId, transaction, async () => {
            assertBridgeQuoteCurrent(current.quote, await client.quote(current.quote.ledger));
            await validateEthereumDepositHelper(provider, current.quote.helperAddress, current.quote.minterAddress, current.quote.tokenAddress);
          });
        } else hash = await send();
      } catch (error) {
        // Unknown is already durable. Only the provider's explicit user
        // rejection can prove that no transaction was submitted.
        if (error instanceof EthereumReceiptRevertedError && error.transactionHash) update(await client.record(current, kind, "failed", error.transactionHash, error.message));
        else if (isUserRejected(error)) update(await client.record(current, kind, "failed", null, "The source wallet declined this request"));
        throw error;
      }
      update(await client.record(current, kind, "submitted", hash));
    }
    await confirm(kind, hash, browserConfirm);
    return hash;
  };
  await submitEthereumDeposit({
    amount: BigInt(current.amount), helperMode: current.quote.helperMode,
    helperAddress: current.quote.helperAddress, minterAddress: current.quote.minterAddress,
    principal: current.quote.principalWord, subaccount: current.quote.subaccountWord,
    tokenAddress: current.quote.tokenAddress, expectedAccount: current.account, provider,
    executeTransaction: execute, onProgress: (progress) => options.onProgress?.(progress.phase),
    ...(options.confirmationTimeoutMs === undefined ? {} : { confirmationTimeoutMs: options.confirmationTimeoutMs }), ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  return current;
}

// XOR in separate disjoint high-bit tags preserves all 128 random bits within
// each step's id space. A bridge's three request IDs are always different.
export function bridgeEvmRequestId(id: string, step: EthereumDepositStep): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid bridge request id");
  const value = BigInt(`0x${id}`) ^ ({ reset_approval: 1n, approval: 2n, deposit: 3n }[step] << 120n);
  return value.toString(16).padStart(32, "0");
}
export function bridgeTransaction(intent: BridgeIntent, kind: EthereumDepositStep): EthereumTransaction {
  const quote = intent.quote;
  const from = getAddress(intent.account);
  const helper = getAddress(quote.helperAddress);
  const amount = BigInt(intent.amount);
  if (kind !== "deposit") {
    if (!quote.tokenAddress) throw new Error("Native ETH has no token approval");
    return { from, to: getAddress(quote.tokenAddress), data: buildApproveData(helper, kind === "approval" ? amount : 0n) };
  }
  const principal = quote.principalWord as Hex;
  const subaccount = quote.subaccountWord as Hex;
  const data = quote.tokenAddress
    ? quote.helperMode === "subaccount" ? buildErc20DepositData(getAddress(quote.tokenAddress), amount, principal, subaccount) : buildLegacyErc20DepositData(getAddress(quote.tokenAddress), amount, principal)
    : quote.helperMode === "subaccount" ? buildEthDepositData(principal, subaccount) : buildLegacyEthDepositData(principal);
  return { from, to: helper, data, ...(quote.tokenAddress ? {} : { value: `0x${amount.toString(16)}` as Hex }) };
}
export function bridgeComplete(intent: BridgeIntent): boolean { return intent.mint?.verifiedLedger === true; }
export function bridgeLabel(intent: BridgeIntent): string {
  if (bridgeComplete(intent)) return `Mint verified at IC ledger block ${intent.mint!.ledgerBlockIndex}`;
  if (intent.mint) return "Minter reported a mint; checking its IC ledger block";
  if (intent.acceptedDeposit) return "Minter accepted this exact deposit; awaiting its mint";
  const deposit = intent.steps.find((step) => step.kind === "deposit")!;
  if (deposit.state === "confirmed") return "Deposit confirmed on Ethereum; awaiting the minter";
  const pending = intent.steps.find((step) => step.state === "unknown" || step.state === "submitted");
  if (pending) return `${pending.kind.replaceAll("_", " ")} ${pending.transactionHash ? "pending confirmation" : "outcome unresolved"}`;
  const failed = intent.steps.find((step) => step.state === "failed");
  return failed?.error ?? "Saved deposit ready to continue";
}
export function parseBridgeQuote(value: unknown): BridgeQuote {
  const q = object(value);
  if (q.chain_id !== "1") throw new Error("ck-token deposits require Ethereum Mainnet");
  return { chainId: "1", ledger: text(q.ledger), minter: text(q.minter), helperAddress: address(q.helper_address), helperMode: variant(q.helper_mode, ["subaccount", "legacy"]), minterAddress: address(q.minter_address), tokenAddress: q.token_address == null ? null : address(q.token_address), recipient: text(q.recipient), principalWord: word(q.principal_word), subaccountWord: word(q.subaccount_word) };
}
export function parseBridgeIntent(value: unknown): BridgeIntent {
  const r = object(value);
  const steps = r.steps;
  if (!Array.isArray(steps) || steps.length !== 3) throw new Error("Invalid bridge steps");
  const accepted = r.accepted_deposit == null ? null : object(r.accepted_deposit);
  const mint = r.mint == null ? null : object(r.mint);
  const parsed: BridgeIntent = {
    id: bytesToHex(parseFixedBytes(r.id, 16, "bridge id")), quote: parseBridgeQuote(r.quote),
    source: parseBridgeSource(r.source), account: address(r.account), amount: nat(r.amount),
    steps: steps.map((value) => { const s = object(value); return { kind: variant(s.kind, ["reset_approval", "approval", "deposit"]), state: variant(s.state, ["ready", "unknown", "submitted", "confirmed", "failed"]), operationId: optionalText(s.operation_id), transactionHash: s.transaction_hash == null ? null : word(s.transaction_hash), error: optionalText(s.error) }; }),
    revision: nat(r.revision), createdAt: text(r.created_at), updatedAt: text(r.updated_at), eventCursor: nat(r.event_cursor),
    acceptedDeposit: accepted && { logIndex: nat(accepted.log_index), blockNumber: nat(accepted.block_number), eventIndex: nat(accepted.event_index) },
    mint: mint && { ledgerBlockIndex: nat(mint.ledger_block_index), eventIndex: nat(mint.event_index), verifiedLedger: mint.verified_ledger === true }, error: optionalText(r.error),
  };
  if (new Set(parsed.steps.map((s) => s.kind)).size !== 3) throw new Error("Duplicate bridge step");
  return parsed;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge record"); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid bridge text"); return value; }
function optionalText(value: unknown): string | null { return value == null ? null : text(value); }
function nat(value: unknown): string { const v = text(value); if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error("Invalid bridge amount"); return v; }
function address(value: unknown): string { const v = text(value); if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("Invalid bridge address"); return v; }
function word(value: unknown): Hex { const v = text(value); if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid bridge bytes32"); return v as Hex; }
function variant<const T extends readonly string[]>(value: unknown, choices: T): T[number] { const r = object(value); const keys = Object.keys(r); if (keys.length !== 1 || !choices.includes(keys[0]!)) throw new Error("Invalid bridge variant"); return keys[0]! as T[number]; }
function isUserRejected(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === 4001; }

function parseBridgeSource(value: unknown): BridgeSource { const r = object(value); if ("evm_agent" in r && Object.keys(r).length === 1) { const a = object(r.evm_agent); return { appId: text(a.app_id), installationUid: text(a.installation_uid) }; } return variant(value, ["external", "evm"]); }

export function assertBridgeQuoteCurrent(saved: BridgeQuote, live: BridgeQuote): void {
  if (saved.chainId !== live.chainId || saved.ledger !== live.ledger || saved.minter !== live.minter || saved.helperMode !== live.helperMode || saved.helperAddress.toLowerCase() !== live.helperAddress.toLowerCase() || saved.minterAddress.toLowerCase() !== live.minterAddress.toLowerCase() || saved.tokenAddress?.toLowerCase() !== live.tokenAddress?.toLowerCase() || saved.recipient !== live.recipient) throw new Error("The minter's supported deposit route changed. This saved deposit will not send to a retired helper; already submitted transactions remain recoverable.");
}
