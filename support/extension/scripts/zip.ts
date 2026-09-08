import { deflateRawSync } from "node:zlib";

export interface ZipEntry { path: string; content: Uint8Array }

/** Deterministic ordinary ZIP, with no tool or package dependency beyond Bun. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const records: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some(part => part === ".." || part === ".")) throw new Error(`Invalid ZIP path: ${entry.path}`);
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.content, { level: 9 });
    const crc = Bun.hash.crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names.
    local.writeUInt16LE(8, 8); // Raw DEFLATE.
    local.writeUInt16LE(0x0021, 12); // January 1, 1980; deterministic DOS date.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    records.push(local, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directory, end]);
}
