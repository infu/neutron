import { exposeTool } from "neutron-tools/app";
import type { JsonObject, JsonValue } from "neutron-tools/protocol";
import type { OpenChatEngine } from "../engine/engine.ts";
import { OC_VIEW_CHAT, TOOLS } from "../shared/protocol.ts";

const OC_APP_ID = "openchat";
const OC_CHATS_TILE = "chats";

// Registers the OpenChat tool surface on the resident endpoint. The chat tools
// are discoverable by the Neutron agent, so the agent can drive OpenChat the
// same way the UI does. Onboarding tools are marked same-app (tile-only)
// because email sign-in is inherently interactive.

const SAME_APP = { "neutron:visibility": "same_app" } as const;

type Schema = JsonObject;
const object = (properties: JsonObject, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string): JsonObject => ({ type: "string", description });
const int = (description: string): JsonObject => ({ type: "integer", description, minimum: 1 });
const bool = (description: string): JsonObject => ({ type: "boolean", description });

export function registerTools(engine: OpenChatEngine, expose = exposeTool): void {
  const s = (v: unknown): JsonValue => v as JsonValue;
  const chatReads = new Set<string>([
    TOOLS.listChats, TOOLS.readMessages, TOOLS.sendMessage, TOOLS.showChat, TOOLS.markAllRead,
  ]);
  const publicReads = new Set<string>([TOOLS.exploreCommunities, TOOLS.exploreGroups]);
  const register: typeof exposeTool = (name, options, handler) => {
    expose(name, options, async (args, context) => {
      // Account callers, including agents that skip whoami, share restoration.
      // Route-dependent tools also need the first chat snapshot. The public
      // directory remains available independently of local session storage.
      if (chatReads.has(name)) await engine.whenChatsReady();
      else if (!publicReads.has(name)) await engine.whenReady();
      context.signal?.throwIfAborted();
      return handler(args, context);
    });
  };

  register(
    TOOLS.whoami,
    {
      title: "OpenChat account",
      description: "Report the signed-in OpenChat account, if any.",
      inputSchema: object({}),
    },
    () => s(engine.whoami()),
  );

  register(
    TOOLS.listChats,
    {
      title: "List chats",
      description: "List the user's OpenChat direct chats, groups, and channels, most recent first.",
      inputSchema: object({}),
    },
    () => s({ chats: engine.listChats() }),
  );

  register(
    TOOLS.readMessages,
    {
      title: "Read messages",
      description: "Read recent messages in a chat. chatId comes from list_chats.",
      inputSchema: object(
        { chatId: str("Chat id from list_chats"), limit: int("Max messages (default 50)") },
        ["chatId"],
      ),
    },
    async (args) =>
      s({ messages: await engine.readMessages(String(args.chatId), clampLimit(args.limit)) }),
  );

  register(
    TOOLS.sendMessage,
    {
      title: "Send message",
      description:
        "Send a text message to a chat (direct, group, or channel) by chatId. If the chat " +
        "requires accepting rules, the result kind is 'rules_required' with the rules in " +
        "rulesText; call again with accept_rules=true to accept them and post.",
      inputSchema: object(
        {
          chatId: str("Chat id from list_chats"),
          text: str("Message text"),
          accept_rules: bool("Accept the chat's rules and post (use after a rules_required result)"),
        },
        ["chatId", "text"],
      ),
    },
    async (args) =>
      s(await engine.sendMessage(String(args.chatId), String(args.text), args.accept_rules === true)),
  );

  register(
    TOOLS.dmUser,
    {
      title: "Direct-message a user",
      description: "Send a direct message to a user by username or principal, creating the DM if needed.",
      inputSchema: object({ user: str("Username or principal"), text: str("Message text") }, [
        "user",
        "text",
      ]),
    },
    async (args) => s(await engine.dmUser(String(args.user), String(args.text))),
  );

  register(
    TOOLS.search,
    {
      title: "Search users",
      description: "Search OpenChat users by name.",
      inputSchema: object({ query: str("Search term") }, ["query"]),
    },
    async (args) => s({ users: await engine.search(String(args.query)) }),
  );

  register(
    TOOLS.joinGroup,
    {
      title: "Join group",
      description: "Join a public OpenChat group by its group id (principal).",
      inputSchema: object({ groupId: str("Group principal") }, ["groupId"]),
    },
    async (args) => s(await engine.joinGroup(String(args.groupId))),
  );

  register(
    TOOLS.joinCommunity,
    {
      title: "Join community",
      description: "Join a public OpenChat community by its community id (principal).",
      inputSchema: object({ communityId: str("Community principal") }, ["communityId"]),
    },
    async (args) => s(await engine.joinCommunity(String(args.communityId))),
  );

  register(
    TOOLS.exploreCommunities,
    {
      title: "Discover communities",
      description:
        "Browse the public OpenChat community directory. Omit query for popular communities, " +
        "or pass a search term. Returns ids you can pass to join_community.",
      inputSchema: object({ query: str("Optional search term") }),
    },
    async (args) =>
      s({ communities: await engine.exploreCommunities(typeof args.query === "string" ? args.query : undefined) }),
  );

  register(
    TOOLS.exploreGroups,
    {
      title: "Discover groups",
      description:
        "Browse the public OpenChat group directory. Omit query for popular groups, or pass a " +
        "search term. Returns ids you can pass to join_group.",
      inputSchema: object({ query: str("Optional search term") }),
    },
    async (args) =>
      s({ groups: await engine.exploreGroups(typeof args.query === "string" ? args.query : undefined) }),
  );

  register(
    TOOLS.showChat,
    {
      title: "Show a chat in the UI",
      description:
        "Open the OpenChat tile and display a specific chat, as if the user navigated to it. " +
        "Pass a chatId from list_chats, or a natural query like a group or person name.",
      inputSchema: object({
        chatId: str("Exact chat id from list_chats (preferred)"),
        query: str("Or a name to match a chat by, e.g. a group or username"),
      }),
    },
    async (args, context) => {
      const result = engine.showChat(
        typeof args.chatId === "string" ? args.chatId : undefined,
        typeof args.query === "string" ? args.query : undefined,
      );
      if (result.ok) {
        // Use this invocation's scoped Kernel client so owner/Root authority
        // and cancellation stay attached to the request to open the tile.
        try {
          await context.kernel.callTool({
            target: "kernel",
            name: "workspace.open_tile",
            arguments: {
              appId: OC_APP_ID,
              tileId: OC_CHATS_TILE,
              reuseExisting: true,
              view: OC_VIEW_CHAT,
            },
          });
        } catch (error) {
          context.signal?.throwIfAborted();
          return s({
            ...result,
            ok: false,
            message: `Chat selected, but its tile could not be opened: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return s(result);
    },
  );

  register(
    TOOLS.takePendingNav,
    {
      title: "Take pending navigation",
      description: "Return and clear the chat the tile should navigate to.",
      inputSchema: object({}),
      annotations: SAME_APP,
    },
    () => s(engine.takePendingNav()),
  );

  register(
    TOOLS.setAvatar,
    {
      title: "Set avatar",
      description: "Set the signed-in user's avatar from a resized image data URL.",
      inputSchema: object({ dataUrl: str("A data:image/... URL (already resized, <=800KB)") }, ["dataUrl"]),
      annotations: SAME_APP,
    },
    async (args) => s(await engine.setAvatar(String(args.dataUrl))),
  );

  register(
    TOOLS.getProfile,
    {
      title: "Get profile",
      description: "Return the signed-in user's editable profile (username, display name, bio, avatar).",
      inputSchema: object({}),
      annotations: SAME_APP,
    },
    async () => s(await engine.getProfile()),
  );

  register(
    TOOLS.saveProfile,
    {
      title: "Save profile",
      description: "Update the signed-in user's username, display name, and/or bio.",
      inputSchema: object({
        username: str("New username (5-20 chars)"),
        displayName: str("New display name (3-25 chars; empty to clear)"),
        bio: str("New bio (<=2000 chars)"),
      }),
      annotations: SAME_APP,
    },
    async (args) =>
      s(
        await engine.saveProfile({
          ...(typeof args.username === "string" ? { username: args.username } : {}),
          ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
          ...(typeof args.bio === "string" ? { bio: args.bio } : {}),
        }),
      ),
  );

  register(
    TOOLS.markAllRead,
    {
      title: "Mark all as read",
      description: "Mark every chat (direct, group, and channel) as read, clearing all unread indicators.",
      inputSchema: object({}),
    },
    async () => s(await engine.markAllRead()),
  );

  register(
    TOOLS.refresh,
    {
      title: "Refresh",
      description: "Re-fetch the chat list from OpenChat now.",
      inputSchema: object({}),
    },
    async () => {
      await engine.refresh();
      return s({ chats: engine.listChats() });
    },
  );

  // -- tile-only onboarding ------------------------------------------------
  register(
    TOOLS.signInStart,
    {
      title: "Start email sign-in",
      description: "Begin email sign-in; the magic-link email is sent in the background.",
      inputSchema: object({ email: str("Email address") }, ["email"]),
      annotations: SAME_APP,
    },
    (args) => s(engine.signInStart(String(args.email))),
  );

  register(
    TOOLS.signInStatus,
    {
      title: "Email sign-in status",
      description: "Report whether the magic-link email is sending, and the confirmation code once ready.",
      inputSchema: object({}),
      annotations: SAME_APP,
    },
    () => s(engine.signInStatus()),
  );

  register(
    TOOLS.signInComplete,
    {
      title: "Complete email sign-in link",
      description: "Complete a pasted OpenChat magic link.",
      inputSchema: object({ link: str("The full magic link URL from the email") }, ["link"]),
      annotations: SAME_APP,
    },
    async (args) => s(await engine.signInComplete(String(args.link))),
  );

  register(
    TOOLS.signInPoll,
    {
      title: "Poll email sign-in",
      description: "Check whether the magic link has been confirmed; register if a username is given.",
      inputSchema: object({ username: str("Username for a new account (optional)") }),
      annotations: SAME_APP,
    },
    async (args) =>
      s(await engine.signInPoll(typeof args.username === "string" ? args.username : undefined)),
  );

  register(
    TOOLS.signOut,
    {
      title: "Sign out",
      description: "Forget the OpenChat session on this device.",
      inputSchema: object({}),
      annotations: SAME_APP,
    },
    async () => {
      await engine.signOut();
      return s({ ok: true });
    },
  );
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" ? v : 50;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}
