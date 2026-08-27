import { expect, test } from "bun:test";
import {
  CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2,
  CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  createStaticFileOperation,
  uploadStaticFileOperation,
} from "../src/install.ts";
import {
  assertSafeArchivePath,
  isCanonicalAbsoluteInstallTarget,
} from "../src/package_decoder.ts";

const canonicalAtSegmentLimit =
  "/" +
  Array.from(
    { length: CERTIFIED_HTTP_PATH_SEGMENTS_MAX_V2 },
    (_, index) => `s${index}`,
  ).join("/");

test("install targets match the backend certified canonical-path corpus", () => {
  for (const target of [
    "/",
    "/api/items",
    "/api/items/",
    "/café/東京",
    "/c1/\u0080\u009f",
    canonicalAtSegmentLimit,
    `/${"x".repeat(CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2)}`,
    `/${"é".repeat(CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 / 2)}`,
  ]) {
    expect(isCanonicalAbsoluteInstallTarget(target), target).toBe(true);
  }

  for (const target of [
    "",
    "api/items",
    "//api/items",
    "/api//items",
    "/api/./items",
    "/api/../items",
    "/api/%2f/items",
    "/api\\items",
    "/api/items?query",
    "/api/items#fragment",
    "/api/\u0000items",
    "/api/\u001fitems",
    "/api/\u007fitems",
    `${canonicalAtSegmentLimit}/overflow`,
    `/${"x".repeat(CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 + 1)}`,
    `/${"é".repeat(CERTIFIED_HTTP_PATH_SEGMENT_BYTES_MAX_V2 / 2 + 1)}`,
    null,
    undefined,
    1,
  ]) {
    expect(
      isCanonicalAbsoluteInstallTarget(target),
      String(target),
    ).toBe(false);
  }
});

test("archive source paths retain their independent 4096-byte ceiling", () => {
  expect(() => assertSafeArchivePath("é".repeat(2_048))).not.toThrow();
  expect(() => assertSafeArchivePath(`${"é".repeat(2_048)}a`)).toThrow(
    "Package path exceeds the 4096-byte limit",
  );
});

test("static operation construction and dispatch reject noncanonical keys before IO", async () => {
  const content = new TextEncoder().encode("ok");
  expect(() =>
    createStaticFileOperation(
      "/api/items?query",
      content,
      "text/plain",
      "identity",
    ),
  ).toThrow("Invalid staged asset target /api/items?query");

  const valid = createStaticFileOperation(
    "/api/items",
    content,
    "text/plain",
    "identity",
  );
  let writes = 0;
  await expect(
    uploadStaticFileOperation(
      {
        async kernel_static() {
          writes += 1;
        },
      },
      { ...valid, key: "/api//items" },
    ),
  ).rejects.toThrow("Invalid staged asset target /api//items");
  expect(writes).toBe(0);
});
