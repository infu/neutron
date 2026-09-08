/**
 * Projecting the SNS aggregator's JSON.
 *
 * Its encodings are quirky in ways that fail silently: an ICRC `Nat` is
 * `{"Nat":[limbs]}`, the top-level fee is a bare `[n]`, and the total supply is
 * a JSON *number* that has already lost digits for most SNSes. Getting any of
 * these wrong produces a plausible-looking row with a wrong number in it.
 */

import { expect, test } from "bun:test";
import { toEntry } from "../src/data/aggregator";

const CANISTERS = {
  root_canister_id: "extk7-gaaaa-aaaaq-aacda-cai",
  governance_canister_id: "eqsml-lyaaa-aaaaq-aacdq-cai",
  ledger_canister_id: "f54if-eqaaa-aaaaq-aacea-cai",
  swap_canister_id: "f25or-jiaaa-aaaaq-aaceq-cai",
  index_canister_id: "ft6fn-7aaaa-aaaaq-aacfa-cai",
};

const METADATA: [string, Record<string, unknown>][] = [
  ["icrc1:symbol", { Text: "NTN" }],
  ["icrc1:name", { Text: "Neutrinite" }],
  ["icrc1:decimals", { Nat: [8] }],
  ["icrc1:fee", { Nat: [10000] }],
  ["icrc1:logo", { Text: "data:image/png;base64,iVBORw0KGg==" }],
];

test("a complete row becomes a usable entry", () => {
  const entry = toEntry({
    canister_ids: CANISTERS,
    meta: { name: "Neutrinite", description: "A DAO", url: "https://x" },
    icrc1_metadata: METADATA,
    icrc1_fee: [10000],
  })!;
  expect(entry.canisters.root).toBe("extk7-gaaaa-aaaaq-aacda-cai");
  expect(entry.canisters.swap).toBe("f25or-jiaaa-aaaaq-aaceq-cai");
  expect(entry.metadata?.name).toBe("Neutrinite");
  expect(entry.token?.symbol).toBe("NTN");
  // `{"Nat":[n]}` is a big integer as limbs, not a plain number.
  expect(entry.token?.decimals).toBe(8);
  expect(entry.token?.fee).toBe(10_000n);
});

// The aggregator cannot tell a wound-down DAO from a working one: 15 of the 16
// SNSes with no governance Wasm still carry complete data here. Claiming alive
// would put them all in the default view.
test("liveness is never claimed", () => {
  const entry = toEntry({ canister_ids: CANISTERS, icrc1_metadata: METADATA })!;
  expect(entry.liveness).toEqual({ governance: false, ledger: false });
});

// 40 of 54 real supplies exceed Number.MAX_SAFE_INTEGER, so the JSON number has
// already lost digits. Better absent than subtly wrong.
test("the lossy total supply is left out entirely", () => {
  const entry = toEntry({
    canister_ids: CANISTERS,
    icrc1_metadata: METADATA,
    icrc1_fee: [10000],
  })!;
  expect(entry.token?.totalSupply).toBeUndefined();
});

test("a row without a full canister set is dropped", () => {
  expect(toEntry({ canister_ids: { root_canister_id: CANISTERS.root_canister_id } })).toBeUndefined();
  expect(toEntry({})).toBeUndefined();
  expect(
    toEntry({ canister_ids: { ...CANISTERS, governance_canister_id: "not a canister" } }),
  ).toBeUndefined();
});

test("a token missing its fee is left out rather than defaulted", () => {
  const entry = toEntry({
    canister_ids: CANISTERS,
    icrc1_metadata: [
      ["icrc1:symbol", { Text: "NTN" }],
      ["icrc1:decimals", { Nat: [8] }],
    ],
  })!;
  expect(entry.token).toBeUndefined();
});

// `meta.logo` is a URL on the aggregator; `icrc1:logo` is a real data URI. Only
// the inline one is taken, so the tile never fetches an image from anyone.
test("only an inline logo is taken", () => {
  const inline = toEntry({ canister_ids: CANISTERS, icrc1_metadata: METADATA })!;
  expect(inline.metadata?.logo).toStartWith("data:image/png;base64,");

  const remote = toEntry({
    canister_ids: CANISTERS,
    icrc1_metadata: [["icrc1:logo", { Text: "https://example.org/logo.png" }]],
  })!;
  expect(remote.metadata?.logo).toBeUndefined();
});
