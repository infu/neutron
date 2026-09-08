import { getAddress, keccak256, parseSignature, recoverTypedDataAddress, stringToHex, type Hex } from "viem";
import { parseEvmOperationResult, type EvmOperationResult, type EvmSignTypedDataRequest, type EvmWalletCaller, type EvmWalletClient } from "neutron-tools/evm_wallet";
import { createFundingTransport, fundingIntent, fundingResult, fundingState, observeFunding, type FundingObservation, type FundingOptions, type FundingResult } from "./funding.ts";
import { formatUsdc, unsignedAtoms } from "./funding_protocol.ts";
import { stable, type Store } from "./store.ts";
import type { MasterTypedDataRequest } from "./trading_key.ts";
import { nextTradingMasterNonce } from "./trading_store.ts";

/** Liquidity recovery only: no arbitrary destination, cash amount, or account-mode action. */
export type CoreCashTransferAction = {
  type: "usdClassTransfer"; signatureChainId: "0xa4b1"; hyperliquidChain: "Mainnet";
  amount: string; toPerp: true; nonce: number;
};
type CoreProof = { owner: string; sourceTransactionHash: string; destinationTransactionHash: string; amountAtoms: string };
type ClassTransferObservation = { hash: string; time: number; amount: string; inferredLinkage: true };
export type CoreFundingRecovery = {
  version: 1; attempt: number; previousAttempts?: CoreFundingRecovery[]; proof: CoreProof; action: CoreCashTransferAction; request: EvmSignTypedDataRequest;
  walletDispatched: boolean; operation: EvmOperationResult | null; envelope: ReturnType<typeof coreCashEnvelope> | null;
  exchangeDispatched: boolean; exchangeAccepted: boolean; exchangeRejected: boolean; exchangeReply: unknown | null;
  observation: { checkedAtMs: number; availableCashAtoms: string; accountMode: string; transfers: ClassTransferObservation[] } | null;
};
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function coreAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(value)) throw new Error("Hyperliquid returned an invalid USDC cash amount.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

export function coreCashAction(amountAtoms: string, nonce: number): CoreCashTransferAction {
  const amount = unsignedAtoms(amountAtoms);
  if (amount === 0n || !Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("Invalid cash recovery amount or nonce.");
  return { type: "usdClassTransfer", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", amount: formatUsdc(amount), toPerp: true, nonce };
}
export function coreCashTypedData(action: CoreCashTransferAction): MasterTypedDataRequest["typedData"] {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" as Hex },
    primaryType: "HyperliquidTransaction:UsdClassTransfer",
    types: {
      EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
      "HyperliquidTransaction:UsdClassTransfer": [{ name: "hyperliquidChain", type: "string" }, { name: "amount", type: "string" }, { name: "toPerp", type: "bool" }, { name: "nonce", type: "uint64" }],
    },
    message: { hyperliquidChain: action.hyperliquidChain, amount: action.amount, toPerp: action.toPerp, nonce: action.nonce },
  };
}
function coreCashRequest(id: string, action: CoreCashTransferAction, attempt = 0): EvmSignTypedDataRequest {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid original funding operation ID.");
  return { accountId: "main", chainId: "42161", requestId: keccak256(stringToHex(`neutron:hyperliquid:funding:core:v1:${id}${attempt === 0 ? "" : `:retry:${attempt}`}`)).slice(2, 34), typedDataJson: JSON.stringify(coreCashTypedData(action)) };
}
export function coreCashEnvelope(action: CoreCashTransferAction, signatureHex: string) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) throw new Error("Wallet returned an invalid cash recovery signature.");
  const signature = parseSignature(signatureHex as Hex);
  return { action, nonce: action.nonce, signature: { r: signature.r, s: signature.s, v: Number(signature.v ?? signature.yParity + 27) } };
}
function proofFromObservation(observation: FundingObservation | null, owner: string, grossAtoms: string): CoreProof {
  const evidence = object(observation?.evidence), cash = object(evidence?.coreCash);
  if (observation?.phase !== "forwarded_to_core_cash" || !cash || cash.phase !== "forwarded_to_core_cash" || cash.coreExecutionProven !== false || typeof cash.recipient !== "string" || getAddress(cash.recipient) !== getAddress(owner) || typeof observation.sourceTransactionHash !== "string" || !hashPattern.test(observation.sourceTransactionHash) || typeof observation.destinationTransactionHash !== "string" || !hashPattern.test(observation.destinationTransactionHash) || cash.transactionHash !== observation.destinationTransactionHash) throw new Error("This original deposit has no verified CCTP cash-fallback receipt to recover.");
  const amount = unsignedAtoms(cash.deliveredAtoms), coreAmount = unsignedAtoms(cash.coreAmountAtoms);
  if (amount === 0n || amount > unsignedAtoms(grossAtoms) || coreAmount !== amount * 100n) throw new Error("The verified cash-fallback amount does not match this deposit.");
  return { owner: getAddress(owner).toLowerCase(), sourceTransactionHash: observation.sourceTransactionHash.toLowerCase(), destinationTransactionHash: observation.destinationTransactionHash.toLowerCase(), amountAtoms: amount.toString() };
}
/** Cash is observed independently after the receipt; an EVM event only queues Core processing. */
export function availableCoreCash(raw: unknown): string {
  const balances = object(raw)?.balances;
  if (!Array.isArray(balances)) throw new Error("Hyperliquid USDC cash balance is unavailable.");
  const rows = balances.map(object).filter(row => row?.token === 0);
  if (rows.length > 1) throw new Error("Hyperliquid returned duplicate USDC cash balances.");
  if (rows.length === 0) return "0";
  const cash = rows[0]!;
  if (cash.coin !== "USDC") throw new Error("Hyperliquid cash balance token does not identify USDC.");
  const total = coreAtoms(cash.total), hold = coreAtoms(cash.hold);
  if (hold > total) throw new Error("Hyperliquid cash availability is inconsistent.");
  return ((total - hold) / 100n).toString();
}
export function observedCashTransfers(raw: unknown, amount: string, notBeforeMs: number): ClassTransferObservation[] {
  if (!Array.isArray(raw)) throw new Error("Hyperliquid cash transfer history is unavailable.");
  const found = new Map<string, ClassTransferObservation>();
  for (const value of raw) {
    const row = object(value), delta = object(row?.delta);
    if (!row || !delta || typeof row.hash !== "string" || !hashPattern.test(row.hash) || typeof row.time !== "number" || !Number.isSafeInteger(row.time) || row.time < notBeforeMs || delta.type !== "accountClassTransfer" || delta.toPerp !== true || typeof delta.usdc !== "string") continue;
    // The public ledger omits this action's nonce, so even a unique match is contextual.
    try {
      if (coreAtoms(delta.usdc) === coreAtoms(amount)) found.set(row.hash.toLowerCase(), { hash: row.hash, time: row.time, amount: delta.usdc, inferredLinkage: true });
    } catch { /* Unknown ledger variants are not evidence. */ }
  }
  return [...found.values()];
}
function definiteFailure(recovery: CoreFundingRecovery): boolean {
  return recovery.exchangeRejected && !recovery.exchangeAccepted || !recovery.exchangeDispatched && recovery.envelope === null && !!recovery.operation && !recovery.operation.signature && ["failed", "rejected"].includes(recovery.operation.status);
}
function validateRecovery(raw: unknown, id: string, proof: CoreProof, priorIndex?: number): CoreFundingRecovery {
  const recovery = raw as CoreFundingRecovery;
  if (!recovery || recovery.previousAttempts !== undefined && !Array.isArray(recovery.previousAttempts) || priorIndex !== undefined && recovery.previousAttempts !== undefined) throw new Error("Invalid saved cash recovery attempt history.");
  const attempt = priorIndex ?? recovery.previousAttempts?.length ?? 0;
  if (recovery.version !== 1 || recovery.attempt !== attempt || stable(recovery.proof) !== stable(proof) || !recovery.action || stable(recovery.action) !== stable(coreCashAction(proof.amountAtoms, recovery.action.nonce)) || stable(recovery.request) !== stable(coreCashRequest(id, recovery.action, attempt))) throw new Error("Saved cash recovery changed its original deposit, amount, or Wallet request.");
  recovery.previousAttempts?.forEach((previous, index) => { if (!definiteFailure(validateRecovery(previous, id, proof, index))) throw new Error("An uncertain cash recovery cannot be replaced by another attempt."); });
  for (const key of ["walletDispatched", "exchangeDispatched", "exchangeAccepted", "exchangeRejected"] as const) if (typeof recovery[key] !== "boolean") throw new Error("Invalid saved cash recovery dispatch state.");
  if (recovery.operation) {
    const operation = parseEvmOperationResult(recovery.operation, recovery.request, "typed_data");
    if (getAddress(operation.address) !== getAddress(proof.owner)) throw new Error("Saved cash recovery belongs to a different Wallet account.");
  }
  if (recovery.envelope !== null && (!recovery.operation?.signature || stable(recovery.envelope) !== stable(coreCashEnvelope(recovery.action, recovery.operation.signature)))) throw new Error("Saved cash recovery signed bytes changed.");
  if (recovery.exchangeDispatched && !recovery.envelope || recovery.exchangeAccepted && !recovery.exchangeDispatched || recovery.exchangeRejected && !recovery.exchangeDispatched || recovery.exchangeAccepted && recovery.exchangeRejected) throw new Error("Invalid saved cash recovery exchange state.");
  return recovery;
}

