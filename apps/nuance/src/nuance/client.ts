// Direct, anonymous reads from the Nuance canisters.
//
// Why this exists at all: every Nuance read is a public `query`. Routing one
// through this app's Motoko backend turns a free browser query into a replicated
// inter-canister *update* that the Neutron owner pays for -- roughly 1.2M cycles
// of ingress reception, 5M of update execution, and 260k per brokered call,
// before any instructions. Reading an article that way also made the canister
// re-parse the whole HTML body just to produce a plain-text field the tile then
// discarded.
//
// So reads happen here, in the browser, at no cost to the owner. Only work that
// genuinely needs the Neutron's identity -- publishing, commenting, voting,
// registering, and anything caller-scoped -- goes through the backend.
//
// Two honest consequences of the change:
//
//   * Query replies are not certified. The boundary node is trusted for display
//     data, exactly as it is for any web page reading the IC. Writes still go
//     through the backend and remain consensus-verified.
//   * The reader's IP is visible to the IC boundary node, where previously the
//     canister made the request. Nothing else about the reader is sent: no
//     identity, no credential, no Neutron canister id.

import { Actor, HttpAgent, type ActorSubclass } from "@icp-sdk/core/agent";
import {
  NUANCE_HOST,
  POST_CORE_ID,
  POST_RELATIONS_ID,
  USER_ID,
  postBucketIdl,
  postCoreIdl,
  postRelationsIdl,
  userIdl,
} from "./idl";

export type KeyProperties = {
  postId: string;
  bucketCanisterId: string;
  handle: string;
  claps: string;
  views: string;
  created: string;
  modified: string;
  publishedDate: string;
  isDraft: boolean;
  tags: { tagId: string; tagName: string }[];
};

export type BucketPost = {
  postId: string;
  bucketCanisterId: string;
  title: string;
  subtitle: string;
  content: string;
  handle: string;
  creatorHandle: string;
  headerImage: string;
  url: string;
  wordCount: string;
  publishedDate: string;
  created: string;
  modified: string;
  isDraft: boolean;
  isPremium: boolean;
  isMembersOnly: boolean;
  isPublication: boolean;
  postOwnerPrincipal: string;
};

export type RawComment = {
  commentId: string;
  postId: string;
  bucketCanisterId: string;
  content: string;
  creator: string;
  handle: string;
  avatar: string;
  createdAt: string;
  isCensored: boolean;
  isVerified: boolean;
  upVotes: string[];
  downVotes: string[];
  repliedCommentId: [] | [string];
  replies: RawComment[];
};

export type UserListItem = {
  principal: string;
  handle: string;
  displayName: string;
  avatar: string;
  isVerified: boolean;
};

type Variant<T> = { ok: T } | { err: string };

let agentPromise: Promise<HttpAgent> | undefined;
const actors = new Map<string, ActorSubclass>();

function agent(): Promise<HttpAgent> {
  // One agent for the page. Mainnet, so no root key fetch.
  //
  // A rejected promise must not stay in the cache: agent creation syncs time
  // with the boundary node, so a tile opened while the network is briefly down
  // would otherwise be stuck with a permanently failing agent for the life of
  // the page, and every retry button in the UI would be inert.
  agentPromise ??= HttpAgent.create({ host: NUANCE_HOST }).catch((error: unknown) => {
    agentPromise = undefined;
    throw error;
  });
  return agentPromise;
}

async function actorFor(
  canisterId: string,
  idl: Parameters<typeof Actor.createActor>[0],
): Promise<ActorSubclass> {
  const cached = actors.get(canisterId);
  if (cached) return cached;
  const created = Actor.createActor(idl, {
    agent: await agent(),
    canisterId,
  });
  actors.set(canisterId, created);
  return created;
}

const core = () => actorFor(POST_CORE_ID, postCoreIdl as never);
const user = () => actorFor(USER_ID, userIdl as never);
const relations = () => actorFor(POST_RELATIONS_ID, postRelationsIdl as never);
const bucket = (id: string) => actorFor(id, postBucketIdl as never);

