export type WagyuRasterMediaTypeV1 = "jpeg" | "png" | "webp";

export interface WagyuRasterInspectionV1 {
  readonly mediaType: WagyuRasterMediaTypeV1;
  readonly width: number;
  readonly height: number;
}

export interface WagyuRasterInspectionLimitsV1 {
  readonly maximumBytes: number;
  readonly maximumDimension: number;
  readonly maximumPixels: number;
}

export interface WagyuDecodedRasterV1 {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export type WagyuRasterBitmapDecoderV1 = (
  blob: Blob,
  options: ImageBitmapOptions,
) => Promise<WagyuDecodedRasterV1>;

const PROFILE_RASTER_LIMITS: WagyuRasterInspectionLimitsV1 = Object.freeze({
  maximumBytes: 256 * 1_024,
  maximumDimension: 1_024,
  maximumPixels: 1_024 * 1_024,
});

/**
 * Performs bounded container validation before a browser decoder sees the
 * bytes. This is deliberately stricter than format sniffing: complete PNG and
 * WebP framing is required, PNG CRCs are checked, and every animation marker
 * is rejected.
 */
export function inspectStaticRaster(
  bytes: Uint8Array,
  mediaType: WagyuRasterMediaTypeV1,
  limits: WagyuRasterInspectionLimitsV1 = PROFILE_RASTER_LIMITS,
): WagyuRasterInspectionV1 {
  assertInspectionLimits(limits);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > limits.maximumBytes
  ) {
    throw new Error(
      `Avatar must be between 1 and ${limits.maximumBytes} bytes`,
    );
  }

  const dimensions = mediaType === "png"
    ? inspectPng(bytes)
    : mediaType === "jpeg"
      ? inspectJpeg(bytes)
      : inspectWebp(bytes);
  assertDimensions(dimensions.width, dimensions.height, limits);
  return { mediaType, ...dimensions };
}

/**
 * Requires a genuine browser raster decode after container validation.
 *
 * `unavailable` is distinct from a decode rejection: an older runtime without
 * createImageBitmap may retain the certified profile text but must not expose
 * the avatar as verified. A present decoder that rejects the bytes makes the
 * profile avatar invalid.
 */
export async function confirmBrowserRasterDecode(
  bytes: Uint8Array,
  inspection: WagyuRasterInspectionV1,
  decoder: WagyuRasterBitmapDecoderV1 | null = browserRasterBitmapDecoder(),
): Promise<"decoded" | "unavailable"> {
  if (decoder === null) return "unavailable";
  const blob = new Blob([Uint8Array.from(bytes)], {
    type: mimeType(inspection.mediaType),
  });
  let decoded: WagyuDecodedRasterV1;
  try {
    decoded = await decoder(blob, { imageOrientation: "none" });
  } catch {
    throw new Error("Avatar bytes are not a decodable static raster image");
  }
  try {
    if (
      !Number.isInteger(decoded.width) ||
      !Number.isInteger(decoded.height) ||
      decoded.width !== inspection.width ||
      decoded.height !== inspection.height
    ) {
      throw new Error(
        "Browser-decoded avatar dimensions do not match its raster container",
      );
    }
  } finally {
    decoded.close();
  }
  return "decoded";
}

export function browserRasterBitmapDecoder():
  | WagyuRasterBitmapDecoderV1
  | null {
  if (typeof globalThis.createImageBitmap !== "function") return null;
  return (blob, options) => globalThis.createImageBitmap(blob, options);
}

export function wagyuRasterMimeType(
  mediaType: WagyuRasterMediaTypeV1,
): string {
  return mimeType(mediaType);
}

