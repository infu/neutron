import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { readFileSync } from "node:fs";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { createActionBackend, parseActionSummary, readAllActionSummaries, type ActionSummary } from "../src/action_backend.ts";
import type { BackendTransport } from "../src/backend.ts";
import { encodeSelfCallResult, normalizeSelfCallResult, SELF_CALL_METADATA_MAX_BYTES } from "neutron-kernel/src/self_calls.ts";

// Exercise the generated backend contract and actual Kernel projection. Empty
// Candid option fields disappear from records at this boundary.
const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
const pageType = motokoTypeToIdl(aliases.icpswap_action_page_Output!, IDL, aliases);
function candid(type: IDL.Type, value: unknown): unknown {
  if (type instanceof IDL.OptClass) return value == null ? [] : [candid(type._type, value)];
  if (type instanceof IDL.VecClass) return (value as unknown[]).map(item => candid(type._type, item));
  if (type instanceof IDL.RecordClass) return Object.fromEntries(type._fields.map(([name, child]) => [name, candid(child, (value as Record<string, unknown>)[name])]));
  if (type instanceof IDL.VariantClass) {
    const row = value as Record<string, unknown>, arm = type._fields.find(([name]) => Object.hasOwn(row, name))!;
    return { [arm[0]]: candid(arm[1], row[arm[0]]) };
  }
  return /^(nat|int)(64)?$/.test(type.display()) ? BigInt(value as string) : value;
}
function projectedPage(value: unknown) {
  return normalizeSelfCallResult(IDL.decode([pageType], IDL.encode([pageType], [candid(pageType, { ok: value })]))[0], pageType) as Record<string, unknown>;
}

const summary = (id: string): ActionSummary => ({
  id, input_json: JSON.stringify({ version: 1, kind: "liquidity", input: { kind: "claim", pool: "mohjv-bqaaa-aaaag-qjyia-cai" } }),
  state: "uncertain", detail: "Retain the original request.", revision: "9007199254740993",
  created_at: "1788890400000000000", updated_at: "1788890400000000001",
  effects: [{ key: "claim", canister: "mohjv-bqaaa-aaaag-qjyia-cai", method: "claim", state: "uncertain",
    error: "Lost reply", dispatched_at: "1788890400000000000", completed_at: null }],
});

