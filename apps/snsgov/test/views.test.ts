/**
 * The view grammar is the contract between the agent and the tile.
 *
 * If the service emits a string the tile does not recognise, the tile silently
 * ignores it: the agent reports "opened Neutrinite" and nothing moved. So every
 * string the service can emit must parse back to what it meant, and anything
 * unrecognised must be rejected loudly at the point it is built.
 */

import { expect, test } from "bun:test";
import { formatView, parseView, SNS_TABS, type TileView } from "../src/data/views";

const ROOT = "extk7-gaaaa-aaaaq-aacda-cai";

const cases: TileView[] = [
  { kind: "feed" },
  { kind: "neurons" },
  { kind: "neurons", rootCanisterId: ROOT, neuronId: "ab".repeat(32) },
  { kind: "activity" },
  { kind: "activity", operationId: "ab".repeat(16) },
  { kind: "list" },
  { kind: "drafts" },
  { kind: "setup" },
  { kind: "draft", draftId: "7" },
  { kind: "sns", rootCanisterId: ROOT, tab: "overview" },
  ...SNS_TABS.map((tab) => ({ kind: "sns" as const, rootCanisterId: ROOT, tab })),
  { kind: "sns", rootCanisterId: ROOT, tab: "proposals", proposalId: 1066n },
];

test("every view the service can emit parses back to itself", () => {
  for (const view of cases) {
    const round = parseView(formatView(view));
    expect(round).toEqual(view);
  }
});

test("a proposal always lands on the proposals tab", () => {
  const view = formatView({
    kind: "sns",
    rootCanisterId: ROOT,
    // Even asked for elsewhere, a proposal belongs to its own tab.
    tab: "overview",
    proposalId: 42n,
  });
  expect(view).toBe(`sns/${ROOT}/proposals/42`);
  expect(parseView(view)).toEqual({
    kind: "sns",
    rootCanisterId: ROOT,
    tab: "proposals",
    proposalId: 42n,
  });
});

test("the strings are the documented ones", () => {
  expect(formatView({ kind: "sns", rootCanisterId: ROOT, tab: "overview" })).toBe(`sns/${ROOT}`);
  expect(formatView({ kind: "sns", rootCanisterId: ROOT, tab: "canisters" })).toBe(
    `sns/${ROOT}/canisters`,
  );
  expect(formatView({ kind: "draft", draftId: "12" })).toBe("draft/12");
});

// A malformed string is indistinguishable from "do nothing" at the tile, so it
// must never be built in the first place.
test("building a malformed view throws rather than emitting a no-op", () => {
  expect(() => formatView({ kind: "sns", rootCanisterId: "not a canister", tab: "overview" })).toThrow(
    /not a canister id/,
  );
  expect(() => formatView({ kind: "draft", draftId: "7; drop" })).toThrow(/not a draft id/);
});

test("anything unrecognised parses to undefined rather than a wrong screen", () => {
  for (const value of [
    "",
    "sns",
    `sns/${ROOT}/nope`,
    `sns/${ROOT}/proposals/abc`,
    `sns/${ROOT}/proposals/1/extra`,
    "sns/NOT-A-CANISTER/proposals/1",
    "draft/",
    "draft/abc",
    "../../etc/passwd",
    "https://example.org",
  ]) {
    expect(parseView(value)).toBeUndefined();
  }
});
