import { normalizeFilesPath } from "./paths.ts";

export const FILES_STORAGE_ROOTS = Object.freeze([
  "Shared",
  "Vault",
  "Workspace",
] as const);

export type FilesStorageRoot = (typeof FILES_STORAGE_ROOTS)[number];
export type FilesStorageClass = "shared" | "vault" | "workspace";

const ROOT_BY_CLASS: Readonly<Record<FilesStorageClass, FilesStorageRoot>> =
  Object.freeze({
    shared: "Shared",
    vault: "Vault",
    workspace: "Workspace",
  });

const CLASS_BY_ROOT = new Map<FilesStorageRoot, FilesStorageClass>([
  ["Shared", "shared"],
  ["Vault", "vault"],
  ["Workspace", "workspace"],
]);

export type FilesRootedPath = Readonly<{
  path: string;
  root: FilesStorageRoot;
  storageClass: FilesStorageClass;
  relativePath: string;
  isRoot: boolean;
}>;

export function filesStorageRootPath(
  storageClass: FilesStorageClass,
): string {
  return `/${ROOT_BY_CLASS[storageClass]}`;
}

export function parseFilesRootedPath(value: string): FilesRootedPath | null {
  const path = normalizeFilesPath(value).path;
  if (path === "/") return null;
  const separator = path.indexOf("/", 1);
  const root = path.slice(
    1,
    separator === -1 ? path.length : separator,
  ) as FilesStorageRoot;
  const storageClass = CLASS_BY_ROOT.get(root);
  if (storageClass === undefined) return null;
  const relativePath = separator === -1 ? "/" : path.slice(separator);
  return Object.freeze({
    path,
    root,
    storageClass,
    relativePath,
    isRoot: relativePath === "/",
  });
}

export function requireFilesRootedPath(value: string): FilesRootedPath {
  const rooted = parseFilesRootedPath(value);
  if (rooted === null) {
    throw new Error(
      "Choose Shared, Vault, or Workspace before creating or opening files",
    );
  }
  return rooted;
}

export function filesVirtualPath(
  storageClass: FilesStorageClass,
  relativePath: string,
): string {
  const normalized = normalizeFilesPath(relativePath).path;
  const root = filesStorageRootPath(storageClass);
  return normalized === "/" ? root : `${root}${normalized}`;
}

export function filesStorageClassForPath(
  value: string,
): FilesStorageClass | null {
  return parseFilesRootedPath(value)?.storageClass ?? null;
}

// The Kernel's inline profile always serves safe plain text. For example,
// HTML and script files are readable source here, never executable content.
export const FILES_SHARED_INLINE_TEXT_EXTENSIONS = Object.freeze([
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
] as const);

const INLINE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  FILES_SHARED_INLINE_TEXT_EXTENSIONS,
);

export function sharedPresentationForPath(
  value: string,
): "inline_text" | "attachment" {
  const name = normalizeFilesPath(value).path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  // A leading dot is the separator for an allowlisted text dotfile such as
  // `.env`; names without a dot and names ending in one remain attachments.
  if (dot < 0 || dot === name.length - 1) return "attachment";
  const extension = name.slice(dot + 1).toLocaleLowerCase("en-US");
  return INLINE_TEXT_EXTENSIONS.has(extension)
    ? "inline_text"
    : "attachment";
}

export function isFilesStorageRootPath(value: string): boolean {
  return parseFilesRootedPath(value)?.isRoot ?? false;
}
