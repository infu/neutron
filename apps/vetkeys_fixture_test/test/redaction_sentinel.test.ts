import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertNoForbiddenMaterial,
  redactionNeedles,
  summarizeForbiddenMaterials,
  type ForbiddenMaterial,
} from "../scripts/redaction-sentinel";

const material = (label: string, value: string): ForbiddenMaterial => ({
  bytes: new TextEncoder().encode(value),
  label,
  textual: true,
});

describe("installed vetKeys redaction sentinel", () => {
  test("detects raw and common serialized representations", () => {
    const secret = material(
      "test-secret",
      "VETKEYS-REDACTION-SENTINEL-0123456789ABCDEF",
    );
    const needles = redactionNeedles([secret]);
    expect(needles.map((needle) => needle.encoding)).toEqual(
      expect.arrayContaining([
        "raw",
        "hex-lower",
        "hex-upper",
        "base64",
        "base64url",
        "json-array",
        "decimal-csv",
        "utf16le",
        "utf16be",
      ]),
    );
    for (const needle of needles) {
      expect(() => assertNoForbiddenMaterial(
        Buffer.concat([
          Buffer.from("prefix"),
          needle.bytes,
          Buffer.from("suffix"),
        ]),
        "test projection",
        [secret],
      )).toThrow("test-secret appeared");
    }
  });

  test("allowlists unrelated public material and reports hashes only", () => {
    const secret = material(
      "private-value",
      "PRIVATE-VETKEY-MATERIAL-0123456789ABCDEF",
    );
    const publicValue = Buffer.from(
      "PUBLIC-DERIVATION-INPUT-0123456789ABCDEF",
    );
    expect(() => assertNoForbiddenMaterial(
      publicValue,
      "public projection",
      [secret],
    )).not.toThrow();
    expect(summarizeForbiddenMaterials([secret])).toEqual([{
      bytes: secret.bytes.byteLength,
      label: "private-value",
      sha256: createHash("sha256").update(secret.bytes).digest("hex"),
    }]);
    expect(JSON.stringify(summarizeForbiddenMaterials([secret])))
      .not.toContain(new TextDecoder().decode(secret.bytes));
  });

  test("requires bounded unique material descriptions", () => {
    expect(() => redactionNeedles([])).toThrow("one to sixteen");
    expect(() => redactionNeedles([
      material("duplicate", "FIRST-VETKEYS-MATERIAL-0123456789ABCDEF"),
      material("duplicate", "SECOND-VETKEYS-MATERIAL-0123456789ABCDEF"),
    ])).toThrow("unique");
    expect(() => redactionNeedles([{
      bytes: new Uint8Array(15),
      label: "too-short",
    }])).toThrow("sixteen");
  });

  test("keeps the private export behind the loopback-only fixture surface", async () => {
    const [manifest, probe, runner] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../src/redaction_probe.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../scripts/prove-installed-origins.ts", import.meta.url),
        "utf8",
      ),
    ]);
    expect(JSON.parse(manifest).scripts["prove:redaction"])
      .toBe("bun scripts/prove-installed-origins.ts --redaction");
    expect(probe).toContain(
      "isLoopbackBrowserHost(window.location.hostname)",
    );
    expect(probe).toContain(
      'Object.defineProperty(window, "__NEUTRON_VETKEYS_REDACTION_PROBE_V1__"',
    );
    expect(probe).not.toMatch(
      /localStorage|sessionStorage|indexedDB|postMessage|console\./u,
    );
    expect(runner).toContain(
      "input.confirmDisposable !== input.canisterId",
    );
    expect(runner).toContain("inspectInstalledBackendRedaction");
    expect(runner).toContain("readInstalledVetKeysProjections");
    expect(runner).toContain("inspectBrowserPersistence");
  });
});
