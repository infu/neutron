import { expect, test } from "bun:test";
import msgpack from "tiny-msgpack";
import { hashContent } from "neutron-tools/src/hash.js";
import { NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS } from "neutron-tools/package_record.js";
import {
  assertNeutronAppSourceBuildInputs,
  decodeNeutronAppSourceSnapshot,
} from "../src/source_snapshot.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const expected = Object.freeze({ id: "hello", version: 100 });

function snapshotBytes(
  files: readonly Readonly<{
    path: string;
    mode: number;
    content: Uint8Array;
  }>[],
  packageIdentity: Readonly<{ id: string; version: number }> = expected,
): Uint8Array {
  return msgpack.encode({
    format: 1,
    package: packageIdentity,
    files,
  });
}

test("bounded source decoder accepts the canonical closed snapshot and verifies build inputs", () => {
  const packageJson = bytes("{\"name\":\"hello\"}\n");
  const source = bytes("module {};\n");
  const decoded = decodeNeutronAppSourceSnapshot(
    snapshotBytes([
      { path: "apps/hello/backend/main.mo", mode: 0o644, content: source },
      { path: "apps/hello/package.json", mode: 0o644, content: packageJson },
    ]),
    expected,
  );

  expect(decoded.package).toEqual(expected);
  expect(decoded.files.map(({ path }) => path)).toEqual([
    "apps/hello/backend/main.mo",
    "apps/hello/package.json",
  ]);
  expect(() => assertNeutronAppSourceBuildInputs(decoded, [
    {
      path: "apps/hello/package.json",
      sha256: hashContent(packageJson),
      bytes: packageJson.byteLength,
    },
  ])).not.toThrow();
});

test("source decoder rejects malformed shape and package identity drift", () => {
  expect(() =>
    decodeNeutronAppSourceSnapshot(bytes("not messagepack"), expected)
  ).toThrow(/MessagePack map|ended unexpectedly/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      snapshotBytes([
        { path: "main.mo", mode: 0o644, content: bytes("module {}") },
      ], { id: "other", version: 100 }),
      expected,
    )
  ).toThrow(/does not match hello v100/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      snapshotBytes([
        { path: "main.mo", mode: 0o644, content: bytes("module {}") },
      ], { id: "hello", version: 101 }),
      expected,
    )
  ).toThrow(/does not match hello v100/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      msgpack.encode({
        files: [],
        format: 1,
        package: expected,
      }),
      expected,
    )
  ).toThrow(/canonical closed order/u);
});

test("source decoder rejects unsafe, repeated, unordered, oversized, and invalid-mode files", () => {
  const content = bytes("source");
  for (const sourceFiles of [
    [{ path: "../secret", mode: 0o644, content }],
    [
      { path: "z.mo", mode: 0o644, content },
      { path: "a.mo", mode: 0o644, content },
    ],
    [
      { path: "same.mo", mode: 0o644, content },
      { path: "same.mo", mode: 0o644, content },
    ],
  ]) {
    expect(() =>
      decodeNeutronAppSourceSnapshot(snapshotBytes(sourceFiles), expected)
    ).toThrow(/Unsafe package path|canonically ordered/u);
  }
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      snapshotBytes([{ path: "main.mo", mode: 0o600, content }]),
      expected,
    )
  ).toThrow(/invalid mode/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      snapshotBytes([{
        path: "a".repeat(NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.pathBytes + 1),
        mode: 0o644,
        content,
      }]),
      expected,
    )
  ).toThrow(/exceeds 4096 UTF-8 bytes/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      snapshotBytes(
        Array.from(
          { length: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.files + 1 },
          (_, index) => ({
            path: `file-${String(index).padStart(5, "0")}`,
            mode: 0o644,
            content: new Uint8Array(),
          }),
        ),
      ),
      expected,
    )
  ).toThrow(/must contain 1-8192 files/u);
  expect(() =>
    decodeNeutronAppSourceSnapshot(
      new Uint8Array(NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes + 1),
      expected,
    )
  ).toThrow(/must be 1-16777216 bytes/u);
});

test("source build-input verification rejects missing, wrong-size, and wrong-digest inputs", () => {
  const content = bytes("exact input\n");
  const decoded = decodeNeutronAppSourceSnapshot(
    snapshotBytes([{ path: "package.json", mode: 0o644, content }]),
    expected,
  );
  expect(() => assertNeutronAppSourceBuildInputs(decoded, [{
    path: "missing.json",
    sha256: hashContent(content),
    bytes: content.byteLength,
  }])).toThrow(/missing declared build input/u);
  expect(() => assertNeutronAppSourceBuildInputs(decoded, [{
    path: "package.json",
    sha256: hashContent(content),
    bytes: content.byteLength + 1,
  }])).toThrow(/expected 13/u);
  expect(() => assertNeutronAppSourceBuildInputs(decoded, [{
    path: "package.json",
    sha256: "0".repeat(64),
    bytes: content.byteLength,
  }])).toThrow(/SHA-256 does not match/u);
});
