import { Principal } from "@dfinity/principal";
import { encodeFunctionData, decodeFunctionResult, getAddress, type Hex } from "viem";
import { connectEthereumProvider, type EthereumProviderConnection, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletInvocationClient, parseEvmWalletIntent, assertEvmWalletIntentAccount, EVM_WALLET_TOOLS, type EvmWalletClient, type EvmWalletIntent, type EvmOperationStatusResult } from "neutron-tools/evm_wallet";

// USDC's canonical Ethereum contract. Helper/minter addresses come from the
// protocol's saved, minter-discovered route; they are not permanent constants.
export const ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
// Official CkDeposit interface (DepositHelperWithSubaccount.sol).
export const DEPOSIT_HELPER_ABI = [
  { type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "depositErc20", stateMutability: "nonpayable", inputs: [{ name: "erc20Address", type: "address" }, { name: "amount", type: "uint256" }, { name: "principal", type: "bytes32" }, { name: "subaccount", type: "bytes32" }], outputs: [] },
] as const;

export type EthereumInvoiceRoute = { chainId: string; tokenAddress: string; helperAddress: string; minterAddress: string; recipientPrincipal: string };
export type EthereumFundingInvoice = { operationId: string; amountAtoms: string; payerAddress: string; principalWord: string; subaccountWord: string; route: EthereumInvoiceRoute };
export type EthereumFundingKind = "approval" | "deposit";
export type EthereumFundingStep = { kind: EthereumFundingKind; requestId: string; transaction: { from: Hex; to: Hex; data: Hex; value: "0x0" } };
export type EthereumFundingPlan = { invoice: EthereumFundingInvoice; steps: { approval: EthereumFundingStep; deposit: EthereumFundingStep } };
export type EthereumFundingRecord = {
  version: 1; invoiceId: string; source: "browser" | "evm_wallet"; step: EthereumFundingStep;
  state: "prepared" | "unknown" | "submitted" | "confirmed" | "reverted" | "rejected";
  transactionHash: Hex | null; walletIntent: EvmWalletIntent | null;
  receipt: { status: "success" | "reverted"; blockNumber: string; finality: string } | null;
  message: string | null;
};
/** Implement these callbacks against durable storage. claim and record must
 * compare the exact previous value atomically; only a successful claim sends. */
export type EthereumFundingJournal = {
  read(kind: EthereumFundingKind): Promise<EthereumFundingRecord | null>;
  claim(record: EthereumFundingRecord): Promise<{ claimed: boolean; record: EthereumFundingRecord }>;
  record(previous: EthereumFundingRecord, next: EthereumFundingRecord): Promise<EthereumFundingRecord>;
};
export type EthereumReadProvider = { request(input: { method: string; params?: readonly unknown[] }): Promise<unknown> };

