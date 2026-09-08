// The app's data layer, split by who has to pay for the call.
//
// READS go straight from the browser to Nuance as anonymous query calls
// (`src/nuance/client.ts`). Nuance's whole read surface is public, queries are
// free, and they return in ~100ms instead of a multi-second replicated round
// trip. Nothing about the reader is disclosed: no identity, no credential, not
// even which Neutron is asking.
//
// WRITES and caller-scoped reads go through this app's Motoko backend, because
// they need the Neutron canister's own principal, which the browser does not and
// must not have. Those are `preapproved_self_calls`, so they are signed without a
// per-call dialog and work from the resident background with no tile open.
//
// Local drafts and bookmarks also live in the backend: they are durable app state
// and their reads are canister queries, which are free.
//
// Two callers exist for the backend half:
//
//   * `globalCaller` for the tile and for background work outside a routed tool
//     invocation.
//   * `scopedCaller(context.kernel)` inside an exposed tool handler. Module-level
//     helpers fail closed with SCOPED_CONTEXT_REQUIRED during an active agent
//     invocation, so a handler that used them would break the moment an agent
//     called it.
//
// Candid <-> JSON encoding for the backend half follows `dist/schema.json`:
//   Nat / Int      -> decimal string
//   opt T          -> property present, or absent for null
//   variant        -> { tagName: payload }, except the two-tag ok/err form
//                     that icblast unwraps -- see the Result note below
//   no arguments   -> [null]
//   one argument   -> [value]
//   many arguments -> [[a, b, ...]]

import { querySelf, updateSelf } from "neutron-tools/app";
import * as nuance from "./nuance/client";
import { htmlToText } from "./markup";

export type SourceRef = {
  postId: string;
  bucketCanisterId: string;
};

export type FeedRow = {
  postId: string;
  bucketCanisterId: string;
  title: string;
  subtitle: string;
  handle: string;
  publishedDate: string;
  claps: string;
  views: string;
  wordCount: string;
  tags: string[];
  /// Cover image. Nuance returns this even in list mode, where it strips the
  /// body, so a feed thumbnail costs no extra request. Empty for the minority of
  /// articles published without one.
  headerImage: string;
};

export type FeedPage = {
  rows: FeedRow[];
  totalCount: string;
  source: string;
};

export type Article = {
  postId: string;
  bucketCanisterId: string;
  title: string;
  subtitle: string;
  handle: string;
  url: string;
  headerImage: string;
  publishedDate: string;
  wordCount: string;
  claps: string;
  views: string;
  tags: string[];
  isDraft: boolean;
  isPremium: boolean;
  isMembersOnly: boolean;
  /// Raw stored markup, for the tile's allowlist renderer.
  html: string;
  /// Plain-text projection, for agents and for loading into a draft. Computed
  /// here rather than in the canister: the tile never reads it.
  text: string;
  /// False when Nuance withheld the body, e.g. a premium or members-only article
  /// this account is not entitled to read.
  available: boolean;
};

export type CommentNode = {
  commentId: string;
  postId: string;
  content: string;
  creator: string;
  handle: string;
  avatar: string;
  createdAt: string;
  upVotes: number;
  downVotes: number;
  depth: number;
  isCensored: boolean;
};

export type CommentPage = {
  comments: CommentNode[];
  total: string;
};

export type CommentWriteResult = {
  confirmed: true;
  message: string;
} & (
  | ({ refreshed: true } & CommentPage)
  | { refreshed: false; refreshError: string }
);

/// What the app canister knows about this Neutron's Nuance account. `handle` and
/// `registered` are a cache of what the User canister last reported.
export type LocalIdentity = {
  principalId: string;
  handle: string;
  displayName: string;
  registered: boolean;
  note: string;
};

/// The local record refreshed against Nuance. The live profile and the posting
/// allowance are public reads, so they come from the browser.
export type Identity = LocalIdentity & { dailyAllowance: string };

export type DraftView = {
  id: string;
  title: string;
  subtitle: string;
  tagIds: string[];
  body: string;
  revision: string;
  created: string;
  modified: string;
  modifiedBy: string;
  sourcePostId?: SourceRef;
  wordCount: string;
  isActive: boolean;
};

export type Bookmark = {
  postId: string;
  bucketCanisterId: string;
  title: string;
  handle: string;
  saved: string;
};

