// Resident background: identity, network client, and tool host.
//
// This is the only surface that holds the Taggr key and the only one that
// reaches the network. Two families of tools live here:
//
//  * `taggr_*` — the agent-facing surface. Bounded, human-readable payloads.
//    Cross-app invocation still passes through the kernel's consent dialog.
//  * `ui_*` — this app's own tile, marked `same_app` so the kernel filters them
//    out of other apps' catalogs and rejects cross-app invocation. The identity
//    export lives here and is additionally guarded by a caller check, because
//    handing out that string hands over the account.

import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
} from "neutron-tools/app";
import {
  addPost,
  browseRealms,
  conversation as loadConversation,
  createUser,
  domains as loadDomainConfigs,
  feed as loadFeed,
  mintCreditsWithIcp,
  react as sendReaction,
  recentTags,
  search as runSearch,
  setTaggrTransport,
  user as loadUser,
  userPosts as loadUserPosts,
  validateUsername,
  type FeedMode,
} from "./taggr_api.ts";
import {
  createTaggrClient,
  isLocalHost,
  replicaHost,
  type TaggrClient,
} from "./taggr_client.ts";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import {
  exportIdentity,
  identityPrincipal,
  loadSettings,
  parseIdentityBackup,
  saveSettings,
} from "./identity.ts";
import {
  hydrateIdentity,
  identitySync,
  replaceStoredIdentity,
  pushSettings,
} from "./identity_sync.ts";
import {
  describeDomain,
  findDomain,
  postSuppression,
  resolveDomain,
  suppressionMessage,
} from "./domain.ts";
import { isReadMethod, isWriteMethod } from "./methods.ts";
import {
  createFundingRequest,
  describeWalletError,
  fundingFailureMessage,
  invoiceAccountText,
  parseFundingResult,
  WALLET_FUNDING_TIMEOUT_SECONDS,
  WALLET_FUNDING_TOOL,
  WALLET_TARGET,
} from "./wallet.ts";
import {
  loadRegistrationFunding,
  saveRegistrationFunding,
  removeRegistrationFunding,
  type RegistrationFundingScope,
} from "./registration_store.ts";
import {
  DOWNVOTE_REACTION_ID,
  reactionEmoji,
  REACTIONS,
  type FeedEntry,
  type Realm,
  type TaggrDomain,
  type TaggrUser,
} from "./model.ts";
import { toPlainText } from "./markdown_source.ts";
import { bucketImageUrl } from "./network.ts";
import { absoluteTime } from "./format.ts";

const STATE_TOPIC = "taggr";
const APP_ID = "taggr";

/** Per-post body budget. Thirty of these stay well under the 1 MiB bus cap. */
const MAX_BODY_CHARS = 4_000;
const MAX_POSTS = 30;
const MAX_REALMS = 50;
const MAX_SEARCH_RESULTS = 40;

/* ------------------------------------------------------------------ */
/* the network client                                                  */
/* ------------------------------------------------------------------ */

let client: TaggrClient | null = null;
let configurationEpoch = 0;

/**
 * The key comes from this app's own canister memory, so nothing signs a Taggr
 * call until that has been read once. Memoised: one round trip per background,
 * retried on the next use if it failed, because a canister that was briefly
 * unreachable must not leave the app permanently on a browser-only key.
 */
let hydration: Promise<Ed25519KeyIdentity> | null = null;

const readyIdentity = async (): Promise<Ed25519KeyIdentity> => {
  if (!hydration) {
    const pending = hydrateIdentity().catch((error: unknown) => {
      if (hydration === pending) hydration = null;
      throw error;
    });
    hydration = pending;
  }
  const pending = hydration;
  const identity = await pending;
  if (!identitySync().stored && hydration === pending) hydration = null;
  return identity;
};

/**
 * One client per configured canister, rebuilt when the owner points the app at
 * a different Taggr deployment or replaces the identity.
 */
const currentClient = async (): Promise<TaggrClient> => {
  const epoch = configurationEpoch;
  const identity = await readyIdentity();
  const settings = loadSettings();
  assertConfiguration(epoch);
  if (client && client.canisterId === settings.canister && client.principal === identity.getPrincipal().toText()) return client;
  const created = await createTaggrClient({ canisterId: settings.canister, identity });
  assertConfiguration(epoch);
  if (identityPrincipal() !== created.principal) throw new Error("The Taggr account changed; retry with the current account");
  client = created;
  return client;
};

const invalidateClient = (): void => {
  configurationEpoch += 1;
  client = null;
};

