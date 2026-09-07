import type { SelfCallObject, SelfCallValue } from "neutron-tools/app";
import { getAddress, isAddress } from "viem";
import { parsePrincipal } from "./icrc_account.ts";
import { parseTransferOperation, transferIdBytes, type WalletTransferOperation } from "./transfers.ts";
import { quoteAuthorizationWire, type WalletWithdrawalQuote } from "./withdrawal_quote.ts";

export type EthereumWithdrawalAttempt = {
  readonly requestId: string;
  readonly args: SelfCallObject;
  operation: WalletTransferOperation | null;
};

export type EthereumWithdrawalBackend = {
  updateSelf: (method: string, args: SelfCallValue[], timeout?: number) => Promise<unknown>;
  querySelf?: (method: string, args: SelfCallValue[], timeout?: number) => Promise<unknown>;
};

/** Capture the reviewed request before any asynchronous work can change the form. */
export function createEthereumWithdrawalAttempt(
  input: { ledger: string; address: string; amountAtoms: string; quote?: WalletWithdrawalQuote },
  suppliedRequestId?: string,
): EthereumWithdrawalAttempt {
  const ledger = parsePrincipal(input.ledger, "Withdrawal ledger").toText();
  const address = input.address.trim();
  if (!isAddress(address)) throw new Error("Enter a valid Ethereum address");
  if (!/^[1-9][0-9]*$/.test(input.amountAtoms)) throw new Error("Enter a positive withdrawal amount");
  if (input.quote && (input.quote.ledger !== ledger || (input.quote.amount !== null && input.quote.amount !== input.amountAtoms))) {
    throw new Error("The withdrawal quote does not match this token and amount");
  }
  const requestId = suppliedRequestId ?? [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  transferIdBytes(requestId);
  const authorization = input.quote ? quoteAuthorizationWire(input.quote) : undefined;
  if (authorization?.gas && typeof authorization.gas === "object") Object.freeze(authorization.gas);
  if (authorization) Object.freeze(authorization);
  const args: SelfCallObject = Object.freeze({
    // A fresh view prevents consumers from mutating the saved ID's bytes.
    get request_id() { return transferIdBytes(requestId); },
    ledger,
    address: getAddress(address).toLowerCase(),
    amount: input.amountAtoms,
    ...(authorization === undefined ? {} : { withdrawal_quote: authorization }),
  });
  return Object.defineProperties({ operation: null } as EthereumWithdrawalAttempt, {
    requestId: { value: requestId, enumerable: true },
    args: { value: args, enumerable: true },
  });
}

/** Retry the original intent after a lost reply; never generate an ID or quote here. */
export async function executeEthereumWithdrawal(
  attempt: EthereumWithdrawalAttempt,
  backend: EthereumWithdrawalBackend,
  onChange?: (operation: WalletTransferOperation) => void | Promise<void>,
): Promise<WalletTransferOperation> {
  const save = async (value: unknown): Promise<WalletTransferOperation> => {
    const operation = parseTransferOperation(value);
    if (operation.requestId !== attempt.requestId) throw new Error("Wallet returned another withdrawal request");
    attempt.operation = operation;
    await onChange?.(operation);
    return operation;
  };
  if (attempt.operation?.status === "rejected") return attempt.operation;
  if (attempt.operation?.status === "succeeded") {
    if (!attempt.operation.native) return attempt.operation;
    return save(await backend.updateSelf("wallet_transfer_refresh_v2", [transferIdBytes(attempt.requestId)], 120));
  }
  const prepared = await save(await backend.updateSelf("wallet_ethereum_withdraw_prepare_v1", [attempt.args], 30));
  if (prepared.status !== "pending") return prepared;
  return save(await backend.updateSelf("wallet_transfer_resume_v2", [transferIdBytes(attempt.requestId)], 120));
}

/** A native request may need read-only reconciliation or Ethereum settlement. */
export function isNativeSettlementPending(operation: WalletTransferOperation): boolean {
  return operation.native && operation.status !== "rejected" &&
    operation.settlement?.status !== "confirmed" && operation.settlement?.status !== "failed";
}

/** Background polling only observes/reconciles withdrawals; it cannot submit burns. */
export async function refreshSubmittedWithdrawals(
  operations: readonly WalletTransferOperation[],
  updateSelf: EthereumWithdrawalBackend["updateSelf"],
): Promise<WalletTransferOperation[]> {
  const refreshed: WalletTransferOperation[] = [];
  for (const operation of operations) {
    if (!isNativeSettlementPending(operation)) {
      refreshed.push(operation);
      continue;
    }
    try {
      const next = parseTransferOperation(await updateSelf("wallet_transfer_refresh_v2", [transferIdBytes(operation.requestId)], 120));
      if (next.requestId !== operation.requestId) throw new Error("Wallet returned another withdrawal request");
      refreshed.push(next);
    } catch {
      // Keep the durable submitted operation visible if one status read fails.
      refreshed.push(operation);
    }
  }
  return refreshed;
}
