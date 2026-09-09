import { expect, test } from "bun:test";
import { getAddress } from "viem";
import { readHistory } from "../src/history.ts";
import { parseInput, type Plan } from "../src/plans.ts";
import { stable, type RecordRow, type Store, type Summary } from "../src/store.ts";
import { attemptId, requestId, stateOf, type Intent, type State } from "../src/workflow.ts";

// Exercise the real transport budget without making Kernel source part of
// this app's TypeScript composite project or its production bundle.
const { acquireAttachmentCapacity, attachmentCapacitySnapshot } = await import(new URL("../../kernel/src/attachment_bus.ts", import.meta.url).href);
const { getRegisteredEndpoint, registerFrameContext } = await import(new URL("../../kernel/src/frame_context.ts", import.meta.url).href);
const { selfCallReservationBytes } = await import(new URL("../../kernel/src/self_calls.ts", import.meta.url).href);

const address = getAddress("0x1111111111111111111111111111111111111111");
const input = parseInput({ kind: "supply", chainId: "1", asset: address, amount: "1000000" });
function row(index: number, attempt = "0"): RecordRow {
  const root = index.toString(16).padStart(32, "0"), id = attemptId(root, attempt);
  const intent: Intent = { version: 1, operationId: root, attempt, account: { accountId: "main", address, publicKey: `0x02${"11".repeat(32)}`, keyFingerprint: `0x${"22".repeat(32)}`, namespaceVersion: "1" }, input, caller: null, agentMode: false };
  const transaction = { chainId: "1" as const, accountId: "main" as const, to: address, valueWei: "0", data: "0x1234" as const };
  const account = { totalCollateralBase: "0", totalDebtBase: "0", availableBorrowsBase: "0", liquidationThresholdBps: 0, ltvBps: 0, healthFactor: null, eModeId: 0 };
  const plan: Plan = { summary: "Supply USDC", chainId: "1", accountAddress: address, validUntil: "1800000000", steps: [{ label: "Supply USDC", kind: "transaction", transaction }], preview: { reserve: null, amount: "1000000", maximumPayment: null, before: account, after: account, warnings: [], blockNumber: "21000000", inputs: [], outputs: [] } };
  const state: State = { version: 1, plan, steps: [{ request: { ...transaction, requestId: requestId(id, 0) }, dispatched: false, unresolved: false, operation: null, evidence: null }], successor: null };
  return { id, root_id: root, input_json: stable(intent), state_json: stable(state), summary: plan.summary, phase: "prepared", revision: "0", created_at: "1800000000000", updated_at: "1800000000000" };
}
function summary(record: RecordRow): Summary {
  const { id, summary, phase, revision, created_at, updated_at } = record;
  return { id, summary, phase, revision, created_at, updated_at };
}
function fixture(records: RecordRow[], roots = records) {
  const rows = new Map(records.map(row => [row.id, row])), reads: string[] = [], pages: unknown[] = [];
  const nextCursor = roots.at(-1)?.id ?? null;
  let mutations = 0;
  const store: Store = {
    async get(id) { reads.push(id); return structuredClone(rows.get(id) ?? null); },
    async page(cursor, limit) { pages.push({ cursor, limit }); return { rows: roots.map(summary), nextCursor }; },
    async begin() { mutations++; throw Error("History must not save a new operation"); },
    async update() { mutations++; throw Error("History must not change an operation"); },
  };
  return { store, rows, reads, pages, nextCursor, mutations: () => mutations };
}

test("default 20-row history fits actual endpoint capacity and returns the entire page", async () => {
  const f = fixture(Array.from({ length: 20 }, (_, index) => row(index + 1)));
  const unregister = registerFrameContext({} as Window, { role: "background", appId: "aave_history_capacity_test" });
  const endpoint = getRegisteredEndpoint("app:aave_history_capacity_test:background")!;
  const bytes = selfCallReservationBytes(0);
  let peak = 0;
  const originalGet = f.store.get;
  f.store.get = async id => {
    const reservation = acquireAttachmentCapacity(endpoint, 0);
    try {
      reservation.resize(bytes);
      peak = Math.max(peak, attachmentCapacitySnapshot().endpoints[endpoint.endpointId] ?? 0);
      await new Promise(resolve => setTimeout(resolve, 0));
      return await originalGet(id);
    } finally { reservation.release(); }
  };
  try {
    // Reproduce the former handler with the same small text-only root records.
    const old = await Promise.allSettled([...f.rows.keys()].map(id => f.store.get(id)));
    expect(old.filter(result => result.status === "rejected")).toHaveLength(7);
    for (const result of old) if (result.status === "rejected") expect(String(result.reason)).toContain("Endpoint attachment in-flight byte limit reached");
    f.reads.length = 0; peak = 0;
    const result = await readHistory(f.store, { cursor: "earlier-page", limit: 20 });
    expect(result.rows.map(row => row.id)).toEqual([...f.rows.keys()]);
    expect(result.rows).toHaveLength(20);
    expect(result.rows.every(row => row.result?.state === "pending" && row.humanOwned && row.input.amount === "1000000")).toBe(true);
    expect(result.nextCursor).toBe(f.nextCursor);
    expect(f.pages).toEqual([{ cursor: "earlier-page", limit: 20 }]);
    expect(f.reads).toEqual([...f.rows.keys()]);
    expect(peak).toBe(bytes);
    expect(f.mutations()).toBe(0);
  } finally { unregister(); }
  expect(attachmentCapacitySnapshot()).toEqual({ global: 0, endpoints: {}, reservations: 0 });
});

test("history reads renewed attempts once and retains the original dispatched-request warning", async () => {
  const root = row(1), successor = row(1, "1"), originalState = stateOf(root);
  originalState.successor = successor.id;
  originalState.steps[0]!.dispatched = true;
  originalState.steps[0]!.unresolved = true;
  root.state_json = stable(originalState);
  const f = fixture([root, successor], [root]);
  const result = await readHistory(f.store);
  expect(f.reads).toEqual([root.id, successor.id]);
  expect(result.rows[0]!.result).toMatchObject({ operationId: root.id, recordId: root.id, state: "pending", steps: [{ label: "Supply USDC", status: "unknown", transactionHash: null }] });
  expect(result.rows[0]!.result!.message).toContain("An earlier attempt already created the original lending request");
  expect(f.mutations()).toBe(0);
});

test("history memoization is limited to one request and refresh sees changed saved progress", async () => {
  const initial = row(1), f = fixture([initial]);
  expect((await readHistory(f.store)).rows[0]!.result?.phase).toBe("prepared");
  f.rows.set(initial.id, { ...initial, phase: "tracking_paused", revision: "1" });
  expect((await readHistory(f.store)).rows[0]!.result?.phase).toBe("tracking_paused");
  expect(f.reads).toEqual([initial.id, initial.id]);
  expect(f.mutations()).toBe(0);
});

test("canceled history stops before reading another row", async () => {
  const f = fixture([row(1), row(2)]), controller = new AbortController();
  const originalGet = f.store.get;
  f.store.get = async id => { const result = await originalGet(id); controller.abort(Error("History view closed")); return result; };
  await expect(readHistory(f.store, { signal: controller.signal })).rejects.toThrow("History view closed");
  expect(f.reads).toEqual([row(1).id]);
  expect(f.mutations()).toBe(0);
});