function inspectPng(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  if (
    bytes.byteLength < 45 ||
    !matches(bytes, 0, signature)
  ) {
    throw new Error("Avatar is not a complete PNG");
  }

  let offset = signature.byteLength;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let sawImageData = false;
  let imageDataEnded = false;

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      throw new Error("PNG avatar has a truncated chunk");
    }
    const length = readU32be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const chunkEnd = crcOffset + 4;
    if (chunkEnd > bytes.byteLength) {
      throw new Error("PNG avatar chunk exceeds the bounded body");
    }
    const type = ascii(bytes, typeOffset, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new Error("PNG avatar contains an invalid chunk type");
    }
    const expectedCrc = readU32be(bytes, crcOffset);
    const actualCrc = crc32(bytes, typeOffset, crcOffset);
    if (expectedCrc !== actualCrc) {
      throw new Error("PNG avatar contains a corrupt chunk");
    }

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("PNG avatar must begin with one IHDR chunk");
      }
      width = readU32be(bytes, dataOffset);
      height = readU32be(bytes, dataOffset + 4);
      assertPngHeader(bytes, dataOffset);
    } else if (type === "IHDR") {
      throw new Error("PNG avatar contains multiple IHDR chunks");
    }

    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("Animated PNG avatars are forbidden");
    }
    if (type === "IDAT") {
      if (imageDataEnded) {
        throw new Error("PNG avatar has non-contiguous image data");
      }
      sawImageData = true;
    } else if (sawImageData) {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (
        length !== 0 ||
        !sawImageData ||
        chunkEnd !== bytes.byteLength
      ) {
        throw new Error("PNG avatar has an invalid final chunk");
      }
      return { width, height };
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }
  throw new Error("PNG avatar is missing its final chunk");
}

function assertPngHeader(bytes: Uint8Array, dataOffset: number): void {
  const bitDepth = bytes[dataOffset + 8]!;
  const colorType = bytes[dataOffset + 9]!;
  const compression = bytes[dataOffset + 10]!;
  const filter = bytes[dataOffset + 11]!;
  const interlace = bytes[dataOffset + 12]!;
  const allowedDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !(colorType in allowedDepths) ||
    !allowedDepths[colorType]!.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    throw new Error("PNG avatar has an invalid IHDR payload");
  }
}

function inspectJpeg(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  if (
    bytes.byteLength < 10 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.byteLength - 2] !== 0xff ||
    bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new Error("Avatar is not a complete JPEG");
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) {
      throw new Error("JPEG avatar has invalid marker framing");
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength - 2) {
      throw new Error("JPEG avatar has a truncated marker");
    }
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00) {
      throw new Error("JPEG avatar has an unexpected marker");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.byteLength - 2) {
      throw new Error("JPEG avatar has a truncated segment");
    }
    const length = readU16be(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength - 2) {
      throw new Error("JPEG avatar segment exceeds the bounded body");
    }
    if (isJpegStartOfFrame(marker)) {
      if (length < 8) {
        throw new Error("JPEG avatar has a malformed frame header");
      }
      dimensions = {
        height: readU16be(bytes, offset + 3),
        width: readU16be(bytes, offset + 5),
      };
    }
    if (marker === 0xda) {
      if (dimensions === null) {
        throw new Error("JPEG avatar scan precedes its frame dimensions");
      }
      // Entropy coding is intentionally delegated to the browser decoder.
      // Requiring the final EOI above still rejects a truncated byte stream.
      return dimensions;
    }
    offset += length;
  }
  throw new Error("JPEG avatar has no decodable image scan");
}

