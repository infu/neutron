import {
  browserRasterBitmapDecoder,
  inspectStaticRaster,
  type WagyuDecodedRasterV1,
  type WagyuRasterBitmapDecoderV1,
  type WagyuRasterMediaTypeV1,
} from "../verifier/raster.ts";

const MAX_AVATAR_BYTES = 256 * 1_024;
const MAX_AVATAR_DIMENSION = 1_024;
const MAX_SOURCE_DIMENSION = 4_096;
const MAX_SOURCE_PIXELS = 16 * 1_024 * 1_024;

const SOURCE_LIMITS = Object.freeze({
  maximumBytes: MAX_AVATAR_BYTES,
  maximumDimension: MAX_SOURCE_DIMENSION,
  maximumPixels: MAX_SOURCE_PIXELS,
});

export interface SanitizedAvatarV1 {
  readonly mediaType: "jpeg";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

export interface AvatarCropV1 {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceSize: number;
  readonly outputSize: number;
  readonly quality: number;
}

export interface AvatarRasterPlatformV1 {
  decode: WagyuRasterBitmapDecoderV1;
  encodeJpeg(
    source: WagyuDecodedRasterV1,
    crop: AvatarCropV1,
  ): Promise<Blob>;
}

type AvatarUploadSourceV1 =
  Pick<Blob, "arrayBuffer" | "size" | "type">;

/**
 * Converts an untrusted local file into a single static square JPEG.
 *
 * Only decoded pixels cross the owner-call boundary. EXIF/GPS, comments,
 * profiles, animation chunks, and every other source-container field are
 * discarded by the canvas encode.
 */
export async function sanitizeAvatarUpload(
  file: AvatarUploadSourceV1,
  platform: AvatarRasterPlatformV1 | null = browserAvatarRasterPlatform(),
): Promise<SanitizedAvatarV1> {
  const sourceMediaType = mediaTypeFromMime(file.type);
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_AVATAR_BYTES
  ) {
    throw new Error("Avatar must be between 1 byte and 256 KiB");
  }
  if (platform === null) {
    throw new Error("This browser cannot safely decode and re-encode avatars");
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  if (sourceBytes.byteLength !== file.size) {
    throw new Error("Avatar changed while it was being read");
  }
  inspectStaticRaster(sourceBytes, sourceMediaType, SOURCE_LIMITS);

  let source: WagyuDecodedRasterV1;
  try {
    source = await platform.decode(
      new Blob([sourceBytes], { type: file.type }),
      { imageOrientation: "from-image" },
    );
  } catch {
    throw new Error("Avatar bytes are not a decodable static raster image");
  }
  try {
    assertDecodedSourceDimensions(source.width, source.height);
    const sourceSize = Math.min(source.width, source.height);
    const sourceX = (source.width - sourceSize) / 2;
    const sourceY = (source.height - sourceSize) / 2;
    let outputSize = Math.min(sourceSize, MAX_AVATAR_DIMENSION);

    while (outputSize >= 1) {
      for (const quality of outputSize === MAX_AVATAR_DIMENSION
        ? [0.9, 0.72, 0.55]
        : [0.82, 0.6]) {
        const encoded = await platform.encodeJpeg(source, {
          sourceX,
          sourceY,
          sourceSize,
          outputSize,
          quality,
        });
        if (
          encoded.type.toLowerCase() !== "image/jpeg" ||
          encoded.size < 1
        ) {
          throw new Error("The browser did not provide a static JPEG encoder");
        }
        if (encoded.size > MAX_AVATAR_BYTES) continue;

        const bytes = new Uint8Array(await encoded.arrayBuffer());
        if (bytes.byteLength !== encoded.size) {
          throw new Error("Encoded avatar changed while it was being read");
        }
        const inspection = inspectStaticRaster(bytes, "jpeg");
        if (
          inspection.width !== outputSize ||
          inspection.height !== outputSize
        ) {
          throw new Error("Encoded avatar dimensions changed unexpectedly");
        }
        await confirmEncodedPixels(platform.decode, encoded, outputSize);
        return {
          mediaType: "jpeg",
          width: outputSize,
          height: outputSize,
          bytes,
        };
      }
      if (outputSize === 1) break;
      outputSize = Math.max(1, Math.floor(outputSize / 2));
    }
  } finally {
    source.close();
  }
  throw new Error("Avatar could not be encoded within the 256 KiB limit");
}

export function browserAvatarRasterPlatform(): AvatarRasterPlatformV1 | null {
  const decode = browserRasterBitmapDecoder();
  if (decode === null) return null;
  return {
    decode,
    encodeJpeg: encodeJpegWithBrowserCanvas,
  };
}

async function confirmEncodedPixels(
  decode: WagyuRasterBitmapDecoderV1,
  encoded: Blob,
  expectedSize: number,
): Promise<void> {
  let checked: WagyuDecodedRasterV1;
  try {
    checked = await decode(encoded, { imageOrientation: "none" });
  } catch {
    throw new Error("The re-encoded avatar is not browser-decodable");
  }
  try {
    if (
      checked.width !== expectedSize ||
      checked.height !== expectedSize
    ) {
      throw new Error("The re-encoded avatar decoded at unexpected dimensions");
    }
  } finally {
    checked.close();
  }
}

async function encodeJpegWithBrowserCanvas(
  source: WagyuDecodedRasterV1,
  crop: AvatarCropV1,
): Promise<Blob> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(crop.outputSize, crop.outputSize);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Avatar canvas is unavailable");
    drawSquare(context, source, crop);
    return canvas.convertToBlob({
      type: "image/jpeg",
      quality: crop.quality,
    });
  }
  if (typeof document === "undefined") {
    throw new Error("Avatar canvas encoder is unavailable");
  }
  const canvas = document.createElement("canvas");
  canvas.width = crop.outputSize;
  canvas.height = crop.outputSize;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Avatar canvas is unavailable");
  drawSquare(context, source, crop);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null
          ? reject(new Error("Avatar JPEG encoding failed"))
          : resolve(blob),
      "image/jpeg",
      crop.quality,
    );
  });
}

function drawSquare(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: WagyuDecodedRasterV1,
  crop: AvatarCropV1,
): void {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, crop.outputSize, crop.outputSize);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source as unknown as CanvasImageSource,
    crop.sourceX,
    crop.sourceY,
    crop.sourceSize,
    crop.sourceSize,
    0,
    0,
    crop.outputSize,
    crop.outputSize,
  );
}

function assertDecodedSourceDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION ||
    BigInt(width) * BigInt(height) > BigInt(MAX_SOURCE_PIXELS)
  ) {
    throw new Error("Decoded avatar exceeds the bounded source dimensions");
  }
}

function mediaTypeFromMime(value: string): WagyuRasterMediaTypeV1 {
  switch (value.toLowerCase()) {
    case "image/jpeg":
      return "jpeg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      throw new Error("Avatar must be JPEG, PNG, or WebP");
  }
}
