import { querySelf, updateSelf } from "neutron-tools/app";

export type Summary = { id: string; summary: string; phase: string; revision: string; created_at: string; updated_at: string };
export type RecordRow = Summary & { root_id: string; input_json: string; state_json: string };
export type Begin = Pick<RecordRow, "id" | "root_id" | "input_json" | "summary" | "state_json" | "phase">;
export type Store = {
  get(id: string): Promise<RecordRow | null>;
  begin(input: Begin): Promise<RecordRow>;
  update(record: RecordRow, state: unknown, phase: string): Promise<RecordRow>;
  page(cursor?: string | null, limit?: number): Promise<{ rows: Summary[]; nextCursor: string | null }>;
};
type Kernel = { querySelf: typeof querySelf; updateSelf: typeof updateSelf };

export function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("Operation data must contain serializable JSON values.");
}
function summary(raw: unknown): Summary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Hyperliquid history record.");
  const value = raw as Record<string, unknown>;
  for (const key of ["id", "summary", "phase", "revision", "created_at", "updated_at"]) if (typeof value[key] !== "string") throw new Error(`Invalid Hyperliquid history ${key}.`);
  return value as Summary;
}
export function recordRow(raw: unknown): RecordRow {
  const value = summary(raw) as RecordRow;
  for (const key of ["root_id", "input_json", "state_json"] as const) if (typeof value[key] !== "string") throw new Error(`Invalid saved operation ${key}.`);
  return value;
}
export function createStore(kernel: Kernel = { querySelf, updateSelf }): Store {
  return {
    async get(id) { const raw = await kernel.querySelf("hyperliquid_get_v1", [id]); return raw === null ? null : recordRow(raw); },
    async begin(input) { return recordRow(await kernel.updateSelf("hyperliquid_begin_v1", [input])); },
    async update(row, state, phase) {
      return recordRow(await kernel.updateSelf("hyperliquid_update_v1", [{ id: row.id, expected_revision: row.revision, state_json: stable(state), phase }]));
    },
    async page(cursor = null, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("History page size must be positive.");
      const raw = await kernel.querySelf("hyperliquid_page_v1", [{ ...(cursor ? { cursor } : {}), limit: String(limit) }]) as unknown as { rows: unknown[]; next_cursor?: string };
      if (!raw || !Array.isArray(raw.rows)) throw new Error("Invalid Hyperliquid history page.");
      const rows = raw.rows.map(summary), nextCursor = raw.next_cursor ?? null;
      if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => row.id === cursor) || (nextCursor !== null && nextCursor !== rows.at(-1)?.id)) throw new Error("Hyperliquid history cursor did not advance.");
      return { rows, nextCursor };
    },
  };
}

