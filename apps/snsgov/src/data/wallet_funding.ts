import type { MsgBusEndpointId, ScopedKernelClient } from "neutron-tools/app";
import { decodeIcrcAccount, encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";

export const WALLET_TARGET: MsgBusEndpointId = "app:wallet:background";
export const WALLET_FUNDING_TOOL = "wallet_fund_v1" as const;
export const WALLET_FUNDING_ROOT_TOOL = "wallet_fund_root_v1" as const;
export const WALLET_TRANSACTION_TOOL = "wallet_transaction_v1" as const;
export const WALLET_OVERVIEW_TOOL = "wallet_overview" as const;
export const WALLET_ADD_LEDGER_TOOL = "wallet_add_ledger_v1" as const;
export const WALLET_ADD_LEDGER_ROOT_TOOL = "wallet_add_ledger_root_v1" as const;
const FUNDING_TIMEOUT_SECONDS = 180;
const MAX_NAT64 = 18_446_744_073_709_551_615n;

/** Inject the tile client or the current invocation's scoped Kernel client. */
export type WalletFundingClient = Pick<ScopedKernelClient, "callTool">;

export type WalletFundingInput = Readonly<{
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  destination: string | Readonly<{ owner: string; subaccount?: Uint8Array | null }>;
  memoHex?: string;
}>;

export type WalletFundingRequest = Readonly<{
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  route: Readonly<{ kind: "direct"; to: string; memoHex?: string }>;
}>;

export type WalletFundingResult = Readonly<
  | { status: "transferred"; commandId: string; blockIndex: string; duplicate: boolean; message: null }
  | { status: "pending" | "rejected"; commandId: string; blockIndex: null; duplicate: null; message: string }
>;

export type WalletFundingIdentity = Readonly<{ expectedCallerAppId: string }>;

export type VerifiedWalletFundingReceipt = Readonly<{
  ledger: string;
  blockIndex: string;
  sourceAccount: string;
  destinationAccount: string;
  amountAtoms: string;
  memoHex: string | null;
  ledgerVerified: true;
  observedAtNs: string;
  timestampNs: string;
  source: Readonly<{ canister: string; method: string; archived: boolean }>;
}>;

/** This route comes from trusted invocation context, never tool arguments.
 * root:true requires the actual depth-zero Agent's scoped client. A nested SNS
 * handler must return rootFundingInstruction instead of calling the root tool.
 */
export type WalletFundingOptions = WalletFundingIdentity & Readonly<{ root: boolean }>;

export type WalletTokenSelection = Readonly<{ ledger: string; selected: boolean }>;
export type WalletLedgerAddition = Readonly<{
  ledger: string;
  selected: true;
  alreadySelected: boolean;
  metadataError: string | null;
}>;

/** Read Wallet's selected-asset projection without adding tokens or refreshing
 * balances. A failed or malformed read is not evidence of an absent selection.
 * Funding still checks the current selection and reserved ledger methods.
 */
export async function readWalletTokenSelection(client: WalletFundingClient, ledger: string): Promise<WalletTokenSelection> {
  ledger = canonicalPrincipal(ledger, "Wallet ledger");
  const overview = record(await client.callTool({
    target: WALLET_TARGET, name: WALLET_OVERVIEW_TOOL, arguments: { includeLogos: false },
  }, 60), "Wallet overview");
  if (!Array.isArray(overview.assets) || typeof overview.configured !== "boolean" ||
    !Number.isSafeInteger(overview.assetCount) || overview.assetCount !== overview.assets.length) {
    throw new Error("Wallet overview did not provide its selected assets");
  }
  const selected = overview.assets.map(asset => canonicalPrincipal(
    record(asset, "Wallet selected asset").principal as string, "selected ledger",
  )).includes(ledger);
  return Object.freeze({ ledger, selected });
}

/** Include ledger selection in the exact SNS review before returning this
 * instruction. Root instructions are executed by the actual Agent root, then
 * the SNS continuation reads Wallet's saved selection again.
 */
export function walletLedgerInstruction(ledger: string, options: Readonly<{ root: boolean }>) {
  ledger = canonicalPrincipal(ledger, "Wallet ledger");
  if (typeof options?.root !== "boolean") throw new Error("Wallet ledger selection requires an explicit trusted route");
  return Object.freeze({
    target: WALLET_TARGET,
    name: options.root ? WALLET_ADD_LEDGER_ROOT_TOOL : WALLET_ADD_LEDGER_TOOL,
    arguments: Object.freeze({ ledger }),
  });
}

/** Call only after the owner accepts the SNS action's exact ledger-selection
 * review. Wallet performs its existing additive token/access review. This
 * normal path cannot silently acquire the root tool's authority.
 */
export async function invokeWalletLedgerAddition(client: WalletFundingClient, ledger: string): Promise<WalletLedgerAddition> {
  const instruction = walletLedgerInstruction(ledger, { root: false });
  const result = record(await client.callTool(instruction, 180), "Wallet ledger selection reply");
  if (result.ledger !== instruction.arguments.ledger || result.selected !== true || typeof result.alreadySelected !== "boolean" ||
    !(result.metadataError === null || typeof result.metadataError === "string")) {
    throw new Error("Wallet did not confirm adding the exact requested ledger");
  }
  // A metadata failure does not undo Wallet's durable token selection. Metadata
  // remains the existing token-info provider's responsibility.
  return Object.freeze({ ledger: instruction.arguments.ledger, selected: true, alreadySelected: result.alreadySelected, metadataError: result.metadataError });
}

/** Prepare an immutable wire request from caller-owned operation identity.
 * Persist this exact request before dispatch. No ID or deadline is generated,
 * extended, or refreshed here, including when restoring an expired request.
 * Wallet itself enforces the deadline when it decides whether dispatch is safe.
 */
export function prepareWalletFundingRequest(input: WalletFundingInput): WalletFundingRequest {
  if (typeof input.requestId !== "string" || !/^[0-9a-f]{32}$/u.test(input.requestId)) {
    throw new Error("Wallet request ID must be 32 lowercase hexadecimal characters");
  }
  const ledger = canonicalPrincipal(input.ledger, "Wallet ledger");
  const amountAtoms = nat(input.amountAtoms, "Wallet funding amount", true);
  const validUntilNs = nat(input.validUntilNs, "Wallet funding deadline", true);
  if (BigInt(validUntilNs) > MAX_NAT64) throw new Error("Wallet funding deadline exceeds Nat64");
  const to = canonicalDestination(input.destination);
  if (input.memoHex !== undefined && (
    typeof input.memoHex !== "string" || input.memoHex.length > 64 ||
    input.memoHex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(input.memoHex)
  )) {
    throw new Error("Wallet funding memo must contain at most 32 bytes of lowercase hexadecimal");
  }
  const route = Object.freeze({
    kind: "direct" as const,
    to,
    ...(input.memoHex === undefined ? {} : { memoHex: input.memoHex }),
  });
  return Object.freeze({ requestId: input.requestId, ledger, amountAtoms, validUntilNs, route });
}

/** Return this instruction to the active Agent root; creating it has no effect. */
export function rootFundingInstruction(request: WalletFundingRequest) {
  return Object.freeze({
    target: WALLET_TARGET,
    name: WALLET_FUNDING_ROOT_TOOL,
    arguments: snapshotRequest(request),
  });
}

/** One invocation only. Transport errors and malformed replies remain errors:
 * they can hide a committed transfer, so never turn them into a rejection or
 * retry with a new ID. A later explicit retry must use the original request.
 */
export async function invokeWalletFunding(
  client: WalletFundingClient,
  request: WalletFundingRequest,
  options: WalletFundingOptions,
): Promise<WalletFundingResult> {
  const exactRequest = snapshotRequest(request);
  const identity = { expectedCallerAppId: options?.expectedCallerAppId };
  expectedCommandId(exactRequest, identity);
  if (typeof options.root !== "boolean") throw new Error("Wallet funding requires an explicit trusted route");
  const value = await client.callTool({
    target: WALLET_TARGET,
    name: options.root ? WALLET_FUNDING_ROOT_TOOL : WALLET_FUNDING_TOOL,
    arguments: exactRequest,
  }, FUNDING_TIMEOUT_SECONDS);
  return parseWalletFundingResult(value, exactRequest, identity);
}

/** Validate a direct-funding receipt, including root handoff results. A receipt
 * links to this Wallet command; it does not by itself prove an SNS claim.
 */
export function parseWalletFundingResult(
  value: unknown,
  request: WalletFundingRequest,
  identity: WalletFundingIdentity,
): WalletFundingResult {
  const commandId = expectedCommandId(snapshotRequest(request), identity);
  const result = exactRecord(value, ["status", "commandId", "blockIndex", "duplicate", "message"], "Wallet funding reply");
  if (result.commandId !== commandId) throw new Error("Wallet funding reply belongs to another command");
  if (result.status === "transferred") {
    const blockIndex = nat(result.blockIndex, "Wallet transfer block index");
    if (typeof result.duplicate !== "boolean" || result.message !== null) {
      throw new Error("Malformed Wallet transfer receipt");
    }
    return Object.freeze({ status: "transferred", commandId, blockIndex, duplicate: result.duplicate, message: null });
  }
  if (result.status === "pending" || result.status === "rejected") {
    if (result.blockIndex !== null || result.duplicate !== null ||
      typeof result.message !== "string" || result.message.length === 0 || result.message.length > 512) {
      throw new Error("Malformed unresolved Wallet funding reply");
    }
    return Object.freeze({ status: result.status, commandId, blockIndex: null, duplicate: null, message: result.message });
  }
  throw new Error("Wallet did not return a direct-funding outcome");
}

/** A root handoff receipt arrives as caller input, so verify its payment through
 * the live Wallet provider before using it. This checks ledger facts, not the
 * caller-supplied command ID: parseWalletFundingResult checks that separately.
 * Use a unique operation-bound memo in the saved funding request to distinguish
 * repeated topups to the same neuron. Absence of evidence remains unresolved;
 * this helper never funds or retries a transfer.
 */
export async function verifyWalletFundingReceipt(
  client: WalletFundingClient,
  request: WalletFundingRequest,
  result: WalletFundingResult,
  options: Readonly<{ expectedSourceAccount: string }>,
): Promise<VerifiedWalletFundingReceipt> {
  const exactRequest = snapshotRequest(request);
  if (result.status !== "transferred") throw new Error("Wallet funding has no transferred receipt to verify");
  const blockIndex = nat(result.blockIndex, "Wallet transfer block index");
  const sourceAccount = canonicalDestination(options.expectedSourceAccount);
  const owner = decodeIcrcAccount(sourceAccount).owner.toText();
  const reply = record(await client.callTool({
    target: WALLET_TARGET,
    name: WALLET_TRANSACTION_TOOL,
    arguments: { ledger: exactRequest.ledger, blockIndex, source: "ledger" },
  }, 60), "Wallet transaction reply");
  if (reply.version !== 1 || reply.ledger !== exactRequest.ledger || reply.owner !== owner || reply.blockIndex !== blockIndex) {
    throw new Error("Wallet transaction evidence belongs to another ledger, owner, or block");
  }
  const source = record(reply.source, "Wallet transaction source");
  if (reply.available !== true || reply.error !== null || source.kind !== "ledger" || source.ledgerVerified !== true) {
    throw new Error("Exact ledger evidence for Wallet funding is unavailable; the transfer remains unresolved");
  }
  const canister = canonicalPrincipal(source.canister as string, "transaction source canister");
  if (typeof source.archived !== "boolean" || (!source.archived && canister !== exactRequest.ledger) ||
    typeof source.method !== "string" || source.method.length === 0) {
    throw new Error("Invalid Wallet ledger evidence source");
  }
  const transaction = record(reply.transaction, "Wallet transaction");
  const memoHex = exactRequest.route.memoHex ?? null;
  if (transaction.blockIndex !== blockIndex || transaction.operation !== "transfer" ||
    transaction.amountAtoms !== exactRequest.amountAtoms || transaction.spender !== null ||
    transaction.memoComplete !== true || transaction.memoHex !== memoHex ||
    transactionAccount(transaction.from) !== sourceAccount || transactionAccount(transaction.to) !== exactRequest.route.to) {
    throw new Error("Wallet ledger transaction does not match the exact funding request");
  }
  return Object.freeze({
    ledger: exactRequest.ledger, blockIndex, sourceAccount, destinationAccount: exactRequest.route.to,
    amountAtoms: exactRequest.amountAtoms, memoHex, ledgerVerified: true,
    observedAtNs: nat(reply.observedAtNs, "Wallet evidence observation time"),
    timestampNs: nat(transaction.timestampNs, "Wallet transfer timestamp"),
    source: Object.freeze({ canister, method: source.method, archived: source.archived }),
  });
}

function transactionAccount(value: unknown): string {
  const account = record(value, "Wallet transaction account");
  if (account.kind !== "icrc") throw new Error("Wallet funding evidence must contain an ICRC account");
  const owner = canonicalPrincipal(account.owner as string, "transaction account owner");
  if (account.subaccountHex === null) return canonicalDestination(owner);
  if (typeof account.subaccountHex !== "string" || !/^[0-9a-f]{64}$/u.test(account.subaccountHex)) {
    throw new Error("Invalid Wallet transaction subaccount");
  }
  const subaccount = Uint8Array.from(account.subaccountHex.match(/../gu)!, byte => Number.parseInt(byte, 16));
  return canonicalDestination({ owner, subaccount });
}

function snapshotRequest(request: WalletFundingRequest): WalletFundingRequest {
  exactRecord(request, ["requestId", "ledger", "amountAtoms", "validUntilNs", "route"], "Wallet funding request");
  const route = exactRecord(request.route, ["kind", "to"], "Wallet direct route", ["memoHex"]);
  if (route.kind !== "direct") throw new Error("SNS funding requires a direct Wallet transfer");
  return prepareWalletFundingRequest({
    requestId: request.requestId,
    ledger: request.ledger,
    amountAtoms: request.amountAtoms,
    validUntilNs: request.validUntilNs,
    destination: request.route.to,
    ...(Object.hasOwn(route, "memoHex") ? { memoHex: request.route.memoHex } : {}),
  });
}

function expectedCommandId(request: WalletFundingRequest, identity: WalletFundingIdentity): string {
  const appId = identity?.expectedCallerAppId;
  if (typeof appId !== "string" || appId.length === 0 || appId.length > 64) {
    throw new Error("Wallet funding requires the expected caller app ID");
  }
  return `${appId}:${request.requestId}`;
}

function canonicalPrincipal(value: string, label: string): string {
  try {
    const account = decodeIcrcAccount(value);
    if (account.subaccount !== undefined || account.owner.toText() !== value) throw new Error();
    return value;
  } catch {
    throw new Error(`Invalid canonical ${label}`);
  }
}

function canonicalDestination(destination: WalletFundingInput["destination"]): string {
  try {
    if (typeof destination === "string") {
      const account = decodeIcrcAccount(destination);
      if (encodeIcrcAccount(account) !== destination) throw new Error();
      return destination;
    }
    const owner = decodeIcrcAccount(canonicalPrincipal(destination.owner, "destination owner")).owner;
    const subaccount = destination.subaccount;
    if (subaccount != null && (!(subaccount instanceof Uint8Array) || subaccount.length !== 32)) throw new Error();
    return encodeIcrcAccount({ owner, ...(subaccount == null ? {} : { subaccount }) });
  } catch {
    throw new Error("Invalid canonical Wallet destination account");
  }
}

function nat(value: unknown, label: string, positive = false): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,79})$/u.test(value) || (positive && value === "0")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function exactRecord(value: unknown, required: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`Malformed ${label}`);
  }
  return value as Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed ${label}`);
  return value as Record<string, unknown>;
}
