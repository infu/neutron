import { describe, expect, test } from "bun:test";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.ts";
import {
  inspectPackageFiles,
  inspectUpdatePackage,
  sha256Hex,
} from "../src/model.ts";

const text = (value: string) => new TextEncoder().encode(value);

function examplePackage(id: string, name: string): Uint8Array {
  const module = text(
    'module { public class Init() { public func ping() : Text { "ok" } } }',
  );
  const entry = hashContent(module);
  const files = {
    "neutron.json": text(
      JSON.stringify({
        format: 3,
        id,
        name,
        version: 100,
        entry,
        func: { ping: { type: "update", async: false } },
      }),
    ),
    "web/index.html": text("<main></main>"),
    [`mo/${entry}.mo`]: module,
  };
  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path, gzipSync(bytes)]),
    ),
  );
}

describe("update package inspection", () => {
  test("uses Neutron's real package preparation for self-contained examples", () => {
    const examples = [
      ["alpha.neutron", "alpha", "Alpha"],
      ["bravo.neutron", "bravo", "Bravo"],
    ] as const;

    for (const [file, id, name] of examples) {
      const bytes = examplePackage(id, name);
      const inspected = inspectUpdatePackage(file, bytes);
      expect(inspected.record).toEqual({
        protocol: "neutron-repo-v1",
        id,
        version: 100,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
      });
      expect(inspected.packagePath).toBe(
        `/repo/v1/packages/${sha256Hex(bytes)}.neutron`,
      );
      expect(inspected.releasePath).toBe(`/repo/v1/releases/${id}.json`);
    }
  });

  test("rejects invalid package bytes through the shared installer", () => {
    expect(() =>
      inspectUpdatePackage("broken.neutron", new Uint8Array([1, 2, 3])),
    ).toThrow("not a valid .neutron package");
  });

  test("rejects duplicate app ids before any publication", async () => {
    const inspect = () => ({
      record: {
        protocol: "neutron-repo-v1" as const,
        id: "alpha",
        version: 100,
        sha256: "a".repeat(64),
        size: 1,
      },
      releaseBytes: new TextEncoder().encode("{}"),
      packagePath: `/repo/v1/packages/${"a".repeat(64)}.neutron`,
      releasePath: "/repo/v1/releases/alpha.json",
    });
    await expect(
      inspectPackageFiles(["alpha.neutron", "copy.neutron"], {
        read: async () => new Uint8Array([1]),
        inspect,
      }),
    ).rejects.toThrow("repeats app id 'alpha'");
  });
});
