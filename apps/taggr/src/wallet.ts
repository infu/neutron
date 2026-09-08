// Paying Taggr's registration invoice through the Wallet app.
//
// Taggr accepts a new account only with an invite code or after an ICP payment
// has been credited to the principal's Taggr invoice. That invoice is an
// ordinary ICRC account on the ICP ledger:
//
//   { owner: <taggr canister>, subaccount: principal_to_subaccount(<caller>) }
//
// Wallet exposes `wallet_fund_v1`, a provider tool annotated
// `"neutron:consent": "provider_once"`. Calling it suspends this app's request,
// opens Wallet's own tile, and lets Wallet render the review and execute the
// transfer with its own authority. This app never sees a balance, a ledger
// handle, or the owner's approval — it only names a destination and an amount,
// and learns afterwards whether the transfer happened.

// `encodeIcrcAccount` is typed against the ICP SDK principal, so build the
// account with that one rather than converting between two identical classes.
import { Principal } from "@icp-sdk/core/principal";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import type { JsonObject, JsonValue, MsgBusEndpointId } from "neutron-tools/app";

export const WALLET_TARGET: MsgBusEndpointId = "app:wallet:background";
export const WALLET_FUNDING_TOOL = "wallet_fund_v1";
export const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";

/** Wallet's own timeout is generous; the owner has to read and decide. */
export const WALLET_FUNDING_TIMEOUT_SECONDS = 180;
const REQUEST_VALIDITY_MS = 5 * 60 * 1_000;

export class WalletFundingError extends Error {}

/** The canonical decimal representation used by Wallet's result schema. */
export const isFundingBlockIndex = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,79})$/.test(value);

/**
 * Taggr's `env::invoices::principal_to_subaccount`: one length byte, then the
 * principal, zero-padded to 32 bytes.
 */
export const principalToSubaccount = (owner: string): Uint8Array<ArrayBuffer> => {
  const bytes = Principal.fromText(owner).toUint8Array();
  const subaccount = new Uint8Array(new ArrayBuffer(32));
  subaccount[0] = bytes.length;
  subaccount.set(bytes, 1);
  return subaccount;
};

/** The ICRC account text Wallet's direct route accepts. */
export const invoiceAccountText = (input: {
  taggrCanister: string;
  principal: string;
}): string =>
  encodeIcrcAccount({
    owner: Principal.fromText(input.taggrCanister),
    subaccount: principalToSubaccount(input.principal),
  });

const randomRequestId = (
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) =>
    crypto.getRandomValues(bytes),
): string => {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  fill(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type WalletFundingRequest = JsonObject & {
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  route: JsonObject & { kind: "direct"; to: string };
};

export const createFundingRequest = (input: {
  to: string;
  amountAtoms: string;
  nowMs?: number;
  fillRandomValues?: (bytes: Uint8Array<ArrayBuffer>) => void;
}): WalletFundingRequest => {
  if (!/^[1-9][0-9]{0,79}$/.test(input.amountAtoms)) {
    throw new WalletFundingError("The invoice amount is not a positive integer");
  }
  if (!/^[a-z0-9.-]{5,160}$/.test(input.to)) {
    throw new WalletFundingError("The invoice account is not a valid destination");
  }
  const nowMs = input.nowMs ?? Date.now();
  return {
    requestId: randomRequestId(input.fillRandomValues),
    ledger: ICP_LEDGER,
    amountAtoms: input.amountAtoms,
    // Nanoseconds, as Wallet's schema requires.
    validUntilNs: String(BigInt(nowMs + REQUEST_VALIDITY_MS) * 1_000_000n),
    route: { kind: "direct", to: input.to },
  };
};

export type WalletFundingOutcome = {
  status: "transferred" | "approved" | "pending" | "rejected";
  blockIndex: string | null;
  message: string | null;
};

/**
 * Wallet reports back with its own command id, `"<caller app>:<requestId>"`.
 * Checking it keeps a stale or mismatched reply from being read as this
 * request's outcome.
 */
export const parseFundingResult = (
  value: JsonValue,
  requestId: string,
): WalletFundingOutcome => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WalletFundingError("Wallet returned an unexpected result");
  }
  const result = value as Record<string, JsonValue>;
  if (result.commandId !== `taggr:${requestId}`) {
    throw new WalletFundingError("Wallet answered a different funding request");
  }
  const status = result.status;
  if (
    status !== "transferred" &&
    status !== "approved" &&
    status !== "pending" &&
    status !== "rejected"
  ) {
    throw new WalletFundingError("Wallet returned an unknown funding status");
  }
  if (
    (status === "transferred" && !isFundingBlockIndex(result.blockIndex)) ||
    (result.blockIndex != null && !isFundingBlockIndex(result.blockIndex))
  ) {
    throw new WalletFundingError("Wallet returned an invalid transfer block index");
  }
  return {
    status,
    blockIndex: typeof result.blockIndex === "string" ? result.blockIndex : null,
    message: typeof result.message === "string" ? result.message : null,
  };
};

/** Turns Wallet's non-success outcomes into something the owner can act on. */
export const fundingFailureMessage = (outcome: WalletFundingOutcome): string => {
  if (outcome.status === "rejected") {
    return outcome.message ?? "The payment was declined in Wallet.";
  }
  if (outcome.status === "pending") {
    return (
      outcome.message ??
      "Wallet is still settling the payment. Try registering again in a moment."
    );
  }
  return (
    outcome.message ??
    `Wallet reported "${outcome.status}" instead of a completed transfer.`
  );
};

/**
 * Wallet may not be installed. Its absence is an ordinary situation for this
 * app, not a defect, so it gets its own message rather than a routing error.
 */
export const describeWalletError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown (tool|endpoint)|not found|no such endpoint/i.test(message)) {
    return "Wallet is not installed in this Neutron, so it cannot pay the registration invoice. Install Wallet, or register with an invite code instead.";
  }
  return message;
};