/** Resume this deposit's same-owner cash recovery using a master Wallet signature.
 * No call here burns, mints, trades, changes account mode, or generates a successor transfer. */
export async function recoverCoreFunding(wallet: EvmWalletClient, store: Store, id: string, caller: EvmWalletCaller | null, agentMode: boolean, options: FundingOptions = {}): Promise<FundingResult> {
  let row = await store.get(id);
  if (!row) throw new Error("No saved funding transfer was found.");
  const intent = fundingIntent(row), state = fundingState(row), transport = options.transport ?? createFundingTransport(), now = options.now ?? Date.now;
  const callOptions = options.signal ? { signal: options.signal } : undefined, abort = () => options.signal?.throwIfAborted();
  if (intent.input.direction !== "deposit" || intent.input.environment !== "mainnet" || stable(intent.caller) !== stable(caller) || intent.agentMode !== agentMode || agentMode && !caller) throw new Error("Resume this original deposit with its original caller and inputs.");
  const account = (await wallet.accounts(callOptions)).accounts.find(value => value.accountId === "main");
  if (!account || account.address.toLowerCase() !== intent.account.address.toLowerCase() || account.keyFingerprint !== intent.account.keyFingerprint || account.namespaceVersion !== intent.account.namespaceVersion) throw new Error("The original deposit's EVM Wallet signing identity changed.");
  const save = async (phase: string) => {
    abort();
    if (state.observation?.recovery && phase.startsWith("core_cash_")) {
      const settled = phase === "core_cash_accepted" || phase === "core_cash_shared", stopped = phase === "core_cash_stopped";
      state.observation.recovery = { ...state.observation.recovery, status: settled ? "complete" : stopped ? "ready" : "pending", methods: settled ? [] : ["perps"], message: state.lastError ?? "The exact cash-to-perps recovery is saved. Continue its original Wallet review.", walletStatus: (state.coreRecovery as CoreFundingRecovery | undefined)?.operation?.status ?? null };
    }
    row = await store.update(row!, state, phase); options.onRecord?.(row);
  };
  // Refresh the full source/CCTP/destination proof before every recovery attempt.
  state.observation = await (options.observe ?? observeFunding)(intent, state, transport, options.signal);
  const proof = proofFromObservation(state.observation, account.address, state.quote.amountAtoms);
  let recovery = state.coreRecovery === undefined ? null : validateRecovery(state.coreRecovery, id, proof), failedAttempt: CoreFundingRecovery | null = null;
  const [balance, mode] = await Promise.all([transport.info({ type: "spotClearinghouseState", user: account.address }, options.signal), transport.info({ type: "userAbstraction", user: account.address }, options.signal)]);
  if (typeof mode !== "string" || !["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"].includes(mode)) throw new Error("The account balance mode is temporarily unavailable; cash recovery remains saved.");
  const cash = availableCoreCash(balance);
  if (recovery) {
    const ledger = await transport.info({ type: "userNonFundingLedgerUpdates", user: account.address, startTime: recovery.action.nonce }, options.signal);
    recovery.observation = { checkedAtMs: now(), availableCashAtoms: cash, accountMode: mode, transfers: observedCashTransfers(ledger, recovery.action.amount, recovery.action.nonce) };
    if (recovery.exchangeAccepted) {
      state.lastError = recovery.observation.transfers.length === 1 ? `Hyperliquid accepted the ${recovery.action.amount} USDC cash-to-perps recovery and a matching ledger transfer was observed. The public ledger does not expose its nonce, so that match is contextual.` : `Hyperliquid accepted the original ${recovery.action.amount} USDC cash-to-perps recovery. Its exact signed action is saved; no second transfer is needed.`;
      await save("core_cash_accepted"); return fundingResult(row!);
    }
    if (definiteFailure(recovery)) {
      if (options.execute === false) { await save("core_cash_stopped"); return fundingResult(row!); }
      // Only an explicit recovery invocation may review a successor after proven
      // rejection. Every prior signature/request remains in the original journal.
      failedAttempt = recovery; recovery = null;
    }
  }
  if (!recovery?.exchangeDispatched && (mode === "unifiedAccount" || mode === "portfolioMargin")) {
    if (BigInt(cash) >= BigInt(proof.amountAtoms)) state.coreShared = { sourceTransactionHash: proof.sourceTransactionHash, destinationTransactionHash: proof.destinationTransactionHash, amountAtoms: proof.amountAtoms, accountMode: mode };
    state.lastError = BigInt(cash) >= BigInt(proof.amountAtoms) ? `This account already uses shared USDC collateral. ${formatUsdc(BigInt(proof.amountAtoms))} USDC from the proven cash-fallback route is available in its cash balance; no cash-to-perps transfer or account-mode change is needed. Cash availability does not identify an individual Core credit.` : "This account uses shared USDC collateral. The original CCTP mint and cash route are verified; waiting for sufficient available USDC. No separate cash-to-perps transfer or account-mode change is needed.";
    await save(BigInt(cash) >= BigInt(proof.amountAtoms) ? "core_cash_shared" : "core_cash_shared_waiting"); return fundingResult(row!);
  }
  if (!recovery?.exchangeDispatched && BigInt(cash) < BigInt(proof.amountAtoms)) {
    state.lastError = `The deposit's cash route is verified. ${formatUsdc(BigInt(cash))} USDC is currently available; recovery waits for the original ${formatUsdc(BigInt(proof.amountAtoms))} USDC instead of transferring unrelated amounts.`;
    await save("core_cash_waiting"); return fundingResult(row!);
  }
  if (!recovery) {
    if (options.execute === false) { state.lastError = "The deposit reached the cash route. Continue its saved recovery to move that exact USDC amount into perps."; await save("core_cash_ready"); return fundingResult(row!); }
    const nonce = await (options.nextNonce ?? (() => nextTradingMasterNonce({ walletAddress: account.address, environment: "mainnet" })))(), action = coreCashAction(proof.amountAtoms, nonce);
    if (failedAttempt && nonce <= failedAttempt.action.nonce) throw new Error("A newly reviewed recovery must use a fresh master Wallet nonce.");
    const previousAttempts: CoreFundingRecovery[] = failedAttempt ? [...(failedAttempt.previousAttempts ?? []), Object.fromEntries(Object.entries(failedAttempt).filter(([key]) => key !== "previousAttempts")) as CoreFundingRecovery] : [];
    recovery = { version: 1, attempt: previousAttempts.length, ...(previousAttempts.length ? { previousAttempts } : {}), proof, action, request: coreCashRequest(id, action, previousAttempts.length), walletDispatched: false, operation: null, envelope: null, exchangeDispatched: false, exchangeAccepted: false, exchangeRejected: false, exchangeReply: null, observation: { checkedAtMs: now(), availableCashAtoms: cash, accountMode: mode, transfers: [] } };
    state.coreRecovery = recovery; state.lastError = null; await save("core_cash_ready");
  }
  if (recovery.walletDispatched && !recovery.operation?.signature) {
    const operation = await wallet.operationStatus({ accountId: "main", chainId: "42161", requestId: recovery.request.requestId }, callOptions);
    if (operation.status !== "not_found") {
      recovery.operation = parseEvmOperationResult(operation, recovery.request, "typed_data");
      if (getAddress(recovery.operation.address) !== getAddress(account.address)) throw new Error("Wallet cash recovery signature belongs to another account.");
      await save("core_cash_wallet_observed");
    }
  }
  if (!recovery.operation?.signature) {
    const status = recovery.operation?.status;
    if (status === "rejected" || status === "failed") { state.lastError = `Wallet ${status} the original cash-to-perps recovery without a signature. No cash transfer was submitted.`; await save("core_cash_stopped"); return fundingResult(row!); }
    if (options.execute === false || status && status !== "prepared") return fundingResult(row!);
    recovery.walletDispatched = true; state.lastError = null; await save("core_cash_wallet_requested"); abort();
    try {
      recovery.operation = parseEvmOperationResult(await wallet.signTypedData(recovery.request, callOptions), recovery.request, "typed_data");
      if (getAddress(recovery.operation.address) !== getAddress(account.address)) throw new Error("Wallet cash recovery signature belongs to another account.");
      await save("core_cash_wallet_observed");
    } catch (error) { abort(); state.lastError = `The cash-recovery Wallet reply was interrupted. Continue to reconcile the same request. ${errorMessage(error)}`; await save("core_cash_wallet_unknown"); return fundingResult(row!); }
    if (!recovery.operation.signature) {
      if (["rejected", "failed"].includes(recovery.operation.status)) { state.lastError = `Wallet ${recovery.operation.status} the original cash-to-perps recovery without a signature. No cash transfer was submitted.`; await save("core_cash_stopped"); }
      return fundingResult(row!);
    }
  }
  if (!recovery.envelope) {
    const signer = await recoverTypedDataAddress({ ...coreCashTypedData(recovery.action), signature: recovery.operation.signature as Hex });
    if (getAddress(signer) !== getAddress(account.address)) throw new Error("Wallet did not sign cash recovery with the original account.");
    recovery.envelope = coreCashEnvelope(recovery.action, recovery.operation.signature); await save("core_cash_signed");
  }
  if (options.execute === false) return fundingResult(row!);
  const priorDispatch = recovery.exchangeDispatched;
  recovery.exchangeDispatched = true; state.lastError = null; await save("core_cash_submitting"); abort();
  try {
    const reply = await transport.exchange(recovery.envelope, options.signal), body = object(reply), response = object(body?.response);
    recovery.exchangeReply = reply;
    if (body?.status === "ok" && response?.type === "default" && !("error" in response)) {
      recovery.exchangeAccepted = true;
      state.lastError = `Hyperliquid accepted the original ${recovery.action.amount} USDC cash-to-perps recovery. Its exact signed action is saved; no second transfer is needed.`;
      await save("core_cash_accepted");
    } else if (!priorDispatch && (body?.status === "err" || response && "error" in response)) {
      recovery.exchangeRejected = true; state.lastError = `Hyperliquid rejected this cash-to-perps recovery: ${JSON.stringify(reply)}. Its original action remains saved; no replacement transfer is created.`;
      await save("core_cash_stopped");
    } else {
      state.lastError = `The original cash-to-perps recovery is not yet confirmed: ${JSON.stringify(reply)}. Its exact signature and nonce remain saved; a used-nonce response after an interrupted reply is not evidence of failure.`;
      await save("core_cash_unknown");
    }
  } catch (error) { abort(); state.lastError = `The cash-to-perps reply was interrupted. Continue this recovery to reconcile or resend its identical signed action. ${errorMessage(error)}`; await save("core_cash_unknown"); }
  return fundingResult(row!);
}
