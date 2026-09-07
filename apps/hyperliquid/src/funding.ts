import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, stringToHex, type Hex } from "viem";
import { parseEvmOperationResult, parseEvmTransactionResult, type EvmAccount, type EvmEffectRequest, type EvmOperationResult, type EvmSendTransactionRequest, type EvmSignTypedDataRequest, type EvmTransactionResult, type EvmWalletCaller, type EvmWalletClient } from "neutron-tools/evm_wallet";
import { stable, type RecordRow, type Store } from "./store.ts";
import { CCTP, CORE_DEPOSIT_ABI, FUNDING_CHAINS, USDC_ABI, coreUserExistsCalldata, depositCalldata, depositFees, formatUsdc, forwardHook, parseFundingInput, unsignedAtoms, usdcAtoms, withdrawalAction, withdrawalEnvelope, withdrawalTypedData, type FundingInput, type NormalizedFundingInput, type WithdrawalAction } from "./funding_protocol.ts";
import { destinationMintFilter, destinationMintHashes, findWithdrawalBurn, observedCoreCredits, selectCctpMessage, verifyCoreForwardReceipt, verifyDestinationReceipt, withdrawalBurnFilter, withdrawalHook } from "./funding_evidence.ts";
export type { FundingInput } from "./funding_protocol.ts";

