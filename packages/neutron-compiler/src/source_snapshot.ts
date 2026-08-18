import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS,
  type NeutronPackageRecordV1,
} from "neutron-tools/src/package_record.js";
import { assertAppVersion } from "neutron-tools/src/version.js";
import { assertSafeArchivePath } from "./package_decoder.ts";

const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

export type DecodedNeutronAppSourceFile = Readonly<{
  path: string;
  mode: 0o644 | 0o755;
  content: Uint8Array;
}>;

export type DecodedNeutronAppSourceSnapshotV1 = Readonly<{
  format: 1;
  package: Readonly<{ id: string; version: number }>;
  files: readonly DecodedNeutronAppSourceFile[];
}>;

/**
 * Decode only the closed source-snapshot shape emitted by neutron-scripts.
 * No general-purpose MessagePack object is materialized before bounds and
 * collection sizes are checked.
 */
export function decodeNeutronAppSourceSnapshot(
  input: Uint8Array,
  expected: Readonly<{ id: string; version: number }>,
): DecodedNeutronAppSourceSnapshotV1 {
  if (!(input instanceof Uint8Array)) {
    throw new Error("Complete App Source snapshot must be bytes");
  }
  if (
    input.byteLength < 1 ||
    input.byteLength > NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes
  ) {
    throw new Error(
      `Complete App Source snapshot must be 1-${NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes} bytes`,
    );
  }
  const reader = new SourceSnapshotMessagePackReader(input);
  reader.expectMapLength(3, "source snapshot");
  reader.expectKey("format", "source snapshot");
  const format = reader.readUnsigned("source snapshot format");
  if (format !== 1) throw new Error("Complete App Source format must be 1");

  reader.expectKey("package", "source snapshot");
  reader.expectMapLength(2, "source snapshot package");
  reader.expectKey("id", "source snapshot package");
  const id = reader.readString(128, "source snapshot package id");
  if (!isValidAppId(id)) {
    throw new Error("Complete App Source package id is invalid");
  }
  reader.expectKey("version", "source snapshot package");
  const version = reader.readUnsigned("source snapshot package version");
  assertAppVersion(version, "Complete App Source package version");
  if (id !== expected.id || version !== expected.version) {
    throw new Error(
      `Complete App Source package ${id} v${version} does not match ${expected.id} v${expected.version}`,
    );
  }

  reader.expectKey("files", "source snapshot");
  const fileCount = reader.readArrayLength("source snapshot files");
  if (
    fileCount < 1 ||
    fileCount > NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.files
  ) {
    throw new Error(
      `Complete App Source must contain 1-${NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.files} files`,
    );
  }

  const files: DecodedNeutronAppSourceFile[] = [];
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (let index = 0; index < fileCount; index += 1) {
    const label = `source snapshot files[${index}]`;
    reader.expectMapLength(3, label);
    reader.expectKey("path", label);
    const sourcePath = reader.readString(
      NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.pathBytes,
      `${label}.path`,
    );
    assertSafeArchivePath(
      sourcePath,
      NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.pathBytes,
    );
    if (
      previousPath !== undefined &&
      compareCanonicalText(previousPath, sourcePath) >= 0
    ) {
      throw new Error(
        "Complete App Source paths must be unique and canonically ordered",
      );
    }
    previousPath = sourcePath;

    reader.expectKey("mode", label);
    const mode = reader.readUnsigned(`${label}.mode`);
    if (mode !== 0o644 && mode !== 0o755) {
      throw new Error(`Complete App Source file ${sourcePath} has invalid mode`);
    }

    reader.expectKey("content", label);
    const content = reader.readBinary(
      NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.fileBytes,
      `${label}.content`,
    );
    totalBytes = checkedAdd(totalBytes, content.byteLength, "source file bytes");
    if (totalBytes > NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.totalFileBytes) {
      throw new Error(
        `Complete App Source exceeds ${NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.totalFileBytes} file bytes`,
      );
    }
    files.push(Object.freeze({ path: sourcePath, mode, content }));
  }
  reader.assertFinished();
  return Object.freeze({
    format: 1 as const,
    package: Object.freeze({ id, version }),
    files: Object.freeze(files),
  });
}

