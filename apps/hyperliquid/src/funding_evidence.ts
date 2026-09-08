import { decodeEventLog, encodeEventTopics, parseAbi, type Hex } from "viem";

// Contract/event layouts: Circle CCTP V2 technical guide and
// circlefin/{evm-cctp-contracts,hyperevm-circle-contracts}. These functions prove
// observed effects; an attestation or a successful source burn is not delivery.
const events = parseAbi([
  "event CrossChainWithdraw(address indexed from, bytes32 indexed to, uint256 value, uint32 destinationDomain, uint64 indexed coreNonce)",
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event SendAsset(address indexed coreRecipient, uint64 coreAmount, uint32 destinationDex)",
  "event NewCoreAccountFeeApplied(address indexed coreRecipient, uint64 newCoreAccountFee, uint256 evmDepositAmount, uint64 coreSentAmount)",
]);
const ZERO = `0x${"0".repeat(40)}`;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null; }
function hex(value: unknown, bytes?: number): Hex {
  if (typeof value !== "string" || !HEX.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2)) throw new Error("Invalid evidence hex bytes.");
  return value.toLowerCase() as Hex;
}
function uint(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) return BigInt(value);
  throw new Error("Invalid evidence unsigned integer.");
}
function same(a: unknown, b: unknown): boolean { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
export function evidenceAddressWord(address: string): Hex {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
  return hex(address, 32);
}
/** CoreDepositWallet's default forwarding hook for sendToEvmWithData(data=0x). */
export function withdrawalHook(owner: string, nonce: string | number): Hex {
  const value = uint(nonce);
  if (value >= (1n << 64n)) throw new Error("HyperCore withdrawal nonce exceeds uint64.");
  // bytes24("cctp-forward"), uint32 version=0, uint32 dataLength=28,
  // address owner, uint64 signed Core nonce. CCTP nonce is a different value.
  return `0x636374702d666f7277617264${"0".repeat(24)}000000000000001c${hex(owner, 20).slice(2)}${value.toString(16).padStart(16, "0")}`;
}
function unique<T>(items: T[], identity: (item: T) => string): T | null {
  const rows = [...new Map(items.map((item) => [identity(item), item])).values()];
  if (rows.length > 1) throw new Error("Ambiguous funding evidence: multiple distinct matches.");
  return rows[0] ?? null;
}
function decoded(raw: unknown, address: string, name: string): Obj | null {
  const log = obj(raw);
  if (!log || log.removed === true || !same(log.address, address) || !Array.isArray(log.topics)) return null;
  try {
    const event = decodeEventLog({ abi: events, topics: log.topics as [Hex, ...Hex[]], data: hex(log.data), strict: true });
    return event.eventName === name ? event.args as unknown as Obj : null;
  } catch { return null; }
}
function receipt(raw: unknown, expectedHash?: string): Obj | null {
  const value = obj(raw);
  if (!value || !Array.isArray(value.logs) || typeof value.transactionHash !== "string" || !HASH.test(value.transactionHash)) return null;
  if (value.status !== "success" && value.status !== "0x1" && value.status !== 1) return null;
  if (expectedHash && !same(value.transactionHash, expectedHash)) return null;
  // A log attached to another receipt is not evidence for this transaction.
  if (value.logs.some((rawLog) => {
    const log = obj(rawLog);
    return !log || log.removed === true || (log.transactionHash !== undefined && !same(log.transactionHash, value.transactionHash));
  })) return null;
  return value;
}

export type WithdrawalBurnIntent = {
  coreDepositWallet: string; owner: string; recipient: string; nonce: string | number;
  destinationDomain: number; amountAtoms: string;
};
export function withdrawalBurnFilter(input: Pick<WithdrawalBurnIntent, "coreDepositWallet" | "owner" | "recipient" | "nonce"> & { fromBlock: string; toBlock?: string }) {
  const nonce = uint(input.nonce);
  if (nonce >= (1n << 64n)) throw new Error("HyperCore withdrawal nonce exceeds uint64.");
  return {
    address: hex(input.coreDepositWallet, 20), fromBlock: `0x${uint(input.fromBlock).toString(16)}`,
    toBlock: input.toBlock === undefined ? "latest" : `0x${uint(input.toBlock).toString(16)}`,
    topics: encodeEventTopics({ abi: events, eventName: "CrossChainWithdraw", args: { from: hex(input.owner, 20), to: evidenceAddressWord(input.recipient), coreNonce: nonce } }),
  };
}
export type WithdrawalBurnEvidence = { transactionHash: string; blockNumber: string; amountAtoms: string; coreNonce: string };
export function findWithdrawalBurn(raw: unknown, input: WithdrawalBurnIntent): WithdrawalBurnEvidence | null {
  if (!Array.isArray(raw)) throw new Error("Invalid HyperEVM withdrawal log response.");
  const matches: WithdrawalBurnEvidence[] = [];
  for (const item of raw) {
    const log = obj(item), event = decoded(item, input.coreDepositWallet, "CrossChainWithdraw");
    if (!log || !event || !same(event.from, input.owner) || !same(event.to, evidenceAddressWord(input.recipient)) || uint(event.coreNonce) !== uint(input.nonce) || uint(event.destinationDomain) !== uint(input.destinationDomain) || uint(event.value) !== uint(input.amountAtoms)) continue;
    matches.push({ transactionHash: hex(log.transactionHash, 32), blockNumber: uint(log.blockNumber).toString(), amountAtoms: uint(event.value).toString(), coreNonce: uint(event.coreNonce).toString() });
  }
  return unique(matches, (entry) => `${entry.transactionHash}:${entry.coreNonce}`);
}

export type CctpMessage = {
  raw: Hex; sourceDomain: number; destinationDomain: number; nonce: Hex;
  sender: Hex; recipient: Hex; destinationCaller: Hex; minFinalityThreshold: number; finalityThresholdExecuted: number;
  messageBody: Hex; burnToken: Hex; mintRecipient: Hex; amountAtoms: string; messageSender: Hex;
  maxFeeAtoms: string; feeExecutedAtoms: string; expirationBlock: string; hookData: Hex;
};
/** Decode the attested bytes themselves; API decodedMessage is display metadata. */
export function decodeCctpMessage(value: unknown): CctpMessage {
  const raw = hex(value), bytes = (raw.length - 2) / 2;
  if (bytes < 376) throw new Error("Truncated CCTP V2 message.");
  const at = (offset: number, length?: number): Hex => `0x${raw.slice(2 + offset * 2, length === undefined ? undefined : 2 + (offset + length) * 2)}`;
  const n = (offset: number, length: number) => uint(at(offset, length));
  if (n(0, 4) !== 1n || n(148, 4) !== 1n) throw new Error("Unsupported CCTP message or burn-message version.");
  const result: CctpMessage = {
    raw, sourceDomain: Number(n(4, 4)), destinationDomain: Number(n(8, 4)), nonce: at(12, 32),
    sender: at(44, 32), recipient: at(76, 32), destinationCaller: at(108, 32), minFinalityThreshold: Number(n(140, 4)), finalityThresholdExecuted: Number(n(144, 4)),
    messageBody: at(148), burnToken: at(152, 32), mintRecipient: at(184, 32), amountAtoms: n(216, 32).toString(), messageSender: at(248, 32),
    maxFeeAtoms: n(280, 32).toString(), feeExecutedAtoms: n(312, 32).toString(), expirationBlock: n(344, 32).toString(), hookData: at(376),
  };
  if (uint(result.feeExecutedAtoms) > uint(result.maxFeeAtoms) || uint(result.feeExecutedAtoms) >= uint(result.amountAtoms)) throw new Error("Invalid CCTP message fee.");
  return result;
}
export type CctpEvidenceIntent = {
  sourceTxHash: string; sourceDomain: number; destinationDomain: number;
  sender: string; recipient: string; destinationCaller: string; burnToken: string; mintRecipient: string;
  messageSender: string; amountAtoms: string; hookData: string; maxFeeAtoms?: string; minFinalityThreshold?: number;
};
export type MatchedCctpMessage = CctpMessage & {
  sourceTxHash: string; attestationStatus: string; attestation: string | null; forwardState: string | null; forwardTxHash: string | null;
};
function matchesCctpIntent(message: CctpMessage, expected: CctpEvidenceIntent): boolean {
  if (message.sourceDomain !== expected.sourceDomain || message.destinationDomain !== expected.destinationDomain || uint(message.amountAtoms) !== uint(expected.amountAtoms) || !same(message.hookData, hex(expected.hookData))) return false;
  if ((["sender", "recipient", "destinationCaller", "burnToken", "mintRecipient", "messageSender"] as const).some((key) => !same(message[key], evidenceAddressWord(expected[key])))) return false;
  if (expected.maxFeeAtoms !== undefined && uint(message.maxFeeAtoms) !== uint(expected.maxFeeAtoms)) return false;
  if (expected.minFinalityThreshold !== undefined && message.minFinalityThreshold !== expected.minFinalityThreshold) return false;
  return true;
}
export function selectCctpMessage(raw: unknown, expected: CctpEvidenceIntent): MatchedCctpMessage | null {
  const response = obj(raw);
  if (!response || !Array.isArray(response.messages)) throw new Error("Invalid Circle message response.");
  // GET /v2/messages is queried by source transaction hash. When Circle also
  // supplies its source hash, it must agree with the immutable transaction.
  if (response.sourceTxHash !== undefined && !same(response.sourceTxHash, expected.sourceTxHash)) throw new Error("Circle returned evidence for a different source transaction.");
  const found: MatchedCctpMessage[] = [];
  for (const item of response.messages) {
    const row = obj(item);
    if (!row || row.cctpVersion !== 2 || typeof row.message !== "string" || row.message === "0x") continue;
    let message: CctpMessage;
    try { message = decodeCctpMessage(row.message); } catch { continue; }
    if (!matchesCctpIntent(message, expected)) continue;
    const attestation = typeof row.attestation === "string" && HEX.test(row.attestation) && row.attestation !== "0x" ? row.attestation : null;
    found.push({ ...message, sourceTxHash: hex(expected.sourceTxHash, 32), attestationStatus: typeof row.status === "string" ? row.status : "unknown", attestation, forwardState: typeof row.forwardState === "string" ? row.forwardState : null, forwardTxHash: typeof row.forwardTxHash === "string" && HASH.test(row.forwardTxHash) ? row.forwardTxHash : null });
  }
  return unique(found, (message) => message.raw);
}

export type DestinationMintEvidence = { transactionHash: string; blockNumber: string; deliveredAtoms: string; nonce: string; finality: "included" };
function matchesMessageReceived(log: unknown, message: MatchedCctpMessage, transmitter: string): boolean {
  const event = decoded(log, transmitter, "MessageReceived");
  return !!event && uint(event.sourceDomain) === BigInt(message.sourceDomain) && same(event.nonce, message.nonce) && same(event.sender, message.sender) && uint(event.finalityThresholdExecuted) === BigInt(message.finalityThresholdExecuted) && same(event.messageBody, message.messageBody);
}
/** A re-attestation can change executed fee, expiry and finality, but not the burn intent. */
function messageReceivedVariant(log: unknown, current: MatchedCctpMessage, expected: CctpEvidenceIntent, transmitter: string): MatchedCctpMessage | null {
  const event = decoded(log, transmitter, "MessageReceived");
  if (!event || !matchesCctpIntent(current, expected) || !same(current.sourceTxHash, expected.sourceTxHash) || uint(event.sourceDomain) !== BigInt(current.sourceDomain) || !same(event.nonce, current.nonce) || !same(event.sender, current.sender)) return null;
  try {
    const finality = uint(event.finalityThresholdExecuted);
    if (finality > 0xffffffffn || finality < BigInt(current.minFinalityThreshold)) return null;
    // MessageReceived exposes the attested body and executed finality. Reuse
    // only the immutable header from the matched burn; validate its reconstructed
    // body against that same operation before accepting a prior attestation.
    const body = hex(event.messageBody);
    const raw = `${current.raw.slice(0, 2 + 144 * 2)}${finality.toString(16).padStart(8, "0")}${body.slice(2)}` as Hex;
    const message = decodeCctpMessage(raw);
    if (!matchesCctpIntent(message, expected)) return null;
    // The current API signature may not sign this already-consumed variant.
    return { ...current, ...message, attestation: null, attestationStatus: "consumed" };
  } catch { return null; }
}
/** Read-only discovery for a manual mint or an outdated Circle forward hash. */
export function destinationMintFilter(message: MatchedCctpMessage, input: { messageTransmitter: string; fromBlock: string; toBlock?: string; allowReattestation?: boolean }) {
  return {
    address: hex(input.messageTransmitter, 20), fromBlock: `0x${uint(input.fromBlock).toString(16)}`,
    toBlock: input.toBlock === undefined ? "latest" : `0x${uint(input.toBlock).toString(16)}`,
    topics: encodeEventTopics({ abi: events, eventName: "MessageReceived", args: { nonce: hex(message.nonce, 32), ...(input.allowReattestation ? {} : { finalityThresholdExecuted: message.finalityThresholdExecuted }) } }),
  };
}
/** A matching log is a candidate; still verify its complete canonical receipt. */
export function destinationMintHashes(raw: unknown, message: MatchedCctpMessage, input: { messageTransmitter: string; intent?: CctpEvidenceIntent }): string[] {
  if (!Array.isArray(raw)) throw new Error("Invalid destination CCTP log response.");
  const hashes = new Set<string>();
  for (const item of raw) {
    if (!(input.intent ? messageReceivedVariant(item, message, input.intent, input.messageTransmitter) : matchesMessageReceived(item, message, input.messageTransmitter))) continue;
    const hash = obj(item)?.transactionHash;
    if (typeof hash === "string" && HASH.test(hash)) hashes.add(hash.toLowerCase());
  }
  return [...hashes];
}
/** Bind a canonical receipt to the original burn even after Circle re-attests it. */
export function matchReceiptCctpMessage(raw: unknown, current: MatchedCctpMessage, expected: CctpEvidenceIntent, input: { messageTransmitter: string; allowDiscoveredReceipt?: boolean }): MatchedCctpMessage | null {
  const value = receipt(raw, input.allowDiscoveredReceipt ? undefined : current.forwardTxHash ?? undefined);
  if (!value) return null;
  const variants = (value.logs as unknown[]).map((log) => messageReceivedVariant(log, current, expected, input.messageTransmitter)).filter((message): message is MatchedCctpMessage => message !== null);
  const match = unique(variants, (message) => message.raw);
  return match ? { ...match, forwardTxHash: value.transactionHash as string } : null;
}
function provesMessageReceived(value: Obj, message: MatchedCctpMessage, transmitter: string): boolean {
  return (value.logs as unknown[]).some((log) => matchesMessageReceived(log, message, transmitter));
}
function hasTransfer(value: Obj, usdc: string, from: string, to: string, amount: bigint): boolean {
  return (value.logs as unknown[]).some((log) => {
    const event = decoded(log, usdc, "Transfer");
    return event && same(event.from, from) && same(event.to, to) && uint(event.value) === amount;
  });
}
/** Destination inclusion is proven by CCTP nonce/body plus native-USDC mint. */
export function verifyDestinationReceipt(raw: unknown, message: MatchedCctpMessage, input: { messageTransmitter: string; usdc: string; recipient: string; allowDiscoveredReceipt?: boolean }): DestinationMintEvidence | null {
  const value = receipt(raw, input.allowDiscoveredReceipt ? undefined : message.forwardTxHash ?? undefined);
  if (!value || !same(message.mintRecipient, evidenceAddressWord(input.recipient)) || !provesMessageReceived(value, message, input.messageTransmitter)) return null;
  const net = uint(message.amountAtoms) - uint(message.feeExecutedAtoms);
  if (!hasTransfer(value, input.usdc, ZERO, input.recipient, net)) return null;
  return { transactionHash: value.transactionHash as string, blockNumber: uint(value.blockNumber).toString(), deliveredAtoms: net.toString(), nonce: message.nonce, finality: "included" };
}
export type CoreForwardEvidence = DestinationMintEvidence & { phase: "forwarded_to_core"; coreAmountAtoms: string; coreExecutionProven: false };
/** A successful EVM forward queues CoreWriter; Core execution is a later step. */
export function verifyCoreForwardReceipt(raw: unknown, message: MatchedCctpMessage, input: { messageTransmitter: string; usdc: string; forwarder: string; coreDepositWallet: string; owner: string; allowDiscoveredReceipt?: boolean }): CoreForwardEvidence | null {
  const mint = verifyDestinationReceipt(raw, message, { ...input, recipient: input.forwarder });
  const value = receipt(raw, input.allowDiscoveredReceipt ? undefined : message.forwardTxHash ?? undefined);
  if (!mint || !value || !hasTransfer(value, input.usdc, input.forwarder, input.coreDepositWallet, uint(mint.deliveredAtoms))) return null;
  const sends = (value.logs as unknown[]).map((log) => decoded(log, input.coreDepositWallet, "SendAsset")).filter((event): event is Obj => !!event && same(event.coreRecipient, input.owner) && uint(event.destinationDex) === 0n);
  if (sends.length !== 1) return null;
  const coreAmount = uint(sends[0]!.coreAmount), scaled = uint(mint.deliveredAtoms) * 100n;
  if (coreAmount <= 0n || coreAmount > scaled) return null;
  if (coreAmount !== scaled && !(value.logs as unknown[]).some((log) => {
    const event = decoded(log, input.coreDepositWallet, "NewCoreAccountFeeApplied");
    return event && same(event.coreRecipient, input.owner) && uint(event.evmDepositAmount) === uint(mint.deliveredAtoms) && uint(event.coreSentAmount) === coreAmount && uint(event.newCoreAccountFee) === scaled - coreAmount;
  })) return null;
  return { ...mint, phase: "forwarded_to_core", coreAmountAtoms: coreAmount.toString(), coreExecutionProven: false };
}

export type CoreCashEvidence = DestinationMintEvidence & { phase: "forwarded_to_core_cash"; recipient: string; coreAmountAtoms: string; coreExecutionProven: false };
/** Disabled perps forwarding deposits the same mint into the recipient's Core cash. */
export function verifyCoreCashReceipt(raw: unknown, message: MatchedCctpMessage, input: { messageTransmitter: string; usdc: string; forwarder: string; coreDepositWallet: string; owner: string; tokenSystemAddress?: string; allowDiscoveredReceipt?: boolean }): CoreCashEvidence | null {
  const mint = verifyDestinationReceipt(raw, message, { ...input, recipient: input.forwarder });
  const value = receipt(raw, input.allowDiscoveredReceipt ? undefined : message.forwardTxHash ?? undefined);
  if (!mint || !value || !hasTransfer(value, input.usdc, input.forwarder, input.coreDepositWallet, uint(mint.deliveredAtoms))) return null;
  // USDC is Core token index 0. This is the linked CoreDepositWallet's event,
  // not a native-USDC transfer to a similarly shaped address.
  const system = input.tokenSystemAddress ?? "0x2000000000000000000000000000000000000000";
  const cashTransfers = (value.logs as unknown[]).map((log) => decoded(log, input.coreDepositWallet, "Transfer")).filter((event): event is Obj => !!event && same(event.from, input.owner) && same(event.to, system) && uint(event.value) === uint(mint.deliveredAtoms));
  if (cashTransfers.length !== 1 || (value.logs as unknown[]).some((log) => {
    const event = decoded(log, input.coreDepositWallet, "SendAsset");
    return event && same(event.coreRecipient, input.owner);
  })) return null;
  return { ...mint, phase: "forwarded_to_core_cash", recipient: hex(input.owner, 20), coreAmountAtoms: (uint(mint.deliveredAtoms) * 100n).toString(), coreExecutionProven: false };
}

export type ObservedCoreCredit = { hash: string; time: number; amount: string; nonce: string; inferredLinkage: true };
/** Contextual ledger evidence, deliberately separate from transaction proof. */
export function observedCoreCredits(raw: unknown, input: { owner: string; coreDepositWallet: string; coreAmountAtoms: string; notBeforeMs: number; seenHashes?: readonly string[] }): ObservedCoreCredit[] {
  if (!Array.isArray(raw)) throw new Error("Invalid HyperCore ledger response.");
  const seen = new Set((input.seenHashes ?? []).map((hash) => hash.toLowerCase()));
  const found = new Map<string, ObservedCoreCredit>();
  for (const item of raw) {
    const row = obj(item), delta = obj(row?.delta);
    if (!row || !delta || typeof row.hash !== "string" || !HASH.test(row.hash) || seen.has(row.hash.toLowerCase()) || typeof row.time !== "number" || !Number.isSafeInteger(row.time) || row.time < input.notBeforeMs) continue;
    if (delta.type !== "send" || !same(delta.user, input.coreDepositWallet) || !same(delta.destination, input.owner) || delta.sourceDex !== "spot" || delta.destinationDex !== "" || delta.token !== "USDC" || typeof delta.amount !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(delta.amount)) continue;
    const [whole, fraction = ""] = delta.amount.split(".");
    if (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0")) !== uint(input.coreAmountAtoms)) continue;
    try { found.set(row.hash.toLowerCase(), { hash: row.hash, time: row.time, amount: delta.amount, nonce: uint(delta.nonce).toString(), inferredLinkage: true }); } catch { /* Unknown ledger variants are not confirmation. */ }
  }
  return [...found.values()];
}
