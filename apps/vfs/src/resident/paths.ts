import {
  filesId128Equal,
  filesId128ToKey,
  parseByteArray,
} from "../protocol/ids.ts";
import type {
  CanonicalNat64,
  FilesId128V2,
} from "../protocol/types.ts";
import {
  canonicalizeFilesPath,
  validateFilesName as validateVaultFilesName,
} from "../vault/paths.ts";

export type CanonicalFilesPath = Readonly<{
  path: string;
  segments: readonly string[];
  scalarLength: number;
}>;

export type FilesResolvedNode = Readonly<{
  nodeId: FilesId128V2;
  parentId: FilesId128V2;
  kind: "file" | "folder";
  structuralRevision: CanonicalNat64;
  metadataRevision: CanonicalNat64;
  childrenRevision: CanonicalNat64;
  canonicalName: string;
}>;

export interface FilesNameTagPort {
  nameTag(parentId: FilesId128V2, canonicalName: string): Promise<ArrayBuffer>;
}

export interface FilesNavigationPort {
  root(): Promise<FilesResolvedNode>;
  child(
    parentId: FilesId128V2,
    nameTag: ArrayBuffer,
  ): Promise<FilesResolvedNode | null>;
}

export interface FilesPathCache {
  get(parentId: FilesId128V2, canonicalName: string): FilesResolvedNode | undefined;
  set(
    parentId: FilesId128V2,
    canonicalName: string,
    node: FilesResolvedNode,
  ): void;
}

export class FilesPathError extends Error {
  constructor(
    public readonly code:
      | "path_invalid"
      | "path_too_long"
      | "name_invalid"
      | "name_too_long"
      | "path_not_found"
      | "path_not_folder"
      | "path_integrity",
    message: string,
  ) {
    super(message);
    this.name = "FilesPathError";
  }
}

export function normalizeFilesPath(input: string): CanonicalFilesPath {
  try {
    const canonical = canonicalizeFilesPath(input);
    return Object.freeze({
      path: canonical.path,
      segments: canonical.segments,
      scalarLength: canonical.scalars,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Files path is invalid";
    throw new FilesPathError(
      message.includes("exceeds") ? "path_too_long" : "path_invalid",
      message.includes("traverse")
        ? "Parent path segments are forbidden"
        : message.includes("invalid") && hasUnpairedSurrogate(input)
          ? "Path contains invalid Unicode"
          : message,
    );
  }
}

/** Direct create/rename validation does not trim the supplied segment. */
export function validateFilesName(input: string): string {
  try {
    return validateVaultFilesName(input);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Files name is invalid";
    throw new FilesPathError(
      message.includes("exceeds") ? "name_too_long" : "name_invalid",
      hasUnpairedSurrogate(input)
        ? "Name contains invalid Unicode"
        : message,
    );
  }
}

export class FilesPathResolver {
  constructor(
    private readonly tags: FilesNameTagPort,
    private readonly navigation: FilesNavigationPort,
    private readonly cache?: FilesPathCache,
  ) {}

  async resolve(input: string): Promise<{
    canonical: CanonicalFilesPath;
    node: FilesResolvedNode;
  }> {
    const canonical = normalizeFilesPath(input);
    let current = await this.navigation.root();
    if (current.canonicalName !== "") {
      throw new FilesPathError(
        "path_integrity",
        "The backend root has a nonempty private name",
      );
    }
    for (const segment of canonical.segments) {
      if (current.kind !== "folder") {
        throw new FilesPathError(
          "path_not_folder",
          "A path prefix resolves to a file",
        );
      }
      let child = this.cache?.get(current.nodeId, segment);
      if (!child) {
        const rawTag = await this.tags.nameTag(current.nodeId, segment);
        const tag = parseByteArray(new Uint8Array(rawTag), {
          label: "name tag",
          exactBytes: 32,
        });
        child = await this.navigation.child(
          current.nodeId,
          tag.buffer.slice(
            tag.byteOffset,
            tag.byteOffset + tag.byteLength,
          ) as ArrayBuffer,
        ) ?? undefined;
      }
      if (!child) {
        throw new FilesPathError("path_not_found", "Path does not exist");
      }
      if (
        !filesId128Equal(child.parentId, current.nodeId) ||
        child.canonicalName !== segment
      ) {
        throw new FilesPathError(
          "path_integrity",
          "Resolved child does not match its authenticated parent and name",
        );
      }
      this.cache?.set(current.nodeId, segment, child);
      current = child;
    }
    return { canonical, node: current };
  }

  async resolveParent(input: string): Promise<{
    canonical: CanonicalFilesPath;
    parent: FilesResolvedNode;
    name: string;
  }> {
    const canonical = normalizeFilesPath(input);
    if (canonical.segments.length === 0) {
      throw new FilesPathError("path_invalid", "The root has no writable parent");
    }
    const name = canonical.segments[canonical.segments.length - 1]!;
    const parentPath =
      canonical.segments.length === 1
        ? "/"
        : `/${canonical.segments.slice(0, -1).join("/")}`;
    const resolved = await this.resolve(parentPath);
    if (resolved.node.kind !== "folder") {
      throw new FilesPathError("path_not_folder", "Parent is not a folder");
    }
    return { canonical, parent: resolved.node, name };
  }
}

export class MapFilesPathCache implements FilesPathCache {
  readonly #entries = new Map<string, FilesResolvedNode>();

  get(
    parentId: FilesId128V2,
    canonicalName: string,
  ): FilesResolvedNode | undefined {
    return this.#entries.get(cacheKey(parentId, canonicalName));
  }

  set(
    parentId: FilesId128V2,
    canonicalName: string,
    node: FilesResolvedNode,
  ): void {
    this.#entries.set(cacheKey(parentId, canonicalName), node);
  }

  clear(): void {
    this.#entries.clear();
  }
}

function cacheKey(parentId: FilesId128V2, canonicalName: string): string {
  return `${filesId128ToKey(parentId)}:${canonicalName}`;
}

function hasUnpairedSurrogate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
