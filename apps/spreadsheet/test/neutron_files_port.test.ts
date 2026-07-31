import { describe, expect, test } from "bun:test";
import type { JsonObject } from "neutron-tools/app";
import { FilePortError } from "../src/file_ports.ts";
import { NeutronFilesPort } from "../src/neutron_files_port.ts";

type AttachmentCaller = NonNullable<ConstructorParameters<typeof NeutronFilesPort>[0]>;
type AttachmentResult = Awaited<ReturnType<AttachmentCaller>>;

const CSV_MEDIA_TYPE = "text/csv";
const NATIVE_MEDIA_TYPE = "application/vnd.neutron.spreadsheet+json";

describe("NeutronFilesPort read integrity", () => {
  test("accepts a response bound to the requested path, version, metadata, and bytes", async () => {
    const data = arrayBuffer("name,total\nAda,42\n");
    const etag = await sha256Hex(data);
    let called = false;
    const port = portReturning(readResult("/report.csv", CSV_MEDIA_TYPE, data, etag), (...args) => {
      called = true;
      const [call, attachments, options] = args;
      expect(call).toEqual({
        target: "app:files:background",
        name: "readBinary",
        arguments: { path: "/report.csv", ifMatch: etag },
      });
      expect(attachments).toEqual([]);
      expect(options).toEqual({ delegationToken: "delegated-read" });
    });

    const result = await port.readBinary("/report.csv", {
      ifMatch: etag,
      delegationToken: "delegated-read",
    });

    expect(called).toBe(true);
    expect(result).toMatchObject({
      path: "/report.csv",
      mediaType: CSV_MEDIA_TYPE,
      byteLength: data.byteLength,
      etag,
      updatedAt: 123,
    });
    expect([...new Uint8Array(result.data)]).toEqual([...new Uint8Array(data)]);
    expect(result.data).not.toBe(data);
  });

  test("rejects a forged response path", async () => {
    const data = arrayBuffer("path");
    const etag = await sha256Hex(data);
    const result = readResult("/other.csv", CSV_MEDIA_TYPE, data, etag);

    await expectInvalid(portReturning(result).readBinary("/report.csv"));
  });

  test("rejects an attachment media type that disagrees with metadata", async () => {
    const data = arrayBuffer("mime");
    const etag = await sha256Hex(data);
    const result = readResult("/report.csv", CSV_MEDIA_TYPE, data, etag);
    result.attachments[0]!.mediaType = NATIVE_MEDIA_TYPE;

    await expectInvalid(portReturning(result).readBinary("/report.csv"));
  });

  test("rejects forged attachment and metadata lengths", async () => {
    const data = arrayBuffer("length");
    const etag = await sha256Hex(data);
    const result = readResult("/report.csv", CSV_MEDIA_TYPE, data, etag);
    result.value = metadata("/report.csv", CSV_MEDIA_TYPE, data.byteLength + 1, etag);

    await expectInvalid(portReturning(result).readBinary("/report.csv"));
  });

  test("rejects bytes that do not match the claimed SHA-256 etag", async () => {
    const data = arrayBuffer("actual bytes");
    const forgedEtag = await sha256Hex(arrayBuffer("different bytes"));

    await expectInvalid(
      portReturning(readResult("/report.csv", CSV_MEDIA_TYPE, data, forgedEtag))
        .readBinary("/report.csv"),
    );
  });

  test("rejects a non-lowercase SHA-256 etag", async () => {
    const data = arrayBuffer("etag case");
    const uppercaseEtag = (await sha256Hex(data)).toUpperCase();

    await expectInvalid(
      portReturning(readResult("/report.csv", CSV_MEDIA_TYPE, data, uppercaseEtag))
        .readBinary("/report.csv"),
    );
  });
});