export type Published = {
  postId: string;
  bucketCanisterId: string;
  url: string;
  isDraft: boolean;
  title: string;
};

export type ShardStatus = {
  registered: string[];
  unregistered: string[];
};

export type AppState = {
  identity: LocalIdentity;
  drafts: DraftView[];
  activeDraftId: string;
  bookmarks: Bookmark[];
  buckets: string[];
};

export type PatchOp =
  | { replace: { find: string; replaceWith: string; occurrence?: string } }
  | { insert_after: { find: string; text: string } }
  | { insert_before: { find: string; text: string } }
  | { append: { text: string } }
  | { prepend: { text: string } }
  | { replace_section: { heading: string; body: string } }
  | { set_title: string }
  | { set_subtitle: string }
  | { set_tags: string[] };

type Ok<T> = { ok: T };
type Err = { err: string };
type Conflict = { conflict: DraftView };

export type Result<T> = Ok<T> | Err;
export type DraftWriteResult = Ok<DraftView> | Conflict | Err;
export type PatchResult =
  | { ok: { draft: DraftView; applied: string[] } }
  | Conflict
  | Err;

export function isErr<T>(
  value: Result<T> | DraftWriteResult | PatchResult,
): value is Err {
  return typeof value === "object" && value !== null && "err" in value;
}

export function isConflict(
  value: DraftWriteResult | PatchResult,
): value is Conflict {
  return typeof value === "object" && value !== null && "conflict" in value;
}

// ---------------------------------------------------------------------------
// icblast's Result convention (backend half only)
//
// The kernel converts Candid replies with icblast, which special-cases a variant
// with exactly two tags named ok/err (`icb_node.js`, `convertBack`):
//
//   #ok(value)  ->  `value`, unwrapped -- there is no { ok: ... } on the wire
//   #err(text)  ->  thrown
//
// A variant with any other arity is left alone, so the three-tag draft results
// (`ok` / `conflict` / `err`) do arrive as tagged objects. That asymmetry is easy
// to get wrong in exactly one direction -- treating an unwrapped payload as
// `{ ok }` yields `undefined` with no error anywhere -- so the two shapes are
// adapted separately below and covered by tests.
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; err?: unknown };
    if (typeof value.message === "string") return value.message;
    if (typeof value.err === "string") return value.err;
    try {
      return JSON.stringify(error);
    } catch {
      // fall through to String()
    }
  }
  return String(error);
}

async function asResult<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { err: describe(error) };
  }
}

async function asVariant<T extends object>(
  run: () => Promise<unknown>,
): Promise<T | { err: string }> {
  try {
    return (await run()) as T;
  } catch (error) {
    return { err: describe(error) };
  }
}

/// Collapse concurrent identical reads onto one in-flight call, so a
/// double-clicked feed tab issues one request rather than two.
function singleFlight() {
  const inFlight = new Map<string, Promise<unknown>>();
  return function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const started = run().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, started);
    return started;
  };
}

export type Caller = {
  query: <T>(method: string, args: unknown[]) => Promise<T>;
  update: <T>(method: string, args: unknown[]) => Promise<T>;
};

export const globalCaller: Caller = {
  query: <T,>(method: string, args: unknown[]) =>
    querySelf(method, args as never) as Promise<T>,
  update: <T,>(method: string, args: unknown[]) =>
    updateSelf(method, args as never) as Promise<T>,
};

export type ScopedKernel = {
  querySelf: (method: string, args: unknown[]) => Promise<unknown>;
  updateSelf: (method: string, args: unknown[]) => Promise<unknown>;
};

export function scopedCaller(kernel: ScopedKernel): Caller {
  return {
    query: <T,>(method: string, args: unknown[]) =>
      kernel.querySelf(method, args) as Promise<T>,
    update: <T,>(method: string, args: unknown[]) =>
      kernel.updateSelf(method, args) as Promise<T>,
  };
}

// -------------------------------------------------------------- projections

export function mergeRows(
  keys: nuance.KeyProperties[],
  bodies: nuance.BucketPost[],
): FeedRow[] {
  const byId = new Map(bodies.map((body) => [body.postId, body]));
  const rows: FeedRow[] = [];
  // Preserve PostCore's ordering: it is the feed's ranking.
  for (const key of keys) {
    const body = byId.get(key.postId);
    if (!body) continue;
    rows.push({
      postId: key.postId,
      bucketCanisterId: key.bucketCanisterId,
      title: body.title,
      subtitle: body.subtitle,
      handle: body.handle,
      publishedDate: key.publishedDate,
      claps: key.claps,
      views: key.views,
      wordCount: body.wordCount,
      tags: key.tags.map((tag) => tag.tagName),
      headerImage: body.headerImage,
    });
  }
  return rows;
}

