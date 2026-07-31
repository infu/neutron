import {
  lowerHex,
  parseLowerHex32,
} from "./bytes.ts";
import {
  WAGYU_ACTION_PATH_SEGMENTS,
  WAGYU_PROFILE_PATH,
  WAGYU_PROTOCOL_PATH_PREFIX,
  type WagyuActionPathKind,
} from "./constants.ts";
import type { WagyuBytes32 } from "./types.ts";

export function actionObjectPath(
  actionKind: WagyuActionPathKind,
  objectDigest: WagyuBytes32,
): string {
  return `${WAGYU_PROTOCOL_PATH_PREFIX}/objects/${WAGYU_ACTION_PATH_SEGMENTS[actionKind]}/sha256/${lowerHex(objectDigest)}`;
}

export function postObjectPath(objectDigest: WagyuBytes32): string {
  return actionObjectPath("post", objectDigest);
}

export function shareObjectPath(objectDigest: WagyuBytes32): string {
  return actionObjectPath("share", objectDigest);
}

export function tombstoneObjectPath(objectDigest: WagyuBytes32): string {
  return actionObjectPath("tombstone", objectDigest);
}

export function likeObjectPath(objectDigest: WagyuBytes32): string {
  return actionObjectPath("like", objectDigest);
}

export function likeBatchPath(batchDigest: WagyuBytes32): string {
  return `${WAGYU_PROTOCOL_PATH_PREFIX}/objects/like-batch/sha256/${lowerHex(batchDigest)}`;
}

export function likeHeadPath(postId: WagyuBytes32): string {
  return `${WAGYU_PROTOCOL_PATH_PREFIX}/heads/likes/${lowerHex(postId)}`;
}

export function replyIndexPath(postId: WagyuBytes32): string {
  return `${WAGYU_PROTOCOL_PATH_PREFIX}/heads/replies/${lowerHex(postId)}`;
}

export function profilePath(): typeof WAGYU_PROFILE_PATH {
  return WAGYU_PROFILE_PATH;
}

export type ParsedImmutableWagyuPath =
  | Readonly<{
      kind: WagyuActionPathKind;
      digest: WagyuBytes32;
    }>
  | Readonly<{
      kind: "like-batch";
      digest: WagyuBytes32;
    }>;

export function parseImmutableWagyuPath(
  path: string,
): ParsedImmutableWagyuPath | null {
  if (path.includes("?") || path.includes("#")) return null;
  const prefix = `${WAGYU_PROTOCOL_PATH_PREFIX}/objects/`;
  if (!path.startsWith(prefix)) return null;
  const suffix = path.slice(prefix.length);
  const match = /^(post|share|tombstone|like|like-batch)\/sha256\/([0-9a-f]{64})$/u.exec(
    suffix,
  );
  if (match === null) return null;
  const kind = match[1] as WagyuActionPathKind | "like-batch";
  return Object.freeze({
    kind,
    digest: parseLowerHex32(match[2]!),
  }) as ParsedImmutableWagyuPath;
}
