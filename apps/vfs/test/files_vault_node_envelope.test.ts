import { describe, expect, test } from "bun:test";
import type { FilesFrameContentSummary } from "../src/vault/types.ts";
import { filesNodeEnvelopeMatches } from "../src/vault/node_envelope.ts";

const CONTENT = Object.freeze({
  contentId: Object.freeze({ hi: "0", lo: "1" }),
  blockCount: 1,
  ciphertextBytes: "32",
  cryptoProfile: "aes_256_gcm_files_v2",
}) as FilesFrameContentSummary;
const WRAPPED_KEY = new Uint8Array(48);

describe("Files node content envelopes", () => {
  test("accepts folders without file content in either response shape", () => {
    expect(filesNodeEnvelopeMatches("folder", null, null, "summary")).toBe(
      true,
    );
    expect(filesNodeEnvelopeMatches("folder", null, null, "complete")).toBe(
      true,
    );
  });

  test("accepts a metadata-only file summary from a folder listing", () => {
    expect(filesNodeEnvelopeMatches("file", CONTENT, null, "summary")).toBe(
      true,
    );
  });

  test("accepts a complete file envelope from lookup", () => {
    expect(
      filesNodeEnvelopeMatches("file", CONTENT, WRAPPED_KEY, "complete"),
    ).toBe(true);
  });

  test("rejects envelopes whose content-key shape does not match the source", () => {
    expect(filesNodeEnvelopeMatches("folder", CONTENT, null, "summary")).toBe(
      false,
    );
    expect(
      filesNodeEnvelopeMatches("folder", null, WRAPPED_KEY, "complete"),
    ).toBe(false);
    expect(filesNodeEnvelopeMatches("file", null, null, "summary")).toBe(
      false,
    );
    expect(filesNodeEnvelopeMatches("file", null, null, "complete")).toBe(
      false,
    );
    expect(filesNodeEnvelopeMatches("file", CONTENT, null, "complete")).toBe(
      false,
    );
    expect(
      filesNodeEnvelopeMatches("file", CONTENT, WRAPPED_KEY, "summary"),
    ).toBe(false);
  });
});
