import { expect, test } from "bun:test";
import { parseCanonicalNat64 } from "../src/protocol/index.ts";
import {
  FilesToolRuntime,
  type FilesResidentFilePort,
  type FilesServiceFile,
} from "../src/resident/index.ts";

const invocation = {
  callerEndpoint: "app:files:tile:files:instance:test",
  callerSession: "session-1",
};

test("readBinary reuses an exact backing ArrayBuffer and copies subranges", async () => {
  const exactBacking = new ArrayBuffer(4);
  const exactBytes = new Uint8Array(exactBacking);
  exactBytes.set([1, 2, 3, 4]);

  const exact = await runtimeReading(exactBytes).readBinary(
    { path: "/fixture.bin" },
    invocation,
  );
  expect(exact.data).toBe(exactBacking);

  const prefixBacking = new ArrayBuffer(5);
  const prefixBytes = new Uint8Array(prefixBacking, 0, 3);
  prefixBytes.set([5, 6, 7]);
  const prefix = await runtimeReading(prefixBytes).readBinary(
    { path: "/fixture.bin" },
    invocation,
  );
  expect(prefix.data).not.toBe(prefixBacking);
  expect([...new Uint8Array(prefix.data)]).toEqual([5, 6, 7]);
  prefixBytes[0] = 50;
  expect([...new Uint8Array(prefix.data)]).toEqual([5, 6, 7]);

  const offsetBacking = new ArrayBuffer(5);
  const offsetBytes = new Uint8Array(offsetBacking, 2, 3);
  offsetBytes.set([8, 9, 10]);
  const offset = await runtimeReading(offsetBytes).readBinary(
    { path: "/fixture.bin" },
    invocation,
  );
  expect(offset.data).not.toBe(offsetBacking);
  expect([...new Uint8Array(offset.data)]).toEqual([8, 9, 10]);
  offsetBytes[0] = 80;
  expect([...new Uint8Array(offset.data)]).toEqual([8, 9, 10]);
});

function runtimeReading(bytes: Uint8Array): FilesToolRuntime {
  const file: FilesServiceFile = {
    entry: {
      path: "/fixture.bin",
      name: "fixture.bin",
      type: "file",
      nodeId: null,
      contentKind: "binary",
      byteLength: bytes.byteLength,
      mediaType: "application/octet-stream",
      etagSha256: "a".repeat(64),
      createdAtNs: parseCanonicalNat64("1"),
      modifiedAtNs: parseCanonicalNat64("1"),
      structuralRevision: parseCanonicalNat64("1"),
      contentId: null,
    },
    bytes,
  };
  const port = {
    async stat() {
      return file.entry;
    },
    async read() {
      return file;
    },
  } as unknown as FilesResidentFilePort;
  return new FilesToolRuntime(port, {
    installationGeneration: () => parseCanonicalNat64("1"),
    lockEpoch: () => parseCanonicalNat64("1"),
  });
}
