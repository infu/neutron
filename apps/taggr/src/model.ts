// Types and parsers for Taggr's JSON wire.
//
// Taggr replies with `serde_json` output straight from its Rust structs, so the
// shapes here mirror `src/backend/env/*.rs` rather than any Candid interface.
// Everything crossing the boundary is validated instead of cast: the reply is
// remote, untrusted data and a missing field should surface as a readable error
// rather than as `undefined` deep inside a render.

export type PostId = number;
export type UserId = number;
export type RealmId = string;

/** Reaction id -> emoji, from Taggr's `reaction2icon`. */
export const REACTIONS: ReadonlyArray<{
  id: number;
  emoji: string;
  label: string;
}> = [
  { id: 11, emoji: "👍", label: "Thumbs up" },
  { id: 10, emoji: "❤️", label: "Heart" },
  { id: 51, emoji: "😂", label: "Joy" },
  { id: 50, emoji: "🔥", label: "Fire" },
  { id: 52, emoji: "💯", label: "Hundred" },
  { id: 53, emoji: "🚀", label: "Rocket" },
  { id: 100, emoji: "⭐️", label: "Star" },
  { id: 101, emoji: "🏴‍☠️", label: "Pirate" },
  { id: 12, emoji: "😢", label: "Sad" },
];

/** Taggr's `DOWNVOTE_REACTION_ID`. Shown apart from the positive reactions. */
export const DOWNVOTE_REACTION_ID = 1;

export const reactionEmoji = (id: number): string =>
  id === DOWNVOTE_REACTION_ID
    ? "❌"
    : (REACTIONS.find((reaction) => reaction.id === id)?.emoji ?? `#${id}`);

export type PostExtension =
  | { kind: "poll"; options: string[]; votes: Record<number, UserId[]>; deadline: number }
  | { kind: "repost"; postId: PostId }
  | { kind: "proposal"; proposalId: number }
  | { kind: "other"; name: string };

/**
 * One attachment. Taggr keys its `files` map `"<id>@<bucket>"` and stores the
 * byte range as `[offset, len]`; the post body references the same `<id>` as
 * `![alt](/blob/<id>)`.
 */
export type PostFile = {
  id: string;
  bucket: string;
  offset: number;
  len: number;
};

export type Post = {
  id: PostId;
  body: string;
  user: UserId;
  /** Nanoseconds since the epoch, as Taggr stores it. */
  timestamp: number;
  parent: PostId | null;
  children: PostId[];
  tags: string[];
  realm: RealmId | null;
  reactions: Array<{ id: number; users: UserId[] }>;
  files: PostFile[];
  treeSize: number;
  extension: PostExtension | null;
};

export type PostMeta = {
  authorName: string;
  nsfw: boolean;
  realmColor: string | null;
  viewerBlocked: boolean;
  /**
   * Set by `Post::with_meta` from the post's *realm* downvote ceiling, not the
   * domain's. Taggr's own client suppresses these posts wherever they appear.
   */
  maxDownvotesReached: boolean;
};

export type FeedEntry = { post: Post; meta: PostMeta };

export type DomainScope =
  | { kind: "blacklist"; realms: RealmId[] }
  | { kind: "whitelist"; realms: RealmId[] }
  | { kind: "journal"; userId: UserId };

/** One hostname's view of the network, from Taggr's `DomainConfig`. */
export type TaggrDomain = {
  name: string;
  /** Posts with more downvotes than this are suppressed on this domain. */
  maxDownvotes: number;
  /** `null` when the DAO manages the domain rather than one user. */
  owner: UserId | null;
  scope: DomainScope;
};


export type TaggrUser = {
  id: UserId;
  name: string;
  about: string;
  principal: string;
  numPosts: number;
  followers: UserId[];
  followees: UserId[];
  realms: RealmId[];
  balance: number;
  rewards: number;
  credits: number;
  stalwart: boolean;
  timestamp: number;
};

export type Realm = {
  id: RealmId;
  description: string;
  logo: string;
  labelColor: string;
  numMembers: number;
  numPosts: number;
  adultContent: boolean;
  controllers: UserId[];
};

export type SearchResult = {
  /** Post id for `post`, user id for `user`; otherwise the wire default is 0. */
  id: PostId;
  /** Author of a post result, not the target id of a user result. */
  userId: UserId;
  /** Realm name for `realm` results. */
  genericId: string;
  /** Protocol result kind: `post`, `user`, `realm`, or `tag`. */
  result: string;
  /** Display snippet; for `tag` results, the tag itself without `#`. */
  relevant: string;
};

export type TaggrStats = {
  users: number;
  usersOnline: number;
  posts: number;
  comments: number;
  realms: number;
  canisterCycleBalance: number;
};

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

export class TaggrParseError extends Error {}

