import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { OC_CANISTERS } from "./constants.ts";
import type { OcTransport } from "./transport.ts";

// Thin typed wrappers over the OpenChat msgpack canisters. Request argument
// shapes are exact (correctness-critical); responses are returned as decoded
// records and interpreted by the caller / view mappers. Principals travel as
// raw bytes (Uint8Array); large ids (message_id: u64) travel as bigint.

export type Variant = Record<string, unknown>;

const bytes = (p: Principal | string): Uint8Array =>
  (typeof p === "string" ? Principal.fromText(p) : p).toUint8Array();

export function randomMessageId(): bigint {
  const buf = new BigUint64Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]!;
}

// ---------------------------------------------------------------------------
// identity canister
// ---------------------------------------------------------------------------
export class IdentityCanisterClient {
  constructor(private readonly t: OcTransport) {}

  checkAuthPrincipal(identity: Identity): Promise<Variant> {
    return this.t.msgpackQuery(OC_CANISTERS.identity, "check_auth_principal_v2", {}, identity);
  }

  createIdentity(
    identity: Identity,
    publicKeyDer: Uint8Array,
    sessionKeyDer: Uint8Array,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      OC_CANISTERS.identity,
      "create_identity",
      {
        public_key: publicKeyDer,
        webauthn_key: null,
        session_key: sessionKeyDer,
        is_ii_principal: null,
        max_time_to_live: null,
      },
      identity,
    );
  }

  prepareDelegation(identity: Identity, sessionKeyDer: Uint8Array): Promise<Variant> {
    return this.t.msgpackUpdate(
      OC_CANISTERS.identity,
      "prepare_delegation",
      { session_key: sessionKeyDer, is_ii_principal: null, max_time_to_live: null },
      identity,
    );
  }

  getDelegation(
    identity: Identity,
    sessionKeyDer: Uint8Array,
    expiration: bigint,
  ): Promise<Variant> {
    return this.t.msgpackQuery(
      OC_CANISTERS.identity,
      "get_delegation",
      { session_key: sessionKeyDer, expiration },
      identity,
    );
  }
}

// ---------------------------------------------------------------------------
// user_index (candid+msgpack; we use msgpack)
// ---------------------------------------------------------------------------
export class UserIndexClient {
  constructor(private readonly t: OcTransport) {}

  currentUser(identity: Identity): Promise<Variant> {
    return this.t.msgpackQuery(OC_CANISTERS.userIndex, "current_user", {}, identity);
  }

  search(identity: Identity, searchTerm: string, maxResults = 10): Promise<Variant> {
    return this.t.msgpackQuery(
      OC_CANISTERS.userIndex,
      "search",
      { search_term: searchTerm, max_results: maxResults },
      identity,
    );
  }

  usersByPrincipal(identity: Identity, userIds: Principal[]): Promise<Variant> {
    return this.t.msgpackQuery(
      OC_CANISTERS.userIndex,
      "users",
      {
        user_groups: [{ users: userIds.map(bytes), updated_since: 0n }],
        users_suspended_since: null,
      },
      identity,
    );
  }

  setUsername(identity: Identity, username: string): Promise<Variant> {
    return this.t.msgpackUpdate(OC_CANISTERS.userIndex, "set_username", { username }, identity);
  }

  setDisplayName(identity: Identity, displayName: string | null): Promise<Variant> {
    return this.t.msgpackUpdate(OC_CANISTERS.userIndex, "set_display_name", { display_name: displayName }, identity);
  }
}

// ---------------------------------------------------------------------------
// group_index (public community/group directory; candid+msgpack, we use msgpack)
// ---------------------------------------------------------------------------
export class GroupIndexClient {
  constructor(private readonly t: OcTransport) {}

  exploreCommunities(
    identity: Identity,
    searchTerm: string | null,
    pageIndex: number,
    pageSize: number,
  ): Promise<Variant> {
    return this.t.msgpackQuery(
      OC_CANISTERS.groupIndex,
      "explore_communities",
      {
        search_term: searchTerm,
        languages: [],
        page_index: pageIndex,
        page_size: pageSize,
        include_moderation_flags: 0,
      },
      identity,
    );
  }

