// Resident background: the agent surface.
//
// This runs for as long as the Neutron shell is open, with or without a tile, so
// an agent can browse, read, draft, and publish while the user is elsewhere. It
// holds no state of its own -- every tool forwards to the same `createApi` the
// tile uses. That is what makes human and agent edits to one draft coherent
// instead of two competing caches.
//
// Browse, read, search, and comment-reading run here in the page as anonymous
// queries against Nuance, so an agent polling for new articles costs the owner
// nothing. Only publishing, commenting, voting, and the draft store reach the app
// canister, and only those consume cycles.
//
// Every handler builds its API from `context.kernel`. Module-level `querySelf` /
// `updateSelf` fail closed with SCOPED_CONTEXT_REQUIRED during an active agent
// invocation, so a handler that used them would work when tested by hand and
// break the moment an agent called it.

import { exposeTool, publishAppStateChange } from "neutron-tools/app";
import {
  DRAFT_TOPIC,
  createApi,
  isConflict,
  isErr,
  scopedCaller,
  type Api,
  type PatchOp,
} from "./api";
import { jsonSafe, toolDescriptor } from "./tools";

/// Register one tool from its shared descriptor. Keeping descriptors out of this
/// module lets them be validated in tests without a browser.
function register(name: string, handler: Parameters<typeof exposeTool>[2]): void {
  const { name: toolName, ...options } = toolDescriptor(name);
  exposeTool(toolName, options, handler);
}

/// Bodies are plain text and bounded: the message bus caps a payload at 1 MiB and
/// a full Nuance article can be 300k characters.
const DEFAULT_BODY_CHARS = 12_000;

type Ctx = { kernel: Parameters<typeof scopedCaller>[0] };

function apiFor(context: Ctx): Api {
  return createApi(scopedCaller(context.kernel));
}

function fail(message: string): never {
  throw new Error(message);
}

/// Same-app invalidation so an open editor re-reads after an agent write. This is
/// a hint, never content. It is best-effort: losing it costs a refresh, never
/// correctness, so it must not turn a successful write into a reported failure.
async function announceDraftChange(revision: string): Promise<void> {
  try {
    await publishAppStateChange(DRAFT_TOPIC, revision);
  } catch {
    // Ignore: the editor also re-reads on focus and on its next save.
  }
}

function clampText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

function feedResult(page: { rows: unknown[]; totalCount: string }) {
  return { rows: page.rows, totalCount: page.totalCount };
}

// ------------------------------------------------------------------- reads

register(
  "nuance_browse",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.feed(
      typeof args.source === "string" ? args.source : "latest",
      typeof args.offset === "number" ? args.offset : 0,
      typeof args.limit === "number" ? args.limit : 10,
    );
    if (isErr(result)) fail(result.err);
    return jsonSafe(feedResult(result.ok)) as never;
  },
);

register(
  "nuance_search",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.search(
      String(args.query),
      typeof args.limit === "number" ? args.limit : 10,
    );
    if (isErr(result)) fail(result.err);
    return jsonSafe(feedResult(result.ok)) as never;
  },
);

register(
  "nuance_read",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.article(String(args.postId), String(args.bucketCanisterId));
    if (isErr(result)) fail(result.err);
    const article = result.ok;
    const limit =
      args.full === true
        ? article.text.length
        : typeof args.maxChars === "number"
          ? args.maxChars
          : DEFAULT_BODY_CHARS;
    const { text, truncated } = clampText(article.text, limit);
    return jsonSafe({
      postId: article.postId,
      bucketCanisterId: article.bucketCanisterId,
      title: article.title,
      subtitle: article.subtitle,
      handle: article.handle,
      publishedDate: article.publishedDate,
      wordCount: article.wordCount,
      claps: article.claps,
      views: article.views,
      tags: article.tags,
      headerImage: article.headerImage,
      url: article.url,
      available: article.available,
      text,
      truncated,
      ...(article.available
        ? {}
        : {
            note:
              "Nuance returned no body. Premium and members-only articles are withheld " +
              "from accounts that are not entitled to read them.",
          }),
    }) as never;
  },
);