const fail = (label: string): never => {
  throw new TaggrParseError(`Taggr returned an unexpected ${label}`);
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(label);

const array = (value: unknown, label: string): unknown[] =>
  Array.isArray(value) ? value : fail(label);

const num = (value: unknown, label: string): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(label);

const str = (value: unknown, label: string): string =>
  typeof value === "string" ? value : fail(label);

const optionalStr = (value: unknown, label: string): string | null =>
  value === null || value === undefined ? null : str(value, label);

const optionalNum = (value: unknown, label: string): number | null =>
  value === null || value === undefined ? null : num(value, label);

const numArray = (value: unknown, label: string): number[] =>
  value === null || value === undefined
    ? []
    : array(value, label).map((entry) => num(entry, label));

const strArray = (value: unknown, label: string): string[] =>
  value === null || value === undefined
    ? []
    : array(value, label).map((entry) => str(entry, label));

/** Taggr replies with `null` bodies for the acknowledge-only endpoints. */
export const parseJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new TaggrParseError("Taggr reply was not valid JSON");
  }
};

/* ------------------------------------------------------------------ */
/* domain parsers                                                      */
/* ------------------------------------------------------------------ */

const parseExtension = (value: unknown): PostExtension | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { kind: "other", name: value };
  const entry = record(value, "post extension");
  if ("Poll" in entry) {
    const poll = record(entry.Poll, "poll");
    const votes: Record<number, UserId[]> = {};
    for (const [key, ids] of Object.entries(record(poll.votes ?? {}, "poll votes"))) {
      votes[Number(key)] = numArray(ids, "poll votes");
    }
    return {
      kind: "poll",
      options: strArray(poll.options, "poll options"),
      votes,
      deadline: num(poll.deadline ?? 0, "poll deadline"),
    };
  }
  if ("Repost" in entry) return { kind: "repost", postId: num(entry.Repost, "repost id") };
  if ("Proposal" in entry)
    return { kind: "proposal", proposalId: num(entry.Proposal, "proposal id") };
  return { kind: "other", name: Object.keys(entry)[0] ?? "unknown" };
};

/** `"<id>@<bucket>"` -> the two halves. Split on the last `@`, because a Taggr
 * file id is an arbitrary token and may itself contain one. */
const parseFiles = (value: unknown): PostFile[] => {
  const entries = record(value ?? {}, "post files");
  const files: PostFile[] = [];
  for (const [key, range] of Object.entries(entries)) {
    const at = key.lastIndexOf("@");
    if (at <= 0 || at === key.length - 1) continue;
    if (!Array.isArray(range) || range.length < 2) continue;
    const offset = range[0];
    const len = range[1];
    if (typeof offset !== "number" || typeof len !== "number") continue;
    files.push({ id: key.slice(0, at), bucket: key.slice(at + 1), offset, len });
  }
  return files;
};

export const parsePost = (value: unknown): Post => {
  const entry = record(value, "post");
  const reactionMap = record(entry.reactions ?? {}, "post reactions");
  const reactions = Object.entries(reactionMap)
    .map(([id, users]) => ({
      id: Number(id),
      users: numArray(users, "reaction users"),
    }))
    .filter((reaction) => Number.isFinite(reaction.id) && reaction.users.length > 0)
    .sort((left, right) => right.users.length - left.users.length);

  return {
    id: num(entry.id, "post id"),
    body: str(entry.body ?? "", "post body"),
    user: num(entry.user, "post author"),
    timestamp: num(entry.timestamp ?? 0, "post timestamp"),
    parent: optionalNum(entry.parent, "post parent"),
    children: numArray(entry.children, "post children"),
    tags: strArray(entry.tags, "post tags"),
    realm: optionalStr(entry.realm, "post realm"),
    reactions,
    files: parseFiles(entry.files),
    treeSize: num(entry.tree_size ?? 0, "post tree size"),
    extension: parseExtension(entry.extension),
  };
};

export const parseMeta = (value: unknown): PostMeta => {
  const entry = record(value, "post meta");
  return {
    authorName: str(entry.author_name ?? "", "author name"),
    nsfw: entry.nsfw === true,
    realmColor: optionalStr(entry.realm_color, "realm colour"),
    viewerBlocked: entry.viewer_blocked === true,
    maxDownvotesReached: entry.max_downvotes_reached === true,
  };
};

/** Feed queries reply with `Vec<(Post, Meta)>`. */
export const parseFeed = (value: unknown): FeedEntry[] =>
  array(value ?? [], "feed").map((pair) => {
    const tuple = array(pair, "feed entry");
    if (tuple.length < 2) fail("feed entry");
    return { post: parsePost(tuple[0]), meta: parseMeta(tuple[1]) };
  });

export const parseUser = (value: unknown): TaggrUser | null => {
  if (value === null || value === undefined) return null;
  const entry = record(value, "user");
  return {
    id: num(entry.id, "user id"),
    name: str(entry.name ?? "", "user name"),
    about: str(entry.about ?? "", "user about"),
    principal: str(entry.principal ?? "", "user principal"),
    numPosts: num(entry.num_posts ?? 0, "user post count"),
    followers: numArray(entry.followers, "followers"),
    followees: numArray(entry.followees, "followees"),
    realms: strArray(entry.realms, "user realms"),
    balance: num(entry.balance ?? 0, "user balance"),
    rewards: num(entry.rewards ?? 0, "user rewards"),
    credits: num(entry.cycles ?? 0, "user credits"),
    stalwart: entry.stalwart === true,
    timestamp: num(entry.timestamp ?? 0, "user timestamp"),
  };
};