/** Verify every declared important build input against the decoded source. */
export function assertNeutronAppSourceBuildInputs(
  snapshot: DecodedNeutronAppSourceSnapshotV1,
  inputs: NeutronPackageRecordV1["build"]["inputs"],
): void {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const input of inputs) {
    const file = files.get(input.path);
    if (file === undefined) {
      throw new Error(
        `Complete App Source is missing declared build input ${input.path}`,
      );
    }
    if (file.content.byteLength !== input.bytes) {
      throw new Error(
        `Complete App Source build input ${input.path} has ${file.content.byteLength} bytes; expected ${input.bytes}`,
      );
    }
    if (hashContent(file.content) !== input.sha256) {
      throw new Error(
        `Complete App Source build input ${input.path} SHA-256 does not match its package record`,
      );
    }
  }
}

class SourceSnapshotMessagePackReader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  expectMapLength(expected: number, label: string): void {
    const actual = this.readMapLength(label);
    if (actual !== expected) {
      throw new Error(`${label} must contain exactly ${expected} fields`);
    }
  }

  expectKey(expected: string, label: string): void {
    const actual = this.readString(64, `${label} field`);
    if (actual !== expected) {
      throw new Error(
        `${label} fields are not in the canonical closed order; expected ${expected}`,
      );
    }
  }

  readArrayLength(label: string): number {
    const type = this.readUint8();
    if (type >= 0x90 && type <= 0x9f) return type - 0x90;
    if (type === 0xdc) return this.readUint16();
    if (type === 0xdd) return this.readUint32();
    throw new Error(`${label} must be a MessagePack array`);
  }

  readString(maximumBytes: number, label: string): string {
    const type = this.readUint8();
    let length: number;
    if (type >= 0xa0 && type <= 0xbf) length = type - 0xa0;
    else if (type === 0xd9) length = this.readUint8();
    else if (type === 0xda) length = this.readUint16();
    else if (type === 0xdb) length = this.readUint32();
    else throw new Error(`${label} must be a MessagePack string`);
    if (length > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
    }
    const encoded = this.readSlice(length, label);
    try {
      return fatalTextDecoder.decode(encoded);
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
  }

  readBinary(maximumBytes: number, label: string): Uint8Array {
    const type = this.readUint8();
    let length: number;
    if (type === 0xc4) length = this.readUint8();
    else if (type === 0xc5) length = this.readUint16();
    else if (type === 0xc6) length = this.readUint32();
    else throw new Error(`${label} must be MessagePack binary bytes`);
    if (length > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    }
    return this.readSlice(length, label);
  }

  readUnsigned(label: string): number {
    const type = this.readUint8();
    if (type <= 0x7f) return type;
    if (type === 0xcc) return this.readUint8();
    if (type === 0xcd) return this.readUint16();
    if (type === 0xce) return this.readUint32();
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }

  assertFinished(): void {
    if (this.offset !== this.input.byteLength) {
      throw new Error("Complete App Source snapshot has trailing bytes");
    }
  }

  private readMapLength(label: string): number {
    const type = this.readUint8();
    if (type >= 0x80 && type <= 0x8f) return type - 0x80;
    if (type === 0xde) return this.readUint16();
    if (type === 0xdf) return this.readUint32();
    throw new Error(`${label} must be a MessagePack map`);
  }

  private readUint8(): number {
    if (this.offset >= this.input.byteLength) this.unexpectedEnd();
    return this.input[this.offset++]!;
  }

  private readUint16(): number {
    return this.readUint8() * 0x100 + this.readUint8();
  }

  private readUint32(): number {
    return (
      this.readUint8() * 0x1_000000 +
      this.readUint8() * 0x1_0000 +
      this.readUint8() * 0x100 +
      this.readUint8()
    );
  }

  private readSlice(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`${label} has an invalid length`);
    }
    const end = checkedAdd(this.offset, length, `${label} end offset`);
    if (end > this.input.byteLength) this.unexpectedEnd();
    const bytes = this.input.subarray(this.offset, end);
    this.offset = end;
    return bytes;
  }

  private unexpectedEnd(): never {
    throw new Error("Complete App Source snapshot ended unexpectedly");
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${label}`);
  return result;
}
