// Typed access to the Taggr network.
//
// Nothing here reaches the network itself: it encodes arguments, hands them to
// a transport, and validates what comes back. The resident background installs
// a transport that calls the Taggr canister directly with this app's own
// identity; the tile installs one that forwards to the background over the
// same-app message bus, because a tile frame is credentialless and cannot hold
// a durable key.
//
// Argument encoding follows Taggr's own frontend convention (`jsonArg` in
// `src/frontend/src/api.ts`): no arguments encode as `null`, exactly one
// argument encodes bare, several encode as a JSON array.

import {
  parseDomains,
  parseFeed,
  parseJson,
  parseRealm,
  parseRealmPairs,
  parseSearchResults,
  parseStats,
  parseTags,
  parseUser,
  parseUserNames,
  TaggrParseError,
  unwrapResult,
  type FeedEntry,
  type PostId,
  type Realm,
  type TaggrDomain,
  type RealmId,
  type SearchResult,
  type TaggrStats,
  type TaggrUser,
  type UserId,
} from "./model.ts";
import { encodeArgs, type AddPostInput } from "./taggr_client.ts";

export { encodeArgs, MAX_POST_BYTES } from "./taggr_client.ts";
export type { AddPostInput } from "./taggr_client.ts";

export type FeedMode = "hot" | "new" | "personal";
export type RealmOrder = "popularity" | "name" | "activity";

/** Taggr's `CONFIG.feed_page_size`. */
export const FEED_PAGE_SIZE = 30;

/**
 * The two halves of Taggr's wire plus its one Candid method. `query` is a
 * non-replicated read and `update` goes through consensus; the transport
 * decides how each is carried.
 */
export type TaggrTransport = {
  query: (method: string, payload: string) => Promise<string>;
  update: (method: string, payload: string) => Promise<string>;
  addPost: (input: AddPostInput) => Promise<PostId>;
};

let transport: TaggrTransport | null = null;

export const setTaggrTransport = (value: TaggrTransport): void => {
  transport = value;
};

const active = (): TaggrTransport => {
  if (!transport) {
    throw new TaggrParseError("The Taggr transport has not been configured yet");
  }
  return transport;
};

const read = async (method: string, ...args: unknown[]): Promise<unknown> =>
  parseJson(await active().query(method, encodeArgs(args)));

/**
 * Taggr's mutating endpoints reply with a serialised Rust `Result`: an `Err`
 * arm carries the reason as ordinary JSON with no transport-level failure, so
 * an unwrapped write would report success while nothing happened. Endpoints
 * that reply with a bare value or no body at all pass straight through.
 */
const write = async (method: string, ...args: unknown[]): Promise<unknown> =>
  unwrapResult(parseJson(await active().update(method, encodeArgs(args))));

/* ------------------------------------------------------------------ */
/* reading and browsing                                                */
/* ------------------------------------------------------------------ */

export const feed = async (input: {
  domain: string;
  mode: FeedMode;
  realm?: RealmId | null;
  page?: number;
  /** Post id to page from; 0 starts at the newest post. */
  offset?: PostId;
  /** Taggr's personal noise filter; only meaningful outside a realm. */
  filtered?: boolean;
}): Promise<FeedEntry[]> => {
  const page = input.page ?? 0;
  const offset = input.offset ?? 0;
  if (input.mode === "personal") {
    return parseFeed(await read("personal_feed", input.domain, page, offset));
  }
  const method = input.mode === "hot" ? "hot_posts" : "last_posts";
  return parseFeed(
    await read(
      method,
      input.domain,
      input.realm ?? "",
      page,
      offset,
      input.filtered ?? false,
    ),
  );
};

export const tagFeed = async (input: {
  domain: string;
  realm?: RealmId | null;
  tags: string[];
  page?: number;
  offset?: PostId;
}): Promise<FeedEntry[]> =>
  parseFeed(
    await read(
      "posts_by_tags",
      input.domain,
      input.realm ?? "",
      input.tags,
      input.page ?? 0,
      input.offset ?? 0,
    ),
  );

/**
 * Taggr's `thread` returns the ancestor chain — root first, ending at the
 * requested post — not its replies. See `State::thread` in
 * `src/backend/env/mod.rs`, which walks `parent` upwards and reverses.
 */
export const ancestors = async (id: PostId): Promise<FeedEntry[]> =>
  parseFeed(await read("thread", id));

export const postsByIds = async (ids: PostId[]): Promise<FeedEntry[]> =>
  ids.length === 0 ? [] : parseFeed(await read("posts", ids));

/**
 * A readable conversation: the ancestor chain that leads to the post, then its
 * direct replies. Two reads, because Taggr exposes the two halves separately
 * and a post carries only the ids of its children.
 */
export const conversation = async (
  id: PostId,
): Promise<{ entries: FeedEntry[]; focus: PostId }> => {
  const chain = await ancestors(id);
  const focused = chain.find((entry) => entry.post.id === id) ?? chain[chain.length - 1];
  const replyIds = focused?.post.children ?? [];
  const replies = await postsByIds(replyIds.slice(0, FEED_PAGE_SIZE));
  return { entries: [...chain, ...replies], focus: id };
};

