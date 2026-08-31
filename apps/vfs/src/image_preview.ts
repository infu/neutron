import { FILES_SERVICE_LIMITS } from "./resident/service_contract.ts";

export const FILES_IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const);

export type FilesImageMediaType =
  (typeof FILES_IMAGE_MEDIA_TYPES)[number];

export const FILES_IMAGE_PREVIEW_MAX_BYTES =
  FILES_SERVICE_LIMITS.binaryBytes;

type FilesImageEntry = Readonly<{
  path: string;
  type: "file" | "folder";
  contentKind: "text" | "binary" | null;
  byteLength: number | null;
  mediaType: string | null;
  etag: string | null;
}>;

type FilesImageReadResult = Readonly<{
  entry: FilesImageEntry;
  data: ArrayBuffer;
}>;

export type ValidatedFilesImageRead = Readonly<{
  path: string;
  etag: string;
  contentKind: "binary";
  byteLength: number;
  mediaType: FilesImageMediaType;
  data: ArrayBuffer;
}>;

const imageMediaTypes = new Set<string>(FILES_IMAGE_MEDIA_TYPES);

const extensionMediaTypes: Readonly<Record<string, FilesImageMediaType>> =
  Object.freeze({
    apng: "image/apng",
    avif: "image/avif",
    gif: "image/gif",
    jfif: "image/jpeg",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  });

/**
 * Returns only inert raster formats that Files renders through a plain img.
 * A filename fallback is accepted solely for absent or generic metadata;
 * another declared type is never overridden by its extension.
 */
export function filesImagePreviewMediaType(
  entry: Pick<FilesImageEntry, "path" | "mediaType">,
): FilesImageMediaType | null {
  const baseType = entry.mediaType?.split(";", 1)[0]?.trim().toLowerCase() ??
    "";
  if (imageMediaTypes.has(baseType)) {
    return baseType as FilesImageMediaType;
  }
  if (baseType !== "" && baseType !== "application/octet-stream") {
    return null;
  }
  const leaf = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const dot = leaf.lastIndexOf(".");
  if (dot < 1 || dot === leaf.length - 1) return null;
  return extensionMediaTypes[leaf.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Binds one completed binary read to the exact file metadata reviewed before
 * the await. The returned envelope is frozen; its ArrayBuffer remains owned
 * by the caller so it can be copied into a Blob and wiped immediately.
 */
export function validateFilesImageRead(
  reviewed: FilesImageEntry,
  result: FilesImageReadResult,
): ValidatedFilesImageRead {
  const mediaType = filesImagePreviewMediaType(reviewed);
  if (
    reviewed.type !== "file" ||
    reviewed.contentKind !== "binary" ||
    reviewed.byteLength === null ||
    !Number.isSafeInteger(reviewed.byteLength) ||
    reviewed.byteLength < 0 ||
    reviewed.byteLength > FILES_IMAGE_PREVIEW_MAX_BYTES ||
    reviewed.etag === null ||
    !/^[a-f0-9]{64}$/u.test(reviewed.etag) ||
    mediaType === null
  ) {
    throw new Error("File is not an eligible raster image");
  }
  if (
    result.entry.type !== "file" ||
    result.entry.contentKind !== "binary" ||
    result.entry.path !== reviewed.path ||
    result.entry.etag !== reviewed.etag ||
    result.entry.byteLength !== reviewed.byteLength ||
    result.entry.mediaType !== reviewed.mediaType ||
    result.data.byteLength !== reviewed.byteLength
  ) {
    throw new Error(
      "Image changed after it was selected; select it again",
    );
  }
  return Object.freeze({
    path: reviewed.path,
    etag: reviewed.etag,
    contentKind: "binary",
    byteLength: reviewed.byteLength,
    mediaType,
    data: result.data,
  });
}