describe("compact backend history", () => {
  test("empty history and final pages accept omitted Candid cursors and optional effect completion", async () => {
    const first = summary("first"), last = summary("last");
    last.effects[0]!.completed_at = "0";
    const empty = projectedPage({ items: [], next_cursor: null });
    const pages = [projectedPage({ items: [first], next_cursor: "first" }), projectedPage({ items: [last], next_cursor: null })];
    expect(empty).toEqual({ items: [] });
    expect(pages[1]).not.toHaveProperty("next_cursor");
    expect((pages[0]!.items as ActionSummary[])[0]!.effects[0]).not.toHaveProperty("completed_at");
    const cursors: unknown[] = [];
    const backend = createActionBackend({
      querySelf: async (_method: string, args: Array<{ cursor: string | null }>) => {
        cursors.push(args[0]!.cursor);
        return cursors.length === 1 ? empty : pages.shift();
      },
      updateSelf: async () => { throw new Error("Reading saved pools must not mutate"); },
    } as unknown as BackendTransport);
    expect(await backend.actionPage({ cursor: null, limit: 20 })).toEqual({ items: [], nextCursor: null });
    expect(await readAllActionSummaries(backend)).toEqual([first, last]);
    expect(cursors).toEqual([null, null, "first"]);
  });

  test("queries the requested page directly and keeps recovery metadata exact", async () => {
    const calls: unknown[] = [];
    const backend = createActionBackend({
      querySelf: async (method: string, args: unknown[]) => {
        calls.push({ method, args });
        return { items: [{ ...summary("saved"), revision: 9007199254740993n }], next_cursor: ["saved"] };
      },
      updateSelf: async () => { throw new Error("History must not mutate"); },
    } as unknown as BackendTransport);
    expect(await backend.actionPage({ cursor: "previous", limit: 50 })).toEqual({ items: [summary("saved")], nextCursor: "saved" });
    expect(calls).toEqual([{ method: "icpswap_action_page", args: [{ cursor: "previous", limit: "50" }] }]);
    await expect(backend.actionPage({ cursor: null, limit: 0 })).rejects.toThrow("positive exact integer");
    await expect(backend.actionPage({ cursor: null, limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("positive exact integer");
    expect(calls).toHaveLength(1);
  });

  test("does not include private funding, plans or raw result payloads", () => {
    const large = { ...summary("saved"), plan_json: "x".repeat(100_000), funding_json: "x".repeat(100_000), result_json: "x".repeat(100_000) };
    expect(() => encodeSelfCallResult([large])).toThrow();
    const parsed = parseActionSummary(large);
    expect(parsed).toEqual(summary("saved"));
    const page = Array.from({ length: 50 }, (_, index) => ({ ...parsed, id: String(index) }));
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(SELF_CALL_METADATA_MAX_BYTES);
    expect(() => encodeSelfCallResult(page)).not.toThrow();
    expect(() => parseActionSummary({ ...summary("broken"), input_json: undefined })).toThrow("summary.input_json");
  });

  test("traverses all pages so closed-position pools remain discoverable beyond page one", async () => {
    const expected = Array.from({ length: 173 }, (_, index) => summary(String(index)));
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const rows = await readAllActionSummaries({
      actionPage: async (request) => {
        calls.push(request);
        const start = request.cursor === null ? 0 : Number(request.cursor) + 1;
        const items = expected.slice(start, start + request.limit);
        return { items, nextCursor: start + items.length < expected.length ? items.at(-1)!.id : null };
      },
    }, { limit: 50 });
    expect(rows).toEqual(expected);
    expect(calls).toEqual([
      { cursor: null, limit: 50 }, { cursor: "49", limit: 50 },
      { cursor: "99", limit: 50 }, { cursor: "149", limit: 50 },
    ]);
  });

  test("adapts reads to the existing self-call payload budget without dropping rows", async () => {
    const expected = Array.from({ length: 43 }, (_, index) => ({ ...summary(String(index)), detail: "Diagnostic context: " + "x".repeat(2500) }));
    const calls: Array<{ cursor: string | null; limit: string }> = [];
    const backend = createActionBackend({
      querySelf: async (method: string, args: Array<{ cursor: string | null; limit: string }>) => {
        expect(method).toBe("icpswap_action_page");
        const request = args[0]!;
        calls.push(request);
        const start = request.cursor === null ? 0 : Number(request.cursor) + 1;
        const items = expected.slice(start, start + Number(request.limit));
        const result = { items, next_cursor: start + items.length < expected.length ? items.at(-1)!.id : null };
        encodeSelfCallResult(result);
        return result;
      },
      updateSelf: async () => { throw new Error("History must not mutate"); },
    } as unknown as BackendTransport);
    expect(await readAllActionSummaries(backend, { limit: 50 })).toEqual(expected);
    expect(calls.slice(0, 4)).toEqual([
      { cursor: null, limit: "50" }, { cursor: null, limit: "25" },
      { cursor: null, limit: "12" }, { cursor: "11", limit: "50" },
    ]);
    expect(calls.at(-1)?.cursor).toBe("23");
  });

  test("never retries unrelated failures or hides an individually oversized record", async () => {
    for (const message of ["Network unavailable", "Self-call result exceeds the metadata byte limit", "Self-call result exceeds the metadata byte limit (unexpected suffix)"]) {
      let calls = 0;
      const failure = new Error(message);
      const backend = createActionBackend({ querySelf: async () => { calls++; throw failure; }, updateSelf: async () => null } as unknown as BackendTransport);
      await expect(backend.actionPage({ cursor: "saved", limit: 4 })).rejects.toBe(failure);
      expect(calls).toBe(message === "Self-call result exceeds the metadata byte limit" ? 3 : 1);
    }
  });

  test("does not return a partial inventory when history fails, loops, or is cancelled", async () => {
    let calls = 0;
    await expect(readAllActionSummaries({ actionPage: async () => {
      if (++calls === 2) throw new Error("History temporarily unavailable");
      return { items: [summary("first")], nextCursor: "first" };
    } })).rejects.toThrow("History temporarily unavailable");
    await expect(readAllActionSummaries({ actionPage: async () => ({ items: [summary("first")], nextCursor: "first" }) })).rejects.toThrow("repeated history cursor");
    const controller = new AbortController();
    calls = 0;
    await expect(readAllActionSummaries({ actionPage: async () => {
      calls++;
      controller.abort(new Error("Tile closed"));
      return { items: [summary("first")], nextCursor: "first" };
    } }, { signal: controller.signal })).rejects.toThrow("Tile closed");
    expect(calls).toBe(1);
  });
});
