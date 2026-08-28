import { describe, expect, test } from "bun:test";
import {
  normalizeToolDescriptor,
  validateToolResult,
} from "neutron-tools/app";
import type {
  JsonValue,
  ScopedKernelClient,
  SelfCallObject,
  SelfCallValue,
} from "neutron-tools/app";
import { sha256Hex } from "../src/json.ts";
import {
  BLAST_SCRIPT_METHODS,
  BlastScriptRejectionError,
  BlastScriptsBackendError,
  createBlastScriptsBackend,
  encodeSaveScriptInput,
  parseGetResponse,
  parseListResponse,
} from "../src/scripts.ts";
import { BLAST_TOOL_DEFINITIONS } from "../src/tool_schemas.ts";

const SOURCE = "return { ok: true };";

describe("Blast saved-script self-call adapter", () => {
  test("encodes create and CAS replacement requests with exact option and Blob shapes", () => {
    const created = encodeSaveScriptInput({
      name: "Example",
      description: "Exact source",
      source: SOURCE,
    });
    expect(created).toEqual({
      name: "Example",
      description: "Exact source",
      source_utf8: new TextEncoder().encode(SOURCE),
    });

    const replaced = encodeSaveScriptInput({
      id: "7",
      expectedRevision: "3",
      name: "Example",
      source: SOURCE,
    });
    expect(replaced).toEqual({
      id: "7",
      expected_revision: "3",
      name: "Example",
      source_utf8: new TextEncoder().encode(SOURCE),
    });
    expect(() => encodeSaveScriptInput({
      id: "7",
      name: "Example",
      source: SOURCE,
    })).toThrow("requires an expected revision");

    expect(encodeSaveScriptInput({
      name: "😀 Example",
      description: "Keeps 😀 scalar text",
      source: "return '😀';",
    })).toMatchObject({
      name: "😀 Example",
      description: "Keeps 😀 scalar text",
    });
    for (const input of [
      { name: "\ud800", source: SOURCE },
      { name: "Example", description: "\udc00", source: SOURCE },
      { name: "Example", source: "return '\ud800';" },
    ]) {
      expect(() => encodeSaveScriptInput(input)).toThrow("Invalid script");
    }
  });

  test("calls list/get queries with exact v1 names and decodes cursors and UTF-8 Blob", async () => {
    const digest = await sha256Hex(SOURCE);
    const calls: unknown[][] = [];
    const kernel = kernelFixture({
      query: async (method, args, timeout) => {
        calls.push([method, args, timeout]);
        if (method === BLAST_SCRIPT_METHODS.list) {
          return ok({
            library_revision: "9",
            scripts: [summary("7", "3", digest, SOURCE)],
            total: "1",
            total_source_bytes: String(new TextEncoder().encode(SOURCE).byteLength),
            next_cursor: { after_id: "7", library_revision: "9" },
          });
        }
        return ok({
          ...summary("7", "3", digest, SOURCE),
          source_utf8: new TextEncoder().encode(SOURCE),
        });
      },
    });
    const backend = createBlastScriptsBackend(kernel);

    const page = await backend.list({
      cursor: { afterId: "6", libraryRevision: "9" },
      limit: 1,
    });
    const script = await backend.get("7");
    expect(page).toMatchObject({
      libraryRevision: "9",
      nextCursor: { afterId: "7", libraryRevision: "9" },
    });
    expect(script).toMatchObject({ id: "7", revision: "3", source: SOURCE });
    validateScriptToolResult("script.list", page);
    validateScriptToolResult("script.get", script);
    expect(calls).toEqual([
      [
        BLAST_SCRIPT_METHODS.list,
        [{ cursor: { after_id: "6", library_revision: "9" }, limit: "1" }],
        30,
      ],
      [BLAST_SCRIPT_METHODS.get, [{ id: "7" }], 30],
    ]);
  });

  test("calls save/delete updates with exact v1 CAS shapes and verifies summaries", async () => {
    const digest = await sha256Hex(SOURCE);
    const calls: unknown[][] = [];
    const kernel = kernelFixture({
      update: async (method, args, timeout) => {
        calls.push([method, args, timeout]);
        if (method === BLAST_SCRIPT_METHODS.save) {
          return ok({
            library_revision: "10",
            total_source_bytes: String(new TextEncoder().encode(SOURCE).byteLength),
            script: summary("7", "4", digest, SOURCE),
          });
        }
        return ok({
          id: "7",
          deleted_revision: "4",
          source_sha256: hexBytes(digest),
          library_revision: "11",
          total_source_bytes: "0",
        });
      },
    });
    const backend = createBlastScriptsBackend(kernel);

    const saved = await backend.save({
      id: "7",
      expectedRevision: "3",
      name: "Example",
      source: SOURCE,
    });
    const deleted = await backend.delete("7", "4");
    expect(saved).toMatchObject({
      libraryRevision: "10",
      script: { id: "7", revision: "4", sourceDigest: digest },
    });
    expect(deleted).toMatchObject({
      id: "7",
      deletedRevision: "4",
      sourceDigest: digest,
      libraryRevision: "11",
    });
    validateScriptToolResult("script.save", saved);
    validateScriptToolResult("script.delete", deleted);
    expect(calls[0]).toEqual([
      BLAST_SCRIPT_METHODS.save,
      [{
        id: "7",
        expected_revision: "3",
        name: "Example",
        source_utf8: new TextEncoder().encode(SOURCE),
      }],
      45,
    ]);
    expect(calls[1]).toEqual([
      BLAST_SCRIPT_METHODS.delete,
      [{ id: "7", expected_revision: "4" }],
      45,
    ]);
  });

  test("preserves backend rejections and maps get not_found to null", async () => {
    const notFound = kernelFixture({
      query: async () => rejected("not_found"),
    });
    expect(await createBlastScriptsBackend(notFound).get("7")).toBeNull();

    const conflict = kernelFixture({
      update: async () => ({
        outcome: {
          rejected: { revision_conflict: { expected: "3", actual: "4" } },
        },
      }),
    });
    try {
      await createBlastScriptsBackend(conflict).delete("7", "3");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(BlastScriptRejectionError);
      expect(error).toMatchObject({
        code: "revision_conflict",
        detail: { expected: "3", actual: "4" },
      });
    }
  });

  test("rejects malformed outcomes, invalid Nat64, mismatched Blob sizes and digests", async () => {
    expect(() => parseListResponse({ outcome: null })).toThrow();
    expect(() => parseListResponse(ok({
      library_revision: "18446744073709551616",
      scripts: [],
      total: "0",
      total_source_bytes: "0",
    }))).toThrow("library revision");

    const digest = await sha256Hex(SOURCE);
    await expect(parseGetResponse(ok({
      ...summary("7", "3", digest, SOURCE),
      source_bytes: "1",
      source_utf8: new TextEncoder().encode(SOURCE),
    }))).rejects.toThrow("byte count");
    await expect(parseGetResponse(ok({
      ...summary("7", "3", "00".repeat(32), SOURCE),
      source_utf8: new TextEncoder().encode(SOURCE),
    }))).rejects.toThrow("digest");

    const malformed = kernelFixture({ query: async () => ({ outcome: {} }) });
    await expect(createBlastScriptsBackend(malformed).list()).rejects
      .toBeInstanceOf(BlastScriptsBackendError);
  });
});