register(
  "nuance_comments",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.comments(String(args.postId), String(args.bucketCanisterId));
    if (isErr(result)) fail(result.err);
    return jsonSafe({ total: result.ok.total, comments: result.ok.comments }) as never;
  },
);

register(
  "nuance_recent_since",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const watermark = typeof args.postId === "string" ? args.postId : "";

    const result = await api.feed("latest", 0, limit);
    if (isErr(result)) fail(result.err);

    // Nuance post ids are decimal and increase over time, so "newer than" is a
    // numeric comparison. This app stores no watermark of its own: keeping one
    // would mean a canister write on every poll, and the caller already has the
    // ids it saw last time.
    const boundary = Number(watermark);
    const known = watermark !== "" && Number.isFinite(boundary);
    const rows = known
      ? result.ok.rows.filter((row) => Number(row.postId) > boundary)
      : result.ok.rows;

    return jsonSafe({
      ...feedResult({ ...result.ok, rows }),
      newest: result.ok.rows[0]?.postId ?? watermark,
      since: watermark,
      ...(known
        ? {}
        : {
            note:
              "No `postId` was given, so this is simply the latest page, not a list of new " +
              "articles. Pass `newest` back as `postId` next time to get only what arrived since.",
          }),
    }) as never;
  },
);

register(
  "nuance_whoami",
  async (_args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.whoami();
    if (isErr(result)) fail(result.err);
    return jsonSafe(result.ok) as never;
  },
);

// ------------------------------------------------------------ co-authoring

register(
  "nuance_draft_list",
  async (_args, context) => {
    const api = apiFor(context as Ctx);
    return jsonSafe(await api.draftList()) as never;
  },
);

register(
  "nuance_draft_read",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.draftRead(typeof args.id === "string" ? args.id : "");
    if (isErr(result)) fail(result.err);
    return jsonSafe(result.ok) as never;
  },
);

register(
  "nuance_draft_new",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.draftNew(
      typeof args.title === "string" ? args.title : "",
      typeof args.body === "string" ? args.body : "",
    );
    if (isErr(result)) fail(result.err);
    if (isConflict(result)) fail("The draft changed while it was being created.");
    await announceDraftChange(result.ok.revision);
    return jsonSafe(result.ok) as never;
  },
);

register(
  "nuance_draft_patch",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.draftPatch({
      id: typeof args.id === "string" ? args.id : "",
      expectedRevision: String(args.expectedRevision),
      ops: args.ops as unknown as PatchOp[],
      editor: "agent",
    });
    if (isConflict(result)) {
      fail(
        `The draft moved to revision ${result.conflict.revision} while you were editing. ` +
          "Re-read it and rebase your ops onto the current text; do not retry blind.",
      );
    }
    if (isErr(result)) fail(result.err);
    await announceDraftChange(result.ok.draft.revision);
    return jsonSafe({ draft: result.ok.draft, applied: result.ok.applied }) as never;
  },
);

register(
  "nuance_draft_load",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.draftLoad(String(args.postId), String(args.bucketCanisterId));
    if (isErr(result)) fail(result.err);
    if (isConflict(result)) fail("The draft changed while it was being created.");
    await announceDraftChange(result.ok.revision);
    return jsonSafe(result.ok) as never;
  },
);

// ------------------------------------------------------------------ writes

register(
  "nuance_post",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.publish(
      typeof args.id === "string" ? args.id : "",
      args.asDraft === true,
    );
    if (isErr(result)) fail(result.err);
    return jsonSafe(result.ok) as never;
  },
);

register(
  "nuance_reply",
  async (args, context) => {
    const api = apiFor(context as Ctx);
    const result = await api.comment({
      postId: String(args.postId),
      bucketCanisterId: String(args.bucketCanisterId),
      content: String(args.content),
      ...(typeof args.replyToCommentId === "string"
        ? { replyToCommentId: args.replyToCommentId }
        : {}),
    });
    if (isErr(result)) fail(result.err);
    return jsonSafe(result.ok) as never;
  },
);
