import { FILES_V2_LIMITS } from "../protocol/constants.ts";

const encoder = new TextEncoder();
const CONTROL = /\p{Cc}/u;
const WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u;
const SURROUNDING_WHITESPACE =
  /^\p{White_Space}+|\p{White_Space}+$/gu;

export type CanonicalFilesPath = Readonly<{
  path: string;
  segments: readonly string[];
  scalars: number;
}>;

export function validateFilesName(name: string): string {
  if (typeof name !== "string" || !isWellFormedUnicode(name)) {
    throw new Error("Files name is invalid");
  }
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    CONTROL.test(name) ||
    WHITESPACE.test(name)
  ) {
    throw new Error("Files name is invalid");
  }
  const normalized = name.normalize("NFC");
  const scalarCount = unicodeScalarCount(normalized);
  if (
    scalarCount < 1 ||
    scalarCount > FILES_V2_LIMITS.nameScalars ||
    encoder.encode(normalized).byteLength > FILES_V2_LIMITS.nameUtf8Bytes
  ) {
    throw new Error("Files name exceeds its bound");
  }
  return normalized;
}

export function canonicalizeFilesPath(input: string): CanonicalFilesPath {
  if (typeof input !== "string" || !isWellFormedUnicode(input)) {
    throw new Error("Files path is invalid");
  }
  const trimmed = input.replace(SURROUNDING_WHITESPACE, "");
  if (
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    CONTROL.test(trimmed)
  ) {
    throw new Error("Files path is invalid");
  }
  const segments: string[] = [];
  for (const raw of trimmed.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") throw new Error("Files path cannot traverse upward");
    segments.push(validateFilesName(raw));
  }
  if (segments.length > FILES_V2_LIMITS.treeDepth) {
    throw new Error("Files path exceeds the tree-depth bound");
  }
  const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  const scalars = unicodeScalarCount(path);
  if (scalars > FILES_V2_LIMITS.pathScalars) {
    throw new Error("Files path exceeds its bound");
  }
  return Object.freeze({
    path,
    segments: Object.freeze(segments),
    scalars,
  });
}

export function unicodeScalarCount(value: string): number {
  return Array.from(value).length;
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
