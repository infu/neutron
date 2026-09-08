import { describe, expect, test } from "bun:test";
import {
  DOWNVOTE_REACTION_ID,
  parseDomains,
  parseFeed,
  parseJson,
  parsePost,
  parseRealmPairs,
  parseSearchResults,
  parseStats,
  parseTags,
  parseUser,
  parseUserNames,
  reactionEmoji,
  TaggrParseError,
  unwrapResult,
} from "../src/model.ts";

// Shaped exactly like `serde_json` output for `env::post::Post`, including the
// fields this client ignores, so a parser that over-constrains its input fails
// here instead of against the live network.
const POST = {
  id: 4242,
  body: "hello **taggr** @alice #neutron",
  user: 7,
  timestamp: 1_700_000_000_000_000_000,
  children: [4243, 4244],
  parent: null,
  watchers: [7],
  tags: ["neutron"],
  reactions: { "10": [1, 2, 3], "1": [9], "53": [4] },
  patches: [[1_600_000_000_000_000_000, "@@ -1 +1 @@"]],
  files: { "abc@bucket": [0, 128] },
  tree_size: 3,
  tree_update: 1_700_000_100_000_000_000,
  tips: [[2, 500]],
  extension: null,
  realm: "NEUTRON",
  hashes: [],
  reposts: [],
  heat: 12,
  encrypted: false,
  hidden_for: [],
};

const META = {
  author_name: "alice",
  author_filters: { age_days: 0, safe: false, balance: 0, num_followers: 0 },
  viewer_blocked: false,
  realm_color: "#334455",
  nsfw: false,
  max_downvotes_reached: false,
};

describe("reply decoding", () => {
  test("treats an empty reply body as null", () => {
    expect(parseJson("")).toBeNull();
    expect(parseJson("   ")).toBeNull();
  });

  test("names a malformed reply instead of throwing a syntax error", () => {
    expect(() => parseJson("{oops")).toThrow(TaggrParseError);
  });
});

describe("post parsing", () => {
  test("reads the fields the client renders and ignores the rest", () => {
    const post = parsePost(POST);
    expect(post.id).toBe(4242);
    expect(post.user).toBe(7);
    expect(post.realm).toBe("NEUTRON");
    expect(post.parent).toBeNull();
    expect(post.children).toEqual([4243, 4244]);
    expect(post.tags).toEqual(["neutron"]);
    expect(post.files).toEqual([
      { id: "abc", bucket: "bucket", offset: 0, len: 128 },
    ]);
    expect(post.treeSize).toBe(3);
    expect(post.extension).toBeNull();
  });

  test("orders reactions by popularity and keeps the downvote id intact", () => {
    const post = parsePost(POST);
    // Three hearts outrank one downvote and one rocket; ties keep Taggr's own
    // ascending id order because the sort is stable.
    expect(post.reactions.map((reaction) => reaction.id)).toEqual([10, 1, 53]);
    expect(post.reactions[0]).toEqual({ id: 10, users: [1, 2, 3] });
    expect(post.reactions.some((r) => r.id === DOWNVOTE_REACTION_ID)).toBe(true);
  });

  test("drops reactions that no longer have any voters", () => {
    const post = parsePost({ ...POST, reactions: { "10": [], "11": [5] } });
    expect(post.reactions).toEqual([{ id: 11, users: [5] }]);
  });

  test("reads a poll extension", () => {
    const post = parsePost({
      ...POST,
      extension: { Poll: { options: ["yes", "no"], votes: { "0": [1] }, voters: [1], deadline: 3 } },
    });
    expect(post.extension).toEqual({
      kind: "poll",
      options: ["yes", "no"],
      votes: { 0: [1] },
      deadline: 3,
    });
  });

  test("reads a repost extension", () => {
    const post = parsePost({ ...POST, extension: { Repost: 11 } });
    expect(post.extension).toEqual({ kind: "repost", postId: 11 });
  });

  test("survives the retained string-form legacy extension", () => {
    const post = parsePost({ ...POST, extension: "Feature" });
    expect(post.extension).toEqual({ kind: "other", name: "Feature" });
  });

  test("rejects a reply that is not a post", () => {
    expect(() => parsePost(null)).toThrow(TaggrParseError);
    expect(() => parsePost({ body: "no id" })).toThrow(TaggrParseError);
  });
});

describe("feed parsing", () => {
  test("reads the (post, meta) pairs the feed queries return", () => {
    const entries = parseFeed([[POST, META]]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.post.id).toBe(4242);
    expect(entries[0]?.meta.authorName).toBe("alice");
    expect(entries[0]?.meta.realmColor).toBe("#334455");
  });

  test("accepts a realm colour omitted by serde's skip_serializing_if", () => {
    const { realm_color: _omitted, ...withoutColor } = META;
    expect(parseFeed([[POST, withoutColor]])[0]?.meta.realmColor).toBeNull();
  });

  test("treats an empty feed as an empty page rather than an error", () => {
    expect(parseFeed([])).toEqual([]);
    expect(parseFeed(null)).toEqual([]);
  });

  test("rejects a truncated pair", () => {
    expect(() => parseFeed([[POST]])).toThrow(TaggrParseError);
  });
});

