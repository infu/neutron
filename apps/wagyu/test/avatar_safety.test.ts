import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  confirmBrowserRasterDecode,
  confirmProfileAvatarSafety,
  inspectStaticRaster,
  validateProfileSemantics,
  type StructurallyCheckedProfileAvatarV1,
  type WagyuRasterBitmapDecoderV1,
} from "../src/verifier/index.ts";
import {
  sanitizeAvatarUpload,
  type AvatarCropV1,
  type AvatarRasterPlatformV1,
} from "../src/app/avatar_pipeline.ts";

const NODE = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const NETWORK = new Uint8Array(32).fill(7);
const STATIC_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

describe("bounded static raster inspection", () => {
  test("accepts a complete static PNG and rejects truncation or corrupt CRCs", () => {
    expect(inspectStaticRaster(STATIC_PNG, "png")).toEqual({
      mediaType: "png",
      width: 1,
      height: 1,
    });
    expect(() =>
      inspectStaticRaster(STATIC_PNG.slice(0, -1), "png")
    ).toThrow(/final|chunk/u);
    const corrupt = STATIC_PNG.slice();
    corrupt[29] = corrupt[29]! ^ 1;
    expect(() => inspectStaticRaster(corrupt, "png")).toThrow("corrupt");
  });

  test("rejects every APNG animation marker before raster decode", () => {
    for (const marker of ["acTL", "fcTL", "fdAT"]) {
      const animated = syntheticPng(8, 8, [
        pngChunk(marker, new Uint8Array(marker === "acTL" ? 8 : 4)),
      ]);
      expect(() => inspectStaticRaster(animated, "png")).toThrow(
        "Animated PNG",
      );
    }
  });

  test("rejects animated WebP and incomplete JPEG containers", () => {
    expect(() =>
      inspectStaticRaster(animatedWebp(), "webp")
    ).toThrow("Animated WebP");
    const jpeg = syntheticJpeg(20, 10);
    expect(inspectStaticRaster(jpeg, "jpeg")).toMatchObject({
      width: 20,
      height: 10,
    });
    expect(() => inspectStaticRaster(jpeg.slice(0, -2), "jpeg")).toThrow(
      "complete JPEG",
    );
  });
});

describe("remote avatar verification", () => {
  test("does not call a structurally checked avatar verified before decode", async () => {
    const structural = checkedProfileAvatar(STATIC_PNG);
    expect(structural.state).toBe("decode-required");

    await expect(confirmProfileAvatarSafety(structural, null)).resolves.toEqual(
      { state: "unsupported" },
    );

    let closed = false;
    const decoder: WagyuRasterBitmapDecoderV1 = async () => ({
      width: 1,
      height: 1,
      close() {
        closed = true;
      },
    });
    await expect(
      confirmProfileAvatarSafety(structural, decoder),
    ).resolves.toMatchObject({
      state: "verified",
      mediaType: "png",
      width: 1,
      height: 1,
    });
    expect(closed).toBe(true);
  });

  test("a present browser decoder rejection or dimension mismatch is fatal", async () => {
    const inspection = inspectStaticRaster(STATIC_PNG, "png");
    await expect(
      confirmBrowserRasterDecode(
        STATIC_PNG,
        inspection,
        async () => {
          throw new Error("decode failed");
        },
      ),
    ).rejects.toThrow("decodable static raster");

    let closed = false;
    await expect(
      confirmBrowserRasterDecode(
        STATIC_PNG,
        inspection,
        async () => ({
          width: 2,
          height: 1,
          close() {
            closed = true;
          },
        }),
      ),
    ).rejects.toThrow("dimensions");
    expect(closed).toBe(true);
  });

  test("known malformed avatars invalidate a profile while unknown tags stay isolated", () => {
    const base = baseProfile();
    expect(() =>
      validateProfileSemantics({
        ...base,
        avatar: [{
          media_type: [{ png: null }],
          width: 1,
          height: 1,
          bytes: STATIC_PNG.slice(0, -3),
        }],
      }, {
        networkId: NETWORK,
        node: NODE,
      })
    ).toThrow();

    expect(validateProfileSemantics({
      ...base,
      avatar: [{
        media_type: [],
        width: 1,
        height: 1,
        bytes: new Uint8Array(),
      }],
    }, {
      networkId: NETWORK,
      node: NODE,
    }).avatar.state).toBe("unsupported");
  });
});

