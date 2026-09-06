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