export function flattenComments(
  nodes: nuance.RawComment[],
  depth: number,
  out: CommentNode[],
): void {
  for (const node of nodes) {
    out.push({
      commentId: node.commentId,
      postId: node.postId,
      content: node.content,
      creator: node.creator,
      handle: node.handle,
      avatar: node.avatar,
      createdAt: node.createdAt,
      upVotes: node.upVotes.length,
      downVotes: node.downVotes.length,
      depth,
      isCensored: node.isCensored,
    });
    flattenComments(node.replies, depth + 1, out);
  }
}

/// Bucket comments carry an empty handle and avatar; only the User canister
/// knows who a creator principal is.
async function enrichComments(nodes: CommentNode[]): Promise<CommentNode[]> {
  const principals = [
    ...new Set(nodes.map((node) => node.creator).filter((value) => value !== "")),
  ];
  if (principals.length === 0) return nodes;

  let profiles: nuance.UserListItem[] = [];
  try {
    profiles = await nuance.profilesFor(principals);
  } catch {
    // Losing display names is cosmetic; the comments still render.
    return nodes;
  }
  const byPrincipal = new Map(profiles.map((profile) => [profile.principal, profile]));
  return nodes.map((node) => {
    const profile = byPrincipal.get(node.creator);
    if (!profile) return node;
    return {
      ...node,
      handle: node.handle || profile.handle,
      avatar: node.avatar || profile.avatar,
    };
  });
}

async function commentPage(
  bucketCanisterId: string,
  postId: string,
): Promise<CommentPage> {
  const page = await nuance.getComments(bucketCanisterId, postId);
  const flat: CommentNode[] = [];
  flattenComments(page.comments, 0, flat);
  return {
    comments: await enrichComments(flat),
    total: page.totalNumberOfComments,
  };
}

/// Once Nuance acknowledged the write, a failed public refresh must not make
/// the caller repeat it. Preserve that acknowledgement separately from the read.
async function refreshAfterCommentWrite(
  message: string,
  bucketCanisterId: string,
  postId: string,
): Promise<CommentWriteResult> {
  try {
    const page = await commentPage(bucketCanisterId, postId);
    return { confirmed: true, message, refreshed: true, ...page };
  } catch (error) {
    return { confirmed: true, message, refreshed: false, refreshError: describe(error) };
  }
}

async function pageFromIds(
  ids: string[],
  limit: number,
  source: string,
): Promise<FeedPage> {
  if (ids.length === 0) return { rows: [], totalCount: "0", source };
  const selected = ids.slice(0, limit);
  const keys = await nuance.keyPropertiesFor(selected);
  const bodies = await nuance.hydrate(keys);
  return { rows: mergeRows(keys, bodies), totalCount: String(ids.length), source };
}

/// A reading-list entry Nuance did not return. Only what was saved is known.
function fallbackRow(entry: Bookmark): FeedRow {
  return {
    postId: entry.postId,
    bucketCanisterId: entry.bucketCanisterId,
    title: entry.title,
    subtitle: "",
    handle: entry.handle,
    publishedDate: "0",
    claps: "0",
    views: "0",
    wordCount: "0",
    tags: [],
    headerImage: "",
  };
}

export function articleUrl(url: string): string {
  return `https://nuance.xyz${url.startsWith("/") ? url : `/${url}`}`;
}

// ---------------------------------------------------------------------- api