describe("other replies", () => {
  test("reads a user profile", () => {
    const user = parseUser({
      id: 7,
      name: "alice",
      about: "hello",
      principal: "2vxsx-fae",
      num_posts: 12,
      followers: [1, 2],
      followees: [3],
      realms: ["NEUTRON"],
      balance: 100_000_000,
      rewards: 5,
      cycles: 250,
      stalwart: true,
      timestamp: 1,
    });
    expect(user?.name).toBe("alice");
    expect(user?.credits).toBe(250);
    expect(user?.stalwart).toBe(true);
  });

  test("reads an absent profile as null, which is how Taggr reports no account", () => {
    expect(parseUser(null)).toBeNull();
  });

  test("reads realm pairs and clears nothing the caller needs", () => {
    const realms = parseRealmPairs([
      [
        "NEUTRON",
        {
          description: "About Neutron",
          logo: "",
          label_color: "#fff",
          num_members: 4,
          num_posts: 9,
          adult_content: false,
          controllers: [7],
        },
      ],
    ]);
    expect(realms[0]).toMatchObject({ id: "NEUTRON", numMembers: 4, numPosts: 9 });
  });

  test("reads search results", () => {
    expect(
      parseSearchResults([
        { id: 1, user_id: 2, generic_id: "post", result: "snippet", relevant: "match" },
      ]),
    ).toEqual([
      { id: 1, userId: 2, genericId: "post", result: "snippet", relevant: "match" },
    ]);
  });

  test("reads the users_data name map", () => {
    const names = parseUserNames({ "7": "alice", "8": "bob" });
    expect(names.get(7)).toBe("alice");
    expect(names.size).toBe(2);
  });

  test("reads recent tag pairs", () => {
    expect(parseTags([["neutron", 12]])).toEqual([{ tag: "neutron", weight: 12 }]);
  });

  test("reads the stats fields the client shows", () => {
    const stats = parseStats({
      users: 10,
      users_online: 2,
      posts: 30,
      comments: 40,
      realms: 3,
      canister_cycle_balance: 99,
    });
    expect(stats).toEqual({
      users: 10,
      usersOnline: 2,
      posts: 30,
      comments: 40,
      realms: 3,
      canisterCycleBalance: 99,
    });
  });

  test("reads each domain's own view of the network", () => {
    // Shapes taken from what mainnet Taggr actually answers.
    expect(
      parseDomains({
        "taggr.network": {
          max_downvotes: 2,
          owner: 305,
          sub_config: { WhiteListedRealms: ["RUGBY", "DAO"] },
        },
        "6qfxa-ryaaa-aaaai-qbhsq-cai.icp0.io": {
          max_downvotes: 15,
          owner: null,
          sub_config: { BlackListedRealms: [] },
        },
        localhost: { max_downvotes: 0, owner: null, sub_config: { BlackListedRealms: [] } },
      }),
    ).toEqual([
      {
        name: "6qfxa-ryaaa-aaaai-qbhsq-cai.icp0.io",
        maxDownvotes: 15,
        owner: null,
        scope: { kind: "blacklist", realms: [] },
      },
      { name: "localhost", maxDownvotes: 0, owner: null, scope: { kind: "blacklist", realms: [] } },
      {
        name: "taggr.network",
        maxDownvotes: 2,
        owner: 305,
        scope: { kind: "whitelist", realms: ["RUGBY", "DAO"] },
      },
    ]);
  });

  test("reads a journal domain", () => {
    expect(parseDomains({ "me.example": { max_downvotes: 3, owner: 8, sub_config: { Journal: 8 } } }))
      .toEqual([
        { name: "me.example", maxDownvotes: 3, owner: 8, scope: { kind: "journal", userId: 8 } },
      ]);
  });

  test("treats a sub-config it does not know as Taggr's own default", () => {
    // `DomainSubConfig::default()` is an empty blacklist.
    expect(parseDomains({ localhost: {} })).toEqual([
      { name: "localhost", maxDownvotes: 0, owner: null, scope: { kind: "blacklist", realms: [] } },
    ]);
  });
});

describe("Rust Result replies", () => {
  test("unwraps Ok", () => {
    expect(unwrapResult({ Ok: 12 })).toBe(12);
    expect(unwrapResult({ Ok: null })).toBeNull();
  });

  test("raises Err with the message Taggr supplied", () => {
    expect(() => unwrapResult({ Err: "not enough credits" })).toThrow(
      "not enough credits",
    );
  });

  test("passes a bare value through", () => {
    expect(unwrapResult(true)).toBe(true);
  });
});

describe("reactions", () => {
  test("maps every configured reaction id to its emoji", () => {
    expect(reactionEmoji(DOWNVOTE_REACTION_ID)).toBe("❌");
    expect(reactionEmoji(10)).toBe("❤️");
    expect(reactionEmoji(11)).toBe("👍");
    expect(reactionEmoji(53)).toBe("🚀");
    expect(reactionEmoji(101)).toBe("🏴‍☠️");
  });

  test("shows an unknown id rather than hiding it", () => {
    expect(reactionEmoji(999)).toBe("#999");
  });
});
