import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { SelfCallValue } from "neutron-tools/app";
import {
  FilesPlainBackendAdapter,
  FilesPlainBackendProtocolError,
  type FilesPlainTransport,
} from "../src/protocol/plain_backend_adapter.ts";
import {
  normalizePlainFilesPath,
  validatePlainFilesName,
} from "../src/protocol/plain_paths.ts";
import { DefaultFilesPlainPort } from "../src/resident/plain_port.ts";
import { FilesRootedResidentPort } from "../src/resident/rooted_port.ts";
import {
  FILES_LEGACY_VAULT_PATH_ROUTING,
  FILES_POLICY_V3_PATH_ROUTING,
} from "../src/resident/path_routing.ts";
import {
  normalizeFilesPathForRouting,
  normalizeFilesPolicyPath,
} from "../src/resident/routed_paths.ts";
import { normalizeFilesPath } from "../src/resident/paths.ts";
import type {
  FilesResidentFilePort,
} from "../src/resident/service_contract.ts";
import {
  normalizeUnicode16Npss,
  UNICODE_NFC_VERSION,
} from "../src/protocol/unicode_nfc.ts";

describe("Files Unicode 16 plain path policy", () => {
  test("passes every official Unicode 16 NFC conformance relation", () => {
    const source = gunzipSync(readFileSync(
      new URL(
        "../scripts/unicode/16.0.0/NormalizationTest.txt.gz",
        import.meta.url,
      ),
    )).toString("utf8");
    let rows = 0;
    let checks = 0;
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.split("#", 1)[0]!.trim();
      if (!line || line.startsWith("@")) continue;
      rows += 1;
      const [c1, c2, c3, c4, c5] = line
        .split(";")
        .slice(0, 5)
        .map(codePointSequence);
      const relations = [
        [c1, c2],
        [c2, c2],
        [c3, c2],
        [c4, c4],
        [c5, c4],
      ] as const;
      for (const [input, expected] of relations) {
        const actual = normalizeUnicode16Npss(input!);
        if (actual !== expected) {
          throw new Error(
            `Unicode 16 NFC mismatch at corpus row ${rows}`,
          );
        }
        checks += 1;
      }
    }
    expect(rows).toBe(19_965);
    expect(checks).toBe(99_825);
  });

  test("uses pinned Unicode 16 NFC instead of host normalization tables", () => {
    const tuluDecomposed = String.fromCodePoint(0x105d2, 0x0307);
    const tuluComposed = String.fromCodePoint(0x105c9);

    expect(UNICODE_NFC_VERSION).toBe("16.0.0");
    expect(normalizeUnicode16Npss(tuluDecomposed)).toBe(tuluComposed);
    expect(validatePlainFilesName(tuluDecomposed)).toBe(tuluComposed);
    expect(
      normalizePlainFilesPath(`/Shared/${tuluDecomposed}`).path,
    ).toBe(`/Shared/${tuluComposed}`);

    const nfd100 = "e\u0301".repeat(100);
    const nfd30 = "e\u0301".repeat(30);
    const rootedBoundary =
      `/Shared/${nfd100}/${nfd100}/${nfd30}`;
    const canonicalBoundary =
      `/Shared/${"é".repeat(100)}/${"é".repeat(100)}/${"é".repeat(30)}`;
    expect(normalizePlainFilesPath(rootedBoundary).path)
      .toBe(canonicalBoundary);
    expect([...canonicalBoundary]).toHaveLength(240);
    expect(() => normalizePlainFilesPath(`${rootedBoundary}e`))
      .toThrow("exceeds");
  });

  test("keeps legacy Vault identity while Plain rejects U16-unassigned scalars", () => {
    const unassigned = "\u0378";
    const noncharacter = "\ufdd0";

    expect(normalizeFilesPath(`/Vault/${unassigned}`).path)
      .toBe(`/Vault/${unassigned}`);
    expect(normalizeFilesPolicyPath(`/Vault/${unassigned}`))
      .toBe(`/Vault/${unassigned}`);
    expect(normalizeFilesPathForRouting(
      `/Shared/${unassigned}`,
      FILES_LEGACY_VAULT_PATH_ROUTING,
    )).toBe(`/Shared/${unassigned}`);

    for (const root of ["Shared", "Workspace"]) {
      expect(() => normalizeFilesPathForRouting(
        `/${root}/${unassigned}`,
        FILES_POLICY_V3_PATH_ROUTING,
      )).toThrow("invalid");
      expect(() => normalizeFilesPolicyPath(`/${root}/${noncharacter}`))
        .toThrow("invalid");
    }
  });

  test("matches the backend name grammar and normalization boundaries", () => {
    expect(validatePlainFilesName("é")).toBe("é");
    expect(validatePlainFilesName("a\u00a0b")).toBe("a\u00a0b");
    expect(validatePlainFilesName("\ufeffname")).toBe("\ufeffname");
    expect(validatePlainFilesName("A\u0305\u0301")).toBe(
      "A\u0305\u0301",
    );

    for (const value of [
      "e\u0301",
      "\u0085name",
      "\u00a0name",
      "name\u2003",
      "a/b",
      "a\\b",
      "\u0378",
      "\ufdd0",
    ]) {
      if (value === "e\u0301") {
        expect(validatePlainFilesName(value)).toBe("é");
      } else {
        expect(() => validatePlainFilesName(value)).toThrow();
      }
    }
  });

  test("prebounds adversarial raw names and paths before NFC/backend work", async () => {
    const decomposedBoundary = "e\u0301".repeat(100);
    expect(validatePlainFilesName(decomposedBoundary)).toBe("é".repeat(100));
    expect(() => validatePlainFilesName("\u0315".repeat(401)))
      .toThrow("exceeds");
    expect(() => normalizePlainFilesPath(
      `/Shared/${"\u0315".repeat(401)}`,
    )).toThrow("exceeds");
    expect(() => normalizeFilesPolicyPath(
      `/Shared/${"/".repeat(10_000)}`,
    )).toThrow("raw bound");

    let backendCalls = 0;
    const backend = {
      stat: async () => {
        backendCalls += 1;
        throw new Error("must not reach backend");
      },
    } as unknown as FilesPlainBackendAdapter;
    const port = new DefaultFilesPlainPort({ backend });
    await expect(port.stat(
      `/Workspace/${"\u0315".repeat(401)}`,
    )).rejects.toMatchObject({ code: "invalid" });
    expect(backendCalls).toBe(0);
  });

  test("never falls malformed policy Plain roots through to Vault", async () => {
    let vaultCalls = 0;
    let plainCalls = 0;
    const vault = {
      stat: async () => {
        vaultCalls += 1;
        throw new Error("must not reach Vault");
      },
    } as unknown as FilesResidentFilePort<never>;
    const plain = {
      stat: async () => {
        plainCalls += 1;
        throw new Error("must not reach Plain backend");
      },
    } as unknown as FilesResidentFilePort<never>;
    const rooted = new FilesRootedResidentPort({ vault, plain });

    for (const root of ["Shared", "Workspace"]) {
      for (const suffix of [
        "/".repeat(10_000),
        "\u0315".repeat(401),
        "e\u0301".repeat(401),
        "\ud800",
        "\u0378",
      ]) {
        await expect(rooted.stat(
          `/${root}/${suffix}`,
          undefined,
          FILES_POLICY_V3_PATH_ROUTING,
        )).rejects.toBeDefined();
      }
    }
    expect(vaultCalls).toBe(0);
    expect(plainCalls).toBe(0);
  });

  test("rejects malformed Plain backend names at the adapter boundary", async () => {
    for (const name of [
      "e\u0301",
      "\u0085name",
      "\u00a0name",
      "\u0378",
      "\ufdd0",
    ]) {
      const adapter = adapterFor(ok({
        revision: "1",
        entries: [wireFolder(`/${name}`, name)],
        total: 1,
        next_cursor: null,
        has_more: false,
      }));
      await expect(adapter.list({
        space: "workspace",
        path: "/",
        cursor: null,
        limit: 1,
      })).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);
    }
  });

  test("enforces exact Shared and Workspace relative response bounds", async () => {
    const cases = [
      {
        space: "shared" as const,
        path: `/${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(30)}`,
      },
      {
        space: "workspace" as const,
        path: `/${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(27)}`,
      },
    ];
    for (const { space, path } of cases) {
      const name = path.split("/").at(-1)!;
      await expect(adapterFor(ok(wireFolder(path, name))).stat({
        space,
        path,
      })).resolves.toMatchObject({ path, name });

      const over = `${path}c`;
      await expect(adapterFor(ok(wireFolder(
        over,
        `${name}c`,
      ))).stat({
        space,
        path: over,
      })).rejects.toBeInstanceOf(FilesPlainBackendProtocolError);
    }
  });
});

function codePointSequence(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Malformed Unicode normalization fixture");
  }
  const trimmed = value.trim();
  return trimmed === ""
    ? ""
    : String.fromCodePoint(
        ...trimmed.split(" ").map((scalar) =>
          Number.parseInt(scalar, 16)
        ),
      );
}

function adapterFor(query: SelfCallValue): FilesPlainBackendAdapter {
  const transport: FilesPlainTransport = {
    query: async () => query,
    update: async () => {
      throw new Error("unexpected update");
    },
  };
  return new FilesPlainBackendAdapter(transport);
}

function ok(value: SelfCallValue): SelfCallValue {
  return { outcome: { ok: value } };
}

function wireFolder(path: string, name: string): SelfCallValue {
  return {
    node_id: "1",
    path,
    name,
    kind: { folder: null },
    content_kind: null,
    byte_length: null,
    media_type: null,
    etag_sha256: null,
    created_at_ns: "1",
    modified_at_ns: "1",
    revision: "1",
    relative_url: null,
  };
}
