import { querySelf, type SelfCallValue } from "neutron-tools/app";
import { METHODS, parseHistory } from "./data.ts";

type HistoryQuery = (method: string, args: SelfCallValue[]) => Promise<unknown>;
const responseSizeErrors = new Set([
  "Self-call result exceeds the metadata byte limit",
  "Self-call Candid reply exceeds the raw metadata limit",
  "Self-call Candid reply exceeds the raw byte limit",
  "Candid reply exceeds the container element limit",
  "Candid reply exceeds the decoder allocation limit",
  "Self-call value exceeds the Candid container element limit",
]);

/** Keep history reachable when full operation records outgrow one transport reply. */
export async function queryHistoryPage(
  offset: string,
  limit = 40,
  query: HistoryQuery = querySelf,
): Promise<ReturnType<typeof parseHistory>> {
  let pageSize = limit;
  for (;;) {
    try {
      return parseHistory(await query(METHODS.history, [{ offset, limit: String(pageSize) }]));
    } catch (error) {
      // This is an existing Kernel response boundary, not an operation/history
      // cap. Retry only this read at the same offset; a single oversized row
      // remains an explicit error instead of being silently skipped.
      if (
        !(error instanceof Error) ||
        !responseSizeErrors.has(error.message) ||
        pageSize <= 1
      ) throw error;
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
  }
}

/**
 * Refresh the loaded window from its beginning instead of merging a new first
 * page into stale rows. Every returned row therefore has a current offset, even
 * when new requests have pushed previously visible operations onto later pages.
 * A zero minimum retains the initial, transport-sized page.
 */
export async function queryHistoryWindow(
  minimumCount = 0,
  query: HistoryQuery = querySelf,
): Promise<ReturnType<typeof parseHistory>> {
  for (;;) {
    const first = await queryHistoryPage("0", 40, query);
    const operations = [...first.operations];
    const ids = new Set(operations.map((operation) => operation.operationId));
    if (ids.size !== operations.length) throw new Error("Wallet history returned duplicate operations");
    let changed = false;
    while (operations.length < minimumCount && BigInt(operations.length) < BigInt(first.total)) {
      const next = await queryHistoryPage(String(operations.length), 40, query);
      // History is append-only. A new request changes every later offset, so
      // discard the partial window and start at the new beginning.
      if (next.total !== first.total) { changed = true; break; }
      if (next.operations.length === 0) throw new Error("Wallet history returned an incomplete page");
      for (const operation of next.operations) {
        if (ids.has(operation.operationId)) throw new Error("Wallet history returned duplicate operations");
        ids.add(operation.operationId);
        operations.push(operation);
      }
    }
    if (!changed) return { operations, total: first.total };
  }
}
