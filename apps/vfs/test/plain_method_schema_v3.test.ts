import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  extractPublicTypeAliases,
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

const appRoot = new URL("../", import.meta.url);

const PLAIN_METHODS = [
  "files_plain_list_v3",
  "files_plain_stat_v3",
  "files_plain_read_chunk_v3",
  "files_plain_write_block_v3",
  "files_plain_mkdir_v3",
  "files_plain_move_v3",
  "files_plain_remove_v3",
  "files_plain_abort_v3",
  "files_plain_cleanup_v3",
] as const;

test("Files V3 public aliases remain locally schema-resolvable", async () => {
  const source = await readFile(new URL("backend/main.mo", appRoot), "utf8");
  const aliases = extractPublicTypeAliases(source);
  const plainAliases = Object.entries(aliases).filter(([name]) =>
    name.startsWith("FilesPlain"),
  );

  expect(plainAliases.length).toBeGreaterThan(0);
  for (const [name, value] of plainAliases) {
    expect(value, `${name} must not depend on an imported type alias`).not
      .toMatch(/\b[A-Za-z_][A-Za-z0-9_]*\./u);
  }
});

test("Files V3 emits and validates all plaintext method schemas", async () => {
  const [source, manifestSource] = await Promise.all([
    readFile(new URL("backend/main.mo", appRoot), "utf8"),
    readFile(new URL("neutron.json", appRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as NeutronManifest;
  const artifact = generateAppMethodSchemaArtifact(manifest, source);

  for (const method of PLAIN_METHODS) {
    expect(artifact.methods[method], `${method} schema`).toBeDefined();
  }

  const examples = {
    files_plain_list_v3: [
      {
        space: { workspace: null },
        path: "/documents",
        cursor: {
          after: "notes.txt",
          revision: "7",
          parent_node_id: "3",
        },
        limit: 100,
      },
    ],
    files_plain_stat_v3: [
      {
        space: { shared_: null },
        path: "/notes.txt",
      },
    ],
    files_plain_read_chunk_v3: [
      {
        space: { workspace: null },
        path: "/documents/archive.bin",
        block_index: 2,
      },
    ],
    files_plain_write_block_v3: [
      {
        request_id: "schema-write",
        space: { shared_: null },
        path: "/notes.txt",
        block_index: 0,
        block_count: 1,
        total_bytes: "2",
        content_kind: { text: null },
        media_type: "text/plain",
        etag_sha256: "2689367b205c16ce32ed4200942b8b1e",
        presentation: { inline_text: null },
        expected_node_id: "8",
        expected_revision: "9",
        if_match: "old-etag",
        move_source: {
          path: "/drafts/notes.txt",
          expected_node_id: "3",
          expected_revision: "4",
          if_match: "old-etag",
        },
        if_none_match: true,
        create_parents: true,
        final: true,
        body_bytes: 2,
        body: [111, 107],
      },
    ],
    files_plain_mkdir_v3: [
      {
        request_id: "schema-mkdir",
        space: { workspace: null },
        path: "/documents",
        recursive: true,
      },
    ],
    files_plain_move_v3: [
      {
        request_id: "schema-move",
        space: { workspace: null },
        from: "/notes.txt",
        to: "/documents/notes.txt",
        overwrite: false,
        expected_node_id: "8",
        expected_revision: "9",
        if_match: "etag",
      },
    ],
    files_plain_remove_v3: [
      {
        request_id: "schema-remove",
        space: { workspace: null },
        path: "/documents/notes.txt",
        recursive: false,
        expected_node_id: "8",
        expected_revision: "10",
        if_match: "etag",
        delete_nonce: [1, 2, 3],
      },
    ],
    files_plain_abort_v3: [
      {
        request_id: "schema-abort",
        space: { shared_: null },
        stage_id: "12",
      },
    ],
    files_plain_cleanup_v3: [{ request_id: "schema-cleanup", limit: 16 }],
  };

  for (const [method, args] of Object.entries(examples)) {
    const result = validateAppMethodArgs(artifact, method, args);
    expect(result.valid, `${method}: ${JSON.stringify(result.errors)}`).toBe(
      true,
    );
  }

  expect(
    validateAppMethodArgs(artifact, "files_plain_list_v3", [
      {
        space: { workspace: null },
        path: "/documents",
        limit: 100,
      },
    ]).valid,
    "an absent optional cursor must validate for the first page",
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "files_plain_list_v3", [
      {
        space: { workspace: null },
        path: "/documents",
        cursor: null,
        limit: 100,
      },
    ]).valid,
    "the self-call JSON convention omits Candid optionals instead of sending null",
  ).toBe(false);
  expect(
    validateAppMethodArgs(artifact, "files_plain_abort_v3", [
      {
        request_id: "schema-abort-by-request",
        space: { shared_: null },
      },
    ]).valid,
    "abort may resolve the active stage from request_id and space",
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "files_plain_abort_v3", [
      {
        request_id: "schema-abort-by-request",
        space: { shared_: null },
        stage_id: null,
      },
    ]).valid,
    "an absent optional stage_id must be omitted instead of sent as null",
  ).toBe(false);

  const listInput = artifact.methods.files_plain_list_v3?.input as {
    prefixItems?: Array<{
      required?: string[];
      properties?: Record<
        string,
        { type?: string; properties?: Record<string, { type?: string }> }
      >;
    }>;
  };
  const listRequest = listInput.prefixItems?.[0];
  expect(listRequest?.required).not.toContain("cursor");
  expect(listRequest?.properties?.cursor?.type).toBe("object");
  expect(
    listRequest?.properties?.cursor?.properties?.parent_node_id?.type,
  ).toBe("string");

  const moveInput = artifact.methods.files_plain_move_v3?.input as {
    prefixItems?: Array<{
      properties?: Record<string, { type?: string }>;
    }>;
  };
  expect(moveInput.prefixItems?.[0]?.properties?.expected_revision?.type).toBe(
    "string",
  );
  expect(moveInput.prefixItems?.[0]?.properties?.expected_node_id?.type).toBe(
    "string",
  );

  const writeInput = artifact.methods.files_plain_write_block_v3?.input as {
    prefixItems?: Array<{
      properties?: Record<
        string,
        { type?: string; properties?: Record<string, { type?: string }> }
      >;
    }>;
  };
  const moveSource =
    writeInput.prefixItems?.[0]?.properties?.move_source?.properties;
  expect(
    writeInput.prefixItems?.[0]?.properties?.expected_node_id?.type,
  ).toBe("string");
  expect(
    writeInput.prefixItems?.[0]?.properties?.expected_revision?.type,
  ).toBe("string");
  expect(moveSource?.path?.type).toBe("string");
  expect(moveSource?.expected_node_id?.type).toBe("string");
  expect(moveSource?.expected_revision?.type).toBe("string");

  const abortInput = artifact.methods.files_plain_abort_v3?.input as {
    prefixItems?: Array<{
      required?: string[];
      properties?: Record<string, { type?: string }>;
    }>;
  };
  expect(abortInput.prefixItems?.[0]?.required).not.toContain("stage_id");
  expect(abortInput.prefixItems?.[0]?.properties?.stage_id?.type).toBe(
    "string",
  );

  const statOutput = artifact.methods.files_plain_stat_v3?.output as {
    properties?: {
      outcome?: {
        oneOf?: Array<{
          properties?: {
            ok?: { properties?: Record<string, { type?: string }> };
          };
        }>;
      };
    };
  };
  const entryProperties =
    statOutput.properties?.outcome?.oneOf?.[0]?.properties?.ok?.properties;
  expect(entryProperties?.node_id?.type).toBe("string");
});