export function createApi(caller: Caller) {
  const dedupe = singleFlight();

  return {
    // ------------------------------------------ reads: direct, free, anonymous
    feed: (source: string, offset: number, limit: number) =>
      dedupe(`feed:${source}:${offset}:${limit}`, () =>
        asResult<FeedPage>(async () => {
          const index = await nuance.feedIndex(source, offset, limit);
          const bodies = await nuance.hydrate(index.posts);
          return {
            rows: mergeRows(index.posts, bodies),
            totalCount: index.totalCount,
            source,
          };
        }),
      ),

    article: (postId: string, bucketCanisterId: string) =>
      dedupe(`article:${postId}`, () =>
        asResult<Article>(async () => {
          const [body, keys] = await Promise.all([
            nuance.getArticle(bucketCanisterId, postId),
            nuance.keyPropertiesFor([postId]).catch(() => []),
          ]);
          const key = keys[0];
          return {
            postId: body.postId,
            bucketCanisterId,
            title: body.title,
            subtitle: body.subtitle,
            handle: body.handle,
            url: articleUrl(body.url),
            headerImage: body.headerImage,
            publishedDate: body.publishedDate,
            wordCount: body.wordCount,
            claps: key?.claps ?? "0",
            views: key?.views ?? "0",
            tags: key?.tags.map((tag) => tag.tagName) ?? [],
            isDraft: body.isDraft,
            isPremium: body.isPremium,
            isMembersOnly: body.isMembersOnly,
            html: body.content,
            text: htmlToText(body.content),
            available: body.content !== "",
          };
        }),
      ),

    comments: (postId: string, bucketCanisterId: string) =>
      dedupe(`comments:${postId}`, () =>
        asResult<CommentPage>(() => commentPage(bucketCanisterId, postId)),
      ),

    search: (term: string, limit: number) =>
      dedupe(`search:${term}:${limit}`, () =>
        asResult<FeedPage>(async () =>
          pageFromIds(await nuance.search(term), limit, "search"),
        ),
      ),

    related: (postId: string, limit: number) =>
      dedupe(`related:${postId}:${limit}`, () =>
        asResult<FeedPage>(async () =>
          pageFromIds(await nuance.relatedPosts(postId), limit, "related"),
        ),
      ),

    tags: () =>
      dedupe("tags", () => asResult<[string, string][]>(() => nuance.getTags())),

    // ------------------------------ identity: principal is backend, rest direct
    /// The principal and the disclosure text are canister state; the live profile
    /// and the posting allowance are public reads from Nuance.
    ///
    /// Pass `local` when the caller has just read `nuance_state` anyway. Both
    /// reads are free, but a kernel query is a message-bus round trip, and doing
    /// it twice on tile open was pure latency.
    whoami: (local?: LocalIdentity) =>
      asResult<Identity>(async () => {
        const identity =
          local ?? (await caller.query<AppState>("nuance_state", [null])).identity;
        const [profile, allowance] = await Promise.all([
          nuance.profileFor(identity.principalId).catch(() => null),
          nuance.dailyAllowance().catch(() => "0"),
        ]);
        return {
          principalId: identity.principalId,
          handle: profile?.handle ?? "",
          displayName: profile?.displayName ?? "",
          registered: profile !== null,
          dailyAllowance: allowance,
          note: identity.note,
        };
      }),

    // ---------------------------------------- writes: backend, owner identity
    register: (handle: string, displayName: string, avatar: string) =>
      asResult<Identity>(async () => {
        const local = await caller.update<LocalIdentity>("nuance_register", [
          [handle, displayName, avatar],
        ]);
        return { ...local, dailyAllowance: await nuance.dailyAllowance().catch(() => "0") };
      }),

    comment: (input: {
      postId: string;
      bucketCanisterId: string;
      content: string;
      replyToCommentId?: string;
      editCommentId?: string;
    }) =>
      asResult<CommentWriteResult>(async () => {
        const message = await caller.update<string>("nuance_comment", [input]);
        // Re-reading is free and keeps one projection path for the tree.
        return refreshAfterCommentWrite(message, input.bucketCanisterId, input.postId);
      }),

    voteComment: (
      bucketCanisterId: string,
      commentId: string,
      vote: "up" | "down" | "clear",
      postId: string,
    ) =>
      asResult<CommentWriteResult>(async () => {
        const message = await caller.update<string>("nuance_vote_comment", [
          [bucketCanisterId, commentId, vote],
        ]);
        return refreshAfterCommentWrite(message, bucketCanisterId, postId);
      }),

    clap: (postId: string) =>
      asResult<string>(() => caller.update("nuance_clap", [postId])),

    publish: (id: string, asDraft: boolean) =>
      asResult<Published>(() => caller.update("nuance_publish", [[id, asDraft]])),

    /// Caller-scoped on Nuance, so the index read must come from the backend.
    /// Hydrating those ids is public, so it happens here for free.
    myPosts: (kind: string, offset: number, limit: number) =>
      asResult<FeedPage>(async () => {
        const keys = await caller.update<nuance.KeyProperties[]>("nuance_my_posts", [
          [kind, String(offset), String(limit)],
        ]);
        const bodies = await nuance.hydrate(keys, kind === "drafts");
        return {
          rows: mergeRows(keys, bodies),
          totalCount: String(keys.length),
          source: kind,
        };
      }),

    /// The reading list, hydrated from Nuance rather than from what was stored.
    ///
    /// The canister keeps only ids plus the title as it read at the time. Titles,
    /// covers, and counters here are therefore live, and hydrating them is a free
    /// query. An article Nuance no longer returns keeps its saved title so the
    /// entry stays visible and removable instead of vanishing.
    readingList: () =>
      asResult<FeedPage>(async () => {
        const saved = await caller.query<Bookmark[]>("nuance_bookmarks", [null]);
        if (saved.length === 0) {
          return { rows: [], totalCount: "0", source: "bookmarks" };
        }
        const page = await pageFromIds(
          saved.map((entry) => entry.postId),
          saved.length,
          "bookmarks",
        );
        const hydrated = new Map(page.rows.map((row) => [row.postId, row]));
        const rows = saved.map(
          (entry) => hydrated.get(entry.postId) ?? fallbackRow(entry),
        );
        return { rows, totalCount: String(saved.length), source: "bookmarks" };
      }),

    // ------------------------------------------ local state: canister queries
    state: () => caller.query<AppState>("nuance_state", [null]),
    draftList: () => caller.query<DraftView[]>("nuance_draft_list", [null]),
    bookmarks: () => caller.query<Bookmark[]>("nuance_bookmarks", [null]),

    draftRead: (id: string) =>
      asResult<DraftView>(() => caller.query("nuance_draft_read", [id])),

    draftNew: (title: string, body: string) =>
      asVariant<DraftWriteResult>(() =>
        caller.update("nuance_draft_new", [[title, body]]),
      ),

    draftSet: (input: {
      id: string;
      expectedRevision: string;
      title: string;
      subtitle: string;
      tagIds: string[];
      body: string;
      editor: "human" | "agent";
    }) => asVariant<DraftWriteResult>(() => caller.update("nuance_draft_set", [input])),

    draftPatch: (input: {
      id: string;
      expectedRevision: string;
      ops: PatchOp[];
      editor: "human" | "agent";
    }) => asVariant<PatchResult>(() => caller.update("nuance_draft_patch", [input])),

    /// Read the article here, then seed the draft in one backend update. Nuance
    /// enforces authorship on publish; this only avoids an obviously futile edit.
    draftLoad: (postId: string, bucketCanisterId: string) =>
      asVariant<DraftWriteResult>(async () => {
        const body = await nuance.getArticle(bucketCanisterId, postId);
        if (body.content === "") {
          throw new Error(
            "Nuance did not return a body for this article, so there is nothing to edit.",
          );
        }
        return caller.update("nuance_draft_create", [
          {
            title: body.title,
            subtitle: body.subtitle,
            body: htmlToText(body.content),
            sourcePostId: { postId: body.postId, bucketCanisterId },
          },
        ]);
      }),

    draftDiscard: (id: string) =>
      asResult<string>(() => caller.update("nuance_draft_discard", [id])),

    toggleBookmark: (
      postId: string,
      bucketCanisterId: string,
      title: string,
      handle: string,
    ) =>
      asResult<string>(() =>
        caller.update("nuance_toggle_bookmark", [
          [postId, bucketCanisterId, title, handle],
        ]),
      ),

    /// Compare the shards Nuance reports against the ones this app may write to.
    /// Reads need no reservation at all now; only comments and votes do.
    shardStatus: () =>
      asResult<ShardStatus>(async () => {
        const [live, local] = await Promise.all([
          nuance.getBuckets(),
          caller.query<AppState>("nuance_state", [null]),
        ]);
        const registered = new Set(local.buckets);
        return {
          registered: local.buckets,
          unregistered: live.filter((id) => !registered.has(id)),
        };
      }),

    registerBucket: (bucket: string) =>
      asResult<string>(() => caller.update("nuance_register_bucket", [bucket])),
  };
}

export type Api = ReturnType<typeof createApi>;

/// The topic used for same-app draft invalidation. The resident background
/// publishes it after a write so an open editor re-reads instead of polling.
export const DRAFT_TOPIC = "draft";
