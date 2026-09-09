import type { JsonObject } from "neutron-tools/app";

/** The analytics API returns these amounts in decimal token units, not atoms.
 * They are reported pool-liquidity accounting, not a ledger balance audit or a
 * promise of executable depth. No token decimal precision is supplied here.
 */
export type PoolCompositionToken = {
  ledger_id: string;
  symbol: string;
  amount_tokens: string | null;
  amount_available: boolean;
  amount_atoms: null;
  decimals: null;
  reported_price_usd: string | null;
};

export type PoolComposition = {
  version: 1;
  source: "icpswap-info-api";
  amount_semantics: "reported_pool_liquidity";
  snapshot_time: null;
  token0: PoolCompositionToken;
  token1: PoolCompositionToken;
  reported_tvl_usd: string | null;
  note: string;
};

const COMPOSITION_NOTE =
  "Reported token amounts come from ICPSwap analytics, whose pool snapshot time is unavailable. " +
  "They are not verified custody balances or executable trade depth. Reported TVL uses token prices " +
  "and can be dominated by an illiquid token. Token decimals and atomic amounts are unavailable in this source.";

function decimal(value: unknown): string | null {
  // Upstream amounts are decimal strings. Accept exact integer JSON values for
  // compatibility, but do not manufacture decimal precision from a JS float.
  const text = typeof value === "string" ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value)
      : null;
  return text !== null && /^\d+(?:\.\d+)?$/u.test(text) ? text : null;
}

/** Preserve source decimals exactly and distinguish an unknown amount from 0. */
export function parsePoolComposition(value: unknown): PoolComposition {
  const row = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const token = (side: 0 | 1): PoolCompositionToken => {
    const amount = decimal(row[`token${side}LiquidityAmount`]);
    const ledger = row[`token${side}LedgerId`];
    const symbol = row[`token${side}Symbol`];
    return {
      ledger_id: typeof ledger === "string" ? ledger : "",
      symbol: typeof symbol === "string" ? symbol : "",
      amount_tokens: amount,
      amount_available: amount !== null,
      amount_atoms: null,
      decimals: null,
      reported_price_usd: decimal(row[`token${side}Price`]),
    };
  };
  return {
    version: 1,
    source: "icpswap-info-api",
    amount_semantics: "reported_pool_liquidity",
    snapshot_time: null,
    token0: token(0),
    token1: token(1),
    reported_tvl_usd: decimal(row.tvlUSD),
    note: COMPOSITION_NOTE,
  };
}

const nullableDecimal: JsonObject = {
  anyOf: [
    { type: "string", pattern: "^[0-9]+$" },
    { type: "string", pattern: "^[0-9]+[.][0-9]+$" },
    { type: "null" },
  ],
};
const tokenSchema: JsonObject = {
  type: "object",
  properties: {
    ledger_id: { type: "string" },
    symbol: { type: "string" },
    amount_tokens: { ...nullableDecimal, description: "Exact reported decimal token units, not atomic units. Null means unavailable; zero is an observed reported zero." },
    amount_available: { type: "boolean", description: "Whether this response supplied a valid reported amount." },
    amount_atoms: { type: "null", description: "Unavailable: the analytics source does not provide token decimals." },
    decimals: { type: "null", description: "Unknown, not zero. Read token metadata separately when atomic conversion is needed." },
    reported_price_usd: { ...nullableDecimal, description: "Analytics price used for valuation. This is not a verified liquid market price." },
  },
  required: ["ledger_id", "symbol", "amount_tokens", "amount_available", "amount_atoms", "decimals", "reported_price_usd"],
  additionalProperties: false,
};

export const poolCompositionOutputSchema: JsonObject = {
  type: "object",
  description: "Both reported token amounts, independent of the pool's potentially misleading USD valuation.",
  properties: {
    version: { type: "integer", enum: [1] },
    source: { type: "string", enum: ["icpswap-info-api"] },
    amount_semantics: { type: "string", enum: ["reported_pool_liquidity"] },
    snapshot_time: { type: "null", description: "The API does not expose the underlying pool snapshot time; a tool's response time does not establish data freshness." },
    token0: tokenSchema,
    token1: tokenSchema,
    reported_tvl_usd: { ...nullableDecimal, description: "Reported USD valuation; not guaranteed executable liquidity. Compare both token quantities and prices." },
    note: { type: "string" },
  },
  required: ["version", "source", "amount_semantics", "snapshot_time", "token0", "token1", "reported_tvl_usd", "note"],
  additionalProperties: false,
};

/** Compact display from decimal text. Tiny positive balances never become 0;
 * titles/tool results retain the exact amount. No conversion through Number.
 */
export function formatPoolAmount(value: string | null): string {
  const parsed = decimal(value);
  if (parsed === null) return "Unavailable";
  const [rawWhole = "0", rawFraction = ""] = parsed.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/u, "");
  const fraction = rawFraction.replace(/0+$/u, "");
  if (whole === "0" && fraction === "") return "0";

  const firstFractionDigit = fraction.search(/[1-9]/u);
  const exponent = whole !== "0" ? whole.length - 1 : -firstFractionDigit - 1;
  const digits = whole !== "0" ? whole + fraction : fraction.slice(firstFractionDigit);
  const trim = (part: string) => part.replace(/0+$/u, "");
  if (exponent >= 15 || exponent < -8) {
    const trailing = trim(digits.slice(1, 6));
    return `${digits[0]}${trailing ? `.${trailing}` : ""}e${exponent >= 0 ? "+" : ""}${exponent}`;
  }
  if (exponent >= 3) {
    const group = Math.floor(exponent / 3);
    const wholeDigits = whole.length - group * 3;
    const trailing = trim(digits.slice(wholeDigits, wholeDigits + 2));
    return `${digits.slice(0, wholeDigits)}${trailing ? `.${trailing}` : ""}${["", "K", "M", "B", "T"][group]}`;
  }
  const shown = trim(fraction.slice(0, whole === "0" ? Math.max(6, firstFractionDigit + 4) : 6));
  return `${whole}${shown ? `.${shown}` : ""}`;
}
