import { callTool, onAppStateChange } from "neutron-tools/app";
import type { JsonObject, JsonValue } from "neutron-tools/protocol";
import {
  OC_BACKGROUND,
  OC_NAV_TOPIC,
  OC_STATE_TOPIC,
  TOOLS,
  type ChatVM,
  type DirectoryEntryVM,
  type JoinResultVM,
  type MessageVM,
  type PendingNavVM,
  type ProfileVM,
  type SaveProfileResultVM,
  type SendResultVM,
  type SetAvatarResultVM,
  type ShowChatResultVM,
  type SignInCompleteVM,
  type SignInPollVM,
  type SignInStartVM,
  type SignInStateVM,
  type UserVM,
  type WhoAmIVM,
} from "./protocol.ts";

// Tile-side client. Tiles never touch the OpenChat network directly; they call
// the resident engine's tools over the private message bus (same-app, so no
// kernel dialog) and subscribe to state-change revisions to refresh.

async function call<T>(name: string, args: JsonObject = {}, timeout = 60): Promise<T> {
  const result = await callTool<JsonValue>(
    { target: OC_BACKGROUND, name, arguments: args },
    timeout,
  );
  return result as T;
}

export const oc = {
  // Short timeout: if the resident is mid-restart, fail fast so useWhoami can
  // retry rather than hang on one call (it never downgrades on failure).
  whoami: () => call<WhoAmIVM>(TOOLS.whoami, {}, 15),
  listChats: () => call<{ chats: ChatVM[] }>(TOOLS.listChats).then((r) => r.chats),
  readMessages: (chatId: string, limit?: number) =>
    call<{ messages: MessageVM[] }>(TOOLS.readMessages, { chatId, ...(limit ? { limit } : {}) }).then(
      (r) => r.messages,
    ),
  sendMessage: (chatId: string, text: string, acceptRules = false) =>
    call<SendResultVM>(TOOLS.sendMessage, { chatId, text, ...(acceptRules ? { accept_rules: true } : {}) }),
  dmUser: (user: string, text: string) => call<SendResultVM>(TOOLS.dmUser, { user, text }),
  search: (query: string) => call<{ users: UserVM[] }>(TOOLS.search, { query }).then((r) => r.users),
  joinGroup: (groupId: string) => call<JoinResultVM>(TOOLS.joinGroup, { groupId }),
  joinCommunity: (communityId: string) => call<JoinResultVM>(TOOLS.joinCommunity, { communityId }),
  exploreCommunities: (query?: string) =>
    call<{ communities: DirectoryEntryVM[] }>(TOOLS.exploreCommunities, query ? { query } : {}).then(
      (r) => r.communities,
    ),
  exploreGroups: (query?: string) =>
    call<{ groups: DirectoryEntryVM[] }>(TOOLS.exploreGroups, query ? { query } : {}).then((r) => r.groups),
  showChat: (target: { chatId?: string; query?: string }) =>
    call<ShowChatResultVM>(TOOLS.showChat, target),
  takePendingNav: () => call<PendingNavVM>(TOOLS.takePendingNav),
  markAllRead: () => call<{ ok: boolean; message: string | null }>(TOOLS.markAllRead, {}, 60),
  refresh: () => call<{ chats: ChatVM[] }>(TOOLS.refresh).then((r) => r.chats),
  signInStart: (email: string) => call<SignInStartVM>(TOOLS.signInStart, { email }),
  signInStatus: () => call<SignInStateVM>(TOOLS.signInStatus),
  signInComplete: (link: string) => call<SignInCompleteVM>(TOOLS.signInComplete, { link }),
  signInPoll: (username?: string) =>
    call<SignInPollVM>(TOOLS.signInPoll, username ? { username } : {}),
  signOut: () => call<{ ok: boolean }>(TOOLS.signOut),
  setAvatar: (dataUrl: string) => call<SetAvatarResultVM>(TOOLS.setAvatar, { dataUrl }, 90),
  getProfile: () => call<ProfileVM>(TOOLS.getProfile),
  saveProfile: (fields: { username?: string; displayName?: string; bio?: string }) =>
    call<SaveProfileResultVM>(TOOLS.saveProfile, fields, 90),
};

export function subscribeChats(onChange: (revision: string) => void): () => void {
  return onAppStateChange(OC_STATE_TOPIC, ({ revision }) => onChange(revision));
}

export function subscribeNav(onChange: (revision: string) => void): () => void {
  return onAppStateChange(OC_NAV_TOPIC, ({ revision }) => onChange(revision));
}
