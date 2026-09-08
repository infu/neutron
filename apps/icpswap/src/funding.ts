// Asking the Wallet to fund a swap.
//
// This app holds no ledger authority and never will. To swap, it asks the
// Wallet for one ICRC-2 allowance naming the pool as spender. The pool pulls
// the input and returns output to this Neutron's own account. Persist the exact
// request before calling Wallet: its deadline and expiry are part of identity.
//
// Two rails, one request shape:
//   - `wallet_fund_v1` opens the Wallet for a human decision;
//   - `wallet_fund_root_v1` is UI-free and admitted only when called directly
//     by the active Agent root. An ICPSwap tool delegated by Agent cannot call
//     this rail itself; it returns the exact saved request for Agent to fund.

import { decodeIcrcAccount, encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type ScopedKernelClient,
} from "neutron-tools/app";

export const WALLET_TARGET: MsgBusEndpointId = "app:wallet:background";
export const WALLET_FUND_TOOL = "wallet_fund_v1" as const;
export const WALLET_FUND_ROOT_TOOL = "wallet_fund_root_v1" as const;

/** Existing Wallet transport window; a timeout is an uncertain reply. */
export const WALLET_FUND_TIMEOUT_SECONDS = 180;

/**
 * How long the funding request itself stays valid.
 *
 * The Wallet caps both this and the allowance lifetime at ten minutes and
 * *rejects* rather than clamping, so both are set well inside the ceiling.
 */
const REQUEST_VALIDITY_MS = 4 * 60_000;

/**
 * How long the allowance lives. Short by design: an allowance is bounded by
 * amount, spender and expiry, but it is not per-app sandboxing — it is drawn
 * from the Neutron canister's shared balance, and the ledger cannot attest
 * which app initiated a `transfer_from`.
 */
const ALLOWANCE_VALIDITY_MS = 5 * 60_000;

export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/u;

type FundingRequestBase = JsonObject & {
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
};
export type AllowanceFundingRequest = FundingRequestBase & {
  route: JsonObject & { kind: "allowance"; spender: string; expiresAtNs: string };
};
export type DirectFundingRequest = FundingRequestBase & {
  route: JsonObject & { kind: "direct"; to: string };
};
export type FundingRequest = AllowanceFundingRequest | DirectFundingRequest;

export type FundingStatus = "transferred" | "approved" | "pending" | "rejected";

export type FundingResult = {
  status: FundingStatus;
  commandId: string;
  blockIndex: string | null;
  duplicate: boolean | null;
  message: string | null;
};

