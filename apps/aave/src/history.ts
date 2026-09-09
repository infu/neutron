import type { Input } from "./plans.ts";
import type { RecordRow, Store, Summary } from "./store.ts";
import { intentOf, latestRecord, savedResult, type Result } from "./workflow.ts";

export type HistoryRow = Summary & { result: Result | null; input: Input; humanOwned: boolean };

/** Hydrate the whole requested page without issuing a backend read for every
 * row at once. Each self-call reserves reply/decoder capacity even for a small
 * text journal, so the old default 20-row fan-out exhausted one endpoint.
 * Cache only within this read: predecessor checks reuse the exact observations
 * already read, while a later refresh still fetches current saved progress. */
export async function readHistory(store: Store, options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const page = await store.page(options.cursor, options.limit);
  const records = new Map<string, Promise<RecordRow | null>>();
  const snapshot: Store = {
    ...store,
    get(id) {
      options.signal?.throwIfAborted();
      let record = records.get(id);
      if (!record) { record = store.get(id); records.set(id, record); }
      return record;
    },
  };
  const rows: HistoryRow[] = [];
  for (const summary of page.rows) {
    options.signal?.throwIfAborted();
    const record = await latestRecord(snapshot, summary.id);
    if (!record) throw new Error("A saved operation disappeared.");
    const intent = intentOf(record);
    rows.push({ ...summary, result: await savedResult(snapshot, summary.id, record), input: intent.input, humanOwned: intent.caller === null && !intent.agentMode });
  }
  options.signal?.throwIfAborted();
  return { rows, nextCursor: page.nextCursor };
}