export type FundingTransport = {
  rpc(url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<unknown>;
  info(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  circle(path: string, signal?: AbortSignal): Promise<unknown>;
  exchange(envelope: unknown, signal?: AbortSignal): Promise<unknown>;
};
export function createFundingTransport(fetcher: typeof fetch = fetch): FundingTransport {
  const json = async (url: string, body: unknown | undefined, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetcher(url, { method: body === undefined ? "GET" : "POST", credentials: "omit", headers: body === undefined ? {} : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status === 404 && url.startsWith(`${CCTP.circleApi}/v2/messages/`)) return { messages: [] };
    if (!response.ok) throw new Error(`Funding provider returned HTTP ${response.status}.`);
    return response.json() as Promise<unknown>;
  };
  return {
    async rpc(url, method, params, signal) {
      const raw = await json(url, { jsonrpc: "2.0", id: 1, method, params }, signal) as Record<string, unknown>;
      if (!raw || raw.error || !("result" in raw)) throw new Error(`Funding RPC ${method} failed: ${JSON.stringify(raw?.error ?? "invalid reply")}`);
      return raw.result;
    },
    info: (body, signal) => json(`${CCTP.hyperliquidApi}/info`, body, signal),
    circle: (path, signal) => json(`${CCTP.circleApi}${path}`, undefined, signal),
    // No automatic retries of signed actions. The journal retains exact bytes.
    exchange: (body, signal) => json(`${CCTP.hyperliquidApi}/exchange`, body, signal),
  };
}
export type FundingQuote = {
  input: NormalizedFundingInput; account: EvmAccount; recipient: string; observedAtMs: number;
  amountAtoms: string; estimatedFeeAtoms: string; maxFeeAtoms: string; minimumReceiveAtoms: string;
  protocolFeeAtoms: string; forwardingFeeAtoms: string; activationFeeAtoms: string;
  sourceDex: "" | "spot"; accountMode: string; allowanceAtoms: string | null;
  sourceGas: { estimatedFeeWei: string | null; maximumFeeWei: string | null; reason: string | null };
  warnings: string[];
};
export type FundingOptions = {
  signal?: AbortSignal; transport?: FundingTransport; now?: () => number;
  nextNonce?: () => Promise<number>; execute?: boolean; onRecord?: (row: RecordRow) => void;
  waitForProgress?: boolean; deadlineMs?: number; wait?: (signal?: AbortSignal) => Promise<void>;
  onProgress?: (message: string) => void;
  prepare?: typeof quoteFunding;
  observe?: (intent: FundingIntent, state: FundingState, transport: FundingTransport, signal?: AbortSignal) => Promise<FundingObservation>;
};
const sameAccount = (a: EvmAccount, b: EvmAccount) => a.accountId === b.accountId && a.address.toLowerCase() === b.address.toLowerCase() && a.keyFingerprint === b.keyFingerprint && a.namespaceVersion === b.namespaceVersion;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const optionsOf = (options: FundingOptions) => options.signal ? { signal: options.signal } : undefined;
const blockHex = (value: unknown): string => { if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid funding chain block number."); return value; };

async function readCore(transport: FundingTransport, name: "calculateCrossChainWithdrawalFee" | "cctpMaxFee" | "newCoreAccountFee" | "enabledDestinationDexes" | "isDexForwardingDisabled", args: readonly unknown[], signal?: AbortSignal): Promise<bigint | boolean> {
  const data = encodeFunctionData({ abi: CORE_DEPOSIT_ABI, functionName: name, args: args as never });
  const raw = await transport.rpc(CCTP.hyperEvmRpc, "eth_call", [{ to: CCTP.coreDepositWallet, data }, "latest"], signal);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`Invalid ${name} response from CoreDepositWallet.`);
  return decodeFunctionResult({ abi: CORE_DEPOSIT_ABI, functionName: name, data: raw as Hex });
}
async function fundingLogs(transport: FundingTransport, url: string, filter: Record<string, unknown>, from: bigint, to: bigint, signal?: AbortSignal): Promise<unknown[]> {
  signal?.throwIfAborted();
  if (from > to) return [];
  try {
    const logs = await transport.rpc(url, "eth_getLogs", [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }], signal);
    if (!Array.isArray(logs)) throw new Error("Invalid funding event log response.");
    return logs;
  } catch (error) {
    if (from >= to || !/block.?range|range.*(?:limit|exceed|large)|too many (?:results|logs)|(?:result|response).*(?:size|limit|large|exceed)/i.test(messageOf(error))) throw error;
    const middle = (from + to) / 2n;
    return [...await fundingLogs(transport, url, filter, from, middle, signal), ...await fundingLogs(transport, url, filter, middle + 1n, to, signal)];
  }
}
export async function quoteFunding(wallet: EvmWalletClient, raw: FundingInput, options: FundingOptions = {}): Promise<FundingQuote> {
  const input = parseFundingInput(raw), transport = options.transport ?? createFundingTransport(), callOptions = optionsOf(options);
  const account = (await wallet.accounts(callOptions)).accounts.find(a => a.accountId === "main");
  if (!account) throw new Error("Initialize the main account in EVM Wallet first.");
  const amount = usdcAtoms(input.amount), recipient = getAddress(account.address).toLowerCase();
  const quote: FundingQuote = { input, account, recipient, observedAtMs: (options.now ?? Date.now)(), amountAtoms: amount.toString(), estimatedFeeAtoms: "0", maxFeeAtoms: "0", minimumReceiveAtoms: amount.toString(), protocolFeeAtoms: "0", forwardingFeeAtoms: "0", activationFeeAtoms: "0", sourceDex: "", accountMode: "standard", allowanceAtoms: null, sourceGas: { estimatedFeeWei: null, maximumFeeWei: null, reason: input.direction === "withdraw" ? "Circle forwards the destination transaction; its gas is covered by the forwarding fee." : null }, warnings: [] };
  if (input.direction === "deposit") {
    const chain = FUNDING_CHAINS[input.chainId];
    const [fees, allowance, enabled, disabled, newAccountFee, exists] = await Promise.all([
      transport.circle(`/v2/burn/USDC/fees/${chain.domain}/19?forward=true&hyperCoreDeposit=true`, options.signal),
      wallet.callContract({ accountId: "main", chainId: input.chainId, to: chain.usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: "allowance", args: [getAddress(account.address), CCTP.tokenMessenger] }) }, callOptions),
      readCore(transport, "enabledDestinationDexes", [0], options.signal),
      readCore(transport, "isDexForwardingDisabled", [], options.signal),
      readCore(transport, "newCoreAccountFee", [], options.signal),
      transport.rpc(CCTP.hyperEvmRpc, "eth_call", [{ to: CCTP.coreUserExists, data: coreUserExistsCalldata(account.address) }, "latest"], options.signal),
    ]);
    if (enabled !== true || disabled !== false) throw new Error("HyperCore's USDC contract has disabled forwarding to the default perps balance. A deposit would route elsewhere; retry when perps forwarding is enabled.");
    Object.assign(quote, depositFees(fees, amount, input.speed));
    if (typeof exists !== "string" || !/^0x0{63}[01]$/.test(exists)) throw new Error("Unable to verify HyperCore account activation state.");
    const activationCore = exists.endsWith("1") ? 0n : BigInt(newAccountFee);
    quote.activationFeeAtoms = ((activationCore + 99n) / 100n).toString();
    quote.allowanceAtoms = decodeFunctionResult({ abi: USDC_ABI, functionName: "allowance", data: allowance.result as Hex }).toString();
    const minimum = amount - unsignedAtoms(quote.maxFeeAtoms) - unsignedAtoms(quote.activationFeeAtoms);
    if (minimum <= 0n) throw new Error("Deposit amount must exceed the current CCTP forwarding and account activation fees.");
    quote.minimumReceiveAtoms = minimum.toString();
    if (unsignedAtoms(quote.allowanceAtoms) < amount) quote.sourceGas.reason = "An exact USDC approval is needed first. EVM Wallet estimates each transaction's ETH gas during review.";
    else {
      const gas = await wallet.estimateTransaction({ accountId: "main", chainId: input.chainId, to: CCTP.tokenMessenger, valueWei: "0", data: depositCalldata(input, recipient, quote.maxFeeAtoms) }, callOptions);
      quote.sourceGas = { estimatedFeeWei: gas.estimatedFeeWei, maximumFeeWei: gas.maximumFeeWei, reason: gas.status === "unavailable" ? gas.reasons.join(" ") : null };
    }
    quote.warnings.push("Fees are deducted from deposited USDC. Source-chain ETH gas is additional; the fee cap uses Circle's current high forwarding estimate.");
    if (BigInt(quote.activationFeeAtoms) > 0n) quote.warnings.push(`The current HyperCore account activation fee deducts another ${formatUsdc(BigInt(quote.activationFeeAtoms))} USDC from this first deposit.`);
  } else {
    const [fee, protocolFee, mode] = await Promise.all([readCore(transport, "calculateCrossChainWithdrawalFee", [true, FUNDING_CHAINS[input.chainId].domain], options.signal), readCore(transport, "cctpMaxFee", [], options.signal), transport.info({ type: "userAbstraction", user: account.address }, options.signal)]);
    if (typeof mode !== "string" || !["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"].includes(mode)) throw new Error("Unable to identify this HyperCore account's collateral mode.");
    quote.accountMode = mode;
    if (mode === "default" && !input.sourceBalance) throw new Error("Hyperliquid reports account mode 'default', which does not identify its withdrawal balance. Choose sourceBalance 'perps' for a separate perps balance or 'unified' for shared USDC, as shown in your Hyperliquid account settings.");
    const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
    if (mode !== "default" && input.sourceBalance && (input.sourceBalance === "unified") !== unified) throw new Error(`The selected withdrawal balance conflicts with this account's current ${mode} mode.`);
    quote.sourceDex = mode === "default" ? input.sourceBalance === "unified" ? "spot" : "" : unified ? "spot" : "";
    if (BigInt(protocolFee) > BigInt(fee)) throw new Error("CoreDepositWallet fee observations changed during this quote. Refresh the withdrawal quote.");
    quote.estimatedFeeAtoms = quote.maxFeeAtoms = BigInt(fee).toString();
    quote.protocolFeeAtoms = BigInt(protocolFee).toString(); quote.forwardingFeeAtoms = (BigInt(fee) - BigInt(protocolFee)).toString();
    if (amount <= BigInt(fee)) throw new Error("Withdrawal amount must exceed the current onchain forwarding fee.");
    quote.minimumReceiveAtoms = (amount - BigInt(fee)).toString();
    quote.warnings.push("This withdrawal reduces collateral. Hyperliquid checks available margin when accepting it. The onchain forwarding fee can change before execution.");
    if (quote.sourceDex === "spot") quote.warnings.push("This account uses unified collateral; withdrawal reads its shared USDC balance. Its account mode will remain unchanged.");
  }
  return quote;
}

