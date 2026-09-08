import { describe, expect, test } from "bun:test";
import {
  canonicalDomain,
  describeDomain,
  findDomain,
  postSuppression,
  resolveDomain,
  suppressionMessage,
} from "../src/domain.ts";
import { DOWNVOTE_REACTION_ID, type Post, type PostMeta, type TaggrDomain } from "../src/model.ts";

const MAINNET = "6qfxa-ryaaa-aaaai-qbhsq-cai";

const domain = (over: Partial<TaggrDomain> = {}): TaggrDomain => ({
  name: "example.test",
  maxDownvotes: 15,
  owner: null,
  scope: { kind: "blacklist", realms: [] },
  ...over,
});

// The three DAO-managed entries mainnet Taggr actually answers with, plus one
// community domain, so the resolution order is tested against real data.
const MAINNET_DOMAINS: TaggrDomain[] = [
  domain({ name: `${MAINNET}.ic0.app` }),
  domain({ name: `${MAINNET}.icp0.io` }),
  domain({ name: "localhost", maxDownvotes: 0 }),
  domain({
    name: "taggr.network",
    maxDownvotes: 2,
    owner: 305,
    scope: { kind: "whitelist", realms: ["RUGBY"] },
  }),
];

const post = (over: Partial<Post> = {}): Post => ({
  id: 1,
  body: "hello",
  user: 7,
  timestamp: 0,
  parent: null,
  children: [],
  tags: [],
  realm: null,
  reactions: [],
  files: [],
  treeSize: 1,
  extension: null,
  ...over,
});

const meta = (over: Partial<PostMeta> = {}): PostMeta => ({
  authorName: "alice",
  nsfw: false,
  realmColor: null,
  viewerBlocked: false,
  maxDownvotesReached: false,
  ...over,
});

const downvotes = (count: number) => [
  { id: DOWNVOTE_REACTION_ID, users: Array.from({ length: count }, (_unused, index) => index) },
];

describe("choosing a domain to read as", () => {
  test("prefers the deployment's canonical domain, which is what Taggr calls it", () => {
    // `getCanonicalDomain()` in Taggr's own client is `${canister_id}.icp0.io`.
    expect(resolveDomain({ canister: MAINNET, domains: MAINNET_DOMAINS })).toBe(
      canonicalDomain(MAINNET),
    );
  });

  test("falls back to the older boundary host, then to localhost", () => {
    const withoutCanonical = MAINNET_DOMAINS.filter(
      (entry) => entry.name !== canonicalDomain(MAINNET),
    );
    expect(resolveDomain({ canister: MAINNET, domains: withoutCanonical })).toBe(
      `${MAINNET}.ic0.app`,
    );
    // A local deployment registers nothing but the wildcard `State::init()` adds.
    expect(
      resolveDomain({ canister: MAINNET, domains: [domain({ name: "localhost" })] }),
    ).toBe("localhost");
  });

  test("never picks a community domain on its own", () => {
    // Those carry someone else's realm policy, so they are opt-in only.
    expect(
      resolveDomain({ canister: MAINNET, domains: [domain({ name: "taggr.network", owner: 305 })] }),
    ).toBe(canonicalDomain(MAINNET));
  });

  test("honours a domain the owner pinned", () => {
    expect(
      resolveDomain({ canister: MAINNET, domains: MAINNET_DOMAINS, preferred: "taggr.network" }),
    ).toBe("taggr.network");
  });

  test("drops a pinned domain the deployment no longer has", () => {
    expect(
      resolveDomain({ canister: MAINNET, domains: MAINNET_DOMAINS, preferred: "gone.example" }),
    ).toBe(canonicalDomain(MAINNET));
  });

  test("keeps a pinned domain when the list could not be read", () => {
    // An offline canister must not silently move the owner off their choice.
    expect(resolveDomain({ canister: MAINNET, domains: [], preferred: "taggr.network" })).toBe(
      "taggr.network",
    );
  });

  test("still names something when the deployment answers nothing", () => {
    expect(resolveDomain({ canister: MAINNET, domains: [] })).toBe(canonicalDomain(MAINNET));
  });
});