  exploreGroups(
    identity: Identity,
    searchTerm: string | null,
    pageIndex: number,
    pageSize: number,
  ): Promise<Variant> {
    return this.t.msgpackQuery(
      OC_CANISTERS.groupIndex,
      "explore_groups",
      {
        search_term: searchTerm,
        page_index: pageIndex,
        page_size: pageSize,
        include_moderation_flags: null,
      },
      identity,
    );
  }
}

// ---------------------------------------------------------------------------
// user canister (the caller's own user canister == their userId principal)
// ---------------------------------------------------------------------------
export class UserClient {
  constructor(private readonly t: OcTransport) {}

  initialState(identity: Identity, userCanister: string): Promise<Variant> {
    return this.t.msgpackQuery(userCanister, "initial_state", {}, identity);
  }

  bio(identity: Identity, userCanister: string): Promise<Variant> {
    return this.t.msgpackQuery(userCanister, "bio", {}, identity);
  }

  /** Mark chats read up to the given message index. One call covers direct +
   *  group chats (messages_read) and community channels (community_messages_read). */
  markRead(
    identity: Identity,
    userCanister: string,
    chats: { chatId: string; readUpTo: number }[],
    communities: { communityId: string; channels: { channelId: number; readUpTo: number }[] }[],
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      userCanister,
      "mark_read",
      {
        messages_read: chats.map((c) => ({
          chat_id: bytes(c.chatId),
          read_up_to: c.readUpTo,
          threads: [],
          date_read_pinned: null,
        })),
        community_messages_read: communities.map((cm) => ({
          community_id: bytes(cm.communityId),
          channels_read: cm.channels.map((ch) => ({
            channel_id: ch.channelId,
            read_up_to: ch.readUpTo,
            threads: [],
            date_read_pinned: null,
          })),
        })),
      },
      identity,
    );
  }

  setBio(identity: Identity, userCanister: string, text: string): Promise<Variant> {
    return this.t.msgpackUpdate(userCanister, "set_bio", { text }, identity);
  }

  events(
    identity: Identity,
    userCanister: string,
    them: Principal,
    startIndex: number,
    ascending: boolean,
    maxMessages = 50,
    maxEvents = 100,
  ): Promise<Variant> {
    return this.t.msgpackQuery(
      userCanister,
      "events",
      {
        user_id: bytes(them),
        thread_root_message_index: null,
        start_index: startIndex,
        ascending,
        max_messages: maxMessages,
        max_events: maxEvents,
        latest_known_update: null,
      },
      identity,
    );
  }

  /** Set the caller's avatar. id is a client-chosen u64 handle (the backend
   *  trusts it and serves the image at /avatar/<id>); data is the raw image
   *  bytes (≤ 800KB), mime_type e.g. "image/jpeg". */
  setAvatar(
    identity: Identity,
    userCanister: string,
    id: bigint,
    mimeType: string,
    data: Uint8Array,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      userCanister,
      "set_avatar",
      { avatar: { id, mime_type: mimeType, data } },
      identity,
    );
  }

  sendMessageV2(
    identity: Identity,
    userCanister: string,
    recipient: Principal,
    messageId: bigint,
    text: string,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      userCanister,
      "send_message_v2",
      {
        recipient: bytes(recipient),
        thread_root_message_index: null,
        message_id: messageId,
        content: { Text: { text } },
        replies_to: null,
        forwarding: false,
        block_level_markdown: false,
        message_filter_failed: null,
        pin: null,
        og_previews: [],
      },
      identity,
    );
  }
}

// ---------------------------------------------------------------------------
// group canister (groupId == the group's canister principal)
// ---------------------------------------------------------------------------
export class GroupClient {
  constructor(private readonly t: OcTransport) {}

  /** The local_user_index that hosts this group — the one to route a join through. */
  localUserIndex(identity: Identity, groupId: string): Promise<Variant> {
    return this.t.msgpackQuery(groupId, "local_user_index", {}, identity);
  }

  /** Full group summary (name, latest message, event index, member count). */
  summary(identity: Identity, groupId: string): Promise<Variant> {
    return this.t.msgpackQuery(groupId, "summary", { on_behalf_of: null }, identity);
  }

  eventsByIndex(
    identity: Identity,
    groupId: string,
    startIndex: number,
    ascending: boolean,
    maxMessages = 50,
    maxEvents = 100,
  ): Promise<Variant> {
    return this.t.msgpackQuery(
      groupId,
      "events",
      {
        thread_root_message_index: null,
        start_index: startIndex,
        ascending,
        max_messages: maxMessages,
        max_events: maxEvents,
        latest_known_update: null,
      },
      identity,
    );
  }

