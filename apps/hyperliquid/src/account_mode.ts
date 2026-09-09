export type AccountAbstraction = "unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction";
export type AccountBalanceSource = "perps" | "unified" | "unknown";
export type AccountModeResolution = {
  balanceSource: AccountBalanceSource;
  source: "userAbstraction" | "webData3" | null;
  basis: "explicit_mode" | "default_account_state" | "unavailable";
  effectiveAbstraction: AccountAbstraction | null;
  observedAt: number;
  serverTime: number | null;
  error: string | null;
};
const modes: readonly string[] = ["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"];
export function parseAccountAbstraction(raw: unknown): AccountAbstraction {
  if (typeof raw !== "string" || !modes.includes(raw)) throw new Error("Invalid userAbstraction response.");
  return raw as AccountAbstraction;
}
export function unresolvedAccountMode(source: AccountModeResolution["source"], error: unknown = null, now = Date.now): AccountModeResolution {
  return { balanceSource: "unknown", source, basis: "unavailable", effectiveAbstraction: null, observedAt: now(), serverTime: null, error: error === null ? null : error instanceof Error ? error.message : String(error) };
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const sourceFor = (mode: Exclude<AccountAbstraction, "default">): "perps" | "unified" => mode === "unifiedAccount" || mode === "portfolioMargin" ? "unified" : "perps";

/** The info enum does not define default's effective collateral source.
 * Resolve that account's actual state using the first-party app's webData3
 * semantics: an absent userState.abstraction has separate perps balances.
 * Source: https://app.hyperliquid.xyz/assets/config-BKJC_Lnd.js (q3/H5/qre,
 * SHA256 2cf4b0e4cc5f04b2192f51dc8340945a636e5e972ae871ab4ff9589c45b21c5d).
 * Explicit unifiedAccount/portfolioMargin semantics are also documented at
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes.
 * Missing/malformed snapshots are never inferred from account balances. */
export async function resolveAccountMode(
  abstraction: AccountAbstraction | null,
  address: string,
  info: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<AccountModeResolution> {
  const now = options.now ?? Date.now;
  options.signal?.throwIfAborted();
  if (abstraction === null) return unresolvedAccountMode(null, null, now);
  if (abstraction !== "default") return { balanceSource: sourceFor(abstraction), source: "userAbstraction", basis: "explicit_mode", effectiveAbstraction: abstraction, observedAt: now(), serverTime: null, error: null };
  const raw = await info({ type: "webData3", user: address }, options.signal);
  options.signal?.throwIfAborted();
  if (!isRecord(raw) || !isRecord(raw.userState)) throw new Error("Invalid webData3 account mode snapshot.");
  const state = raw.userState;
  if (!/^0x[0-9a-f]{40}$/i.test(address) || typeof state.user !== "string" || state.user.toLowerCase() !== address.toLowerCase()) throw new Error("webData3 account mode belongs to another wallet.");
  if (typeof state.serverTime !== "number" || !Number.isSafeInteger(state.serverTime) || state.serverTime <= 0) throw new Error("webData3 account mode has no valid server timestamp.");
  const present = Object.hasOwn(state, "abstraction");
  const effective = present ? parseAccountAbstraction(state.abstraction) : "default";
  if (present && effective === "default") throw new Error("webData3 did not resolve the default account mode.");
  return {
    balanceSource: effective === "default" ? "perps" : sourceFor(effective), source: "webData3",
    basis: present ? "explicit_mode" : "default_account_state", effectiveAbstraction: effective,
    observedAt: now(), serverTime: state.serverTime, error: null,
  };
}
