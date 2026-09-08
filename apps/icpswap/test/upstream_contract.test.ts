import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The Motoko records in `backend/icpswap/Types.mo` are decoded from raw reply
// blobs with `from_candid`, so a silent upstream rename or retype turns into a
// `null` decode at runtime rather than a compile error. These assertions pin
// the exact shapes observed on mainnet so a drift shows up here first.
//
// Recorded 2026-08-31 by introspecting the deployed canisters:
//   SwapFactory 4mmnk-kiaaa-aaaag-qbllq-cai
//     getPools : () -> (variant { ok : vec PoolData; err : Error }) query
//   SwapPool    (dynamic, e.g. mohjv-bqaaa-aaaag-qjyia-cai)
//     metadata : () -> (variant { ok : PoolMetadata; err : Error }) query
//   TokenList   k37c6-riaaa-aaaag-qcyza-cai
//     getList : () -> (variant { ok : vec TokenMetadata; err : text }) query
//   token ledgers (dynamic)
//     icrc1_decimals : () -> (nat8) query
//
// Re-record with:
//   node node_modules/icblast/bin/blast.js scan <canister>
//   node node_modules/icblast/bin/blast.js call <canister> <method>

const typesUrl = new URL("../backend/icpswap/Types.mo", import.meta.url);
const clientUrl = new URL("../backend/icpswap/Client.mo", import.meta.url);
const marketUrl = new URL("../backend/icpswap/Market.mo", import.meta.url);

/** Candid field name to the Motoko type that decodes it. */
const UPSTREAM_RECORDS: Record<string, Record<string, string>> = {
  TokenRef: {
    address: "Text",
    standard: "Text",
  },
  PoolData: {
    canisterId: "Principal",
    fee: "Nat",
    key: "Text",
    tickSpacing: "Int",
    token0: "TokenRef",
    token1: "TokenRef",
  },
  PoolMetadata: {
    fee: "Nat",
    key: "Text",
    liquidity: "Nat",
    sqrtPriceX96: "Nat",
    tick: "Int",
    token0: "TokenRef",
    token1: "TokenRef",
  },
  TokenListEntry: {
    canisterId: "Text",
    symbol: "Text",
    name: "Text",
    decimals: "Nat",
    standard: "Text",
    fee: "Nat",
    totalSupply: "Nat",
    introduction: "Text",
    mediaLinks: "[MediaLink]",
    rank: "Nat32",
  },
  MediaLink: {
    link: "Text",
    mediaType: "Text",
  },
};

/** Method name to the canister that must serve it. */
const UPSTREAM_METHODS: Record<
  string,
  "SWAP_FACTORY" | "TOKEN_LIST" | "SWAP_POOL" | "TOKEN_LEDGER"
> = {
  getPools: "SWAP_FACTORY",
  getPool: "SWAP_FACTORY",
  getList: "TOKEN_LIST",
  metadata: "SWAP_POOL",
  quote: "SWAP_POOL",
  getCachedTokenFee: "SWAP_POOL",
  getAvailabilityState: "SWAP_POOL",
  depositFromAndSwap: "SWAP_POOL",
  getUserUnusedBalance: "SWAP_POOL",
};

/**
 * The legacy swap client's mutation. LiquidityClient.mo has separately
 * reviewed deposit, liquidity and withdrawal contracts.
 */
const UPSTREAM_MUTATIONS = new Set(["depositFromAndSwap"]);

async function readTypes(): Promise<string> {
  return readFile(typesUrl, "utf8");
}

/** Extract `public type <name> = { ... };` as a field name to type map. */
function parseRecord(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`public type ${name} = {`);
  if (start < 0) throw new Error(`missing Motoko type ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unterminated Motoko type ${name}`);
  const body = source.slice(open + 1, end);
  const fields: Record<string, string> = {};
  for (const line of body.split(";")) {
    const cleaned = line.replace(/\/\/.*$/gm, "").trim();
    if (cleaned === "") continue;
    const separator = cleaned.indexOf(":");
    if (separator < 0) continue;
    fields[cleaned.slice(0, separator).trim()] = cleaned
      .slice(separator + 1)
      .trim();
  }
  return fields;
}

