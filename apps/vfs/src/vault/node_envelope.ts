import type {
  FilesFrameContentSummary,
  FilesFrameNodeSummary,
} from "./types.ts";

export type FilesNodeEnvelopeCompleteness = "complete" | "summary";

/**
 * A lookup returns the wrapped content key needed to read a file, while a
 * folder listing intentionally returns only the file's content summary.
 */
export function filesNodeEnvelopeMatches(
  nodeKind: FilesFrameNodeSummary["kind"],
  content: FilesFrameContentSummary | null,
  wrappedContentKey: Uint8Array | null,
  completeness: FilesNodeEnvelopeCompleteness,
): boolean {
  if (nodeKind === "folder") {
    return content === null && wrappedContentKey === null;
  }
  if (content === null) return false;
  return completeness === "complete"
    ? wrappedContentKey !== null
    : wrappedContentKey === null;
}
