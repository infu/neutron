import { FILES_V2_LIMITS } from "./constants.ts";
import {
  isUnicode16Control,
  isUnicode16WhiteSpace,
  normalizeUnicode16Npss,
  UNICODE_MAX_CANONICAL_DECOMPOSITION,
} from "./unicode_nfc.ts";

const encoder = new TextEncoder();
const MAX_RAW_NAME_SCALARS =
  FILES_V2_LIMITS.nameScalars *
  UNICODE_MAX_CANONICAL_DECOMPOSITION;
const MAX_RAW_NAME_CODE_UNITS = MAX_RAW_NAME_SCALARS * 2;
const MAX_RAW_NAME_UTF8_BYTES =
  FILES_V2_LIMITS.nameUtf8Bytes *
  UNICODE_MAX_CANONICAL_DECOMPOSITION;
const MAX_RAW_PATH_SCALARS =
  FILES_V2_LIMITS.pathScalars *
  UNICODE_MAX_CANONICAL_DECOMPOSITION;
const MAX_RAW_PATH_CODE_UNITS = MAX_RAW_PATH_SCALARS * 2;
const MAX_RAW_PATH_UTF8_BYTES =
  FILES_V2_LIMITS.pathScalars * 4 *
  UNICODE_MAX_CANONICAL_DECOMPOSITION;

export type CanonicalPlainFilesPath = Readonly<{
  path: string;
  segments: readonly string[];
  scalarLength: number;
}>;

export function validatePlainFilesName(input: string): string {
  if (typeof input !== "string") {
    throw new Error("Files plain name is invalid");
  }
  if (
    input.length > MAX_RAW_NAME_CODE_UNITS ||
    [...input].length > MAX_RAW_NAME_SCALARS ||
    encoder.encode(input).byteLength > MAX_RAW_NAME_UTF8_BYTES
  ) {
    throw new Error("Files plain name exceeds its bound");
  }
  const normalized = normalizeUnicode16Npss(input);
  if (
    normalized === null ||
    normalized === "" ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error("Files plain name is invalid");
  }
  const scalars = [...normalized];
  if (
    scalars[0] === undefined ||
    edgeWhiteSpace(scalars[0]) ||
    edgeWhiteSpace(scalars.at(-1)!)
  ) {
    throw new Error("Files plain name is invalid");
  }
  for (const character of scalars) {
    const scalar = character.codePointAt(0)!;
    if (
      isUnicode16Control(scalar) ||
      scalar === 0x2f ||
      scalar === 0x5c
    ) {
      throw new Error("Files plain name is invalid");
    }
  }
  if (
    scalars.length > FILES_V2_LIMITS.nameScalars ||
    encoder.encode(normalized).byteLength >
      FILES_V2_LIMITS.nameUtf8Bytes
  ) {
    throw new Error("Files plain name exceeds its bound");
  }
  return normalized;
}

export function isCanonicalPlainFilesName(value: string): boolean {
  try {
    return validatePlainFilesName(value) === value;
  } catch {
    return false;
  }
}

export function normalizePlainFilesPath(
  input: string,
): CanonicalPlainFilesPath {
  if (typeof input !== "string") {
    throw new Error("Files plain path is invalid");
  }
  if (input.length > MAX_RAW_PATH_CODE_UNITS) {
    throw new Error("Files plain path exceeds its bound");
  }
  const trimmed = trimUnicodeWhiteSpace(input);
  if (
    [...trimmed].length > MAX_RAW_PATH_SCALARS ||
    encoder.encode(trimmed).byteLength > MAX_RAW_PATH_UTF8_BYTES
  ) {
    throw new Error("Files plain path exceeds its bound");
  }
  const segments: string[] = [];
  for (const raw of trimmed.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      throw new Error("Files plain path cannot traverse upward");
    }
    segments.push(validatePlainFilesName(raw));
  }
  if (segments.length > FILES_V2_LIMITS.treeDepth) {
    throw new Error("Files plain path exceeds the tree-depth bound");
  }
  const path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  const scalarLength = [...path].length;
  if (scalarLength > FILES_V2_LIMITS.pathScalars) {
    throw new Error("Files plain path exceeds its bound");
  }
  return Object.freeze({
    path,
    segments: Object.freeze(segments),
    scalarLength,
  });
}

export function isCanonicalPlainFilesPath(value: string): boolean {
  try {
    return normalizePlainFilesPath(value).path === value;
  } catch {
    return false;
  }
}

export function isPlainStorageRootedInput(value: string): boolean {
  if (value.length > MAX_RAW_PATH_CODE_UNITS) {
    throw new Error("Files path exceeds its raw bound");
  }
  const trimmed = trimUnicodeWhiteSpace(value);
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    return segment === "Shared" || segment === "Workspace";
  }
  return false;
}

function edgeWhiteSpace(character: string): boolean {
  return isUnicode16WhiteSpace(character.codePointAt(0)!);
}

function trimUnicodeWhiteSpace(value: string): string {
  const characters = [...value];
  let first = 0;
  while (
    first < characters.length &&
    edgeWhiteSpace(characters[first]!)
  ) {
    first += 1;
  }
  let last = characters.length;
  while (
    last > first &&
    edgeWhiteSpace(characters[last - 1]!)
  ) {
    last -= 1;
  }
  return characters.slice(first, last).join("");
}