/** `realms` replies with the realm bodies; ids come from the request. */
export const parseRealm = (id: RealmId, value: unknown): Realm => {
  const entry = record(value, "realm");
  return {
    id,
    description: str(entry.description ?? "", "realm description"),
    logo: str(entry.logo ?? "", "realm logo"),
    labelColor: str(entry.label_color ?? "", "realm colour"),
    numMembers: num(entry.num_members ?? 0, "realm members"),
    numPosts: num(entry.num_posts ?? 0, "realm posts"),
    adultContent: entry.adult_content === true,
    controllers: numArray(entry.controllers, "realm controllers"),
  };
};

/** `all_realms` and `realm_search` reply with `[id, realm]` pairs. */
export const parseRealmPairs = (value: unknown): Realm[] =>
  array(value ?? [], "realm list").map((pair) => {
    const tuple = array(pair, "realm entry");
    if (tuple.length < 2) fail("realm entry");
    return parseRealm(str(tuple[0], "realm id"), tuple[1]);
  });

export const parseSearchResults = (value: unknown): SearchResult[] =>
  array(value ?? [], "search results").map((entry) => {
    const item = record(entry, "search result");
    return {
      id: num(item.id, "search result id"),
      userId: num(item.user_id, "search user id"),
      genericId: str(item.generic_id ?? "", "search generic id"),
      result: str(item.result ?? "", "search result kind"),
      relevant: str(item.relevant ?? "", "search snippet or tag"),
    };
  });

/** `users_data` replies with `{ userId: name }`. */
export const parseUserNames = (value: unknown): Map<UserId, string> => {
  const entries = record(value ?? {}, "user names");
  const names = new Map<UserId, string>();
  for (const [id, name] of Object.entries(entries)) {
    names.set(Number(id), str(name, "user name"));
  }
  return names;
};

/** `recent_tags` replies with `[tag, weight]` pairs. */
export const parseTags = (value: unknown): Array<{ tag: string; weight: number }> =>
  array(value ?? [], "tags").map((pair) => {
    const tuple = array(pair, "tag entry");
    if (tuple.length < 2) fail("tag entry");
    return { tag: str(tuple[0], "tag"), weight: num(tuple[1], "tag weight") };
  });

export const parseStats = (value: unknown): TaggrStats => {
  const entry = record(value, "stats");
  return {
    users: num(entry.users ?? 0, "user count"),
    usersOnline: num(entry.users_online ?? 0, "online user count"),
    posts: num(entry.posts ?? 0, "post count"),
    comments: num(entry.comments ?? 0, "comment count"),
    realms: num(entry.realms ?? 0, "realm count"),
    canisterCycleBalance: num(entry.canister_cycle_balance ?? 0, "cycle balance"),
  };
};

/** `domains` replies with `{ domain: DomainConfig }`. */
/**
 * `domains` replies with a map of hostname to `DomainConfig`. The sub-config is
 * a serialised Rust enum: exactly one of `BlackListedRealms`, `WhiteListedRealms`
 * or `Journal`. An unknown arm is read as an empty blacklist, which is
 * `DomainSubConfig::default()` and the least surprising fallback.
 */
export const parseDomains = (value: unknown): TaggrDomain[] =>
  Object.entries(record(value ?? {}, "domains"))
    .map(([name, config]): TaggrDomain => {
      const entry = record(config, "domain config");
      const sub = record(entry.sub_config ?? {}, "domain sub-config");
      return {
        name,
        maxDownvotes: num(entry.max_downvotes ?? 0, "domain downvote ceiling"),
        owner: entry.owner === null || entry.owner === undefined
          ? null
          : num(entry.owner, "domain owner"),
        scope:
          "WhiteListedRealms" in sub
            ? { kind: "whitelist", realms: strArray(sub.WhiteListedRealms, "domain realms") }
            : "Journal" in sub
              ? { kind: "journal", userId: num(sub.Journal, "domain journal user") }
              : {
                  kind: "blacklist",
                  realms:
                    "BlackListedRealms" in sub
                      ? strArray(sub.BlackListedRealms, "domain realms")
                      : [],
                },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

/**
 * Most mutating endpoints reply with a serialised Rust `Result`:
 * `{"Ok": ...}` or `{"Err": "message"}`. A few reply with a bare value.
 */
export const unwrapResult = (value: unknown): unknown => {
  if (isRecord(value)) {
    if ("Err" in value) {
      throw new TaggrParseError(
        typeof value.Err === "string" ? value.Err : "Taggr rejected the request",
      );
    }
    if ("Ok" in value) return value.Ok;
  }
  return value;
};
