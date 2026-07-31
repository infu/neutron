import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WAGYU_PROFILE_PATH,
  actionObjectPath,
  likeBatchPath,
  likeHeadPath,
  parseImmutableWagyuPath,
  parseLowerHex32,
  replyIndexPath,
} from "../src/protocol/index.ts";

interface PathFixture {
  paths: {
    post: string;
    share: string;
    like: string;
    tombstone: string;
    like_head: string;
    reply_index: string;
    profile: string;
  };
  semantic: {
    post_object_digest: string;
    share_object_digest: string;
    like_object_digest: string;
    tombstone_object_digest: string;
    post_id: string;
  };
}

const golden = JSON.parse(
  readFileSync(
    new URL("../candid/fixtures/golden-v1.json", import.meta.url),
    "utf8",
  ),
) as PathFixture;

describe("Wagyu V1 certified paths", () => {
  test("derives every fixed immutable action path", () => {
    expect(
      actionObjectPath(
        "post",
        parseLowerHex32(golden.semantic.post_object_digest),
      ),
    ).toBe(golden.paths.post);
    expect(
      actionObjectPath(
        "share",
        parseLowerHex32(golden.semantic.share_object_digest),
      ),
    ).toBe(golden.paths.share);
    expect(
      actionObjectPath(
        "like",
        parseLowerHex32(golden.semantic.like_object_digest),
      ),
    ).toBe(golden.paths.like);
    expect(
      actionObjectPath(
        "tombstone",
        parseLowerHex32(golden.semantic.tombstone_object_digest),
      ),
    ).toBe(golden.paths.tombstone);
    expect(
      likeHeadPath(parseLowerHex32(golden.semantic.post_id)),
    ).toBe(golden.paths.like_head);
    expect(
      replyIndexPath(parseLowerHex32(golden.semantic.post_id)),
    ).toBe(golden.paths.reply_index);
    expect(golden.paths.profile).toBe(WAGYU_PROFILE_PATH);
  });

  test("like-batch uses its separate path class", () => {
    const digest = parseLowerHex32("11".repeat(32));
    expect(likeBatchPath(digest)).toBe(
      `/app/wagyu/_route/protocol/v1/objects/like-batch/sha256/${"11".repeat(32)}`,
    );
    expect(parseImmutableWagyuPath(likeBatchPath(digest))).toEqual({
      kind: "like-batch",
      digest,
    });
  });

  test("parser rejects queries, fragments, uppercase hex, and adjacent paths", () => {
    const path = golden.paths.post;
    expect(parseImmutableWagyuPath(path)?.kind).toBe("post");
    expect(parseImmutableWagyuPath(`${path}?x=1`)).toBeNull();
    expect(parseImmutableWagyuPath(`${path}#x`)).toBeNull();
    expect(parseImmutableWagyuPath(path.toUpperCase())).toBeNull();
    expect(parseImmutableWagyuPath(`${path}/extra`)).toBeNull();
  });
});
