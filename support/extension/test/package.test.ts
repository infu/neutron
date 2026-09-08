import { expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { zip } from "../scripts/zip";

test("extension ZIP preserves file bytes, CRC32, deterministic order and source paths", () => {
  const entries = [
    { path: "source/support/extension/LICENSE", content: new TextEncoder().encode("source license\n") },
    { path: "manifest.json", content: new TextEncoder().encode('{"manifest_version":3}') },
  ];
  const archive = Buffer.from(zip(entries));
  expect(archive).toEqual(Buffer.from(zip([...entries].reverse())));
  let offset = 0;
  const files = new Map<string, Uint8Array>();
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedLength = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const bodyStart = offset + 30 + nameLength;
    const bytes = inflateRawSync(archive.subarray(bodyStart, bodyStart + compressedLength));
    expect(Bun.hash.crc32(bytes)).toBe(archive.readUInt32LE(offset + 14));
    expect(bytes.length).toBe(archive.readUInt32LE(offset + 22));
    files.set(name, bytes);
    offset = bodyStart + compressedLength;
  }
  for (const entry of entries) expect(files.get(entry.path)).toEqual(Buffer.from(entry.content));
  expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
  expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
});

test("extension ZIP rejects parent and absolute paths", () => {
  for (const filename of ["../outside", "/absolute", "source/../outside", "source\\escape"]) expect(() => zip([{ path: filename, content: new Uint8Array() }])).toThrow("Invalid ZIP path");
});