function call<T>(actor: ActorSubclass, method: string, args: unknown[]): Promise<T> {
  const fn = (actor as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[
    method
  ];
  if (!fn) throw new Error(`Nuance canister has no method ${method}`);
  return fn(...args);
}

function unwrap<T>(value: Variant<T>, what: string): T {
  if ("err" in value) throw new Error(value.err);
  if (!("ok" in value)) throw new Error(`Nuance returned an unexpected ${what}`);
  return value.ok;
}

const FEED_METHOD: Record<string, string> = {
  latest: "getLatestPosts",
  popular: "getPopular",
  popular_today: "getPopularToday",
  popular_week: "getPopularThisWeek",
  popular_month: "getPopularThisMonth",
};

// ------------------------------------------------------------------ reads

export async function feedIndex(
  source: string,
  offset: number,
  limit: number,
): Promise<{ posts: KeyProperties[]; totalCount: string }> {
  const method = FEED_METHOD[source] ?? FEED_METHOD.latest!;
  return call(await core(), method, [offset, offset + limit]);
}

export async function keyPropertiesFor(postIds: string[]): Promise<KeyProperties[]> {
  if (postIds.length === 0) return [];
  return call(await core(), "getPostsByPostIds", [postIds]);
}

/// Nuance shards article bodies across bucket canisters, and the index rows carry
/// no title. This is the same two-phase read Nuance's own frontend performs.
export async function hydrate(
  keys: KeyProperties[],
  includeDraft = false,
): Promise<BucketPost[]> {
  const byBucket = new Map<string, string[]>();
  for (const key of keys) {
    // An empty shard id means the post has no bucket mapping; it is unfetchable.
    if (!key.bucketCanisterId) continue;
    const list = byBucket.get(key.bucketCanisterId) ?? [];
    list.push(key.postId);
    byBucket.set(key.bucketCanisterId, list);
  }

  const pages = await Promise.all(
    [...byBucket.entries()].map(async ([id, ids]) => {
      try {
        return await call<BucketPost[]>(await bucket(id), "getPostsByPostIds", [
          ids,
          includeDraft,
        ]);
      } catch {
        // One shard failing must not blank the whole page.
        return [] as BucketPost[];
      }
    }),
  );
  return pages.flat();
}

export async function getArticle(
  bucketCanisterId: string,
  postId: string,
): Promise<BucketPost> {
  return unwrap(
    await call<Variant<BucketPost>>(await bucket(bucketCanisterId), "getPost", [postId]),
    "article",
  );
}

export async function getComments(
  bucketCanisterId: string,
  postId: string,
): Promise<{ comments: RawComment[]; totalNumberOfComments: string }> {
  return unwrap(
    await call<Variant<{ comments: RawComment[]; totalNumberOfComments: string }>>(
      await bucket(bucketCanisterId),
      "getPostComments",
      [postId],
    ),
    "comment list",
  );
}

export async function getTags(): Promise<[string, string][]> {
  const tags = await call<{ id: string; value: string }[]>(await core(), "getAllTags", []);
  return tags.map((tag) => [tag.id, tag.value]);
}

export async function getBuckets(): Promise<string[]> {
  const pairs = await call<[string, string][]>(await core(), "getBucketCanisters", []);
  return pairs.map(([id]) => id).filter((id) => id !== "");
}

export async function dailyAllowance(): Promise<string> {
  const value = await call<bigint>(await core(), "getUserDailyAllowedPostNumber", []);
  return value.toString();
}

export async function search(term: string): Promise<string[]> {
  return call(await relations(), "searchPost", [term]);
}

export async function relatedPosts(postId: string): Promise<string[]> {
  return call(await relations(), "getRelatedPosts", [postId]);
}

export async function profilesFor(principalIds: string[]): Promise<UserListItem[]> {
  if (principalIds.length === 0) return [];
  return call(await user(), "getUsersByPrincipals", [principalIds]);
}

/// Nuance reports an unknown principal as `err`, which is simply the state before
/// this Neutron has registered a handle. That is not an error here.
export async function profileFor(
  principalId: string,
): Promise<{ handle: string; displayName: string; avatar: string } | null> {
  const value = await call<Variant<{ handle: string; displayName: string; avatar: string }>>(
    await user(),
    "getUserByPrincipalId",
    [principalId],
  );
  return "ok" in value ? value.ok : null;
}