function address(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid Ethereum address.");
  return getAddress(value.toLowerCase());
}
function word(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Invoice words must contain exactly 32 bytes.");
  return value.toLowerCase() as Hex;
}
function requestId(value: string): string { if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Retain a 32-character hexadecimal request ID."); return value; }
function atoms(value: string): bigint { if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error("Invoice amount must be a positive uint256."); return BigInt(value); }
export function principalToEthereumWord(value: string): Hex {
  const principal = Principal.fromText(value), bytes = principal.toUint8Array();
  if (principal.isAnonymous() || !bytes.length || bytes.length > 29) throw new Error("The deposit recipient must be the marketplace canister principal.");
  const result = new Uint8Array(32); result[0] = bytes.length; result.set(bytes, 1);
  return `0x${[...result].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export function buildEthereumFundingPlan(invoice: EthereumFundingInvoice, canonicalRoute: EthereumInvoiceRoute, ids: Record<EthereumFundingKind, string>): EthereumFundingPlan {
  requestId(invoice.operationId); requestId(ids.approval); requestId(ids.deposit);
  if (ids.approval === ids.deposit) throw new Error("Approval and deposit require different retained request IDs.");
  if (invoice.route.chainId !== "1" || canonicalRoute.chainId !== "1") throw new Error("This payment route requires Ethereum Mainnet.");
  const route = { ...invoice.route, tokenAddress: address(invoice.route.tokenAddress), helperAddress: address(invoice.route.helperAddress), minterAddress: address(invoice.route.minterAddress) };
  if (route.tokenAddress.toLowerCase() !== ETHEREUM_USDC) throw new Error("The invoice does not use canonical Ethereum USDC.");
  for (const field of ["tokenAddress", "helperAddress", "minterAddress"] as const) if (route[field] !== address(canonicalRoute[field])) throw new Error(`The saved invoice ${field} differs from its protocol route.`);
  if (Principal.fromText(route.recipientPrincipal).toText() !== Principal.fromText(canonicalRoute.recipientPrincipal).toText()) throw new Error("The invoice names another marketplace recipient.");
  const principalWord = word(invoice.principalWord), subaccountWord = word(invoice.subaccountWord);
  if (principalWord !== principalToEthereumWord(route.recipientPrincipal)) throw new Error("The invoice principal word does not encode its marketplace recipient.");
  const amount = atoms(invoice.amountAtoms), payer = address(invoice.payerAddress);
  const approval: EthereumFundingStep = { kind: "approval", requestId: ids.approval, transaction: { from: payer, to: address(ETHEREUM_USDC), value: "0x0", data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [route.helperAddress, amount] }) } };
  const deposit: EthereumFundingStep = { kind: "deposit", requestId: ids.deposit, transaction: { from: payer, to: route.helperAddress, value: "0x0", data: encodeFunctionData({ abi: DEPOSIT_HELPER_ABI, functionName: "depositErc20", args: [route.tokenAddress, amount, principalWord, subaccountWord] }) } };
  Object.freeze(approval.transaction); Object.freeze(deposit.transaction);
  Object.freeze(approval); Object.freeze(deposit); Object.freeze(route);
  return Object.freeze({ invoice: Object.freeze({ ...invoice, payerAddress: payer, principalWord, subaccountWord, route }), steps: Object.freeze({ approval, deposit }) });
}
function hexResult(value: unknown): Hex { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("Invalid Ethereum RPC bytes."); return value as Hex; }
function txHash(value: unknown): Hex { if (typeof value !== "string") throw new Error("The wallet did not return a transaction hash."); return word(value); }
export async function readEthereumFundingState(plan: EthereumFundingPlan, provider: EthereumReadProvider) {
  if (await provider.request({ method: "eth_chainId" }) !== "0x1") throw new Error("Connect the wallet to Ethereum Mainnet.");
  const route = plan.invoice.route;
  const call = async (to: string, data: Hex) => hexResult(await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] }));
  for (const target of [route.helperAddress, route.tokenAddress]) {
    const code = hexResult(await provider.request({ method: "eth_getCode", params: [target, "latest"] }));
    if (!/[1-9a-f]/i.test(code.slice(2))) throw new Error("The invoice helper or token contract has no code.");
  }
  const minter = decodeFunctionResult({ abi: DEPOSIT_HELPER_ABI, functionName: "getMinterAddress", data: await call(route.helperAddress, encodeFunctionData({ abi: DEPOSIT_HELPER_ABI, functionName: "getMinterAddress" })) });
  if (address(minter) !== address(route.minterAddress)) throw new Error("The deposit helper belongs to another minter.");
  const owner = address(plan.invoice.payerAddress), helper = address(route.helperAddress);
  const allowance = decodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", data: await call(route.tokenAddress, encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [owner, helper] })) });
  const balance = decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: await call(route.tokenAddress, encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [owner] })) });
  return { allowanceAtoms: String(allowance), balanceAtoms: String(balance), approvalRequired: allowance !== atoms(plan.invoice.amountAtoms) };
}

/** Call from the tile's click handler before any awaited app calls. The existing
 * Kernel provider handles iframe access and declines agent delegation. */
export async function connectEthereumFundingBrowser(plan?: EthereumFundingPlan): Promise<EthereumProviderConnection> {
  const connection = await connectEthereumProvider();
  try {
    if (plan) await requireBrowserPayer(connection.provider, plan);
    else {
      const accounts = await connection.provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || !accounts.length || typeof accounts[0] !== "string") throw new Error("The browser wallet returned no Ethereum payer.");
      address(accounts[0]);
    }
    if (await connection.provider.request({ method: "eth_chainId" }) !== "0x1") await connection.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    if (await connection.provider.request({ method: "eth_chainId" }) !== "0x1") throw new Error("The browser wallet is not on Ethereum Mainnet.");
    return connection;
  } catch (error) { await connection.close().catch(() => undefined); throw error; }
}
async function requireBrowserPayer(provider: EthereumReadProvider, plan: EthereumFundingPlan) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts.some(account => typeof account === "string" && address(account) === address(plan.invoice.payerAddress))) throw new Error("Reconnect the invoice's original Ethereum payer.");
}
export function createEthereumFundingWallet(context: MsgBusToolContext): EvmWalletClient {
  return createEvmWalletInvocationClient(context, { parallelReadTools: [EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.callContract, EVM_WALLET_TOOLS.readContract, EVM_WALLET_TOOLS.transaction] });
}
export async function readEthereumFundingWalletState(plan: EthereumFundingPlan, client: EvmWalletClient) {
  const read: EthereumReadProvider = { async request({ method, params }) {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_call") { const tx = params![0] as { to: string; data: string }; return (await client.callContract({ accountId: "main", chainId: "1", ...tx })).result; }
    if (method === "eth_getCode") {
      const to = String(params![0]);
      const data = address(to) === address(plan.invoice.route.helperAddress)
        ? encodeFunctionData({ abi: DEPOSIT_HELPER_ABI, functionName: "getMinterAddress" })
        : encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [address(plan.invoice.payerAddress), address(plan.invoice.route.helperAddress)] });
      return (await client.readContract({ accountId: "main", chainId: "1", to, data })).code;
    }
    throw new Error("Unsupported funding read.");
  } };
  return readEthereumFundingState(plan, read);
}

function assertRecord(plan: EthereumFundingPlan, kind: EthereumFundingKind, source: EthereumFundingRecord["source"], record: EthereumFundingRecord): void {
  if (record.version !== 1 || record.invoiceId !== plan.invoice.operationId || record.source !== source || JSON.stringify(record.step) !== JSON.stringify(plan.steps[kind])) throw new Error("The saved Ethereum step differs from this invoice. Keep its original request.");
}
/** Merge only observations of one immutable Wallet request. In particular, a
 * concurrent status message cannot discard a hash returned by the sender. */
export function mergeEthereumFundingRecords(previous: EthereumFundingRecord, current: EthereumFundingRecord, next: EthereumFundingRecord): EthereumFundingRecord {
  const identity = (record: EthereumFundingRecord) => JSON.stringify({ version: record.version, invoiceId: record.invoiceId, source: record.source, step: record.step, walletIntent: record.walletIntent });
  if (identity(previous) !== identity(current) || identity(previous) !== identity(next)) throw new Error("Conflicting Ethereum funding request identity.");
  const records = [previous, current, next];
  const hashes = new Set(records.flatMap(record => record.transactionHash ? [txHash(record.transactionHash)] : []));
  if (hashes.size > 1) throw new Error("Conflicting Ethereum funding transaction hashes; retain and reconcile the original request.");
  const hash = [...hashes][0] ?? null;
  const withReceipts = records.filter(record => record.receipt !== null);
  if (withReceipts.length && !hash) throw new Error("Ethereum receipt evidence has no transaction hash.");
  let strongestReceipt: EthereumFundingRecord | undefined;
  const finality = (value: string) => value === "finalized" ? 2 : value === "safe" ? 1 : 0;
  for (const record of withReceipts) {
    if (strongestReceipt && (record.receipt!.status !== strongestReceipt.receipt!.status || record.receipt!.blockNumber !== strongestReceipt.receipt!.blockNumber)) throw new Error("Conflicting Ethereum receipt evidence; reconcile the original transaction.");
    if (!strongestReceipt || finality(record.receipt!.finality) >= finality(strongestReceipt.receipt!.finality)) strongestReceipt = record;
  }
  if (strongestReceipt) return { ...strongestReceipt, transactionHash: hash, state: strongestReceipt.receipt!.status === "success" ? "confirmed" : "reverted" };
  // With no contention, preserve the caller's explicit prepared -> unknown
  // dispatch transition. During contention, prefer already retained chain
  // evidence or a known rejection over a stale observer's empty result.
  const unchanged = JSON.stringify(previous) === JSON.stringify(current);
  const rank = (record: EthereumFundingRecord) => record.transactionHash ? 3 : record.state === "rejected" ? 2 : record.state === "prepared" ? 1 : 0;
  const chosen = unchanged || rank(next) > rank(current) ? next : current;
  return { ...chosen, transactionHash: hash, receipt: null };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function userRejected(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === 4001; }
type Driver = {
  source: EthereumFundingRecord["source"];
  prepare(step: EthereumFundingStep): Promise<EvmWalletIntent | null>;
  send(record: EthereumFundingRecord): Promise<Partial<EthereumFundingRecord>>;
  observe(record: EthereumFundingRecord): Promise<Partial<EthereumFundingRecord>>;
};
async function executeStep(plan: EthereumFundingPlan, kind: EthereumFundingKind, journal: EthereumFundingJournal, driver: Driver): Promise<EthereumFundingRecord> {
  async function retain(previous: EthereumFundingRecord, patch: Partial<EthereumFundingRecord>): Promise<EthereumFundingRecord> {
    const next = mergeEthereumFundingRecords(previous, previous, { ...previous, ...patch });
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
    try { return await journal.record(previous, next); }
    catch (error) {
      // A lost write response or a concurrent observer is not permission to
      // repeat the financial effect. Re-read and merge this same evidence.
      const current = await journal.read(kind);
      if (!current) throw error;
      assertRecord(plan, kind, driver.source, current);
      const merged = mergeEthereumFundingRecords(previous, current, next);
      if (JSON.stringify(current) === JSON.stringify(merged)) return current;
      return journal.record(current, merged);
    }
  }
  async function send(saved: EthereumFundingRecord): Promise<EthereumFundingRecord> {
    let observed: Partial<EthereumFundingRecord>;
    try { observed = await driver.send(saved); }
    catch (error) { observed = { state: "unknown", message: `${message(error)} The original request may have been submitted; do not send it again. Reconcile its retained request ID or transaction.` }; }
    return retain(saved, observed);
  }
  let saved = await journal.read(kind);
  if (saved) {
    assertRecord(plan, kind, driver.source, saved);
    if (["confirmed", "reverted", "rejected"].includes(saved.state)) return saved;
    // A browser request without a hash has nothing new to observe. Writing a
    // different message here used to invalidate the sender's pending CAS.
    if (driver.source === "browser" && !saved.transactionHash) return saved;
    // Wallet can return an unsigned, revised review after its nonce changes.
    // An explicit continuation may ask the existing provider to review that
    // exact same request again; no new ID or root signing bypass is used.
    if (driver.source === "evm_wallet" && saved.state === "prepared") return send(saved);
    return retain(saved, await driver.observe(saved));
  }
  const step = plan.steps[kind];
  const walletIntent = await driver.prepare(step);
  const original: EthereumFundingRecord = { version: 1, invoiceId: plan.invoice.operationId, source: driver.source, step, walletIntent, state: "unknown", transactionHash: null, receipt: null, message: "The original wallet request is saved. Its result is not yet known; do not send it again. Reconcile the original request." };
  const claim = await journal.claim(original); saved = claim.record;
  assertRecord(plan, kind, driver.source, saved);
  if (!claim.claimed) return saved;
  // If this write's reply is lost, the claimed unknown record still prevents a
  // browser resend. EVM Wallet can find the same saved request without signing.
  return send(saved);
}
async function browserReceipt(provider: EthereumReadProvider, record: EthereumFundingRecord): Promise<Partial<EthereumFundingRecord>> {
  if (!record.transactionHash) return { state: "unknown", message: "The browser request has no saved hash. Check the original wallet transaction; do not send it again." };
  const raw = await provider.request({ method: "eth_getTransactionReceipt", params: [record.transactionHash] });
  if (raw === null) return { state: "submitted", message: "The original Ethereum transaction is awaiting a receipt." };
  if (!raw || typeof raw !== "object") throw new Error("Invalid Ethereum receipt.");
  const receipt = raw as Record<string, unknown>;
  if (txHash(receipt.transactionHash) !== record.transactionHash || typeof receipt.from !== "string" || address(receipt.from) !== record.step.transaction.from || typeof receipt.to !== "string" || address(receipt.to) !== record.step.transaction.to || typeof receipt.blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber) || !["0x0", "0x1"].includes(String(receipt.status))) throw new Error("The receipt does not match the saved Ethereum transaction.");
  const success = receipt.status === "0x1";
  return { state: success ? "confirmed" : "reverted", receipt: { status: success ? "success" : "reverted", blockNumber: String(BigInt(receipt.blockNumber)), finality: "included" }, message: success ? record.step.kind === "approval" ? "USDC approval confirmed. No payment has been made." : "Ethereum deposit confirmed. The protocol must verify this payment before granting app access." : "The Ethereum transaction reverted." };
}
export async function executeBrowserFundingStep(plan: EthereumFundingPlan, kind: EthereumFundingKind, connection: EthereumProviderConnection, journal: EthereumFundingJournal): Promise<EthereumFundingRecord> {
  return executeStep(plan, kind, journal, {
    source: "browser",
    async prepare() {
      await requireBrowserPayer(connection.provider, plan);
      const state = await readEthereumFundingState(plan, connection.provider);
      if (BigInt(state.balanceAtoms) < atoms(plan.invoice.amountAtoms)) throw new Error("The Ethereum account has insufficient USDC for this invoice.");
      if (kind === "deposit" && state.approvalRequired) throw new Error("Confirm the invoice's exact USDC approval before its deposit.");
      return null;
    },
    async send(record) {
      let result: unknown;
      try { result = await connection.provider.request({ method: "eth_sendTransaction", params: [record.step.transaction] }); }
      catch (error) { if (userRejected(error)) return { state: "rejected", message: "The browser wallet declined this transaction before submission." }; throw error; }
      return { state: "submitted", transactionHash: txHash(result), message: record.step.kind === "approval" ? "Approval submitted; this is not a payment." : "Deposit submitted; waiting for Ethereum confirmation." };
    },
    observe: record => browserReceipt(connection.provider, record),
  });
}

export async function executeEvmFundingStep(plan: EthereumFundingPlan, kind: EthereumFundingKind, client: EvmWalletClient, journal: EthereumFundingJournal): Promise<EthereumFundingRecord> {
  async function observe(record: EthereumFundingRecord, status?: EvmOperationStatusResult): Promise<Partial<EthereumFundingRecord>> {
    if (!record.walletIntent) throw new Error("The saved EVM Wallet intent is unavailable.");
    await assertEvmWalletIntentAccount(client, record.walletIntent);
    const result = status ?? await client.operationStatus({ accountId: "main", chainId: "1", requestId: record.step.requestId });
    if (result.status === "not_found") return { state: "unknown", message: "The original Wallet request was not found. Do not reconstruct or send another payment." };
    if (result.address.toLowerCase() !== record.walletIntent.walletAddress.toLowerCase() || result.kind !== "transaction") throw new Error("The Wallet operation belongs to another payer or effect.");
    if (result.replacementTransactionHash) return { state: "unknown", message: "The original Wallet transaction has a replacement. Verify that exact replacement before continuing.", transactionHash: result.transactionHash ? txHash(result.transactionHash) : null };
    if (!result.transactionHash) return { state: result.status === "rejected" ? "rejected" : result.status === "prepared" ? "prepared" : "unknown", message: result.message ?? (result.status === "prepared" ? "The original Wallet request requires a fresh review. Continue this same request to approve its updated review." : "The original Wallet request has no confirmed transaction hash.") };
    const hash = txHash(result.transactionHash), evidence = await client.transaction({ chainId: "1", transactionHash: hash });
    const transaction = evidence.transaction;
    if (transaction && (address(transaction.from) !== record.step.transaction.from || !transaction.to || address(transaction.to) !== record.step.transaction.to || transaction.data.toLowerCase() !== record.step.transaction.data.toLowerCase() || transaction.valueWei !== "0")) throw new Error("The Wallet transaction does not match the invoice's original call.");
    if (!transaction || !evidence.receipt) return { state: "submitted", transactionHash: hash, message: "The original Ethereum transaction is awaiting chain evidence." };
    const receipt = evidence.receipt, success = receipt.status === "success";
    return { state: success ? "confirmed" : "reverted", transactionHash: hash, receipt: { status: receipt.status, blockNumber: receipt.blockNumber, finality: receipt.finality }, message: success ? kind === "approval" ? "USDC approval confirmed. No payment has been made." : "Ethereum deposit confirmed. The protocol must independently verify the payment." : "The Ethereum transaction reverted." };
  }
  return executeStep(plan, kind, journal, {
    source: "evm_wallet",
    async prepare(step) {
      const account = (await client.accounts()).accounts.find(value => value.accountId === "main");
      if (!account || address(account.address) !== address(plan.invoice.payerAddress)) throw new Error("EVM Wallet is not the invoice's saved payer.");
      const state = await readEthereumFundingWalletState(plan, client);
      if (BigInt(state.balanceAtoms) < atoms(plan.invoice.amountAtoms)) throw new Error("EVM Wallet has insufficient USDC for this invoice.");
      if (kind === "deposit" && state.approvalRequired) throw new Error("Confirm the invoice's exact USDC approval before its deposit.");
      return parseEvmWalletIntent({ version: 1, kind: "transaction", request: { accountId: "main", chainId: "1", requestId: step.requestId, to: step.transaction.to, valueWei: "0", data: step.transaction.data }, walletAddress: account.address, walletKeyFingerprint: account.keyFingerprint });
    },
    async send(record) {
      await assertEvmWalletIntentAccount(client, record.walletIntent!);
      const status = await client.operationStatus({ accountId: "main", chainId: "1", requestId: record.step.requestId });
      if (status.status !== "not_found" && status.status !== "prepared") return observe(record, status);
      return observe(record, await client.sendTransaction(record.walletIntent!.request as import("neutron-tools/evm_wallet").EvmSendTransactionRequest));
    },
    observe,
  });
}

/** Observation only, supplied by the existing browser provider or a direct RPC
 * adapter. A timeout returns the pending record and never resubmits its call. */
export async function pollEthereumFundingReceipt(provider: EthereumReadProvider, record: EthereumFundingRecord, options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal }): Promise<EthereumFundingRecord> {
  const deadline = Date.now() + options.timeoutMs;
  let current = record;
  while (true) {
    options.signal?.throwIfAborted();
    current = { ...current, ...await browserReceipt(provider, current) };
    if (["confirmed", "reverted", "rejected", "unknown"].includes(current.state) || Date.now() >= deadline) return current;
    await new Promise<void>((resolve, reject) => {
      const done = () => { options.signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(done, Math.min(options.intervalMs ?? 1500, Math.max(0, deadline - Date.now())));
      const abort = () => { clearTimeout(timer); reject(options.signal?.reason ?? new Error("Ethereum receipt observation canceled.")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