function inspectWebp(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  if (
    bytes.byteLength < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    readU32le(bytes, 4) + 8 !== bytes.byteLength
  ) {
    throw new Error("Avatar is not a complete WebP container");
  }

  let offset = 12;
  let chunkIndex = 0;
  let containerDimensions:
    | { readonly width: number; readonly height: number }
    | null = null;
  let imageDimensions:
    | { readonly width: number; readonly height: number }
    | null = null;

  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error("WebP avatar has a truncated chunk");
    }
    const kind = ascii(bytes, offset, 4);
    const size = readU32le(bytes, offset + 4);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size & 1);
    if (paddedEnd > bytes.byteLength) {
      throw new Error("WebP avatar chunk exceeds the bounded body");
    }
    if ((size & 1) !== 0 && bytes[end] !== 0) {
      throw new Error("WebP avatar has non-zero chunk padding");
    }
    if (kind === "ANIM" || kind === "ANMF") {
      throw new Error("Animated WebP avatars are forbidden");
    }
    if (kind === "VP8X") {
      if (
        chunkIndex !== 0 ||
        containerDimensions !== null ||
        size !== 10
      ) {
        throw new Error("WebP avatar has a malformed extended header");
      }
      const flags = bytes[start]!;
      if ((flags & 0x02) !== 0) {
        throw new Error("Animated WebP avatars are forbidden");
      }
      if ((flags & 0xc1) !== 0) {
        throw new Error("WebP avatar has reserved feature bits");
      }
      containerDimensions = {
        width: readU24le(bytes, start + 4) + 1,
        height: readU24le(bytes, start + 7) + 1,
      };
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (imageDimensions !== null) {
        throw new Error("WebP avatar contains multiple image payloads");
      }
      imageDimensions = kind === "VP8 "
        ? inspectVp8(bytes, start, size)
        : inspectVp8l(bytes, start, size);
    }

    offset = paddedEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.byteLength || imageDimensions === null) {
    throw new Error("WebP avatar has no complete image payload");
  }
  if (
    containerDimensions !== null &&
    (
      containerDimensions.width !== imageDimensions.width ||
      containerDimensions.height !== imageDimensions.height
    )
  ) {
    throw new Error("WebP avatar container dimensions do not match its image");
  }
  return imageDimensions;
}

function inspectVp8(
  bytes: Uint8Array,
  start: number,
  size: number,
): { readonly width: number; readonly height: number } {
  if (
    size < 10 ||
    bytes[start + 3] !== 0x9d ||
    bytes[start + 4] !== 0x01 ||
    bytes[start + 5] !== 0x2a
  ) {
    throw new Error("WebP avatar has a malformed VP8 image");
  }
  return {
    width: readU16le(bytes, start + 6) & 0x3fff,
    height: readU16le(bytes, start + 8) & 0x3fff,
  };
}

function inspectVp8l(
  bytes: Uint8Array,
  start: number,
  size: number,
): { readonly width: number; readonly height: number } {
  if (size < 5 || bytes[start] !== 0x2f) {
    throw new Error("WebP avatar has a malformed VP8L image");
  }
  const packed = readU32le(bytes, start + 1);
  if ((packed & 0xe000_0000) !== 0) {
    throw new Error("WebP avatar has an invalid VP8L version");
  }
  return {
    width: (packed & 0x3fff) + 1,
    height: ((packed >>> 14) & 0x3fff) + 1,
  };
}

function assertInspectionLimits(
  limits: WagyuRasterInspectionLimitsV1,
): void {
  if (
    !Number.isSafeInteger(limits.maximumBytes) ||
    !Number.isSafeInteger(limits.maximumDimension) ||
    !Number.isSafeInteger(limits.maximumPixels) ||
    limits.maximumBytes < 1 ||
    limits.maximumDimension < 1 ||
    limits.maximumPixels < 1
  ) {
    throw new Error("Raster inspection limits are invalid");
  }
}

function assertDimensions(
  width: number,
  height: number,
  limits: WagyuRasterInspectionLimitsV1,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > limits.maximumDimension ||
    height > limits.maximumDimension ||
    BigInt(width) * BigInt(height) > BigInt(limits.maximumPixels)
  ) {
    throw new Error("Avatar dimensions exceed the bounded raster limits");
  }
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
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

function matches(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): boolean {
  if (offset + expected.byteLength > bytes.byteLength) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string {
  if (offset + length > bytes.byteLength) return "";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

function readU16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU24le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16)
  );
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1_00_00_00 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  ) >>> 0;
}

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x1_00_00 +
    bytes[offset + 3]! * 0x1_00_00_00
  ) >>> 0;
}

function mimeType(mediaType: WagyuRasterMediaTypeV1): string {
  return mediaType === "jpeg" ? "image/jpeg" : `image/${mediaType}`;
}
