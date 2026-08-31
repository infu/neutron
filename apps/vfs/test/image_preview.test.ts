import { expect, test } from "bun:test";

// Keep tile-only source outside the scripts project's static module graph.
// The app project typechecks it, while Bun executes this exact module here.
const IMAGE_PREVIEW_MODULE = "../src/image_preview.ts";
const {
  FILES_IMAGE_MEDIA_TYPES,
  FILES_IMAGE_PREVIEW_MAX_BYTES,
  filesImagePreviewMediaType,
  validateFilesImageRead,
} = await import(IMAGE_PREVIEW_MODULE);

const ETAG = "a".repeat(64);

function imageEntry(
  overrides: Partial<{
    path: string;
    type: "file" | "folder";
    contentKind: "text" | "binary" | null;
    byteLength: number | null;
    mediaType: string | null;
    etag: string | null;
  }> = {},
) {
  return {
    path: "/Workspace/photo.png",
    type: "file" as const,
    contentKind: "binary" as const,
    byteLength: 4,
    mediaType: "image/png",
    etag: ETAG,
    ...overrides,
  };
}

test("classifies only the exact raster allowlist", () => {
  expect(FILES_IMAGE_PREVIEW_MAX_BYTES).toBe(16 * 1024 * 1024);
  expect(FILES_IMAGE_MEDIA_TYPES).toEqual([
    "image/png",
    "image/apng",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
  ]);
  expect(
    filesImagePreviewMediaType({
      path: "/Workspace/photo.bin",
      mediaType: " IMAGE/JPEG ; profile=baseline ",
    }),
  ).toBe("image/jpeg");
  expect(
    filesImagePreviewMediaType({
      path: "/Workspace/animation.apng",
      mediaType: "image/apng",
    }),
  ).toBe("image/apng");
  expect(
    filesImagePreviewMediaType({
      path: "/Workspace/photo.WEBP",
      mediaType: "application/octet-stream;charset=binary",
    }),
  ).toBe("image/webp");
  expect(
    filesImagePreviewMediaType({
      path: "/Workspace/camera.JFIF",
      mediaType: null,
    }),
  ).toBe("image/jpeg");
});

test("does not let an extension override an active or unsupported type", () => {
  for (const entry of [
    { path: "/Workspace/vector.svg", mediaType: "image/svg+xml" },
    { path: "/Workspace/disguised.png", mediaType: "image/svg+xml" },
    { path: "/Workspace/page.png", mediaType: "text/html" },
    { path: "/Workspace/photo.bmp", mediaType: "image/bmp" },
    { path: "/Workspace/photo.png.exe", mediaType: null },
    { path: "/Workspace/.png", mediaType: null },
  ]) {
    expect(filesImagePreviewMediaType(entry)).toBeNull();
  }
});

test("validates and freezes an exact reviewed image read", () => {
  const reviewed = imageEntry();
  const data = Uint8Array.of(1, 2, 3, 4).buffer;
  const validated = validateFilesImageRead(reviewed, {
    entry: { ...reviewed },
    data,
  });

  expect(validated).toEqual({
    path: reviewed.path,
    etag: ETAG,
    contentKind: "binary",
    byteLength: 4,
    mediaType: "image/png",
    data,
  });
  expect(validated.data).toBe(data);
  expect(Object.isFrozen(validated)).toBe(true);

  const generic = imageEntry({
    path: "/Workspace/camera.JPEG",
    mediaType: null,
  });
  expect(
    validateFilesImageRead(generic, {
      entry: generic,
      data: Uint8Array.of(1, 2, 3, 4).buffer,
    }).mediaType,
  ).toBe("image/jpeg");
});

test("accepts the readBinary limit and rejects a larger preview", () => {
  const atLimit = imageEntry({
    byteLength: FILES_IMAGE_PREVIEW_MAX_BYTES,
  });
  expect(
    validateFilesImageRead(atLimit, {
      entry: atLimit,
      data: new ArrayBuffer(FILES_IMAGE_PREVIEW_MAX_BYTES),
    }).byteLength,
  ).toBe(FILES_IMAGE_PREVIEW_MAX_BYTES);

  const oversized = imageEntry({
    byteLength: FILES_IMAGE_PREVIEW_MAX_BYTES + 1,
  });
  expect(() =>
    validateFilesImageRead(oversized, {
      entry: oversized,
      data: new ArrayBuffer(0),
    })
  ).toThrow("File is not an eligible raster image");
});

test("rejects stale metadata and mismatched bytes", () => {
  const reviewed = imageEntry();
  const changes = [
    imageEntry({ path: "/Workspace/other.png" }),
    imageEntry({ etag: "b".repeat(64) }),
    imageEntry({ contentKind: "text" }),
    imageEntry({ mediaType: "image/jpeg" }),
    imageEntry({ byteLength: 3 }),
    imageEntry({ type: "folder" }),
  ];
  for (const entry of changes) {
    expect(() =>
      validateFilesImageRead(reviewed, {
        entry,
        data: Uint8Array.of(1, 2, 3, 4).buffer,
      })
    ).toThrow("Image changed after it was selected");
  }
  expect(() =>
    validateFilesImageRead(reviewed, {
      entry: reviewed,
      data: Uint8Array.of(1, 2, 3).buffer,
    })
  ).toThrow("Image changed after it was selected");
});

test("rejects ineligible reviewed metadata before accepting bytes", () => {
  for (const reviewed of [
    imageEntry({ contentKind: "text" }),
    imageEntry({ mediaType: "image/svg+xml" }),
    imageEntry({ etag: null }),
    imageEntry({ etag: "not-an-etag" }),
    imageEntry({ byteLength: -1 }),
    imageEntry({ type: "folder" }),
  ]) {
    expect(() =>
      validateFilesImageRead(reviewed, {
        entry: reviewed,
        data: Uint8Array.of(1, 2, 3, 4).buffer,
      })
    ).toThrow("File is not an eligible raster image");
  }
});