describe("upstream ICPSwap Candid contract", () => {
  for (const [name, expected] of Object.entries(UPSTREAM_RECORDS)) {
    test(`${name} mirrors the deployed record exactly`, async () => {
      const fields = parseRecord(await readTypes(), name);
      expect(fields).toEqual(expected);
    });
  }

  test("only the two fixed canisters are named", async () => {
    const client = await readFile(clientUrl, "utf8");
    expect(client).toContain('SWAP_FACTORY : Text = "4mmnk-kiaaa-aaaag-qbllq-cai"');
    expect(client).toContain('TOKEN_LIST : Text = "k37c6-riaaa-aaaag-qcyza-cai"');

    const principals = new Set(
      client.match(/[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-cai/g) ?? [],
    );
    expect([...principals].sort()).toEqual([
      "4mmnk-kiaaa-aaaag-qbllq-cai",
      "k37c6-riaaa-aaaag-qcyza-cai",
    ]);
  });

  test("the quote references are the reviewed dollar and ICP pairs", async () => {
    const market = await readFile(marketUrl, "utf8");
    expect(market).toContain('ICP_LEDGER : Text = "ryjl3-tyaaa-aaaaa-aaaba-cai"');
    expect(market).toContain('CKUSDC_LEDGER : Text = "xevnm-gaaaa-aaaar-qafnq-cai"');
    expect(market).toContain('CKUSDT_LEDGER : Text = "cngnf-vqaaa-aaaar-qag4q-cai"');
    // 2^96, the fixed-point scale every ICPSwap pool uses.
    expect(market).toContain("79_228_162_514_264_337_593_543_950_336.0");
  });

  test("the legacy swap client uses its recorded queries and swap method", async () => {
    const client = await readFile(clientUrl, "utf8");
    // Method names reach a request either as a literal or through one of the
    // module's `public let … : Text` constants, because pools and ledgers are
    // discovered at runtime and cannot be named by an exact reservation.
    const constants = new Map(
      [...client.matchAll(/public let ([A-Z_]+) : Text = "([^"]+)"/g)].map(
        (match) => [match[1]!, match[2]!],
      ),
    );
    const requested = [
      ...client.matchAll(/method = (?:"([A-Za-z0-9_]+)"|([A-Z_]+))/g),
    ].map((match) =>
      match[1] !== undefined ? match[1] : (constants.get(match[2]!) ?? match[2]!),
    );
    expect(requested.length).toBeGreaterThan(0);
    for (const method of requested) {
      expect(
        Object.keys(UPSTREAM_METHODS),
        `${method} is not a recorded upstream method`,
      ).toContain(method);
    }
    // Every recorded method is actually used; an unused reservation would be
    // authority this app does not need.
    for (const method of Object.keys(UPSTREAM_METHODS)) {
      expect(requested, `${method} is declared but never called`).toContain(
        method,
      );
    }
  });

  test("no dead or frozen analytics canister is used", async () => {
    const types = await readTypes();
    const client = await readFile(clientUrl, "utf8");
    const market = await readFile(marketUrl, "utf8");
    // NodeIndex, GlobalIndex and BaseIndex still publish Candid metadata but
    // are stopped on mainnet. PriceIndex answers, which is worse: its data has
    // been frozen since 2025-06-12 and it reports ICP at $13.05 against a real
    // $2.40. None of them may appear in a request builder.
    const forbidden = [
      "ggzvv-5qaaa-aaaag-qck7a-cai",
      "gp26j-lyaaa-aaaag-qck6q-cai",
      "g54jq-hiaaa-aaaag-qck5q-cai",
      "gbytb-qiaaa-aaaag-qck7q-cai",
      "getAllTokens",
      "getAllPools",
      "getTokenPrice",
      "getPoolTvl",
      "getUsdcPrice",
    ];
    for (const stopped of forbidden) {
      expect(client, `Client.mo must not use ${stopped}`).not.toContain(stopped);
      expect(market, `Market.mo must not use ${stopped}`).not.toContain(stopped);
    }
    // The type mirrors may name them only inside explanatory prose.
    for (const stopped of forbidden.filter((entry) => entry.endsWith("-cai"))) {
      const uses = types.split("\n").filter(
        (line) => line.includes(stopped) && !line.trimStart().startsWith("///"),
      );
      expect(uses, `Types.mo must not declare ${stopped}`).toEqual([]);
    }
  });
});

test("the legacy swap client mutation is depositFromAndSwap", () => {
  // The legacy swap client uses the pool's one-step swap. LiquidityClient.mo
  // supplies the additional saved deposit, position and withdrawal calls.
  expect([...UPSTREAM_MUTATIONS].sort()).toEqual(["depositFromAndSwap"]);
  for (const method of Object.keys(UPSTREAM_METHODS)) {
    if (UPSTREAM_MUTATIONS.has(method)) continue;
    expect(
      /^(get|metadata|quote|icrc1_|icrc2_)/.test(method),
      `${method} is not obviously a read`,
    ).toBe(true);
  }
});

test("the client never names a ledger method at all", async () => {
  // Ledgers belong to the Wallet without exception. Decimals, fees and
  // balances reach this app through `wallet_token_info_v1`, never by calling
  // a ledger directly.
  const client = await readFile(clientUrl, "utf8");
  const ledgerCalls = [
    ...new Set(
      [...client.matchAll(/"(icrc\d+_[a-z_0-9]+|transfer[a-z_]*)"/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
  expect(ledgerCalls).toEqual([]);
});