const assertConfiguration = (epoch: number): void => {
  if (epoch !== configurationEpoch) {
    throw new Error("The Taggr account or deployment changed. Continue from the original account to recover any pending registration.");
  }
};

setTaggrTransport({
  query: async (method, payload) => (await currentClient()).query(method, payload),
  update: async (method, payload) => (await currentClient()).update(method, payload),
  addPost: async (input) => (await currentClient()).addPost(input),
});

/**
 * The hostname this installation browses under.
 *
 * A Taggr front end uses its own `location.hostname`, which decides which
 * realms it shows and how many downvotes it tolerates. This app has no Taggr
 * hostname, so unless the owner pinned one it follows the deployment's own
 * canonical domain, read from the live `domains` list. Cached per canister for
 * the life of the background: it is one query, and a rename between sessions is
 * picked up on the next start.
 */
let resolvedDomain: { canister: string; domain: string } | null = null;
let domainList: { canister: string; value: Promise<TaggrDomain[]> } | null = null;

const listDomains = async (): Promise<TaggrDomain[]> => {
  await readyIdentity();
  const canister = loadSettings().canister;
  if (domainList?.canister !== canister) {
    const pending = loadDomainConfigs().catch((error: unknown) => {
      if (domainList?.value === pending) domainList = null;
      throw error;
    });
    domainList = { canister, value: pending };
  }
  return domainList.value;
};

const activeDomain = async (): Promise<string> => {
  await readyIdentity();
  const settings = loadSettings();
  if (settings.domain !== null) return settings.domain;
  if (resolvedDomain?.canister === settings.canister) return resolvedDomain.domain;
  let known: TaggrDomain[] = [];
  try {
    known = await listDomains();
  } catch {
    // Offline or a deployment that answers nothing: fall through to the
    // canonical name, which is the right guess and a readable empty feed if
    // the deployment never registered it.
    return resolveDomain({ canister: settings.canister, domains: [] });
  }
  const domain = resolveDomain({ canister: settings.canister, domains: known });
  resolvedDomain = { canister: settings.canister, domain };
  return domain;
};

/** The config for the active domain, which decides what it suppresses. */
const activeDomainConfig = async (): Promise<TaggrDomain | null> => {
  const name = await activeDomain();
  try {
    return findDomain(await listDomains(), name);
  } catch {
    return null;
  }
};

// Revisions must be non-negative and monotonic for the tile's invalidation
// listener. Seeding from the clock keeps them increasing across reloads.
let revision = Date.now();

const publishChange = async (): Promise<void> => {
  revision += 1;
  try {
    await publishAppStateChange(STATE_TOPIC, String(revision));
  } catch {
    // A missed notification must never turn a successful write into a failure.
    // Open tiles still refresh on their next manual reload.
  }
};

/* ------------------------------------------------------------------ */
/* shaping                                                             */
/* ------------------------------------------------------------------ */

const truncate = (value: string, limit: number): { text: string; truncated: boolean } =>
  value.length <= limit
    ? { text: value, truncated: false }
    : { text: `${value.slice(0, limit - 1)}…`, truncated: true };

const postToJson = (entry: FeedEntry, domain: TaggrDomain | null): JsonObject => {
  const { post, meta } = entry;
  const body = truncate(post.body, MAX_BODY_CHARS);
  const suppressed = postSuppression({ post, meta, domain });
  return {
    id: post.id,
    author: meta.authorName,
    authorId: post.user,
    createdAt: absoluteTime(post.timestamp),
    realm: post.realm,
    nsfw: meta.nsfw,
    parentPostId: post.parent,
    replyCount: post.children.length,
    tags: post.tags,
    body: body.text,
    bodyTruncated: body.truncated,
    preview: toPlainText(post.body, 200),
    attachmentCount: post.files.length,
    // Taggr serves attachments as raw byte ranges from per-user bucket
    // canisters, so these are ordinary image URLs an agent can pass on.
    images: post.files.map((file) => bucketImageUrl(file)) as unknown as JsonValue,
    reactions: post.reactions.map((reaction) => ({
      id: reaction.id,
      emoji: reactionEmoji(reaction.id),
      count: reaction.users.length,
    })),
    kind: post.extension?.kind ?? "post",
    // Taggr's own front ends hide these. Reporting rather than dropping them
    // keeps the agent from concluding a post does not exist.
    suppressed: suppressed === null ? null : suppressionMessage(suppressed),
  };
};