describe("local avatar pixel-only upload pipeline", () => {
  test("center-crops and uploads only a bounded static re-encode", async () => {
    const metadata = new TextEncoder().encode("GPS=51.5007,-0.1246");
    const sourceBytes = syntheticPng(800, 400, [
      pngChunk("tEXt", metadata),
    ]);
    const file = new File([Uint8Array.from(sourceBytes)], "tracked-location.png", {
      type: "image/png",
    });
    const crops: AvatarCropV1[] = [];
    let decodeCalls = 0;
    let sourceClosed = false;
    let outputClosed = false;
    const platform: AvatarRasterPlatformV1 = {
      async decode() {
        decodeCalls += 1;
        const source = decodeCalls === 1;
        return {
          width: source ? 800 : crops.at(-1)!.outputSize,
          height: source ? 400 : crops.at(-1)!.outputSize,
          close() {
            if (source) sourceClosed = true;
            else outputClosed = true;
          },
        };
      },
      async encodeJpeg(_source, crop) {
        crops.push(crop);
        return new Blob(
          [Uint8Array.from(syntheticJpeg(crop.outputSize, crop.outputSize))],
          { type: "image/jpeg" },
        );
      },
    };

    const sanitized = await sanitizeAvatarUpload(file, platform);
    expect(sanitized).toMatchObject({
      mediaType: "jpeg",
      width: 400,
      height: 400,
    });
    expect(crops[0]).toMatchObject({
      sourceX: 200,
      sourceY: 0,
      sourceSize: 400,
      outputSize: 400,
    });
    expect(
      new TextDecoder().decode(sanitized.bytes).includes("GPS="),
    ).toBe(false);
    expect(sanitized.bytes).not.toEqual(sourceBytes);
    expect(sanitized.bytes.byteLength).toBeLessThanOrEqual(256 * 1_024);
    expect(sourceClosed).toBe(true);
    expect(outputClosed).toBe(true);
  });

  test("rejects animation and oversized decoded rasters before encoding", async () => {
    let decodeCalls = 0;
    let encodeCalls = 0;
    const platform: AvatarRasterPlatformV1 = {
      async decode() {
        decodeCalls += 1;
        return { width: 8, height: 8, close() {} };
      },
      async encodeJpeg() {
        encodeCalls += 1;
        return new Blob();
      },
    };
    const animation = new File(
      [Uint8Array.from(
        syntheticPng(8, 8, [pngChunk("acTL", new Uint8Array(8))]),
      )],
      "animated.png",
      { type: "image/png" },
    );
    await expect(sanitizeAvatarUpload(animation, platform)).rejects.toThrow(
      "Animated PNG",
    );
    expect(decodeCalls).toBe(0);
    expect(encodeCalls).toBe(0);

    const huge = new File(
      [Uint8Array.from(syntheticPng(4_097, 1))],
      "huge.png",
      { type: "image/png" },
    );
    await expect(sanitizeAvatarUpload(huge, platform)).rejects.toThrow(
      "bounded raster",
    );
    expect(decodeCalls).toBe(0);
  });
});

function checkedProfileAvatar(
  bytes: Uint8Array,
): StructurallyCheckedProfileAvatarV1 {
  return validateProfileSemantics({
    ...baseProfile(),
    avatar: [{
      media_type: [{ png: null }],
      width: 1,
      height: 1,
      bytes,
    }],
  }, {
    networkId: NETWORK,
    node: NODE,
  }).avatar;
}

function baseProfile() {
  return {
    network_id: NETWORK,
    node: Principal.fromText(NODE),
    profile_generation: 1n,
    revision: 0n,
    updated_at_ns: 4n,
    previous_profile_digest: [],
    display_name: "Alice",
    description: "",
    capabilities: [],
    avatar: [],
  };
}

function syntheticPng(
  width: number,
  height: number,
  extraChunks: readonly Uint8Array[] = [],
): Uint8Array {
  const header = new Uint8Array(13);
  writeU32be(header, 0, width);
  writeU32be(header, 4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return concat(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk("IHDR", header),
    ...extraChunks,
    pngChunk("IDAT", Uint8Array.of(0)),
    pngChunk("IEND", new Uint8Array()),
  );
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  writeU32be(chunk, 0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeU32be(
    chunk,
    8 + data.byteLength,
    crc32(chunk, 4, 8 + data.byteLength),
  );
  return chunk;
}

function syntheticJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    8,
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    1,
    0xff,
    0xda,
    0,
    2,
    0xff,
    0xd9,
  );
}

function animatedWebp(): Uint8Array {
  const vp8x = new Uint8Array(18);
  new TextEncoder().encodeInto("VP8X", vp8x);
  writeU32le(vp8x, 4, 10);
  vp8x[8] = 0x02;
  const body = concat(
    new TextEncoder().encode("WEBP"),
    vp8x,
  );
  const riff = new Uint8Array(8 + body.byteLength);
  riff.set(new TextEncoder().encode("RIFF"), 0);
  writeU32le(riff, 4, body.byteLength);
  riff.set(body, 8);
  return riff;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeU32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