export const userPosts = async (input: {
  domain: string;
  handle: string;
  page?: number;
  offset?: PostId;
}): Promise<FeedEntry[]> =>
  parseFeed(
    await read("user_posts", input.domain, input.handle, input.page ?? 0, input.offset ?? 0),
  );

export const journal = async (input: {
  domain: string;
  handle: string;
  page?: number;
  offset?: PostId;
}): Promise<FeedEntry[]> =>
  parseFeed(
    await read("journal", input.domain, input.handle, input.page ?? 0, input.offset ?? 0),
  );

export const search = async (domain: string, query: string): Promise<SearchResult[]> =>
  parseSearchResults(await read("search", domain, query));

/* ------------------------------------------------------------------ */
/* discovery                                                          */
/* ------------------------------------------------------------------ */

/**
 * `realm_search` is preferred over `all_realms` for browsing: it clears each
 * realm's post-id vector and caps at 100 entries, so the reply stays small.
 * An empty query matches every realm.
 */
export const browseRealms = async (input: {
  domain: string;
  order?: RealmOrder;
  query?: string;
}): Promise<Realm[]> =>
  parseRealmPairs(
    await read("realm_search", input.domain, input.order ?? "popularity", input.query ?? ""),
  );

export const realmsByIds = async (ids: RealmId[]): Promise<Realm[]> => {
  if (ids.length === 0) return [];
  // The endpoint drops unknown ids and its bodies do not contain their names.
  // Read each name separately so an absent first result cannot relabel the
  // next realm as the missing one.
  const resolved = await Promise.all(ids.map(async (id) => {
    const value = await read("realms", [id]);
    if (!Array.isArray(value)) throw new TaggrParseError("Taggr returned an unexpected realm list");
    return value.length === 0 ? [] : [parseRealm(id, value[0])];
  }));
  return resolved.flat();
};

export const recentTags = async (input: {
  domain: string;
  realm?: RealmId | null;
  limit?: number;
}): Promise<Array<{ tag: string; weight: number }>> =>
  parseTags(await read("recent_tags", input.domain, input.realm ?? "", input.limit ?? 60));

export const domains = async (): Promise<TaggrDomain[]> =>
  parseDomains(await read("domains"));

export const stats = async (): Promise<TaggrStats> => parseStats(await read("stats"));

/* ------------------------------------------------------------------ */
/* people                                                              */
/* ------------------------------------------------------------------ */

/** Omit `handle` to fetch the profile of this app's own identity. */
export const user = async (
  domain: string,
  handle?: string | null,
): Promise<TaggrUser | null> =>
  parseUser(await read("user", domain, handle ? [handle] : []));

export const userNames = async (ids: UserId[]): Promise<Map<UserId, string>> =>
  ids.length === 0 ? new Map() : parseUserNames(await read("users_data", ids));

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

export const addPost = (input: AddPostInput): Promise<PostId> => active().addPost(input);

/** Reaction ids come from `REACTIONS`; each one costs the account 1 credit. */
export const react = async (postId: PostId, reactionId: number): Promise<void> => {
  await write("react", postId, reactionId);
};

export const toggleBookmark = async (postId: PostId): Promise<boolean> =>
  (await write("toggle_bookmark", postId)) === true;

export const toggleFollowingUser = async (userId: UserId): Promise<boolean> =>
  (await write("toggle_following_user", userId)) === true;

export const toggleRealmMembership = async (realm: RealmId): Promise<boolean> =>
  (await write("toggle_realm_membership", realm)) === true;

export const voteOnPoll = async (
  postId: PostId,
  option: number,
  anonymously = false,
): Promise<void> => {
  await write("vote_on_poll", postId, option, anonymously);
};

export const createUser = async (name: string, inviteCode: string): Promise<void> => {
  await write("create_user", name, inviteCode);
};

export type TaggrInvoice = {
  /** Cost of one kilo-credit in e8s, fixed when the invoice was created. */
  amountAtoms: string;
  paid: boolean;
};

/**
 * `mint_credits_with_icp` doubles as the invoice reader. With `kiloCredits` 0 it
 * creates the invoice at the current XDR rate if there is none and returns it
 * rather than erroring on an unpaid balance; with 1 it settles a funded invoice.
 * Taggr's `Invoices::outstanding_icp_invoice` is the authority for both.
 */
export const mintCreditsWithIcp = async (
  kiloCredits: number,
): Promise<TaggrInvoice> => {
  const value = await write("mint_credits_with_icp", kiloCredits);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaggrParseError("Taggr returned an unexpected invoice");
  }
  const invoice = value as Record<string, unknown>;
  const amount = invoice.e8s;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new TaggrParseError("Taggr returned an invoice with no price");
  }
  return { amountAtoms: String(amount), paid: invoice.paid === true };
};

export const updateLastActivity = async (): Promise<void> => {
  await write("update_last_activity");
};

export const validateUsername = async (name: string): Promise<string | null> => {
  const value = await read("validate_username", name);
  // Replies with a serialised `Result<(), String>`: `null` on success.
  if (value && typeof value === "object" && "Err" in value) {
    const message = (value as { Err: unknown }).Err;
    return typeof message === "string" ? message : "Invalid username";
  }
  return null;
};