describe("what a domain suppresses", () => {
  test("shows an ordinary post", () => {
    expect(postSuppression({ post: post(), meta: meta(), domain: domain() })).toBeNull();
  });

  test("suppresses a post past the realm's own downvote ceiling, naming the realm", () => {
    // `Post::with_meta` sets this from the realm, not the domain, so it holds
    // wherever the post is read.
    const result = postSuppression({
      post: post({ realm: "DAO" }),
      meta: meta({ maxDownvotesReached: true }),
      domain: domain(),
    });
    expect(result).toEqual({ by: "realm", where: "DAO" });
    expect(suppressionMessage(result!)).toContain("DAO");
  });

  test("suppresses a post past the domain's downvote ceiling", () => {
    const strict = domain({ name: "localhost", maxDownvotes: 0 });
    expect(
      postSuppression({ post: post({ reactions: downvotes(1) }), meta: meta(), domain: strict }),
    ).toEqual({ by: "domain", where: "localhost" });
    // Exactly at the ceiling is still shown: Taggr's check is `>`, not `>=`.
    expect(
      postSuppression({
        post: post({ reactions: downvotes(2) }),
        meta: meta(),
        domain: domain({ maxDownvotes: 2 }),
      }),
    ).toBeNull();
  });

  test("counts only downvotes, not every reaction", () => {
    expect(
      postSuppression({
        post: post({ reactions: [{ id: 11, users: [1, 2, 3, 4] }] }),
        meta: meta(),
        domain: domain({ maxDownvotes: 0 }),
      }),
    ).toBeNull();
  });

  test("applies a whitelist domain's realm list", () => {
    const only = domain({ name: "taggr.network", scope: { kind: "whitelist", realms: ["RUGBY"] } });
    expect(postSuppression({ post: post({ realm: "RUGBY" }), meta: meta(), domain: only })).toBeNull();
    expect(
      postSuppression({ post: post({ realm: "DAO" }), meta: meta(), domain: only }),
    ).toEqual({ by: "domain", where: "taggr.network" });
    // A post outside every realm is not on the whitelist either.
    expect(postSuppression({ post: post(), meta: meta(), domain: only })).toBeNull();
  });

  test("applies a blacklist domain's realm list", () => {
    const most = domain({
      name: "taggr-gallery.promptops.cc",
      scope: { kind: "blacklist", realms: ["TAGGRDEV", "DAO"] },
    });
    expect(postSuppression({ post: post({ realm: "DAO" }), meta: meta(), domain: most })).toEqual({
      by: "domain",
      where: "taggr-gallery.promptops.cc",
    });
    expect(
      postSuppression({ post: post({ realm: "PHOTOGRAPHY" }), meta: meta(), domain: most }),
    ).toBeNull();
  });

  test("suppresses nothing for a domain the deployment does not know", () => {
    // The backend's own filter already returned an empty feed for it; there is
    // no config to apply and nothing to hide.
    expect(postSuppression({ post: post({ realm: "DAO" }), meta: meta(), domain: null })).toBeNull();
  });
});

describe("describing a domain", () => {
  test("says who runs it, what it shows, and where it draws the line", () => {
    expect(describeDomain(domain())).toBe(
      "DAO-managed, every realm, hides posts past 15 downvotes",
    );
    expect(
      describeDomain(
        domain({ owner: 305, maxDownvotes: 1, scope: { kind: "whitelist", realms: ["RUGBY"] } }),
      ),
    ).toBe("community-run, only 1 realm, hides posts past 1 downvote");
    expect(describeDomain(domain({ scope: { kind: "journal", userId: 8 } }))).toContain("journal");
    expect(
      describeDomain(domain({ scope: { kind: "blacklist", realms: ["A", "B"] } })),
    ).toContain("every realm but 2");
  });
});

describe("finding a domain", () => {
  test("returns the config or null, never a guess", () => {
    expect(findDomain(MAINNET_DOMAINS, "localhost")?.maxDownvotes).toBe(0);
    expect(findDomain(MAINNET_DOMAINS, "nope.example")).toBeNull();
  });
});