function kernelFixture(handlers: Readonly<{
  query?: (
    method: string,
    args: SelfCallValue[],
    timeout: number,
  ) => Promise<SelfCallValue>;
  update?: (
    method: string,
    args: SelfCallValue[],
    timeout: number,
  ) => Promise<SelfCallValue>;
}>): ScopedKernelClient {
  return {
    querySelf: async (method, args, timeout) =>
      await (handlers.query?.(method, args ?? [], timeout ?? 0) ?? Promise.reject(
        new Error(`Unexpected query ${method}`),
      )),
    updateSelf: async (method, args, timeout) =>
      await (handlers.update?.(method, args ?? [], timeout ?? 0) ?? Promise.reject(
        new Error(`Unexpected update ${method}`),
      )),
  } as ScopedKernelClient;
}

function ok(value: SelfCallValue): SelfCallValue {
  return { outcome: { ok: value } };
}

function rejected(code: string): SelfCallValue {
  return { outcome: { rejected: { [code]: null } } };
}

function summary(
  id: string,
  revision: string,
  digest: string,
  source: string,
): SelfCallObject {
  return {
    id,
    revision,
    name: "Example",
    source_sha256: hexBytes(digest),
    source_bytes: String(new TextEncoder().encode(source).byteLength),
    created_at_ns: "1",
    updated_at_ns: "2",
  };
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

function validateScriptToolResult(
  name: "script.list" | "script.get" | "script.save" | "script.delete",
  result: unknown,
): void {
  validateToolResult(
    normalizeToolDescriptor({ name, ...BLAST_TOOL_DEFINITIONS[name] }),
    JSON.parse(JSON.stringify(result)) as JsonValue,
  );
}
