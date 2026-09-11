import {
  isJsonObject,
  type JsonObject,
  type MsgBusEndpointId,
  type ScopedKernelClient,
} from "neutron-tools/app";
import { decodeIcrcAccount, encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";

export const WALLET_TARGET = "app:wallet:background" as const satisfies MsgBusEndpointId;
export const WALLET_FUNDING_TOOL = "wallet_fund_v1" as const;
export const WALLET_ROOT_FUNDING_TOOL = "wallet_fund_root_v1" as const;
export const WALLET_TOKEN_INFO_TOOL = "wallet_token_info_v1" as const;
const WALLET_FUNDING_TIMEOUT_SECONDS = 180;
const WALLET_READ_TIMEOUT_SECONDS = 60;
type ToolCaller = Pick<ScopedKernelClient, "callTool">;

export type PurchaseFundingRequest = JsonObject & {
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  route: JsonObject & { kind: "allowance"; spender: string; expiresAtNs: string };
};

export type FundingResult = {
  status: "approved" | "pending" | "rejected";
  commandId: string;
  blockIndex: string | null;
  duplicate: boolean | null;
  message: string | null;
};

export type FundingInstruction = JsonObject & {
  target: typeof WALLET_TARGET;
  name: typeof WALLET_ROOT_FUNDING_TOOL;
  arguments: PurchaseFundingRequest;
};

export type WalletTokenInfo = {
  ledger: string;
  account: string;
  name: string | null;
  symbol: string;
  decimals: number;
  /** Live ledger fee; Wallet checks the fee again before approval. */
  feeAtoms: string;
  balanceAtoms: string;
  observedAtNs: string;
};

function nat(value: unknown, label: string): string {
  // This is Wallet's public atomic-amount encoding, not a marketplace limit.
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,79})$/u.test(value)) {
    throw new Error(`Invalid Wallet ${label}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = nat(value, label);
  if (BigInt(result) > 18_446_744_073_709_551_615n) throw new Error(`Invalid Wallet ${label}`);
  return result;
}

function positiveTimestamp(value: unknown, label: string): string {
  const result = timestamp(value, label);
  if (result === "0") throw new Error(`Invalid Wallet ${label}`);
  return result;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) throw new Error("Invalid Wallet request ID");
  return value;
}

function account(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid Wallet ${label}`);
  try {
    if (encodeIcrcAccount(decodeIcrcAccount(value)) !== value) throw new Error("Noncanonical account");
    return value;
  } catch {
    throw new Error(`Invalid Wallet ${label}`);
  }
}

function ledger(value: unknown): string {
  const result = account(value, "ledger");
  if (decodeIcrcAccount(result).subaccount !== undefined) throw new Error("Invalid Wallet ledger");
  return result;
}

/** Encode the protocol quote's exact spender subaccount without deriving a new one. */
export function spenderAccountText(owner: string, subaccount: Uint8Array): string {
  const protocol = decodeIcrcAccount(ledger(owner));
  return encodeIcrcAccount({ owner: protocol.owner, subaccount });
}

/** Restore the saved request exactly; do not refresh its ID, validity, or expiry. */
export function parsePurchaseFundingRequest(value: unknown): PurchaseFundingRequest {
  if (!isJsonObject(value) || !isJsonObject(value.route) || value.route.kind !== "allowance") {
    throw new Error("Invalid saved Wallet allowance request");
  }
  const amountAtoms = nat(value.amountAtoms, "funding amount");
  if (amountAtoms === "0") throw new Error("Wallet funding amount must be positive");
  return {
    requestId: requestId(value.requestId),
    ledger: ledger(value.ledger),
    amountAtoms,
    validUntilNs: positiveTimestamp(value.validUntilNs, "funding deadline"),
    route: {
      kind: "allowance",
      spender: account(value.route.spender, "spender"),
      expiresAtNs: positiveTimestamp(value.route.expiresAtNs, "allowance expiry"),
    },
  };
}

/**
 * Persist the returned request before dispatch. saleAtoms is the purchase price
 * alone: Wallet adds the collection fee to the allowance and separately pays
 * the approval fee. Adding either fee here would over-approve the purchase.
 */
export function createPurchaseFundingRequest(input: {
  requestId: string;
  ledger: string;
  saleAtoms: string;
  spender: string;
  validUntilNs: string;
  expiresAtNs: string;
}): PurchaseFundingRequest {
  return parsePurchaseFundingRequest({
    requestId: input.requestId,
    ledger: input.ledger,
    amountAtoms: input.saleAtoms,
    validUntilNs: input.validUntilNs,
    route: { kind: "allowance", spender: input.spender, expiresAtNs: input.expiresAtNs },
  });
}