const realmToJson = (realm: Realm): JsonObject => ({
  id: realm.id,
  description: toPlainText(realm.description, 400),
  members: realm.numMembers,
  posts: realm.numPosts,
  adultContent: realm.adultContent,
});

const userToJson = (user: TaggrUser): JsonObject => ({
  id: user.id,
  handle: user.name,
  about: toPlainText(user.about, 600),
  principal: user.principal,
  posts: user.numPosts,
  followers: user.followers.length,
  following: user.followees.length,
  realms: user.realms,
  credits: user.credits,
  tokens: user.balance,
  stalwart: user.stalwart,
});

const feedPayload = async (entries: FeedEntry[]): Promise<JsonObject> => {
  const trimmed = entries.slice(0, MAX_POSTS);
  const domain = await activeDomainConfig();
  return {
    posts: trimmed.map((entry) => postToJson(entry, domain)) as unknown as JsonValue,
    count: trimmed.length,
    omitted: Math.max(0, entries.length - trimmed.length),
  };
};

const objectSchema = (
  required: string[],
  properties: Record<string, JsonObject>,
): JsonObject => ({
  type: "object",
  required,
  properties: properties as unknown as JsonValue,
  additionalProperties: false,
});

const postSchema: JsonObject = { type: "object" };
const feedOutputSchema = objectSchema(["posts", "count", "omitted"], {
  posts: { type: "array", items: postSchema },
  count: { type: "integer" },
  omitted: { type: "integer" },
});

const SAME_APP: JsonObject = { "neutron:visibility": "same_app" };