export type FundingIntent = { kind: "funding"; version: 1; operationId: string; input: NormalizedFundingInput; caller: EvmWalletCaller | null; agentMode: boolean; account: EvmAccount };
type FundingStep = { kind: "transaction" | "typed_data"; label: string; request: EvmEffectRequest; dispatched: boolean; operation: EvmOperationResult | null; evidence: EvmTransactionResult | null };
export type FundingObservation = { phase: "waiting_source" | "waiting_attestation" | "waiting_forwarding" | "forwarded_to_core" | "complete"; sourceTransactionHash: string | null; destinationTransactionHash: string | null; receivedAtoms: string | null; message: string; evidence: unknown };
export type FundingState = { version: 1; quote: FundingQuote; steps: FundingStep[]; withdrawal: WithdrawalAction | null; fromBlock: string | null; destinationFromBlock: string; envelope: unknown | null; exchangeDispatched: boolean; exchangeAccepted: boolean; exchangeRejected: boolean; exchangeReply: unknown | null; observation: FundingObservation | null; lastError: string | null };
export type FundingResult = { operationId: string; state: "pending" | "review" | "stopped" | "complete"; phase: string; summary: string; message: string; direction: "deposit" | "withdraw"; chainId: string; amount: string; sourceTransactionHash: string | null; destinationTransactionHash: string | null; receivedUsdc: string | null; quote: FundingQuote; steps: { label: string; status: string; transactionHash: string | null }[]; observation: FundingObservation | null };
const fundingId = (value: string) => { if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Reuse one 32-character lowercase hex operation ID for this funding transfer."); return value; };
export const fundingRequestId = (id: string, index: number) => keccak256(stringToHex(`neutron:hyperliquid:funding:v1:${fundingId(id)}:${index}`)).slice(2, 34);
function waitForFunding(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 2500);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function expectedSteps(intent: FundingIntent, state: Pick<FundingState, "quote" | "withdrawal">): FundingStep[] {
  const quote = state.quote, scope = { accountId: "main" as const, chainId: intent.input.chainId }, requests: Omit<FundingStep, "dispatched" | "operation" | "evidence">[] = [];
  if (intent.input.direction === "deposit") {
    if (quote.allowanceAtoms === null) throw new Error("Saved deposit allowance is missing.");
    if (unsignedAtoms(quote.allowanceAtoms) < usdcAtoms(intent.input.amount)) requests.push({ kind: "transaction", label: "Approve exact USDC amount", request: { ...scope, requestId: fundingRequestId(intent.operationId, 0), to: FUNDING_CHAINS[intent.input.chainId].usdc, valueWei: "0", data: encodeFunctionData({ abi: USDC_ABI, functionName: "approve", args: [CCTP.tokenMessenger, usdcAtoms(intent.input.amount)] }) } });
    requests.push({ kind: "transaction", label: "Deposit USDC through CCTP", request: { ...scope, requestId: fundingRequestId(intent.operationId, requests.length), to: CCTP.tokenMessenger, valueWei: "0", data: depositCalldata(intent.input, intent.account.address, quote.maxFeeAtoms) } });
  } else {
    if (!state.withdrawal || stable(state.withdrawal) !== stable(withdrawalAction(intent.input, intent.account.address, quote.sourceDex, state.withdrawal.nonce))) throw new Error("Saved withdrawal action changed.");
    requests.push({ kind: "typed_data", label: `Withdraw USDC to ${FUNDING_CHAINS[intent.input.chainId].name}`, request: { accountId: "main", chainId: "42161", requestId: fundingRequestId(intent.operationId, 0), typedDataJson: withdrawalTypedData(state.withdrawal) } });
  }
  return requests.map(step => ({ ...step, dispatched: false, operation: null, evidence: null }));
}
export function fundingIntent(row: RecordRow): FundingIntent {
  const v = JSON.parse(row.input_json) as FundingIntent;
  if (v.kind !== "funding" || v.version !== 1 || fundingId(v.operationId) !== row.id || row.root_id !== row.id || stable(parseFundingInput(v.input)) !== stable(v.input) || !v.account || v.account.accountId !== "main" || typeof v.agentMode !== "boolean" || (v.agentMode && !v.caller)) throw new Error("Invalid saved funding identity.");
  getAddress(v.account.address);
  return v;
}
export function fundingState(row: RecordRow): FundingState {
  const intent = fundingIntent(row), state = JSON.parse(row.state_json) as FundingState;
  if (state.version !== 1 || !state.quote || stable(state.quote.input) !== stable(intent.input) || !sameAccount(state.quote.account, intent.account) || state.quote.recipient.toLowerCase() !== intent.account.address.toLowerCase() || state.quote.amountAtoms !== usdcAtoms(intent.input.amount).toString()) throw new Error("Saved funding quote changed its recipient or amount.");
  const expected = expectedSteps(intent, state);
  if (!Array.isArray(state.steps) || expected.length !== state.steps.length) throw new Error("Invalid saved funding steps.");
  state.steps.forEach((step, i) => {
    if (step.kind !== expected[i]!.kind || stable(step.request) !== stable(expected[i]!.request) || typeof step.dispatched !== "boolean") throw new Error("Saved funding Wallet request changed.");
    if (step.operation) validateWalletOperation(intent, step, step.operation);
    if (step.evidence) {
      if (step.kind !== "transaction" || !step.operation || ![step.operation.transactionHash, step.operation.replacementTransactionHash].includes(step.evidence.transactionHash)) throw new Error("Saved funding receipt is not linked to its Wallet request.");
      parseEvmTransactionResult(step.evidence, { chainId: intent.input.chainId, transactionHash: step.evidence.transactionHash });
    }
  });
  if (state.envelope !== null) {
    const signature = state.steps[0]?.operation?.signature;
    if (!state.withdrawal || !signature || stable(state.envelope) !== stable(withdrawalEnvelope(state.withdrawal, signature))) throw new Error("Saved signed withdrawal bytes changed.");
  }
  return state;
}
function validateWalletOperation(intent: FundingIntent, step: FundingStep, raw: unknown) {
  const operation = parseEvmOperationResult(raw, step.request, step.kind);
  if (operation.address.toLowerCase() !== intent.account.address.toLowerCase()) throw new Error("Wallet funding operation belongs to a different account.");
  return operation;
}
function stepStatus(intent: FundingIntent, step: FundingStep): string {
  if (step.kind === "typed_data") return step.operation?.signature ? "signed" : step.operation?.status ?? (step.dispatched ? "unknown" : "queued");
  const tx = step.evidence?.transaction, request = step.request as EvmSendTransactionRequest;
  if (tx) {
    const matches = tx.from.toLowerCase() === intent.account.address.toLowerCase() && tx.to?.toLowerCase() === request.to.toLowerCase() && tx.valueWei === "0" && tx.data.toLowerCase() === request.data.toLowerCase();
    if (!matches) return step.evidence?.receipt ? "replaced" : "unknown";
    return step.evidence?.receipt ? step.evidence.receipt.status === "success" ? "confirmed" : "reverted" : "submitted";
  }
  if (step.operation?.receipt) return "unknown";
  return step.operation?.status ?? (step.dispatched ? "unknown" : "queued");
}
export function fundingResult(row: RecordRow): FundingResult {
  const intent = fundingIntent(row), state = fundingState(row), steps = state.steps.map(step => ({ label: step.label, status: stepStatus(intent, step), transactionHash: step.evidence?.transactionHash ?? step.operation?.transactionHash ?? null }));
  const stopped = steps.some(s => ["rejected", "reverted", "failed", "replaced"].includes(s.status)) || state.exchangeRejected || row.phase === "fee_changed";
  const status = state.observation?.phase === "complete" ? "complete" : stopped ? "stopped" : steps.some(s => s.status === "prepared") ? "review" : "pending";
  return { operationId: row.id, state: status, phase: row.phase, summary: `${intent.input.direction === "deposit" ? "Deposit" : "Withdraw"} ${intent.input.amount} USDC ${intent.input.direction === "deposit" ? "from" : "to"} ${FUNDING_CHAINS[intent.input.chainId].name}`, message: state.lastError ?? state.observation?.message ?? (status === "stopped" ? "This transfer stopped. Its exact requests and progress remain saved." : status === "review" ? "Continue this operation to finish its EVM Wallet review." : "Progress is saved. Continue with this same operation ID to reconcile and finish the transfer."), direction: intent.input.direction, chainId: intent.input.chainId, amount: intent.input.amount, sourceTransactionHash: state.observation?.sourceTransactionHash ?? (intent.input.direction === "deposit" ? steps.at(-1)?.transactionHash ?? null : null), destinationTransactionHash: state.observation?.destinationTransactionHash ?? null, receivedUsdc: state.observation?.receivedAtoms === null || state.observation?.receivedAtoms === undefined ? null : formatUsdc(BigInt(state.observation.receivedAtoms)), quote: state.quote, steps, observation: state.observation };
}

/** The original immutable request is used after every interruption. No successor
 * burn or newly timestamped withdrawal is ever created for an existing ID. */
export async function runFunding(wallet: EvmWalletClient, store: Store, id: string, raw: FundingInput, caller: EvmWalletCaller | null, agentMode: boolean, options: FundingOptions = {}): Promise<FundingResult> {
  fundingId(id); const input = parseFundingInput(raw), transport = options.transport ?? createFundingTransport(), callOptions = optionsOf(options);
  if (agentMode && !caller) throw new Error("Agent funding needs its authenticated caller.");
  const abort = () => options.signal?.throwIfAborted(), now = options.now ?? Date.now;
  const deadline = options.deadlineMs ?? now() + 240_000;
  let row = await store.get(id);
  const account = (await wallet.accounts(callOptions)).accounts.find(a => a.accountId === "main");
  if (!account) throw new Error("Initialize the main EVM Wallet account first.");
  if (!row) {
    if (options.execute === false) throw new Error("No saved funding operation was found.");
    const quote = await (options.prepare ?? quoteFunding)(wallet, input, options);
    if (!sameAccount(account, quote.account)) throw new Error("Wallet identity changed while preparing funding.");
    const intent: FundingIntent = { kind: "funding", version: 1, operationId: id, input, caller, agentMode, account };
    const withdrawal = input.direction === "withdraw" ? withdrawalAction(input, account.address, quote.sourceDex, await (options.nextNonce ?? (async () => (options.now ?? Date.now)()))()) : null;
    const fromBlock = withdrawal ? blockHex(await transport.rpc(CCTP.hyperEvmRpc, "eth_blockNumber", [], options.signal)) : null;
    const destinationFromBlock = blockHex(await transport.rpc(withdrawal ? FUNDING_CHAINS[input.chainId].rpc : CCTP.hyperEvmRpc, "eth_blockNumber", [], options.signal));
    const state: FundingState = { version: 1, quote, withdrawal, steps: [], fromBlock, destinationFromBlock, envelope: null, exchangeDispatched: false, exchangeAccepted: false, exchangeRejected: false, exchangeReply: null, observation: null, lastError: null };
    state.steps = expectedSteps(intent, state); abort();
    row = await store.begin({ id, root_id: id, input_json: stable(intent), state_json: stable(state), summary: stable({ kind: "funding", title: `${input.direction} ${input.amount} USDC`, humanOwned: caller === null && !agentMode }), phase: "ready" });
  }
  const intent = fundingIntent(row);
  if (stable(intent.input) !== stable(input) || stable(intent.caller) !== stable(caller) || intent.agentMode !== agentMode) throw new Error("This funding ID already belongs to its original inputs and caller. Resume that same transfer.");
  if (!sameAccount(intent.account, account)) throw new Error("The EVM Wallet signing identity changed. Reconcile with the original account.");
  const state = fundingState(row);
  if (state.exchangeRejected) return fundingResult(row);
  const save = async (phase: string) => { abort(); if (row!.phase !== phase || row!.state_json !== stable(state)) row = await store.update(row!, state, phase); options.onRecord?.(row!); return row; };
  const pending = async () => {
    const result = fundingResult(row!);
    if (options.execute === false || options.waitForProgress === false || result.state !== "pending" || !result.steps.some(step => ["submitted", "signing", "signed"].includes(step.status)) || now() >= deadline) return result;
    options.onProgress?.("Waiting for the original Wallet transaction to confirm. The next funding step follows automatically…");
    await (options.wait ?? waitForFunding)(options.signal);
    return runFunding(wallet, store, id, input, caller, agentMode, { ...options, deadlineMs: deadline });
  };
  const observeWallet = async (step: FundingStep, rawOperation: unknown) => {
    step.operation = validateWalletOperation(intent, step, rawOperation);
    const hash = step.operation.receipt ? step.operation.transactionHash : step.operation.replacementTransactionHash ?? step.operation.transactionHash;
    if (step.kind === "transaction" && hash) step.evidence = await wallet.transaction({ chainId: input.chainId, transactionHash: hash }, callOptions);
  };
  for (let index = 0; index < state.steps.length; index++) {
    const step = state.steps[index]!;
    if (step.dispatched) {
      const operation = await wallet.operationStatus({ accountId: "main", chainId: step.request.chainId, requestId: step.request.requestId }, callOptions);
      if (operation.status !== "not_found") await observeWallet(step, operation);
      await save(`wallet_${index}_${stepStatus(intent, step)}`);
    }
    const status = stepStatus(intent, step);
    if (["rejected", "reverted", "failed", "replaced"].includes(status)) return fundingResult(row!);
    if (status === "confirmed" || (step.kind === "typed_data" && status === "signed")) continue;
    if (options.execute === false || !["queued", "prepared", "unknown"].includes(status) || (status === "unknown" && step.operation !== null)) return pending();
    options.onProgress?.(step.label);
    // Check again immediately before dispatching an unsigned final burn. The
    // saved calldata's fee cap is never expanded without a new owner decision.
    if (input.direction === "deposit" && index === state.steps.length - 1 && (!step.dispatched || status === "prepared")) {
      const current = await (options.prepare ?? quoteFunding)(wallet, input, options);
      if (BigInt(current.maxFeeAtoms) > BigInt(state.quote.maxFeeAtoms) || BigInt(current.activationFeeAtoms) > BigInt(state.quote.activationFeeAtoms)) {
        state.lastError = step.dispatched
          ? "Current forwarding or activation fees exceed this saved transfer's cap. Its original unsigned burn request remains in EVM Wallet. Decline that original request before preparing another transfer; this operation retains its original request ID."
          : "Current forwarding or activation fees exceed this saved transfer's cap. The burn was not requested. Prepare a new transfer to review the updated fees.";
        await save("fee_changed"); return fundingResult(row!);
      }
    }
    step.dispatched = true; state.lastError = null; await save(`wallet_${index}_requested`); abort();
    try {
      await observeWallet(step, step.kind === "transaction" ? await wallet.sendTransaction(step.request as EvmSendTransactionRequest, callOptions) : await wallet.signTypedData(step.request as EvmSignTypedDataRequest, callOptions));
      await save(`wallet_${index}_${stepStatus(intent, step)}`);
    } catch (error) {
      abort(); state.lastError = `The Wallet reply was interrupted. Continue this saved transfer to check its exact original request. ${messageOf(error)}`;
      await save(`wallet_${index}_unknown`); return fundingResult(row!);
    }
    if (!["confirmed", "signed"].includes(stepStatus(intent, step))) return pending();
  }
  if (state.withdrawal && state.envelope === null) {
    const signature = state.steps[0]!.operation?.signature;
    if (!signature) return fundingResult(row!);
    state.envelope = withdrawalEnvelope(state.withdrawal, signature); await save("withdrawal_signed");
  }
  if (state.withdrawal && state.exchangeDispatched) {
    state.observation = await (options.observe ?? observeFunding)(intent, state, transport, options.signal);
    await save(state.observation.phase);
    if (state.observation.sourceTransactionHash || state.exchangeAccepted || options.execute === false) return fundingResult(row!);
  }
  if (state.withdrawal && !state.exchangeAccepted && options.execute !== false) {
    const priorDispatch = state.exchangeDispatched;
    state.exchangeDispatched = true; state.lastError = null; await save("withdrawal_submitting"); abort();
    try {
      const reply = await transport.exchange(state.envelope, options.signal); state.exchangeReply = reply;
      const response = reply as { status?: string; response?: unknown } | null;
      if (response?.status === "ok" && !(response.response && typeof response.response === "object" && "error" in response.response)) { state.exchangeAccepted = true; await save("withdrawal_accepted"); }
      else if (!priorDispatch && (response?.status === "err" || (response?.response && typeof response.response === "object" && "error" in response.response))) {
        state.exchangeRejected = true; state.lastError = `Hyperliquid rejected this withdrawal: ${JSON.stringify(reply)}. No replacement withdrawal is created automatically.`;
        await save("exchange_rejected"); return fundingResult(row!);
      } else {
        // A retry can report a used nonce after an earlier successful but lost
        // reply. This never justifies replacing the original signed action.
        state.lastError = `Hyperliquid has not confirmed acceptance of this saved withdrawal: ${JSON.stringify(reply)}. Reconciliation will keep checking its original nonce.`;
        await save("withdrawal_unconfirmed");
      }
    } catch (error) { abort(); state.lastError = `The withdrawal reply was interrupted. Its exact signed action is retained; continue this operation to reconcile. ${messageOf(error)}`; await save("withdrawal_unconfirmed"); return fundingResult(row!); }
  }
  try { state.observation = await (options.observe ?? observeFunding)(intent, state, transport, options.signal); state.lastError = null; await save(state.observation.phase); }
  catch (error) { abort(); state.lastError = `Transfer progress is saved; destination verification is temporarily unavailable. ${messageOf(error)}`; await save("verification_unavailable"); }
  return fundingResult(row!);
}

// The evidence adapter below is deliberately separate from execution: Circle
// messages and chain receipts are observations and grant no signing authority.
export async function observeFunding(intent: FundingIntent, state: FundingState, transport: FundingTransport, signal?: AbortSignal): Promise<FundingObservation> {
  const deposit = intent.input.direction === "deposit", chain = FUNDING_CHAINS[intent.input.chainId];
  let sourceHash: string | null = null;
  const result = (phase: FundingObservation["phase"], message: string, extra: Partial<FundingObservation> = {}): FundingObservation => ({ phase, sourceTransactionHash: sourceHash, destinationTransactionHash: null, receivedAtoms: null, message, evidence: null, ...extra });
  if (deposit) {
    const step = state.steps.at(-1)!;
    if (stepStatus(intent, step) !== "confirmed") return result("waiting_source", "The exact source-chain deposit transaction is awaiting confirmation.");
    sourceHash = step.evidence?.transactionHash ?? null;
  } else {
    if (!state.withdrawal || !state.fromBlock || !state.exchangeDispatched) return result("waiting_source", "The withdrawal has not been submitted to Hyperliquid.");
    const expected = { coreDepositWallet: CCTP.coreDepositWallet, owner: intent.account.address, recipient: intent.account.address, nonce: state.withdrawal.nonce, destinationDomain: chain.domain, amountAtoms: state.quote.amountAtoms };
    const retained = state.observation?.sourceTransactionHash;
    if (retained) {
      const receipt = await transport.rpc(CCTP.hyperEvmRpc, "eth_getTransactionReceipt", [retained], signal) as { status?: unknown; logs?: unknown; transactionHash?: unknown } | null;
      if (receipt?.status === "0x1" && receipt.transactionHash === retained && findWithdrawalBurn(receipt.logs, expected)) sourceHash = retained;
    }
    if (!sourceHash) {
    const latest = blockHex(await transport.rpc(CCTP.hyperEvmRpc, "eth_blockNumber", [], signal));
    // Split only when the upstream RPC reports a range/result-size constraint.
    const burn = findWithdrawalBurn(await fundingLogs(transport, CCTP.hyperEvmRpc, withdrawalBurnFilter({ ...expected, fromBlock: state.fromBlock }), BigInt(state.fromBlock), BigInt(latest), signal), expected);
    if (!burn) return result("waiting_source", "Waiting for the original signed withdrawal's HyperEVM burn. An exchange acknowledgment alone is not a completed withdrawal.");
    const receipt = await transport.rpc(CCTP.hyperEvmRpc, "eth_getTransactionReceipt", [burn.transactionHash], signal) as { status?: unknown; logs?: unknown; transactionHash?: unknown } | null;
    if (!receipt || receipt.status !== "0x1" || receipt.transactionHash !== burn.transactionHash || !findWithdrawalBurn(receipt.logs, expected)) return result("waiting_source", "The withdrawal burn is awaiting a matching canonical receipt.");
    sourceHash = burn.transactionHash;
    }
  }
  if (!sourceHash) return result("waiting_source", "Waiting for the original source transaction.");
  const raw = await transport.circle(`/v2/messages/${deposit ? chain.domain : 19}?transactionHash=${sourceHash}`, signal);
  const matched = selectCctpMessage(raw, {
    sourceTxHash: sourceHash, sourceDomain: deposit ? chain.domain : 19, destinationDomain: deposit ? 19 : chain.domain,
    sender: CCTP.tokenMessenger, recipient: CCTP.tokenMessenger,
    destinationCaller: deposit ? CCTP.forwarder : "0x0000000000000000000000000000000000000000",
    burnToken: deposit ? chain.usdc : CCTP.hyperEvmUsdc,
    mintRecipient: deposit ? CCTP.forwarder : intent.account.address,
    messageSender: deposit ? intent.account.address : CCTP.coreDepositWallet,
    amountAtoms: state.quote.amountAtoms,
    hookData: deposit ? forwardHook(intent.account.address) : withdrawalHook(intent.account.address, state.withdrawal!.nonce),
    ...(deposit ? { maxFeeAtoms: state.quote.maxFeeAtoms, minFinalityThreshold: intent.input.speed === "fast" ? 1000 : 2000 } : {}),
  });
  if (!matched) return result("waiting_attestation", "The source transfer is confirmed. Waiting for Circle's matching CCTP message; USDC has not yet been verified at the destination.");
  const evidence = { cctpNonce: matched.nonce, attestationStatus: matched.attestationStatus, forwardState: matched.forwardState, feeExecutedAtoms: matched.feeExecutedAtoms };
  const destinationRpc = deposit ? CCTP.hyperEvmRpc : chain.rpc;
  const mintOptions = { messageTransmitter: CCTP.messageTransmitter, usdc: chain.usdc, recipient: intent.account.address };
  const coreOptions = { messageTransmitter: CCTP.messageTransmitter, usdc: CCTP.hyperEvmUsdc, forwarder: CCTP.forwarder, coreDepositWallet: CCTP.coreDepositWallet, owner: intent.account.address };
  let destinationReceipt: unknown = matched.forwardTxHash ? await transport.rpc(destinationRpc, "eth_getTransactionReceipt", [matched.forwardTxHash], signal) : null;
  let discovered = false;
  const hasProof = (value: unknown, allowDiscoveredReceipt: boolean) => deposit ? verifyCoreForwardReceipt(value, matched, { ...coreOptions, allowDiscoveredReceipt }) : verifyDestinationReceipt(value, matched, { ...mintOptions, allowDiscoveredReceipt });
  if (!hasProof(destinationReceipt, false)) {
    // A manually received CCTP message may never acquire Circle.forwardTxHash.
    // Discover only this message's exact nonce/body, from the saved pre-dispatch
    // destination checkpoint, then prove the destination mint independently.
    const latest = blockHex(await transport.rpc(destinationRpc, "eth_blockNumber", [], signal));
    const logs = await fundingLogs(transport, destinationRpc, destinationMintFilter(matched, { messageTransmitter: CCTP.messageTransmitter, fromBlock: state.destinationFromBlock }), BigInt(state.destinationFromBlock), BigInt(latest), signal);
    const hashes = destinationMintHashes(logs, matched, { messageTransmitter: CCTP.messageTransmitter });
    const receipts = await Promise.all(hashes.map(hash => transport.rpc(destinationRpc, "eth_getTransactionReceipt", [hash], signal)));
    const proven = receipts.filter(candidate => hasProof(candidate, true));
    if (proven.length > 1) throw new Error("Multiple destination transactions claim this CCTP mint; retry canonical receipt verification.");
    if (proven.length === 1) { destinationReceipt = proven[0]; discovered = true; }
  }
  if (!deposit) {
    const proof = verifyDestinationReceipt(destinationReceipt, matched, { ...mintOptions, allowDiscoveredReceipt: discovered });
    if (!proof) return result("waiting_forwarding", "Waiting for the destination receipt proving this CCTP message minted native USDC to your Wallet account.", { destinationTransactionHash: matched.forwardTxHash, evidence });
    return result("complete", `${formatUsdc(BigInt(proof.deliveredAtoms))} native USDC arrived on ${chain.name}. Its mint is included in a matching destination-chain receipt.`, { destinationTransactionHash: proof.transactionHash, receivedAtoms: proof.deliveredAtoms, evidence: { ...evidence, mint: proof } });
  }
  const proof = verifyCoreForwardReceipt(destinationReceipt, matched, { ...coreOptions, allowDiscoveredReceipt: discovered });
  if (!proof) return result("waiting_forwarding", "Waiting for the exact HyperEVM forwarding receipt into your default perps account.", { destinationTransactionHash: matched.forwardTxHash, evidence });
  const block = await transport.rpc(CCTP.hyperEvmRpc, "eth_getBlockByNumber", [`0x${BigInt(proof.blockNumber).toString(16)}`, false], signal) as { timestamp?: unknown } | null;
  if (!block || typeof block.timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.timestamp)) throw new Error("Missing destination block time for Core credit verification.");
  const notBeforeMs = Number(BigInt(block.timestamp) * 1000n);
  const ledger = await transport.info({ type: "userNonFundingLedgerUpdates", user: intent.account.address, startTime: notBeforeMs }, signal);
  const credits = observedCoreCredits(ledger, { owner: intent.account.address, coreDepositWallet: CCTP.coreDepositWallet, coreAmountAtoms: proof.coreAmountAtoms, notBeforeMs });
  return result("forwarded_to_core", credits.length === 1
    ? `CCTP forwarding succeeded and a matching ${credits[0]!.amount} USDC perps credit was observed. HyperCore's public ledger does not expose the EVM transaction link; the credit match is contextual.`
    : credits.length > 1 ? "CCTP forwarding succeeded. Multiple matching perps credits exist; the public ledger cannot identify this transfer's individual credit." : "CCTP forwarding succeeded and queued the default perps deposit. Waiting to observe the matching HyperCore ledger credit.", {
      destinationTransactionHash: proof.transactionHash, receivedAtoms: credits.length === 1 ? (BigInt(proof.coreAmountAtoms) / 100n).toString() : null, evidence: { ...evidence, forward: proof, coreCredits: credits, coreExecutionProven: false },
    });
}
