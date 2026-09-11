import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadProposalFeedPage, projectFeedRegistry, type ProposalFeedReader } from "../src/data/feed";
import { SnsError } from "../src/data/errors";
import type { Registry } from "../src/data/registry";
import type { ProposalSummary, SnsCanisterIds } from "../src/data/types";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const options = { host: "https://feed-test.invalid" };
const ids = (root: string, governance = `${root}-gov`): SnsCanisterIds => ({ root, governance, ledger: `${root}-ledger`, swap: null, index: null });
function cached(roots: string[], active: string[] = roots): Registry {
  const entries = roots.map(root => ({ canisters: ids(root), liveness: { governance: active.includes(root), ledger: true }, metadata: { name: root } }));
  return { entries, byRoot: new Map(entries.map(entry => [entry.canisters.root, entry])), fetchedAt: Date.now(), livenessKnown: true };
}
const proposal = (id: bigint): ProposalSummary => ({ id, title: "Test", summary: "", url: "", status: "open", createdAtSeconds: id, actionKind: "Motion" });
const inactive = () => new SnsError("SNS_GOVERNANCE_INACTIVE", "Canister is stopped.");

test("lean registry offers only cached active roots while preserving every SNS-W candidate for recovery", () => {
  const cold = projectFeedRegistry([ids("alpha"), ids("beta")], undefined, options);
  expect(cold.availableRoots).toEqual([]);
  expect(cold.entries.map(entry => entry.canisters.root)).toEqual(["alpha", "beta"]);
  const warm = projectFeedRegistry([ids("alpha"), ids("beta")], cached(["alpha", "beta"], ["alpha"]), options);
  expect(warm.availableRoots).toEqual(["alpha"]);
  expect(warm.entries[0]?.metadata?.name).toBe("alpha");
  expect(projectFeedRegistry([ids("alpha")], { ...cached(["alpha"]), livenessKnown: false }, options).availableRoots).toEqual([]);
});

test("confirmed unavailability retires cached active status and a fresh successful read restores it", async () => {
  const previous = cached(["alpha"]);
  const registry = projectFeedRegistry([ids("alpha")], previous, options);
  const unavailable = await loadProposalFeedPage({ sns: ["alpha"], registry }, async () => { throw inactive(); });
  expect(unavailable.failures).toEqual([]);
  expect(unavailable.unavailable).toEqual([{ scope: "alpha", code: "SNS_GOVERNANCE_INACTIVE", message: "Canister is stopped." }]);
  expect(unavailable.nextCursor).toBeUndefined();
  const nextRegistry = projectFeedRegistry([ids("alpha")], previous, options);
  expect(nextRegistry.availableRoots).toEqual([]);
  expect(nextRegistry.entries).toHaveLength(1);
  const recovered = await loadProposalFeedPage({ sns: ["alpha"], registry: nextRegistry }, async () => ({ proposals: [] }));
  expect(recovered.activeSns).toEqual(["alpha"]);
  expect(recovered.unavailable).toBeUndefined();
  expect(projectFeedRegistry([ids("alpha")], previous, options).availableRoots).toEqual(["alpha"]);
});

test("temporary failures keep cached active communities selectable and retain retry cursors", async () => {
  for (const message of ["network timeout", "HTTP 429 Too Many Requests"]) {
    const registry = projectFeedRegistry([ids("alpha")], cached(["alpha"]), options);
    const page = await loadProposalFeedPage({ sns: ["alpha"], registry }, async () => { throw new Error(message); });
    expect(page.unavailable).toBeUndefined();
    expect(page.failures).toHaveLength(1);
    expect(page.nextCursor).toBeString();
    expect(projectFeedRegistry([ids("alpha")], cached(["alpha"]), options).availableRoots).toEqual(["alpha"]);
  }
});

test("unknown or method-version failures do not mark an unverified source as dead or active", async () => {
  const registry = projectFeedRegistry([ids("alpha")], undefined, options);
  const page = await loadProposalFeedPage({ sns: ["alpha"], registry }, async () => { throw new SnsError("SNS_UNSUPPORTED_METHOD", "method unavailable on this SNS version"); });
  expect(page.failures).toHaveLength(1);
  expect(page.unavailable).toBeUndefined();
  expect(page.activeSns).toBeUndefined();
  expect(projectFeedRegistry([ids("alpha")], undefined, options).availableRoots).toEqual([]);
});

test("confirmed inactive sources are skipped on continuation but always retried by fresh refresh", async () => {
  let betaReads = 0;
  let recovered = false;
  const read: ProposalFeedReader = async ({ sns, beforeProposal }) => {
    if (sns === "beta") { betaReads++; if (!recovered) throw inactive(); return { proposals: [] }; }
    return beforeProposal === undefined ? { proposals: [proposal(2n)], nextBefore: 2n } : { proposals: [proposal(1n)] };
  };
  const first = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 1 }, read);
  const second = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 1, cursor: first.nextCursor! }, read);
  expect(betaReads).toBe(1);
  expect(second.unavailable).toEqual(first.unavailable);
  expect(second.failures).toEqual([]);
  expect(second.nextCursor).toBeUndefined();
  recovered = true;
  const refreshed = await loadProposalFeedPage({ sns: ["alpha", "beta"], limit: 1 }, read);
  expect(betaReads).toBe(2);
  expect(refreshed.activeSns).toEqual(["alpha", "beta"]);
  expect(refreshed.unavailable).toBeUndefined();
});

test("mixed feeds retain temporary failures separately from confirmed unavailable communities", async () => {
  const page = await loadProposalFeedPage({ sns: ["empty", "dead", "temporary"] }, async ({ sns }) => {
    if (sns === "dead") throw new Error("IC0537: Canister contains no Wasm module");
    if (sns === "temporary") throw new Error("fetch failed");
    return { proposals: [] };
  });
  expect(page.activeSns).toEqual(["empty"]);
  expect(page.failures.map(failure => failure.scope)).toEqual(["temporary"]);
  expect(page.unavailable?.map(failure => failure.scope)).toEqual(["dead"]);
  expect(page.nextCursor).toBeString();
});

test("observations cannot carry across governance identity or network changes", async () => {
  const registry = projectFeedRegistry([ids("alpha")], undefined, options);
  await loadProposalFeedPage({ sns: ["alpha"], registry }, async () => ({ proposals: [] }));
  expect(projectFeedRegistry([ids("alpha")], undefined, options).availableRoots).toEqual(["alpha"]);
  expect(projectFeedRegistry([ids("alpha", "different-gov")], cached(["alpha"]), options).availableRoots).toEqual([]);
  expect(projectFeedRegistry([ids("alpha")], undefined, { host: "https://another.invalid" }).availableRoots).toEqual([]);
  expect(projectFeedRegistry([ids("beta")], undefined, options).availableRoots).toEqual([]);
});

test("browser storage refusal or corruption never prevents current proposal discovery", async () => {
  storage.set(`snsgov.feed-availability.v1:${options.host}`, "bad json");
  expect(projectFeedRegistry([ids("alpha")], undefined, options).availableRoots).toEqual([]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("SecurityError"); } });
  const registry = projectFeedRegistry([ids("alpha")], undefined, options);
  const page = await loadProposalFeedPage({ sns: ["alpha"], registry }, async () => ({ proposals: [] }));
  expect(page.activeSns).toEqual(["alpha"]);
  expect(page.failures).toEqual([]);
});