const asString = (value: JsonValue | undefined, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const requireAccount = async (): Promise<void> => {
  if ((await loadUser(await activeDomain(), null)) === null) {
    throw new Error(
      "This installation has no Taggr account yet. Open the Taggr tile and register in Settings before writing.",
    );
  }
};

/**
 * The kernel filters `same_app` tools out of other apps' catalogs and rejects
 * cross-app invocation, but a control that can hand over the account deserves a
 * second, local check as well.
 */
const readyPrincipal = async (): Promise<string> =>
  (await readyIdentity()).getPrincipal().toText();

const requireOwnTile = (context: MsgBusToolContext, action: string): void => {
  if (context.agentMode === true || context.caller?.appId !== APP_ID) {
    throw new Error(`${action} is available only to this app's own tile.`);
  }
};

/* ------------------------------------------------------------------ */
/* agent-facing reads                                                  */
/* ------------------------------------------------------------------ */

exposeTool(
  "taggr_feed",
  {
    title: "Read a Taggr feed",
    description:
      "Read one page of the Taggr social feed. 'hot' ranks by engagement, 'new' is reverse chronological, and 'personal' is this installation's own following feed and needs a registered account.",
    inputSchema: objectSchema([], {
      mode: { type: "string", enum: ["hot", "new", "personal"] },
      realm: { type: "string", maxLength: 64 },
      page: { type: "integer", minimum: 0, maximum: 200 },
    }),
    outputSchema: feedOutputSchema,
  },
  async (args) =>
    feedPayload(
      await loadFeed({
        domain: await activeDomain(),
        mode: asString(args.mode, "hot") as FeedMode,
        realm: asString(args.realm) || null,
        page: asNumber(args.page, 0),
      }),
    ),
);

exposeTool(
  "taggr_thread",
  {
    title: "Read a Taggr conversation",
    description:
      "Read a Taggr post in context: the ancestor chain that leads to it, oldest first, followed by its direct replies.",
    inputSchema: objectSchema(["postId"], {
      postId: { type: "integer", minimum: 0 },
    }),
    outputSchema: objectSchema(["posts", "count", "omitted", "focusPostId"], {
      posts: { type: "array", items: postSchema },
      count: { type: "integer" },
      omitted: { type: "integer" },
      focusPostId: { type: "integer" },
    }),
  },
  async (args) => {
    const { entries, focus } = await loadConversation(asNumber(args.postId, 0));
    return { ...(await feedPayload(entries)), focusPostId: focus };
  },
);

exposeTool(
  "taggr_search",
  {
    title: "Search Taggr",
    description:
      "Search Taggr posts, users, realms, and tags. Each result identifies its kind and target: postId for a conversation, userId for a profile, realm for a community, or tag for a topic.",
    inputSchema: objectSchema(["query"], {
      query: { type: "string", minLength: 1, maxLength: 200 },
    }),
    outputSchema: objectSchema(["results", "count"], {
      results: { type: "array", items: { type: "object" } },
      count: { type: "integer" },
    }),
  },
  async (args) => {
    const results = await runSearch(await activeDomain(), asString(args.query));
    const trimmed = results.slice(0, MAX_SEARCH_RESULTS);
    return {
      results: trimmed.map((result) => ({
        kind: result.result,
        postId: result.result === "post" ? result.id : null,
        userId: result.result === "user" ? result.id : result.userId,
        realm: result.result === "realm" ? result.genericId : null,
        tag: result.result === "tag" ? result.relevant : null,
        match: result.relevant,
        snippet: toPlainText(result.relevant, 300),
      })) as unknown as JsonValue,
      count: trimmed.length,
    };
  },
);

exposeTool(
  "taggr_tags",
  {
    title: "List trending Taggr tags",
    description:
      "List the tags used most recently on Taggr with a relative weight. Useful for discovering what the network is currently discussing.",
    inputSchema: objectSchema([], {
      realm: { type: "string", maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
    outputSchema: objectSchema(["tags"], {
      tags: { type: "array", items: { type: "object" } },
    }),
  },
  async (args) => ({
    tags: (await recentTags({
      domain: await activeDomain(),
      realm: asString(args.realm) || null,
      limit: asNumber(args.limit, 50),
    })) as unknown as JsonValue,
  }),
);

exposeTool(
  "taggr_realms",
  {
    title: "Discover Taggr realms",
    description:
      "List or filter Taggr realms — the network's topic communities. An empty query returns the most popular realms.",
    inputSchema: objectSchema([], {
      query: { type: "string", maxLength: 100 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    outputSchema: objectSchema(["realms", "count"], {
      realms: { type: "array", items: { type: "object" } },
      count: { type: "integer" },
    }),
  },
  async (args) => {
    const realms = await browseRealms({
      domain: await activeDomain(),
      query: asString(args.query),
    });
    const trimmed = realms.slice(0, Math.min(asNumber(args.limit, MAX_REALMS), MAX_REALMS));
    return {
      realms: trimmed.map(realmToJson) as unknown as JsonValue,
      count: trimmed.length,
    };
  },
);

exposeTool(
  "taggr_user",
  {
    title: "Read a Taggr profile",
    description:
      "Read one Taggr user profile by handle. Omit the handle to read this installation's own account, if it has one.",
    inputSchema: objectSchema([], { handle: { type: "string", maxLength: 16 } }),
    outputSchema: objectSchema(["user"], { user: { type: ["object", "null"] } }),
  },
  async (args) => {
    const person = await loadUser(await activeDomain(), asString(args.handle) || null);
    return { user: person === null ? null : (userToJson(person) as unknown as JsonValue) };
  },
);

exposeTool(
  "taggr_user_posts",
  {
    title: "Read a Taggr user's posts",
    description: "Read one page of posts written by a Taggr user, newest first.",
    inputSchema: objectSchema(["handle"], {
      handle: { type: "string", minLength: 1, maxLength: 16 },
      page: { type: "integer", minimum: 0, maximum: 200 },
    }),
    outputSchema: feedOutputSchema,
  },
  async (args) =>
    feedPayload(
      await loadUserPosts({
        domain: await activeDomain(),
        handle: asString(args.handle),
        page: asNumber(args.page, 0),
      }),
    ),
);

exposeTool(
  "taggr_status",
  {
    title: "Taggr client status",
    description:
      "Report which Taggr deployment this app talks to, which feed domain it filters by, the principal it posts under, and whether that principal has a Taggr account. Check this before attempting to post or react.",
    inputSchema: objectSchema([], {}),
    outputSchema: objectSchema(
      ["canister", "domain", "domainFilter", "principal", "registered"],
      {
        canister: { type: "string" },
        domain: { type: "string" },
        domainFilter: { type: "string" },
        principal: { type: "string" },
        network: { type: "string" },
        registered: { type: "boolean" },
        handle: { type: ["string", "null"] },
        credits: { type: ["integer", "null"] },
      },
    ),
  },
  async () => {
    await readyIdentity();
    const settings = loadSettings();
    const domain = await activeDomain();
    const config = await activeDomainConfig();
    const account = await loadUser(domain, null);
    return {
      canister: settings.canister,
      domain,
      // Which realms this domain shows and how many downvotes it tolerates,
      // because that changes what every read below returns.
      domainFilter: config === null ? "unregistered on this deployment" : describeDomain(config),
      principal: await readyPrincipal(),
      network: isLocalHost() ? "local" : "ic",
      registered: account !== null,
      handle: account?.name ?? null,
      credits: account?.credits ?? null,
    };
  },
);

/* ------------------------------------------------------------------ */
/* agent-facing writes                                                 */
/* ------------------------------------------------------------------ */

exposeTool(
  "taggr_post",
  {
    title: "Publish to Taggr",
    description:
      "Publish a Markdown post to the public Taggr network under this installation's own principal, or reply to an existing post by giving its id. This is public and permanent: Taggr keeps an edit history and this client cannot delete. It costs the account 2 credits.",
    inputSchema: objectSchema(["body"], {
      body: { type: "string", minLength: 1, maxLength: 20000 },
      parentPostId: { type: "integer", minimum: 0 },
      realm: { type: "string", maxLength: 64 },
    }),
    outputSchema: objectSchema(["postId"], { postId: { type: "integer" } }),
  },
  async (args, context) => {
    await readyIdentity();
    const epoch = configurationEpoch;
    const principal = identityPrincipal();
    await requireAccount();
    assertConfiguration(epoch);
    if (identityPrincipal() !== principal) throw new Error("The Taggr account changed; retry from the current account");
    context.signal?.throwIfAborted();
    const postId = await addPost({
      body: asString(args.body),
      parent: typeof args.parentPostId === "number" ? args.parentPostId : null,
      realm: asString(args.realm) || null,
    });
    await publishChange();
    return { postId };
  },
);

exposeTool(
  "taggr_react",
  {
    title: "React to a Taggr post",
    // Reaction names rather than emoji: tool metadata is normalised as
    // untrusted text, which rejects the zero-width joiners and variation
    // selectors that several of these emoji carry.
    description:
      "React to a public Taggr post. Costs the account 1 credit, and Taggr rejects reactions to your own posts. Valid reactions: 1 downvote, 10 heart, 11 thumbs up, 12 sad, 50 fire, 51 joy, 52 hundred, 53 rocket, 100 star, 101 pirate.",
    inputSchema: objectSchema(["postId", "reaction"], {
      postId: { type: "integer", minimum: 0 },
      reaction: {
        type: "integer",
        enum: [
          DOWNVOTE_REACTION_ID,
          ...REACTIONS.map((reaction) => reaction.id),
        ] as unknown as JsonValue,
      },
    }),
    outputSchema: objectSchema(["postId", "reaction"], {
      postId: { type: "integer" },
      reaction: { type: "integer" },
    }),
  },
  async (args, context) => {
    await readyIdentity();
    const epoch = configurationEpoch;
    const principal = identityPrincipal();
    await requireAccount();
    assertConfiguration(epoch);
    if (identityPrincipal() !== principal) throw new Error("The Taggr account changed; retry from the current account");
    context.signal?.throwIfAborted();
    const postId = asNumber(args.postId, -1);
    const reaction = asNumber(args.reaction, -1);
    await sendReaction(postId, reaction);
    await publishChange();
    return { postId, reaction };
  },
);

/* ------------------------------------------------------------------ */
/* tile-facing tools                                                   */
/* ------------------------------------------------------------------ */

// The tile drives the network through these. They forward Taggr's raw JSON so
// the tile can use the same parsers as the background rather than a second,
// lossier shape.

exposeTool(
  "ui_read",
  {
    title: "Forward a Taggr read",
    description: "Internal: run one allowlisted Taggr query and return its raw JSON.",
    inputSchema: objectSchema(["method", "payload"], {
      method: { type: "string", maxLength: 64 },
      payload: { type: "string", maxLength: 200000 },
    }),
    outputSchema: objectSchema(["json"], { json: { type: "string" } }),
    annotations: SAME_APP,
  },
  async (args) => {
    const method = asString(args.method);
    if (!isReadMethod(method)) throw new Error(`${method} is not an allowed Taggr read`);
    const taggr = await currentClient();
    return { json: await taggr.query(method, asString(args.payload, "null")) };
  },
);

exposeTool(
  "ui_write",
  {
    title: "Forward a Taggr write",
    description: "Internal: run one allowlisted Taggr update and return its raw JSON.",
    inputSchema: objectSchema(["method", "payload"], {
      method: { type: "string", maxLength: 64 },
      payload: { type: "string", maxLength: 200000 },
    }),
    outputSchema: objectSchema(["json"], { json: { type: "string" } }),
    annotations: SAME_APP,
  },
  async (args) => {
    const method = asString(args.method);
    if (!isWriteMethod(method)) throw new Error(`${method} is not an allowed Taggr write`);
    const taggr = await currentClient();
    const json = await taggr.update(method, asString(args.payload, "null"));
    await publishChange();
    return { json };
  },
);

exposeTool(
  "ui_add_post",
  {
    title: "Publish from the tile",
    description: "Internal: publish a post or reply composed in the Taggr tile.",
    inputSchema: objectSchema(["body"], {
      body: { type: "string", minLength: 1, maxLength: 100000 },
      parentPostId: { type: ["integer", "null"], minimum: 0 },
      realm: { type: ["string", "null"], maxLength: 64 },
    }),
    outputSchema: objectSchema(["postId"], { postId: { type: "integer" } }),
    annotations: SAME_APP,
  },
  async (args) => {
    const postId = await addPost({
      body: asString(args.body),
      parent: typeof args.parentPostId === "number" ? args.parentPostId : null,
      realm: asString(args.realm) || null,
    });
    await publishChange();
    return { postId };
  },
);

exposeTool(
  "ui_settings",
  {
    title: "Taggr client settings",
    description: "Internal: the deployment, feed domain, and identity this tile is using.",
    inputSchema: objectSchema([], {}),
    outputSchema: objectSchema(
      [
        "canister",
        "domain",
        "domainPinned",
        "principal",
        "network",
        "domains",
        "stored",
        "storageError",
      ],
      {
        canister: { type: "string" },
        domain: { type: "string" },
        /** False when the domain follows the deployment rather than a choice. */
        domainPinned: { type: "boolean" },
        principal: { type: "string" },
        network: { type: "string" },
        domains: { type: "array" },
        stored: { type: "boolean" },
        storageError: { type: ["string", "null"] },
      },
    ),
    annotations: SAME_APP,
  },
  async () => {
    await readyIdentity();
    const settings = loadSettings();
    let known: TaggrDomain[] = [];
    try {
      known = await listDomains();
    } catch {
      // The picker degrades to the resolved name; the feed reports the failure.
    }
    return {
      canister: settings.canister,
      domain: await activeDomain(),
      domainPinned: settings.domain !== null,
      principal: await readyPrincipal(),
      // False while the account exists only in this browser, which the tile
      // turns into a warning: that copy does not survive clearing site data.
      stored: identitySync().stored,
      storageError: identitySync().error,
      network: isLocalHost() ? "local" : "ic",
      domains: known.map((domain) => ({
        name: domain.name,
        maxDownvotes: domain.maxDownvotes,
        owner: domain.owner,
        scope: domain.scope.kind,
        realms: domain.scope.kind === "journal" ? [] : domain.scope.realms,
      })),
    };
  },
);

exposeTool(
  "ui_configure",
  {
    title: "Change the Taggr deployment or feed domain",
    description: "Internal: point this installation at a Taggr canister and feed domain.",
    inputSchema: objectSchema(["canister"], {
      canister: { type: "string", minLength: 5, maxLength: 64 },
      // Null follows whatever the deployment registered as its canonical
      // domain, which is what an unconfigured installation does.
      domain: { type: ["string", "null"], maxLength: 64 },
    }),
    outputSchema: objectSchema(["canister", "domain"], {
      canister: { type: "string" },
      domain: { type: "string" },
    }),
    annotations: SAME_APP,
  },
  async (args, context) => {
    requireOwnTile(context, "Changing the Taggr deployment");
    await readyIdentity();
    context.signal?.throwIfAborted();
    const settings = saveSettings({
      canister: asString(args.canister),
      domain: typeof args.domain === "string" && args.domain.length > 0 ? args.domain : null,
    });
    invalidateClient();
    resolvedDomain = null;
    domainList = null;
    await pushSettings(settings);
    await publishChange();
    return { canister: settings.canister, domain: await activeDomain() };
  },
);

exposeTool(
  "ui_identity",
  {
    title: "Manage the Taggr identity",
    description:
      "Internal: export, import, or replace the key this installation posts under. The exported string is the account.",
    inputSchema: objectSchema(["action"], {
      action: { type: "string", enum: ["export", "import", "reset"] },
      backup: { type: "string", maxLength: 4096 },
    }),
    outputSchema: objectSchema(["principal"], {
      principal: { type: "string" },
      backup: { type: ["string", "null"] },
    }),
    annotations: SAME_APP,
  },
  async (args, context) => {
    requireOwnTile(context, "Managing the Taggr identity");
    const action = asString(args.action);
    if (action === "export") {
      await readyIdentity();
      return { principal: identityPrincipal(), backup: exportIdentity() };
    }
    if (action === "import") {
      // Import and reset replace the account, so the canister has to learn the
      // new key before the old one stops being reachable.
      await readyIdentity();
      context.signal?.throwIfAborted();
      let identity: Ed25519KeyIdentity;
      try {
        identity = await replaceStoredIdentity(parseIdentityBackup(asString(args.backup)));
      } catch (error) {
        hydration = null;
        invalidateClient();
        throw error;
      }
      hydration = Promise.resolve(identity);
      invalidateClient();
      await publishChange();
      return { principal: identity.getPrincipal().toText(), backup: null };
    }
    if (action === "reset") {
      await readyIdentity();
      context.signal?.throwIfAborted();
      let identity: Ed25519KeyIdentity;
      try {
        identity = await replaceStoredIdentity(Ed25519KeyIdentity.generate());
      } catch (error) {
        hydration = null;
        invalidateClient();
        throw error;
      }
      hydration = Promise.resolve(identity);
      invalidateClient();
      await publishChange();
      return { principal: identity.getPrincipal().toText(), backup: null };
    }
    throw new Error("Unknown identity action");
  },
);

exposeTool(
  "ui_validate_username",
  {
    title: "Check a Taggr handle",
    description: "Internal: ask Taggr whether a handle is available and well formed.",
    inputSchema: objectSchema(["name"], { name: { type: "string", maxLength: 32 } }),
    outputSchema: objectSchema(["error"], { error: { type: ["string", "null"] } }),
    annotations: SAME_APP,
  },
  async (args) => ({ error: await validateUsername(asString(args.name)) }),
);

/**
 * Reads the invoice without committing to anything: `mint_credits_with_icp(0)`
 * creates it at the current XDR rate if there is none and returns it unpaid
 * rather than erroring, so the tile can show the exact price first.
 */
exposeTool(
  "ui_registration_quote",
  {
    title: "Price this installation's Taggr registration",
    description: "Internal: read the Taggr ICP invoice for this installation.",
    inputSchema: objectSchema([], {}),
    outputSchema: objectSchema(["amountAtoms", "paid", "account"], {
      amountAtoms: { type: "string" },
      paid: { type: "boolean" },
      account: { type: "string" },
    }),
    annotations: SAME_APP,
  },
  async (_args, context) => {
    requireOwnTile(context, "Pricing a Taggr registration");
    await readyIdentity();
    const epoch = configurationEpoch;
    const settings = loadSettings();
    const principal = identityPrincipal();
    context.signal?.throwIfAborted();
    const invoice = await mintCreditsWithIcp(0);
    assertConfiguration(epoch);
    return {
      amountAtoms: invoice.amountAtoms,
      paid: invoice.paid,
      account: invoiceAccountText({
        taggrCanister: settings.canister,
        principal,
      }),
    };
  },
);

/**
 * Registration in one step: price the invoice, ask Wallet to pay it, settle it,
 * then create the account.
 *
 * Wallet's `wallet_fund_v1` carries the `provider_once` consent annotation, so
 * the kernel suspends this call, opens Wallet's own tile, and Wallet renders the
 * review and moves the value with its own authority. This app names a
 * destination and an amount and learns the outcome; it never touches a ledger.
 */
const registrationFlights = new Map<string, Promise<JsonObject>>();

const finishRegistration = async (
  scope: RegistrationFundingScope,
  blockIndex: string | null,
  step = "registered",
): Promise<JsonObject> => {
  try {
    removeRegistrationFunding(scope);
  } catch {
    step += "; the original payment record is retained for reconciliation";
  }
  await publishChange();
  return { registered: true, step, blockIndex };
};

const registerWithWallet = async (
  handle: string,
  context: MsgBusToolContext,
  scope: RegistrationFundingScope,
  epoch: number,
): Promise<JsonObject> => {
  const check = () => {
    assertConfiguration(epoch);
    context.signal?.throwIfAborted();
    if (identityPrincipal() !== scope.principal || loadSettings().canister !== scope.taggrCanister) {
      throw new Error("The Taggr account changed; continue registration from the original account");
    }
  };
  check();
  const domain = await activeDomain();
  check();
  if ((await loadUser(domain, null)) !== null) {
    return finishRegistration(scope, null, "already registered");
  }
  check();
  let invoice = await mintCreditsWithIcp(0);
  check();
  let saved = loadRegistrationFunding(scope);
  let blockIndex = saved?.blockIndex ?? null;

  if (!invoice.paid) {
    if (!saved || saved.status === "rejected") {
      saved = {
        version: 1,
        request: createFundingRequest({
          to: invoiceAccountText(scope),
          amountAtoms: invoice.amountAtoms,
        }),
        status: "requested",
        blockIndex: null,
      };
      // Persist before handing anything to Wallet. A remounted background must
      // reuse this exact command even after its original validity elapsed.
      saveRegistrationFunding(scope, saved);
    }
    if (saved.status !== "transferred") {
      let reply: JsonValue;
      try {
        check();
        reply = await context.kernel.callTool(
          { target: WALLET_TARGET, name: WALLET_FUNDING_TOOL, arguments: saved.request },
          WALLET_FUNDING_TIMEOUT_SECONDS,
        );
      } catch (error: unknown) {
        throw new Error(`${describeWalletError(error)} Saved payment request ${saved.request.requestId}; retry registration to reconcile the same payment.`);
      }
      const outcome = parseFundingResult(reply, saved.request.requestId);
      if (outcome.status === "rejected") {
        saveRegistrationFunding(scope, { ...saved, status: "rejected", blockIndex: null });
        throw new Error(fundingFailureMessage(outcome));
      }
      if (outcome.status !== "transferred") {
        throw new Error(`${fundingFailureMessage(outcome)} Saved payment request ${saved.request.requestId} will be reused.`);
      }
      blockIndex = outcome.blockIndex;
      saved = { ...saved, status: "transferred", blockIndex };
      // Record the confirmed transfer before checking a changed UI selection.
      saveRegistrationFunding(scope, saved);
    }
    check();
    invoice = await mintCreditsWithIcp(1);
    check();
    if (!invoice.paid) {
      throw new Error("Wallet transferred the payment, but Taggr has not settled the invoice yet. Retry registration to check settlement without paying again.");
    }
  }
  check();
  await createUser(handle, "");
  // A successful create_user reply is the write outcome. A later query or
  // notification failure must not turn it into an invitation to pay again.
  return finishRegistration(scope, blockIndex);
};

exposeTool(
  "ui_register_with_icp",
  {
    title: "Register on Taggr, paying through Wallet",
    description:
      "Internal: price the Taggr registration invoice, ask Wallet to pay it, and create the account.",
    inputSchema: objectSchema(["name"], {
      name: { type: "string", minLength: 2, maxLength: 16 },
    }),
    outputSchema: objectSchema(["registered", "step"], {
      registered: { type: "boolean" },
      step: { type: "string" },
      blockIndex: { type: ["string", "null"] },
    }),
    annotations: SAME_APP,
  },
  async (args, context) => {
    requireOwnTile(context, "Registering on Taggr");
    await readyIdentity();
    context.signal?.throwIfAborted();
    const handle = asString(args.name);
    const scope = {
      taggrCanister: loadSettings().canister,
      principal: identityPrincipal(),
    };
    const key = `${scope.taggrCanister}:${scope.principal}`;
    const existing = registrationFlights.get(key);
    if (existing) return existing;
    const result = registerWithWallet(handle, context, scope, configurationEpoch);
    registrationFlights.set(key, result);
    void result.finally(() => {
      if (registrationFlights.get(key) === result) registrationFlights.delete(key);
    }).catch(() => undefined);
    return result;
  },
);

exposeTool(
  "ui_register",
  {
    title: "Register on Taggr",
    description: "Internal: create the Taggr account for this installation's principal.",
    inputSchema: objectSchema(["name", "invite"], {
      name: { type: "string", minLength: 2, maxLength: 16 },
      invite: { type: "string", maxLength: 64 },
    }),
    outputSchema: objectSchema(["registered"], { registered: { type: "boolean" } }),
    annotations: SAME_APP,
  },
  async (args, context) => {
    await readyIdentity();
    context.signal?.throwIfAborted();
    await createUser(asString(args.name), asString(args.invite));
    await publishChange();
    return { registered: true };
  },
);

// Surface the identity and target once at start, so a misconfigured deployment
// is visible in the background's console rather than only as empty feeds.
void (async () => {
  try {
    const principal = await readyPrincipal();
    const settings = loadSettings();
    const where = identitySync().stored ? "this Neutron" : "this browser only";
    console.info(
      `Taggr client ready: ${principal} (key in ${where}) -> ${settings.canister} via ${replicaHost()}`,
    );
  } catch (error: unknown) {
    console.error("Taggr client could not start:", error);
  }
})();
