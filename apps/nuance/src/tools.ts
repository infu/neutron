// Agent tool descriptors.
//
// These live apart from `service.ts` so they can be validated in tests without
// importing the app SDK, which installs a message listener on import and needs a
// browser. That separation matters: `exposeTool` validates a descriptor eagerly
// and throws, and a throw at module scope in the resident background would
// disable *every* agent tool at once with no visible error.
//
// The descriptions are the agent-facing contract. They are the only place an
// agent learns the read-then-patch discipline, so they are written for that
// reader rather than for a human skimming code.

// Type-only import: erased at compile time, so this module still pulls in no SDK
// runtime and stays importable from a test with no browser.
import type { JsonObject } from "neutron-tools/protocol";

export type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
};

const ROW_SCHEMA = {
  type: "object",
  properties: {
    postId: { type: "string" },
    bucketCanisterId: { type: "string" },
    title: { type: "string" },
    subtitle: { type: "string" },
    handle: { type: "string" },
    publishedDate: { type: "string" },
    claps: { type: "string" },
    views: { type: "string" },
    wordCount: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    headerImage: { type: "string" },
  },
  additionalProperties: true,
} as const;

const FEED_OUTPUT = {
  type: "object",
  properties: {
    rows: { type: "array", items: ROW_SCHEMA },
    totalCount: { type: "string" },
    note: { type: "string" },
  },
  additionalProperties: true,
} as const;

const OBJECT_OUTPUT = { type: "object", additionalProperties: true } as const;

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "nuance_browse",
    title: "Browse Nuance articles",
    description:
      "List articles from Nuance. `source` selects the index: latest, popular_today, " +
      "popular_week, or popular_month. Returns index rows only -- titles here are " +
      "truncated by Nuance at 60 characters, so call nuance_read for the real title " +
      "and the body.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["latest", "popular_today", "popular_week", "popular_month"],
        },
        offset: { type: "integer", minimum: 0, maximum: 100000 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
    outputSchema: FEED_OUTPUT,
  },
  {
    name: "nuance_search",
    title: "Search Nuance",
    description: "Full-text search across Nuance articles. Returns index rows.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
    outputSchema: FEED_OUTPUT,
  },
  {
    name: "nuance_read",
    title: "Read a Nuance article",
    description:
      "Fetch one article's full title and body as plain text. Both ids come from a " +
      "nuance_browse or nuance_search row. Bodies are truncated unless `full` is true.",
    inputSchema: {
      type: "object",
      required: ["postId", "bucketCanisterId"],
      properties: {
        postId: { type: "string" },
        bucketCanisterId: { type: "string" },
        full: { type: "boolean" },
        maxChars: { type: "integer", minimum: 500, maximum: 120000 },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_comments",
    title: "Read Nuance comments",
    description:
      "Fetch the comment thread for an article, flattened with a `depth` field for replies.",
    inputSchema: {
      type: "object",
      required: ["postId", "bucketCanisterId"],
      properties: {
        postId: { type: "string" },
        bucketCanisterId: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_recent_since",
    title: "Check for new Nuance articles",
    description:
      "Return the latest articles published after `postId`. Nuance post ids increase " +
      "over time, so this is a numeric cutoff. The reply carries `newest`; keep it and " +
      "pass it back as `postId` on the next poll. With no `postId` this is just the " +
      "latest page, and the reply says so.",
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
    outputSchema: FEED_OUTPUT,
  },
  {
    name: "nuance_whoami",
    title: "Nuance account for this Neutron",
    description:
      "Report the Nuance identity this Neutron posts under. It is this canister's own " +
      "principal, not the owner's nuance.xyz login. Publishing and commenting need a " +
      "registered handle, which only the owner can claim from the tile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_draft_list",
    title: "List Nuance drafts",
    description:
      "List the shared drafts in this app. A draft is edited by both the owner and " +
      "agents, so always read one before patching it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "array", items: OBJECT_OUTPUT },
  },
  {
    name: "nuance_draft_read",
    title: "Read a Nuance draft",
    description:
      "Read one shared draft, including its `revision`. Call this before every patch " +
      "and pass the revision you saw as `expectedRevision`.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_draft_new",
    title: "Start a Nuance draft",
    description: "Create a new shared draft and make it the active one.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 400 },
        body: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_draft_patch",
    title: "Edit a Nuance draft",
    description:
      "Apply ordered edits to a shared draft. Read the draft first and pass the " +
      "`revision` you saw as `expectedRevision`; if the owner has typed since, the " +
      "patch is rejected as a conflict and you must re-read and rebase rather than " +
      "retrying blind. Matches are exact substrings, never fuzzy: an anchor that " +
      "appears more than once is an error, so extend `find` or set `occurrence`. " +
      "The whole op list applies atomically -- if one op fails, none are applied.",
    inputSchema: {
      type: "object",
      required: ["expectedRevision", "ops"],
      properties: {
        id: { type: "string" },
        expectedRevision: { type: "string" },
        ops: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: true,
            description:
              "One of: {replace:{find,replaceWith,occurrence?}}, " +
              "{insert_after:{find,text}}, {insert_before:{find,text}}, " +
              "{append:{text}}, {prepend:{text}}, " +
              "{replace_section:{heading,body}}, {set_title:string}, " +
              "{set_subtitle:string}, {set_tags:[string]}",
          },
        },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_draft_load",
    title: "Load a published article for revision",
    description:
      "Copy a published article into a shared draft so it can be revised. Republishing " +
      "only updates the original if this Neutron wrote it; Nuance rejects anyone else. " +
      "Formatting is flattened to plain text on import, so republishing replaces the " +
      "original body.",
    inputSchema: {
      type: "object",
      required: ["postId", "bucketCanisterId"],
      properties: {
        postId: { type: "string" },
        bucketCanisterId: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_post",
    title: "Publish a Nuance draft",
    description:
      "Publish a shared draft to Nuance. Nuance requires a title, a non-empty body, " +
      "and 1-3 tag ids. Set `asDraft` to keep it private on Nuance instead. Publishing " +
      "uses whatever the draft currently contains, so read it first if the owner may " +
      "have edited it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        asDraft: { type: "boolean" },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
  {
    name: "nuance_reply",
    title: "Comment on a Nuance article",
    description:
      "Post a comment, or a reply when `replyToCommentId` is given. Nuance limits a " +
      "comment to 400 characters and requires a registered handle. A confirmed write " +
      "with refreshed=false succeeded; use nuance_comments to refresh, do not post it again.",
    inputSchema: {
      type: "object",
      required: ["postId", "bucketCanisterId", "content"],
      properties: {
        postId: { type: "string" },
        bucketCanisterId: { type: "string" },
        content: { type: "string", minLength: 1, maxLength: 400 },
        replyToCommentId: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: OBJECT_OUTPUT,
  },
];

export function toolDescriptor(name: string): ToolDescriptor {
  const found = TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name);
  if (!found) throw new Error(`Unknown tool descriptor: ${name}`);
  return found;
}

/// Strip `undefined` so a value is JSON-safe.
///
/// Candid `opt` decodes to an absent-or-undefined property, and the message bus
/// validates tool results as JSON. An `undefined` sitting in a returned object is
/// not JSON and would fail validation at the boundary rather than in the handler.
export function jsonSafe<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = jsonSafe(item);
    }
    return out as unknown as T;
  }
  return value;
}
