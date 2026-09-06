import { querySelf, updateSelf } from "neutron-tools/app";

export type ActionSummary = {
  id: string; summary: string; phase: string; revision: string; created_at: string; updated_at: string;
  kind: string; operationId: string; humanOwned: boolean; chainId: string; accountId: string;
};
export type ActionRecord = ActionSummary & { input_json: string; state_json: string };
export type ActionPage = { rows: ActionSummary[]; nextCursor: string | null };
export type TrackedPosition = { chainId: string; protocol: "v3" | "v4"; tokenId: string };
export type ActionStore = {
  get(id: string): Promise<ActionRecord | null>;
  page(cursor?: string | null, limit?: number): Promise<ActionPage>;
  list(): Promise<ActionSummary[]>;
  begin(input: { id: string; input_json: string; state_json: string; summary: string; phase: string }): Promise<ActionRecord>;
  update(record: ActionRecord, state: unknown, phase: string): Promise<ActionRecord>;
  positionRefs(chainId: string): Promise<TrackedPosition[]>;
  trackPosition(input: TrackedPosition): Promise<TrackedPosition>;
};
type Kernel = { querySelf: typeof querySelf; updateSelf: typeof updateSelf };

export function parseActionSummary(raw: unknown): ActionSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid saved action summary.");
  const value = raw as Record<string, unknown>;
  for (const key of ["id", "summary", "phase", "revision", "created_at", "updated_at"]) {
    if (typeof value[key] !== "string") throw new Error(`Invalid saved action ${key}.`);
  }
  const metadata = JSON.parse(value.summary as string) as Record<string, unknown>;
  for (const key of ["title", "kind", "operationId", "chainId", "accountId"]) {
    if (typeof metadata[key] !== "string") throw new Error(`Invalid saved action summary ${key}.`);
  }
  if (typeof metadata.humanOwned !== "boolean") throw new Error("Invalid saved action owner summary.");
  return {
    id: value.id as string, summary: metadata.title as string, phase: value.phase as string,
    revision: value.revision as string, created_at: value.created_at as string, updated_at: value.updated_at as string,
    kind: metadata.kind as string, operationId: metadata.operationId as string, humanOwned: metadata.humanOwned,
    chainId: metadata.chainId as string, accountId: metadata.accountId as string,
  };
}
export function parseActionRecord(raw: unknown): ActionRecord {
  const summary = parseActionSummary(raw), value = raw as Record<string, unknown>;
  if (typeof value.input_json !== "string" || typeof value.state_json !== "string") throw new Error("Invalid saved action intent or progress.");
  return { ...summary, input_json: value.input_json, state_json: value.state_json };
}
function parsePositionRef(raw: unknown): TrackedPosition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid tracked position.");
  const value = raw as Record<string, unknown>;
  if (typeof value.chain_id !== "string" || typeof value.token_id !== "string" || !["v3", "v4"].includes(String(value.protocol))) throw new Error("Invalid tracked position identity.");
  return { chainId: value.chain_id, tokenId: value.token_id, protocol: value.protocol as "v3" | "v4" };
}

export function createActionStore(kernel: Kernel = { querySelf, updateSelf }): ActionStore {
  const store: ActionStore = {
    async get(id) {
      const raw = await kernel.querySelf("uniswap_action_get_v1", [id]);
      return raw === null ? null : parseActionRecord(raw);
    },
    async page(cursor = null, limit = 32) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Action history page size must be a positive integer.");
      const raw = await kernel.querySelf("uniswap_action_page_v1", [{ ...(cursor === null ? {} : { cursor }), limit: String(limit) }]);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.rows)) throw new Error("Invalid action history page.");
      const rows = raw.rows.map(parseActionSummary), nextCursor = raw.next_cursor ?? null;
      if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor === cursor || nextCursor !== rows.at(-1)?.id)) throw new Error("Action history cursor did not advance.");
      if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => row.id === cursor)) throw new Error("Action history repeated a record.");
      return { rows, nextCursor };
    },
    async list() {
      const rows: ActionSummary[] = []; let cursor: string | null = null;
      do { const page = await store.page(cursor); rows.push(...page.rows); cursor = page.nextCursor; } while (cursor !== null);
      return rows;
    },
    async begin(input) { return parseActionRecord(await kernel.updateSelf("uniswap_action_begin_v1", [input])); },
    async update(record, state, phase) {
      return parseActionRecord(await kernel.updateSelf("uniswap_action_update_v1", [{ id: record.id, expected_revision: record.revision, state_json: JSON.stringify(state), phase }]));
    },
    async positionRefs(chainId) {
      const raw = await kernel.querySelf("uniswap_position_refs_v1", [chainId]);
      if (!Array.isArray(raw)) throw new Error("Invalid tracked positions response.");
      return raw.map(parsePositionRef);
    },
    async trackPosition(input) {
      return parsePositionRef(await kernel.updateSelf("uniswap_position_track_v1", [{ chain_id: input.chainId, protocol: input.protocol, token_id: input.tokenId }]));
    },
  };
  return store;
}