/**
 * The namespace is part of funding identity. Normal calls belong to marketplace;
 * a depth-zero root call belongs to that authenticated Agent app. A matching ID
 * from another app is not evidence for this saved funding request.
 */
export function parseFundingResult(value: unknown, expectedRequestId: string, expectedCallerAppId: string): FundingResult {
  requestId(expectedRequestId);
  if (!expectedCallerAppId || expectedCallerAppId.includes(":")) throw new Error("Invalid Wallet funding caller");
  if (!isJsonObject(value)) throw new Error("Malformed Wallet funding result");
  if (value.commandId !== `${expectedCallerAppId}:${expectedRequestId}`) {
    throw new Error("Wallet answered a different funding request or caller");
  }
  if (value.status !== "approved" && value.status !== "pending" && value.status !== "rejected") {
    throw new Error("Wallet returned a result for another funding route");
  }
  const blockIndex = value.blockIndex === null ? null : nat(value.blockIndex, "approval block index");
  if (value.duplicate !== null && typeof value.duplicate !== "boolean") throw new Error("Invalid Wallet duplicate flag");
  if (value.message !== null && typeof value.message !== "string") throw new Error("Invalid Wallet funding message");
  if (value.status !== "approved" && (blockIndex !== null || value.duplicate !== null)) {
    throw new Error("Wallet returned approval evidence for an unresolved or rejected request");
  }
  if (value.status === "approved" && typeof value.duplicate !== "boolean") throw new Error("Invalid Wallet approval evidence");
  // Approved can have no new block when Wallet reused an existing allowance.
  return { status: value.status, commandId: value.commandId, blockIndex, duplicate: value.duplicate, message: value.message };
}

/** Normal mode uses Wallet's provider review through the invocation's context.kernel. */
export async function requestFunding(kernel: ToolCaller, savedRequest: PurchaseFundingRequest): Promise<FundingResult> {
  const request = parsePurchaseFundingRequest(savedRequest);
  const result = await kernel.callTool({ target: WALLET_TARGET, name: WALLET_FUNDING_TOOL, arguments: request }, WALLET_FUNDING_TIMEOUT_SECONDS);
  return parseFundingResult(result, request.requestId, "marketplace");
}

/** Return to the depth-zero Agent; nested marketplace tools never call the root rail. */
export function rootFundingInstruction(savedRequest: PurchaseFundingRequest): FundingInstruction {
  return { target: WALLET_TARGET, name: WALLET_ROOT_FUNDING_TOOL, arguments: parsePurchaseFundingRequest(savedRequest) };
}

export function parseWalletTokenInfo(value: unknown, expectedLedger: string, expectedAccount?: string): WalletTokenInfo {
  if (!isJsonObject(value)) throw new Error("Malformed Wallet token information");
  const tokenLedger = ledger(value.ledger);
  if (tokenLedger !== ledger(expectedLedger)) throw new Error("Wallet returned information for another ledger");
  const tokenAccount = account(value.account, "token account");
  if (expectedAccount !== undefined && tokenAccount !== account(expectedAccount, "expected token account")) {
    throw new Error("Wallet returned information for another account");
  }
  if (typeof value.decimals !== "number" || !Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    throw new Error("Invalid Wallet token decimals");
  }
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") throw new Error("Invalid Wallet token symbol");
  if (value.name !== null && typeof value.name !== "string") throw new Error("Invalid Wallet token name");
  return {
    ledger: tokenLedger, account: tokenAccount, name: value.name, symbol: value.symbol, decimals: value.decimals,
    feeAtoms: nat(value.feeAtoms, "ledger fee"), balanceAtoms: nat(value.balanceAtoms, "token balance"),
    observedAtNs: timestamp(value.observedAtNs, "token observation time"),
  };
}

// Wallet metadata requests may need the same owner-consent dialog. Serializing
// our reads prevents overlapping checkout token reads from competing for it.
let readTail: Promise<void> = Promise.resolve();

/** Read once; errors and interrupted replies propagate without another request. */
export function readWalletTokenInfo(kernel: ToolCaller, tokenLedger: string, expectedAccount?: string, signal?: AbortSignal): Promise<WalletTokenInfo> {
  const canonicalLedger = ledger(tokenLedger);
  const result = readTail.then(async () => {
    signal?.throwIfAborted();
    const response = await kernel.callTool({ target: WALLET_TARGET, name: WALLET_TOKEN_INFO_TOOL, arguments: { ledger: canonicalLedger } }, WALLET_READ_TIMEOUT_SECONDS);
    return parseWalletTokenInfo(response, canonicalLedger, expectedAccount);
  });
  readTail = result.then(() => undefined, () => undefined);
  return result;
}