describe("NeutronFilesPort write integrity", () => {
  test("sends and accepts only the requested path, media type, length, and byte hash", async () => {
    const data = arrayBuffer("native workbook bytes");
    const etag = await sha256Hex(data);
    let called = false;
    const port = portReturning({
      value: metadata("/book.nsheet", NATIVE_MEDIA_TYPE, data.byteLength, etag),
      attachments: [],
    }, (...args) => {
      called = true;
      const [call, attachments, options] = args;
      expect(call).toEqual({
        target: "app:files:background",
        name: "writeBinary",
        arguments: {
          path: "/book.nsheet",
          mediaType: NATIVE_MEDIA_TYPE,
          createParents: true,
          ifNoneMatch: "*",
        },
      });
      expect(options).toEqual({ delegationToken: "delegated-write" });
      expect(attachments).toHaveLength(1);
      const attachment = attachments![0]!;
      expect(attachment).toMatchObject({
        name: "file",
        mediaType: NATIVE_MEDIA_TYPE,
        byteLength: data.byteLength,
      });
      expect([...new Uint8Array(attachment.data)]).toEqual([...new Uint8Array(data)]);
      expect(attachment.data).not.toBe(data);
      // The real attachment bus transfers this buffer and detaches it before
      // the Files response arrives. Response validation must use pre-transfer
      // expectations rather than consulting the detached payload.
      structuredClone(attachment.data, { transfer: [attachment.data] });
      expect(attachment.data.byteLength).toBe(0);
    });

    const result = await port.writeBinary(
      "/book.nsheet",
      NATIVE_MEDIA_TYPE,
      data,
      { ifNoneMatch: "*" },
      { delegationToken: "delegated-write" },
    );

    expect(called).toBe(true);
    expect(result).toMatchObject({
      path: "/book.nsheet",
      mediaType: NATIVE_MEDIA_TYPE,
      byteLength: data.byteLength,
      etag,
    });
  });

  test("rejects a forged write path", async () => {
    const fixture = await writeFixture({ path: "/other.nsheet" });
    await expectInvalid(fixture.port.writeBinary(
      "/book.nsheet",
      NATIVE_MEDIA_TYPE,
      fixture.data,
      { ifNoneMatch: "*" },
    ));
  });

  test("rejects a forged write media type", async () => {
    const fixture = await writeFixture({ mediaType: CSV_MEDIA_TYPE });
    await expectInvalid(fixture.port.writeBinary(
      "/book.nsheet",
      NATIVE_MEDIA_TYPE,
      fixture.data,
      { ifNoneMatch: "*" },
    ));
  });

  test("rejects a forged write byte length", async () => {
    const fixture = await writeFixture({ byteLengthDelta: 1 });
    await expectInvalid(fixture.port.writeBinary(
      "/book.nsheet",
      NATIVE_MEDIA_TYPE,
      fixture.data,
      { ifNoneMatch: "*" },
    ));
  });

  test("rejects a forged write hash", async () => {
    const fixture = await writeFixture({
      etag: await sha256Hex(arrayBuffer("not the written bytes")),
    });
    await expectInvalid(fixture.port.writeBinary(
      "/book.nsheet",
      NATIVE_MEDIA_TYPE,
      fixture.data,
      { ifNoneMatch: "*" },
    ));
  });
});

function portReturning(
  result: AttachmentResult,
  inspect?: (...args: Parameters<AttachmentCaller>) => void,
): NeutronFilesPort {
  const caller: AttachmentCaller = async (...args) => {
    inspect?.(...args);
    return result;
  };
  return new NeutronFilesPort(caller);
}

function readResult(
  path: string,
  mediaType: string,
  data: ArrayBuffer,
  etag: string,
): AttachmentResult {
  return {
    value: metadata(path, mediaType, data.byteLength, etag),
    attachments: [{
      name: "file",
      mediaType,
      byteLength: data.byteLength,
      data,
    }],
  };
}

function metadata(
  path: string,
  mediaType: string,
  byteLength: number,
  etag: string,
): JsonObject {
  return {
    path,
    mediaType,
    size: byteLength,
    byteLength,
    etag,
    etagSha256: etag,
    updatedAt: 123,
  };
}

async function writeFixture(overrides: {
  path?: string;
  mediaType?: string;
  byteLengthDelta?: number;
  etag?: string;
}): Promise<{ data: ArrayBuffer; port: NeutronFilesPort }> {
  const data = arrayBuffer("write fixture");
  const byteLength = data.byteLength + (overrides.byteLengthDelta ?? 0);
  const etag = overrides.etag ?? await sha256Hex(data);
  return {
    data,
    port: portReturning({
      value: metadata(
        overrides.path ?? "/book.nsheet",
        overrides.mediaType ?? NATIVE_MEDIA_TYPE,
        byteLength,
        etag,
      ),
      attachments: [],
    }),
  };
}

async function expectInvalid(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: "FilePortError",
    code: "FILES_INVALID_RESPONSE",
  });
  await operation.catch((error: unknown) => {
    expect(error).toBeInstanceOf(FilePortError);
  });
}

function arrayBuffer(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
