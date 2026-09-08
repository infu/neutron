import { beforeEach, describe, expect, test } from "bun:test";
import {
  conversation,
  feed,
  react,
  realmsByIds,
  mintCreditsWithIcp,
  setTaggrTransport,
  toggleBookmark,
  updateLastActivity,
  validateUsername,
  type TaggrTransport,
} from "../src/taggr_api.ts";

test("realm lookups keep each name associated when unknown realms are omitted", async () => {
  const requests: string[] = [];
  setTaggrTransport({
    query: async (_method, payload) => {
      requests.push(payload);
      return payload === '["KNOWN"]' ? '[{"description":"real realm"}]' : '[]';
    },
    update: async () => { throw new Error("no writes"); },
    addPost: async () => { throw new Error("no writes"); },
  });
  const result = await realmsByIds(["MISSING", "KNOWN"]);
  expect(result.map((realm) => ({ id: realm.id, description: realm.description }))).toEqual([{ id: "KNOWN", description: "real realm" }]);
  expect(requests).toEqual(['["MISSING"]', '["KNOWN"]']);
});

test("malformed realm responses are not silently treated as missing realms", async () => {
  const { install } = transport({ realms: '{"Err":"unavailable"}' });
  install();
  await expect(realmsByIds(["KNOWN"])).rejects.toThrow("unexpected realm list");
});

test("invoice amounts cannot be rounded before the Wallet request", async () => {
  for (const amount of [1.25, Number.MAX_SAFE_INTEGER + 1]) {
    const { install } = transport({ mint_credits_with_icp: JSON.stringify({ Ok: { e8s: amount, paid: false } }) });
    install();
    await expect(mintCreditsWithIcp(0)).rejects.toThrow("no price");
  }
});

type Recorded = { method: string; payload: string };

const transport = (
  replies: Record<string, string>,
): { calls: Recorded[]; install: () => void } => {
  const calls: Recorded[] = [];
  const respond = (method: string, payload: string): Promise<string> => {
    calls.push({ method, payload });
    const reply = replies[method];
    if (reply === undefined) throw new Error(`no fixture for ${method}`);
    return Promise.resolve(reply);
  };
  const fake: TaggrTransport = {
    query: respond,
    update: respond,
    addPost: () => Promise.reject(new Error("not used")),
  };
  return { calls, install: () => setTaggrTransport(fake) };
};

describe("writes", () => {
  test("raise the reason from a serialised Rust Err rather than reporting success", async () => {
    // Taggr answers a forbidden reaction with an ordinary JSON body and no
    // transport-level failure, so an unwrapped write would look like it worked.
    const { install } = transport({
      react: '{"Err":"reactions to own posts are forbidden"}',
    });
    install();
    await expect(react(42, 11)).rejects.toThrow("reactions to own posts are forbidden");
  });

  test("accept an Ok arm", async () => {
    const { install } = transport({ react: '{"Ok":null}' });
    install();
    await expect(react(42, 11)).resolves.toBeUndefined();
  });

  test("pass a bare boolean reply through", async () => {
    const { install } = transport({ toggle_bookmark: "true" });
    install();
    expect(await toggleBookmark(42)).toBe(true);
  });

  test("treat an empty acknowledgement as success", async () => {
    const { install } = transport({ update_last_activity: "" });
    install();
    await expect(updateLastActivity()).resolves.toBeUndefined();
  });
});

describe("reads", () => {
  test("send Taggr's positional argument array for a feed page", async () => {
    const { calls, install } = transport({ last_posts: "[]" });
    install();
    await feed({ domain: "localhost", mode: "new", page: 2 });
    expect(calls).toEqual([
      { method: "last_posts", payload: '["localhost","",2,0,false]' },
    ]);
  });

  test("use hot_posts and personal_feed for the other two modes", async () => {
    const hot = transport({ hot_posts: "[]" });
    hot.install();
    await feed({ domain: "localhost", mode: "hot" });
    expect(hot.calls[0]?.method).toBe("hot_posts");

    const personal = transport({ personal_feed: "[]" });
    personal.install();
    await feed({ domain: "localhost", mode: "personal" });
    expect(personal.calls[0]).toEqual({
      method: "personal_feed",
      payload: '["localhost",0,0]',
    });
  });

  test("keep a read's Err arm as data, because validate_username reports through it", async () => {
    const { install } = transport({ validate_username: '{"Err":"taken"}' });
    install();
    expect(await validateUsername("alice")).toBe("taken");
  });

  test("report an available handle as no error", async () => {
    const { install } = transport({ validate_username: '{"Ok":null}' });
    install();
    expect(await validateUsername("alice")).toBeNull();
  });
});

describe("conversation", () => {
  const post = (id: number, children: number[], parent: number | null) => [
    {
      id,
      body: `post ${id}`,
      user: 1,
      timestamp: 1,
      children,
      parent,
      watchers: [],
      tags: [],
      reactions: {},
      patches: [],
      files: {},
      tree_size: 1,
      tree_update: 1,
      tips: [],
      extension: null,
      realm: null,
      hashes: [],
      reposts: [],
      encrypted: false,
      hidden_for: [],
    },
    { author_name: "alice", viewer_blocked: false, nsfw: false, max_downvotes_reached: false },
  ];

  test("joins the ancestor chain to the focused post's replies", async () => {
    // `thread` gives ancestors only; the replies come from `posts(children)`.
    const { calls, install } = transport({
      thread: JSON.stringify([post(1, [2, 3], null)]),
      posts: JSON.stringify([post(2, [], 1), post(3, [], 1)]),
    });
    install();
    const view = await conversation(1);
    expect(view.focus).toBe(1);
    expect(view.entries.map((entry) => entry.post.id)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.method)).toEqual(["thread", "posts"]);
    expect(calls[1]?.payload).toBe("[2,3]");
  });

  test("skips the second read when the post has no replies", async () => {
    const { calls, install } = transport({ thread: JSON.stringify([post(9, [], null)]) });
    install();
    const view = await conversation(9);
    expect(view.entries.map((entry) => entry.post.id)).toEqual([9]);
    expect(calls.map((call) => call.method)).toEqual(["thread"]);
  });

  test("uses the focused post's children, not the root's", async () => {
    const { calls, install } = transport({
      thread: JSON.stringify([post(1, [2], null), post(2, [5], 1)]),
      posts: JSON.stringify([post(5, [], 2)]),
    });
    install();
    const view = await conversation(2);
    expect(calls[1]?.payload).toBe("[5]");
    expect(view.entries.map((entry) => entry.post.id)).toEqual([1, 2, 5]);
  });
});
