// What the Wallet knows about a token.
//
// This app holds no ledger authority at all — it cannot read a balance, a fee,
// an allowance, or even a token's decimals. All of that belongs to the Wallet,
// which exposes it through one read-only tool. Everything here is a read; the
// funding calls that actually move value live in `funding.ts`.

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type ScopedKernelClient,
} from "neutron-tools/app";

export const WALLET_TARGET: MsgBusEndpointId = "app:wallet:background";
export const WALLET_TOKEN_INFO_TOOL = "wallet_token_info_v1" as const;

const TOKEN_INFO_TIMEOUT_SECONDS = 60;
// Metadata reads can open the Kernel's single owner-consent dialog. Queue
// ICPSwap's reads across clients and view changes so the second pool token does
// not race the first. This does not schedule or retry any financial action.
let walletReadTail: Promise<void> = Promise.resolve();

export type WalletTokenInfo = {
  ledger: string;
  /** The Wallet's default account, which is this Neutron's own. */
  account: string;
  name: string | null;
  symbol: string;
  decimals: number;
  /** Base units. Advisory — the Wallet rechecks it before funding. */
  feeAtoms: bigint;
  balanceAtoms: bigint;
  observedAtNs: bigint;
};

type ToolCaller = Pick<ScopedKernelClient, "callTool">;

/** Keep account evidence and token metadata from competing for owner consent.
 * Financial requests retain their own reviewed execution path.
 */
export function readWalletTool(
  client: ToolCaller,
  name: "wallet_token_info_v1" | "wallet_account_transactions_v1" | "wallet_transaction_v1",
  args: JsonObject,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const read = walletReadTail.then(async () => {
    signal?.throwIfAborted();
    return client.callTool({ target: WALLET_TARGET, name, arguments: args }, TOKEN_INFO_TIMEOUT_SECONDS);
  });
  walletReadTail = read.then(() => undefined, () => undefined);
  return read;
}

export function walletSetupRequired(error: string | null | undefined): boolean {
  return typeof error === "string" && /Ledger is not selected(?: in Wallet)?/iu.test(error);
}

/** Called only from an explicit setup action. Wallet reviews the additive token
 * selection; it sends no tokens and leaves every other selection intact.
 */
export function addLedgerToWallet(client: ToolCaller, ledger: string, signal?: AbortSignal): Promise<void> {
  const request = walletReadTail.then(async () => {
    signal?.throwIfAborted();
    const value = await client.callTool({ target: WALLET_TARGET, name: "wallet_add_ledger_v1", arguments: { ledger } }, 180);
    if (!isJsonObject(value) || value.ledger !== ledger || value.selected !== true) {
      throw new Error("Wallet did not confirm adding this token. Check Wallet and try again.");
    }
  });
  walletReadTail = request.then(() => undefined, () => undefined);
  return request;
}

function nat(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Wallet reported no usable ${label}`);
  }
  return BigInt(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Wallet reported no ${label}`);
  }
  return value;
}

export function parseTokenInfo(value: JsonValue, expectedLedger?: string): WalletTokenInfo {
  if (!isJsonObject(value)) throw new Error("Malformed Wallet token reply");
  const decimals = value.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Wallet reported no decimals for this token");
  }
  const ledger = requiredText(value.ledger, "ledger identity");
  if (expectedLedger !== undefined && ledger !== expectedLedger) {
    throw new Error("Wallet returned token information for another ledger");
  }
  return {
    ledger,
    account: requiredText(value.account, "account identity"),
    name: typeof value.name === "string" ? value.name : null,
    symbol: requiredText(value.symbol, "token symbol"),
    decimals,
    feeAtoms: nat(value.feeAtoms, "ledger fee"),
    balanceAtoms: nat(value.balanceAtoms, "token balance"),
    observedAtNs: nat(value.observedAtNs, "observation time"),
  };
}

/**
 * Read live metadata, fee and balance for one ledger.
 *
 * The ledger must be selected in Wallet (by its owner or an authorized agent).
 * Failures are returned without retry. A view can cancel a queued read before
 * it opens another request; an already dispatched Wallet read still finishes.
 */
export async function readTokenInfo(
  client: ToolCaller,
  ledger: string,
  signal?: AbortSignal,
): Promise<WalletTokenInfo> {
  return parseTokenInfo(await readWalletTool(client, WALLET_TOKEN_INFO_TOOL, { ledger }, signal), ledger);
}
