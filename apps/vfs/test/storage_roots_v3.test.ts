import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FILES_SHARED_INLINE_TEXT_EXTENSIONS,
  FILES_STORAGE_ROOTS,
  filesStorageClassForPath,
  filesStorageRootPath,
  filesVirtualPath,
  isFilesStorageRootPath,
  parseFilesRootedPath,
  requireFilesRootedPath,
  sharedPresentationForPath,
} from "../src/resident/storage_roots.ts";

const EXPECTED_INLINE_TEXT_EXTENSIONS = [
  "bash",
  "bat",
  "c",
  "cc",
  "cfg",
  "cjs",
  "cmd",
  "conf",
  "config",
  "cpp",
  "css",
  "csv",
  "cts",
  "cxx",
  "diff",
  "env",
  "fish",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "json5",
  "jsonl",
  "jsx",
  "log",
  "lua",
  "md",
  "markdown",
  "mjs",
  "mts",
  "ndjson",
  "patch",
  "php",
  "properties",
  "proto",
  "ps1",
  "py",
  "r",
  "rb",
  "rs",
  "scss",
  "sh",
  "shell",
  "source",
  "sql",
  "svelte",
  "swift",
  "text",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
] as const;

describe("Files storage roots", () => {
  test("keeps the fixed home order and storage-class mapping", () => {
    expect(FILES_STORAGE_ROOTS).toEqual([
      "Shared",
      "Vault",
      "Workspace",
    ]);
    expect(Object.isFrozen(FILES_STORAGE_ROOTS)).toBe(true);
    expect(filesStorageRootPath("shared")).toBe("/Shared");
    expect(filesStorageRootPath("vault")).toBe("/Vault");
    expect(filesStorageRootPath("workspace")).toBe("/Workspace");
  });

  test("parses normalized rooted paths without weakening the policy boundary", () => {
    expect(parseFilesRootedPath(" Shared//projects/./roadmap.md ")).toEqual({
      path: "/Shared/projects/roadmap.md",
      root: "Shared",
      storageClass: "shared",
      relativePath: "/projects/roadmap.md",
      isRoot: false,
    });
    expect(parseFilesRootedPath("/Vault")).toEqual({
      path: "/Vault",
      root: "Vault",
      storageClass: "vault",
      relativePath: "/",
      isRoot: true,
    });
    expect(parseFilesRootedPath("/Workspace/archive")).toEqual({
      path: "/Workspace/archive",
      root: "Workspace",
      storageClass: "workspace",
      relativePath: "/archive",
      isRoot: false,
    });

    expect(parseFilesRootedPath("/")).toBeNull();
    expect(parseFilesRootedPath("/shared/file.txt")).toBeNull();
    expect(parseFilesRootedPath("/Other/file.txt")).toBeNull();
    expect(filesStorageClassForPath("/Vault/notes")).toBe("vault");
    expect(filesStorageClassForPath("/Other/notes")).toBeNull();
  });

  test("builds virtual paths and identifies only the three immutable roots", () => {
    expect(filesVirtualPath("shared", "/")).toBe("/Shared");
    expect(filesVirtualPath("vault", "docs//report.txt")).toBe(
      "/Vault/docs/report.txt",
    );
    expect(filesVirtualPath("workspace", "/drafts")).toBe(
      "/Workspace/drafts",
    );

    expect(isFilesStorageRootPath("/Shared")).toBe(true);
    expect(isFilesStorageRootPath("/Vault/")).toBe(true);
    expect(isFilesStorageRootPath("/Workspace/project")).toBe(false);
    expect(isFilesStorageRootPath("/")).toBe(false);
    expect(() => requireFilesRootedPath("/unknown")).toThrow(
      "Choose Shared, Vault, or Workspace",
    );
  });

  test("chooses friendly shared-file presentation from the extension", () => {
    for (const extension of EXPECTED_INLINE_TEXT_EXTENSIONS) {
      const upper = extension.toUpperCase();
      expect(
        sharedPresentationForPath(`/Shared/sample.${upper}`),
      ).toBe("inline_text");
      expect(
        sharedPresentationForPath(`/Shared/.${upper}`),
      ).toBe("inline_text");
    }

    for (const path of [
      "/Shared/photo.png",
      "/Shared/photo.jpg",
      "/Shared/photo.jpeg",
      "/Shared/document.pdf",
      "/Shared/document.docx",
      "/Shared/archive.zip",
      "/Shared/audio.mp3",
      "/Shared/video.mp4",
      "/Shared/vector.svg",
      "/Shared/unknown.neutron",
      "/Shared/.neutron",
      "/Shared/.png",
      "/Shared/no-extension",
      "/Shared/report.",
    ]) {
      expect(sharedPresentationForPath(path)).toBe("attachment");
    }
  });

  test("keeps the resident and backend text allowlists exactly aligned", async () => {
    expect(FILES_SHARED_INLINE_TEXT_EXTENSIONS).toEqual(
      EXPECTED_INLINE_TEXT_EXTENSIONS,
    );
    const backend = await readFile(
      new URL("../backend/files/PlainService.mo", import.meta.url),
      "utf8",
    );
    const match = backend.match(
      /let inlineTextSuffixes : \[Text\] = \[([\s\S]*?)\];/u,
    );
    expect(match).not.toBeNull();
    const backendExtensions = [
      ...(match?.[1] ?? "").matchAll(/"\.([a-z0-9]+)"/gu),
    ].map((item) => item[1]!);
    expect(backendExtensions).toEqual([
      ...EXPECTED_INLINE_TEXT_EXTENSIONS,
    ]);

    const motokoTest = await readFile(
      new URL("motoko/plain_service_behavior_test.mo", import.meta.url),
      "utf8",
    );
    const vectorMatch = motokoTest.match(
      /let inlineTextExtensions : \[Text\] = \[([\s\S]*?)\];/u,
    );
    expect(vectorMatch).not.toBeNull();
    const motokoExtensions = [
      ...(vectorMatch?.[1] ?? "").matchAll(/"([a-z0-9]+)"/gu),
    ].map((item) => item[1]!);
    expect(motokoExtensions).toEqual([
      ...EXPECTED_INLINE_TEXT_EXTENSIONS,
    ]);
  });
});
