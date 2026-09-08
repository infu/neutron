/**
 * ICRC-1 ledger reads: token identity, supply, balances, treasuries.
 *
 * `decimals` always comes from the ledger. Every SNS token happens to use 8
 * today, but the treasuries hold other assets — ckETH is 18, ckUSDC is 6 — and
 * a hard-coded 8 would misprice them by twelve orders of magnitude.
 */

import { actorFor, type AgentOptions } from "./agent";
import { icpTreasuryAccount, snsTreasuryAccount, toCandidAccount, type IcrcAccount } from "./accounts";
import { classifyError } from "./errors";
import { ICP_DECIMALS, ICP_LEDGER_CANISTER_ID } from "./ids";
import { idlFactory as ledgerIdl } from "../candid/icrc_ledger.did.js";
import type { TokenInfo, TreasuryBalances } from "./types";

type MetadataValue =
  | { Nat: bigint }
  | { Int: bigint }
  | { Text: string }
  | { Blob: Uint8Array | number[] };

interface LedgerService {
  icrc1_name: () => Promise<string>;
  icrc1_symbol: () => Promise<string>;
  icrc1_decimals: () => Promise<number>;
  icrc1_fee: () => Promise<bigint>;
  icrc1_total_supply: () => Promise<bigint>;
  icrc1_metadata: () => Promise<[string, MetadataValue][]>;
  icrc1_balance_of: (account: ReturnType<typeof toCandidAccount>) => Promise<bigint>;
}

/**
 * Token identity and supply.
 *
 * `icrc1_metadata` carries the same fields plus the logo, but embeds the logo
 * as a base64 data URI, which makes the response large. The scalar endpoints
 * are cheaper, so the logo is opt-in.
 */
export async function readTokenInfo(
  ledgerCanisterId: string,
  options: AgentOptions & { includeLogo?: boolean } = {},
): Promise<TokenInfo> {
  const actor = await actorFor<LedgerService>(ledgerIdl, ledgerCanisterId, options);
  try {
    const [name, symbol, decimals, fee, totalSupply] = await Promise.all([
      actor.icrc1_name(),
      actor.icrc1_symbol(),
      actor.icrc1_decimals(),
      actor.icrc1_fee(),
      actor.icrc1_total_supply(),
    ]);
    const info: TokenInfo = { name, symbol, decimals: Number(decimals), fee, totalSupply };
    if (options.includeLogo) {
      const logo = await readLogo(actor);
      if (logo) info.logo = logo;
    }
    return info;
  } catch (error) {
    throw classifyError(error, { role: "ledger" });
  }
}

async function readLogo(actor: LedgerService): Promise<string | undefined> {
  try {
    const metadata = await actor.icrc1_metadata();
    for (const [key, value] of metadata) {
      if (key === "icrc1:logo" && "Text" in value) return value.Text;
    }
  } catch {
    // A missing logo is not an error worth surfacing.
  }
  return undefined;
}

export async function balanceOf(
  ledgerCanisterId: string,
  account: IcrcAccount,
  options: AgentOptions = {},
): Promise<bigint> {
  const actor = await actorFor<LedgerService>(ledgerIdl, ledgerCanisterId, options);
  try {
    return await actor.icrc1_balance_of(toCandidAccount(account));
  } catch (error) {
    throw classifyError(error, { role: "ledger" });
  }
}

/**
 * Both treasuries for one SNS.
 *
 * The two live on different ledgers with different account derivations, and
 * either can fail independently, so a failure of one must not hide the other.
 */
export async function readTreasuries(
  params: { governanceCanisterId: string; ledgerCanisterId: string },
  options: AgentOptions = {},
): Promise<TreasuryBalances> {
  const [icp, token] = await Promise.allSettled([
    balanceOf(ICP_LEDGER_CANISTER_ID, icpTreasuryAccount(params.governanceCanisterId), options),
    (async () =>
      balanceOf(
        params.ledgerCanisterId,
        await snsTreasuryAccount(params.governanceCanisterId),
        options,
      ))(),
  ]);

  const out: TreasuryBalances = {};
  if (icp.status === "fulfilled") out.icpE8s = icp.value;
  if (token.status === "fulfilled") out.tokenE8s = token.value;
  return out;
}

export const ICP_TOKEN: Pick<TokenInfo, "symbol" | "decimals"> = {
  symbol: "ICP",
  decimals: ICP_DECIMALS,
};