  /** Group text rules (text + version), from selected_initial.chat_rules. */
  selectedInitial(identity: Identity, groupId: string): Promise<Variant> {
    return this.t.msgpackQuery(groupId, "selected_initial", {}, identity);
  }

  sendMessageV2(
    identity: Identity,
    groupId: string,
    messageId: bigint,
    text: string,
    senderName: string,
    senderDisplayName: string | null,
    rulesAccepted: number | null = null,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      groupId,
      "send_message_v2",
      {
        thread_root_message_index: null,
        message_id: messageId,
        content: { Text: { text } },
        sender_name: senderName,
        sender_display_name: senderDisplayName,
        replies_to: null,
        mentioned: [],
        forwarding: false,
        block_level_markdown: false,
        rules_accepted: rulesAccepted,
        message_filter_failed: null,
        new_achievement: false,
        og_previews: [],
      },
      identity,
    );
  }
}

// ---------------------------------------------------------------------------
// community canister
// ---------------------------------------------------------------------------
export class CommunityClient {
  constructor(private readonly t: OcTransport) {}

  /** The local_user_index that hosts this community — route a join through it. */
  localUserIndex(identity: Identity, communityId: string): Promise<Variant> {
    return this.t.msgpackQuery(communityId, "local_user_index", {}, identity);
  }

  /** Full community summary (name, member count, and full channel summaries). */
  summary(identity: Identity, communityId: string): Promise<Variant> {
    return this.t.msgpackQuery(
      communityId,
      "summary",
      { on_behalf_of: null, invite_code: null },
      identity,
    );
  }

  /** Community-level rules (text + version), from selected_initial.chat_rules. */
  selectedInitial(identity: Identity, communityId: string): Promise<Variant> {
    return this.t.msgpackQuery(communityId, "selected_initial", { invite_code: null }, identity);
  }

  /** Channel-level rules (text + version), from selected_channel_initial.chat_rules. */
  selectedChannelInitial(identity: Identity, communityId: string, channelId: number): Promise<Variant> {
    return this.t.msgpackQuery(communityId, "selected_channel_initial", { channel_id: channelId }, identity);
  }

  sendMessage(
    identity: Identity,
    communityId: string,
    channelId: number,
    messageId: bigint,
    text: string,
    senderName: string,
    senderDisplayName: string | null,
    communityRulesAccepted: number | null = null,
    channelRulesAccepted: number | null = null,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      communityId,
      "send_message",
      {
        channel_id: channelId,
        thread_root_message_index: null,
        message_id: messageId,
        content: { Text: { text } },
        sender_name: senderName,
        sender_display_name: senderDisplayName,
        replies_to: null,
        mentioned: [],
        forwarding: false,
        block_level_markdown: false,
        community_rules_accepted: communityRulesAccepted,
        channel_rules_accepted: channelRulesAccepted,
        message_filter_failed: null,
        new_achievement: false,
        og_previews: [],
      },
      identity,
    );
  }
}

// ---------------------------------------------------------------------------
// local_user_index (registration + joins)
// ---------------------------------------------------------------------------
export class LocalUserIndexClient {
  constructor(private readonly t: OcTransport) {}

  registerUser(
    identity: Identity,
    lui: string,
    username: string,
    ocUserKey: Uint8Array,
  ): Promise<Variant> {
    return this.t.msgpackUpdate(
      lui,
      "register_user",
      { username, email: null, referral_code: null, public_key: ocUserKey },
      identity,
    );
  }

  joinGroup(identity: Identity, lui: string, groupId: string): Promise<Variant> {
    return this.t.msgpackUpdate(
      lui,
      "join_group",
      {
        chat_id: bytes(groupId),
        invite_code: null,
        verified_credential_args: null,
        composite_gate_index: null,
      },
      identity,
    );
  }

  joinCommunity(identity: Identity, lui: string, communityId: string): Promise<Variant> {
    return this.t.msgpackUpdate(
      lui,
      "join_community",
      {
        community_id: bytes(communityId),
        invite_code: null,
        referred_by: null,
        verified_credential_args: null,
        composite_gate_index: null,
      },
      identity,
    );
  }
}
