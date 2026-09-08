// The contract shared by the resident engine (tool provider), the tile UI
// (tool consumer), and the Neutron agent (tool consumer). Everything here is
// JSON-safe: it crosses the private message bus, so no BigInt / Uint8Array —
// ids and large integers are strings.

export const OC_BACKGROUND = "app:openchat:background" as const;
export const OC_STATE_TOPIC = "chats" as const;
export const OC_NAV_TOPIC = "nav" as const;
/** The bounded view token delivered to the tile to signal a pending navigation. */
export const OC_VIEW_CHAT = "chat" as const;

export type ChatKind = "direct" | "group" | "channel";

/** Opaque, addressable chat id used across the bus. Encodings:
 *  direct:<userPrincipal> | group:<groupPrincipal> | channel:<communityPrincipal>:<channelId>
 */
export type ChatId = string;

export type MessagePreview = {
  text: string;
  senderId: string | null;
  timestampMs: number;
};

export type ChatVM = {
  id: ChatId;
  kind: ChatKind;
  title: string;
  subtitle: string | null;
  lastMessage: MessagePreview | null;
  unread: number;
  lastUpdatedMs: number;
  avatarUrl?: string | null; // person (DM), group, or community avatar
  // Community grouping for the folder/tree view (channel rows only). The tile
  // groups channels by communityId under a folder named communityName, shows
  // channelName inside it, and treats primaryChannel as the community's main
  // ("general") channel — the one opened when the folder is clicked.
  communityId?: string | null;
  communityName?: string | null;
  channelName?: string | null;
  primaryChannel?: boolean;
};

/** A renderable image on a message. thumbnailDataUrl is a self-contained
 *  `data:` URL (inline, no network) safe to show in the sandboxed frame;
 *  fullUrl is the full-resolution blob on the IC http gateway. */
export type MessageImageVM = {
  thumbnailDataUrl: string | null;
  fullUrl: string | null;
  width: number;
  height: number;
};

export type MessageVM = {
  messageId: string;
  index: number;
  senderId: string;
  senderName: string | null;
  senderAvatarUrl: string | null;
  text: string;
  contentKind: string;
  image: MessageImageVM | null;
  timestampMs: number;
  mine: boolean;
  edited: boolean;
};

export type WhoAmIVM = {
  status: "logged_out" | "awaiting_email" | "logged_in";
  ocPrincipal: string | null;
  userId: string | null;
  username: string | null;
  avatarUrl?: string | null;
  pendingEmail: string | null;
};

export type SetAvatarResultVM = { ok: boolean; message: string | null };

/** The editable profile fields OpenChat exposes. */
export type ProfileVM = {
  username: string;
  displayName: string | null;
  bio: string;
  avatarUrl: string | null;
};

export type SaveProfileResultVM = { ok: boolean; message: string | null };

export type UserVM = {
  userId: string;
  username: string;
  displayName: string | null;
};

/** A discoverable public community or group from the OpenChat directory. */
export type DirectoryEntryVM = {
  id: string; // community or group principal — pass to join_community / join_group
  kind: "community" | "group";
  name: string;
  description: string;
  members: number;
  channels: number | null;
  gated: boolean;
  verified: boolean;
};

// Starting sign-in only *accepts* the request; sending the magic-link email is
// a slow IC update (it makes an HTTPS outcall), so it runs in the background and
// the UI polls signInStatus for the code rather than blocking on one RPC.
export type SignInStartVM = {
  accepted: boolean;
  message: string | null;
};

// The paste box is shown as soon as sign-in is `ready`. `emailSent` flips true
// once generate_magic_link's reply arrives (that reply carries the user_key we
// need to finish); until then completion waits only on that one value.
export type SignInStateVM =
  | { phase: "idle" }
  | { phase: "ready"; email: string; emailSent: boolean; code: string | null }
  | { phase: "error"; message: string };

export type SignInCompleteVM = { ok: boolean; message: string | null };

export type SignInPollVM = {
  status: "pending" | "logged_in" | "expired" | "error";
  message: string | null;
};

export type JoinResultVM = {
  kind: "joined" | "already_member" | "gate_blocked" | "not_found" | "error";
  message: string | null;
};

export type ShowChatResultVM = {
  ok: boolean;
  chatId: ChatId | null;
  title: string | null;
  message: string | null;
};

export type PendingNavVM = { chatId: ChatId; title: string } | null;

export type SendResultVM = {
  // `rules_required` means the chat has rules that must be accepted before
  // posting; `rulesText` carries them so the UI/agent can show them and resend
  // with acceptRules=true.
  kind: "sent" | "duplicate" | "error" | "rules_required";
  messageId: string;
  message: string | null;
  rulesText?: string | null;
};

// Tool names. The chat tools are discoverable by the Neutron agent so it can
// drive OpenChat exactly as the UI does. The onboarding tools are marked
// same-app (tile-only) because email sign-in is inherently interactive.
export const TOOLS = {
  whoami: "openchat.whoami",
  listChats: "openchat.list_chats",
  readMessages: "openchat.read_messages",
  sendMessage: "openchat.send_message",
  dmUser: "openchat.dm_user",
  search: "openchat.search",
  joinGroup: "openchat.join_group",
  joinCommunity: "openchat.join_community",
  exploreCommunities: "openchat.explore_communities",
  exploreGroups: "openchat.explore_groups",
  showChat: "openchat.show_chat",
  markAllRead: "openchat.mark_all_read",
  refresh: "openchat.refresh",
  // tile-only (same_app)
  setAvatar: "openchat.set_avatar",
  getProfile: "openchat.get_profile",
  saveProfile: "openchat.save_profile",
  takePendingNav: "openchat.take_pending_nav",
  signInStart: "openchat.sign_in_email_start",
  signInStatus: "openchat.sign_in_email_status",
  signInPoll: "openchat.sign_in_email_poll",
  signInComplete: "openchat.sign_in_email_complete",
  signOut: "openchat.sign_out",
} as const;

export const AGENT_TOOLS: string[] = [
  TOOLS.whoami,
  TOOLS.listChats,
  TOOLS.readMessages,
  TOOLS.sendMessage,
  TOOLS.dmUser,
  TOOLS.search,
  TOOLS.joinGroup,
  TOOLS.joinCommunity,
  TOOLS.exploreCommunities,
  TOOLS.exploreGroups,
  TOOLS.showChat,
  TOOLS.markAllRead,
];