/** A fresh idempotency key: 16 cryptographic bytes as 32 hex characters. */
export function createRequestId(
  fill: (bytes: Uint8Array) => void = (bytes) =>
    crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toNanoseconds(milliseconds: number): string {
  const value = BigInt(milliseconds) * 1_000_000n;
  if (value > 18_446_744_073_709_551_615n) throw new Error("Funding deadline exceeds the Wallet timestamp format");
  return value.toString();
}

function unsigned(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/** Restore a retained funding request without generating a new deadline. */
export function parseFundingRequest(value: JsonValue): FundingRequest {
  if (!isJsonObject(value) || !isJsonObject(value.route) || (value.route.kind !== "allowance" && value.route.kind !== "direct")) {
    throw new Error("Malformed saved Wallet funding request");
  }
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Invalid funding request id");
  const ledger = typeof value.ledger === "string" ? value.ledger : "";
  if (ledger === "") throw new Error("Funding needs a ledger");
  const amountAtoms = unsigned(value.amountAtoms, "funding amount");
  if (amountAtoms === "0") throw new Error("Funding amount must be positive");
  const validUntilNs = unsigned(value.validUntilNs, "funding deadline");
  if (BigInt(validUntilNs) === 0n || BigInt(validUntilNs) > 18_446_744_073_709_551_615n) throw new Error("Invalid saved Wallet funding deadline");
  if (value.route.kind === "direct") {
    const to = canonicalAccount(value.route.to);
    return { requestId, ledger, amountAtoms, validUntilNs, route: { kind: "direct", to } };
  }
  const spender = canonicalAccount(value.route.spender);
  const expiresAtNs = unsigned(value.route.expiresAtNs, "allowance expiration");
  if (BigInt(validUntilNs) === 0n || BigInt(expiresAtNs) < BigInt(validUntilNs) || BigInt(expiresAtNs) > 18_446_744_073_709_551_615n) {
    throw new Error("Invalid saved Wallet funding times");
  }
  return { requestId, ledger, amountAtoms, validUntilNs, route: { kind: "allowance", spender, expiresAtNs } };
}

/**
 * Build the allowance request for one swap.
 *
 * `amountAtoms` is the bare input amount. The Wallet adds the ledger's live
 * transfer fee on top when it approves, which is exactly what ICRC-2 consumes
 * — approving only the amount is short by one fee, the mistake ICPSwap's own
 * app hides behind a 1000x over-approval.
 */
export function createFundingRequest(input: {
  requestId: string;
  ledger: string;
  spender: string;
  amountAtoms: string;
  nowMs?: number;
}): AllowanceFundingRequest {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid clock");
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("Invalid funding request id");
  }
  if (!/^[1-9][0-9]*$/u.test(input.amountAtoms)) {
    throw new Error("Funding amount must be a positive integer");
  }
  if (input.ledger === "" || input.spender === "") {
    throw new Error("Funding needs a ledger and a spender");
  }
  return {
    requestId: input.requestId,
    ledger: input.ledger,
    amountAtoms: input.amountAtoms,
    validUntilNs: toNanoseconds(nowMs + REQUEST_VALIDITY_MS),
    route: {
      kind: "allowance",
      spender: input.spender,
      expiresAtNs: toNanoseconds(nowMs + ALLOWANCE_VALIDITY_MS),
    },
  };
}

function canonicalAccount(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Wallet funding account");
  try {
    const account = decodeIcrcAccount(value);
    if (encodeIcrcAccount(account) !== value) throw new Error("Noncanonical account");
    return value;
  } catch { throw new Error("Invalid Wallet funding account"); }
}

/** The upstream pool's deposit account for this Neutron's own principal. */
export function poolDepositAccount(pool: string, owner: string): string {
  const poolAccount = decodeIcrcAccount(canonicalAccount(pool));
  const ownerAccount = decodeIcrcAccount(canonicalAccount(owner));
  if (poolAccount.subaccount !== undefined || ownerAccount.subaccount !== undefined) {
    throw new Error("Pool deposits require pool and owner principals");
  }
  const principal = ownerAccount.owner.toUint8Array();
  const subaccount = new Uint8Array(32);
  subaccount[0] = principal.length;
  subaccount.set(principal, 1);
  return encodeIcrcAccount({ owner: poolAccount.owner, subaccount });
}

/** ICRC1 funding sends the pool deficit plus its subsequent deposit fee. */
export function createDirectFundingRequest(input: {
  requestId: string; ledger: string; pool: string; owner: string;
  amountAtoms: string; feeAtoms: string; nowMs?: number;
}): DirectFundingRequest {
  const amount = BigInt(unsigned(input.amountAtoms, "pool funding amount"));
  if (amount === 0n) throw new Error("Funding amount must be positive");
  const fee = BigInt(unsigned(input.feeAtoms, "pool deposit fee"));
  const base = createFundingRequest({ ...input, spender: input.pool, amountAtoms: (amount + fee).toString() });
  return { requestId: base.requestId, ledger: base.ledger, amountAtoms: base.amountAtoms, validUntilNs: base.validUntilNs,
    route: { kind: "direct", to: poolDepositAccount(input.pool, input.owner) } };
}

export function assertFundingResultMatchesRequest(result: FundingResult, request: FundingRequest): void {
  if (!result.commandId.endsWith(`:${request.requestId}`)) throw new Error("Wallet returned another funding request's result");
  if ((result.status === "approved" && request.route.kind !== "allowance") ||
      (result.status === "transferred" && request.route.kind !== "direct")) {
    throw new Error("Wallet funding outcome does not match the saved route");
  }
}

export function parseFundingResult(value: JsonValue, expectedRequestId?: string): FundingResult {
  if (!isJsonObject(value)) throw new Error("Malformed Wallet reply");
  const status = value.status;
  if (
    status !== "transferred" &&
    status !== "approved" &&
    status !== "pending" &&
    status !== "rejected"
  ) {
    throw new Error("Unexpected Wallet status");
  }
  if (typeof value.commandId !== "string" || value.commandId === "") throw new Error("Wallet returned no funding command identity");
  if (expectedRequestId !== undefined && !value.commandId.endsWith(`:${expectedRequestId}`)) {
    throw new Error("Wallet returned another funding request's result");
  }
  if (value.blockIndex !== null) unsigned(value.blockIndex, "Wallet funding block index");
  if (value.duplicate !== null && typeof value.duplicate !== "boolean") throw new Error("Malformed Wallet duplicate result");
  if (value.message !== null && typeof value.message !== "string") throw new Error("Malformed Wallet funding message");
  return {
    status,
    commandId: value.commandId,
    blockIndex: value.blockIndex as string | null,
    duplicate: value.duplicate as boolean | null,
    message: value.message as string | null,
  };
}

/**
 * Whether this reply ends the exchange for this request.
 *
 * `pending` is not terminal: the caller must re-ask later with a byte-identical
 * request and the same id, and the Wallet replays to a terminal result without
 * a second owner decision. Rotating the id would ask the owner twice.
 */
export function isTerminal(result: FundingResult): boolean {
  return result.status === "approved" || result.status === "transferred" || result.status === "rejected";
}

/** `duplicate` means the ledger deduplicated an already-committed approval. */
export function succeeded(result: FundingResult): boolean {
  return result.status === "approved" || result.status === "transferred";
}

export function commandIdFor(appId: string, requestId: string): string {
  return `${appId}:${requestId}`;
}

/**
 * The subset of a Kernel client this module needs.
 *
 * Both the tile's own bus client and a handler's invocation-scoped
 * `context.kernel` satisfy it, which is what lets one request shape serve both
 * the human and the agent rail.
 */
type ToolCaller = Pick<ScopedKernelClient, "callTool">;

/** Ask the Wallet to open its own modal and approve one allowance. */
export async function requestFunding(
  client: ToolCaller,
  request: FundingRequest,
): Promise<FundingResult> {
  const result = parseFundingResult(
    await client.callTool(
      { target: WALLET_TARGET, name: WALLET_FUND_TOOL, arguments: request },
      WALLET_FUND_TIMEOUT_SECONDS,
    ),
    request.requestId,
  );
  assertFundingResultMatchesRequest(result, request);
  return result;
}

/**
 * The UI-free rail, for an autonomous agent turn.
 *
 * Only the active depth-zero Agent root may call this. A nested ICPSwap tool
 * must return the saved request for that root to execute directly. Never drop
 * invocation context or retry through a global client to change authority.
 */
export async function requestRootFunding(
  client: ToolCaller,
  request: FundingRequest,
): Promise<FundingResult> {
  const result = parseFundingResult(
    await client.callTool(
      { target: WALLET_TARGET, name: WALLET_FUND_ROOT_TOOL, arguments: request },
      WALLET_FUND_TIMEOUT_SECONDS,
    ),
    request.requestId,
  );
  assertFundingResultMatchesRequest(result, request);
  return result;
}
