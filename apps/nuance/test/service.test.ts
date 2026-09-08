import { beforeAll, beforeEach, expect, test } from "bun:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Api } from "../src/api";

type Handler = (args: Record<string, unknown>, context: { kernel: unknown }) => Promise<any>;
let handlers: Map<string, Handler>;
let createApi: (caller: unknown) => Api;
let fixture: {
  article: Record<string, unknown>;
  comments: { comments: unknown[]; totalNumberOfComments: string };
  commentsError: string | null;
};

beforeAll(async () => {
  // Bundle the real registrations and API together. Only the two external
  // transports are substituted; no global module mock can leak into other tests.
  const result = await build({
    stdin: {
      contents: `
        import "./service";
        export { handlers } from "neutron-tools/app";
        export { fixture } from "./nuance/client";
        export { createApi } from "./api";
      `,
      resolveDir: fileURLToPath(new URL("../src", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    plugins: [{
      name: "nuance-test-transports",
      setup(plugin) {
        plugin.onResolve({ filter: /^neutron-tools\/app$/ }, () => ({ path: "sdk", namespace: "fixture" }));
        plugin.onResolve({ filter: /^\.\/nuance\/client$/ }, () => ({ path: "nuance", namespace: "fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: "js",
          contents: path === "sdk" ? `
            export const handlers = new Map();
            export function exposeTool(name, options, handler) { handlers.set(name, handler); }
            export async function publishAppStateChange() {}
            export async function querySelf() { throw new Error("Unscoped query used"); }
            export async function updateSelf() { throw new Error("Unscoped update used"); }
          ` : `
            export const fixture = {
              article: {
                postId: "42", title: "An article", subtitle: "", handle: "writer",
                content: "<p>Article body</p>", url: "/writer/an-article-42",
                headerImage: "", publishedDate: "1", wordCount: "2",
                isDraft: false, isPremium: false, isMembersOnly: false,
              },
              comments: { comments: [], totalNumberOfComments: "0" },
              commentsError: null,
            };
            export async function getArticle() { return fixture.article; }
            export async function keyPropertiesFor() { return []; }
            export async function getComments() {
              if (fixture.commentsError) throw new Error(fixture.commentsError);
              return fixture.comments;
            }
            export async function profilesFor() { return []; }
            export async function feedIndex() { return { posts: [], totalCount: "0" }; }
            export async function hydrate() { return []; }
            export async function search() { return []; }
            export async function relatedPosts() { return []; }
            export async function getTags() { return []; }
            export async function getBuckets() { return []; }
            export async function profileFor() { return null; }
            export async function dailyAllowance() { return "0"; }
          `,
        }));
      },
    }],
  });
  const module = { exports: {} as any };
  new Function("module", "exports", result.outputFiles![0]!.text)(module, module.exports);
  ({ handlers, createApi, fixture } = module.exports);
});

beforeEach(() => {
  fixture.commentsError = null;
});

test("the registered read tool preserves the API's absolute article link", async () => {
  const result = await handlers.get("nuance_read")!({ postId: "42", bucketCanisterId: "bucket" }, { kernel: {} });
  expect(result.url).toBe("https://nuance.xyz/writer/an-article-42");
  expect(result.text).toBe("Article body");
  expect(result.truncated).toBe(false);
});

test("registered draft tools keep the supplied scoped backend client", async () => {
  const calls: unknown[] = [];
  const draft = { id: "d1", revision: "2", body: "draft" };
  const result = await handlers.get("nuance_draft_read")!({ id: "d1" }, {
    kernel: {
      async querySelf(method: string, args: unknown[]) {
        calls.push([method, args]);
        return draft;
      },
    },
  });
  expect(result).toEqual(draft);
  expect(calls).toEqual([["nuance_draft_read", ["d1"]]]);
});

test("a confirmed comment remains successful when the subsequent public read fails", async () => {
  fixture.commentsError = "Public query unavailable";
  const calls: unknown[] = [];
  const api = createApi({
    async update(method: string, args: unknown[]) {
      calls.push([method, args]);
      return "Comment posted.";
    },
  });
  const input = { postId: "42", bucketCanisterId: "bucket", content: "A comment" };
  expect(await api.comment(input)).toEqual({
    ok: {
      confirmed: true,
      message: "Comment posted.",
      refreshed: false,
      refreshError: "Public query unavailable",
    },
  });
  expect(calls).toEqual([["nuance_comment", [input]]]);
});

test("the reply tool reports the acknowledged write rather than an error after refresh failure", async () => {
  fixture.commentsError = "Public query unavailable";
  let writes = 0;
  const result = await handlers.get("nuance_reply")!({ postId: "42", bucketCanisterId: "bucket", content: "A comment" }, {
    kernel: {
      async updateSelf() { writes += 1; return "Comment posted."; },
    },
  });
  expect(result).toEqual({
    confirmed: true,
    message: "Comment posted.",
    refreshed: false,
    refreshError: "Public query unavailable",
  });
  expect(writes).toBe(1);
});

test("a confirmed vote preserves its acknowledgement when refresh fails", async () => {
  fixture.commentsError = "Public query unavailable";
  const calls: unknown[] = [];
  const api = createApi({
    async update(method: string, args: unknown[]) {
      calls.push([method, args]);
      return "Vote recorded.";
    },
  });
  expect(await api.voteComment("bucket", "comment", "up", "42")).toEqual({
    ok: {
      confirmed: true,
      message: "Vote recorded.",
      refreshed: false,
      refreshError: "Public query unavailable",
    },
  });
  expect(calls).toEqual([["nuance_vote_comment", [["bucket", "comment", "up"]]]]);
});

test("a successful comment refresh still returns its page", async () => {
  const api = createApi({ update: async () => "Comment posted." });
  expect(await api.comment({ postId: "42", bucketCanisterId: "bucket", content: "A comment" })).toEqual({
    ok: { confirmed: true, message: "Comment posted.", refreshed: true, comments: [], total: "0" },
  });
});

test("a rejected comment write is still reported as an error", async () => {
  const api = createApi({ update: async () => { throw new Error("Comment rejected"); } });
  expect(await api.comment({ postId: "42", bucketCanisterId: "bucket", content: "A comment" })).toEqual({ err: "Comment rejected" });
});
