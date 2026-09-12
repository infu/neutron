import { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";
import type { FeedbackKind, AuthorRole } from "./types.ts";

export type Option<T> = [] | [T];
export const optional = <T>(value: T | null | undefined): Option<T> => value == null ? [] : [value];
export type Result<T> = { ok: T } | { err: { code: string; message: string } };
export type WireKind = { [K in FeedbackKind]?: null };
export type WireThread = { id: bigint; owner: Principal; kind: WireKind; title: string; appId: Option<string>; resolved: boolean; needsReply: boolean; messageCount: bigint; lastMessageId: bigint; unreadReplies: bigint; activity: bigint; createdAtNs: bigint; updatedAtNs: bigint };
export type WireMessage = { id: bigint; threadId: bigint; author: Principal; role: { [K in AuthorRole]?: null }; body: string; moderatorSequence: bigint; createdAtNs: bigint };
export type WireSession = { neutron: Principal; moderator: boolean; unreadReplies: bigint };
export type WirePage<T> = { items: T[]; nextCursor: Option<bigint> };
export type Method = { args: IDL.Type[]; returns: IDL.Type[]; update: boolean };
export type Contract = Record<string, Method>;
const { Text, Nat, Nat64, Int, Bool, Principal: principal, Null, Record: rec, Variant: variant, Opt: opt, Vec: vec } = IDL;
export const kindType = variant({ issue: Null, feedback: Null, app_suggestion: Null, feature_suggestion: Null });
export const threadType = rec({ id: Nat64, owner: principal, kind: kindType, title: Text, appId: opt(Text), resolved: Bool, needsReply: Bool, messageCount: Nat, lastMessageId: Nat64, unreadReplies: Nat, activity: Nat64, createdAtNs: Int, updatedAtNs: Int });
export const messageType = rec({ id: Nat64, threadId: Nat64, author: principal, role: variant({ user: Null, moderator: Null }), body: Text, moderatorSequence: Nat, createdAtNs: Int });
const sessionType = rec({ neutron: principal, moderator: Bool, unreadReplies: Nat });
const page = (item: IDL.Type) => rec({ items: vec(item), nextCursor: opt(Nat64) });
const result = (value: IDL.Type) => variant({ ok: value, err: rec({ code: Text, message: Text }) });
const query = (args: IDL.Type[], value: IDL.Type): Method => ({ args, returns: [result(value)], update: false });
const update = (args: IDL.Type[], value: IDL.Type): Method => ({ args, returns: [result(value)], update: true });
const replyType = rec({ requestId: Text, threadId: Nat64, body: Text });
const messagesType = rec({ threadId: Nat64, cursor: opt(Nat64), limit: Nat });
export const CONTRACT: Contract = {
  session: query([], sessionType),
  read_delegate_set: update([rec({ browser: principal })], Null),
  my_threads: query([rec({ cursor: opt(Nat64), limit: Nat, kind: opt(kindType), unreadOnly: Bool })], page(threadType)),
  moderation_threads: query([rec({ cursor: opt(Nat64), limit: Nat, kind: opt(kindType), needsReply: Bool })], page(threadType)),
  thread: query([Nat64], threadType),
  moderation_thread: query([Nat64], threadType),
  messages: query([messagesType], page(messageType)),
  moderation_messages: query([messagesType], page(messageType)),
  thread_create: update([rec({ requestId: Text, kind: kindType, title: Text, appId: opt(Text), body: Text })], threadType),
  reply: update([replyType], messageType),
  moderation_reply: update([replyType], messageType),
  mark_read: update([rec({ threadId: Nat64, throughMessageId: Nat64 })], threadType),
  issue_status_set: update([rec({ threadId: Nat64, resolved: Bool })], threadType),
};
export const UPDATE_METHODS = ["read_delegate_set", "thread_create", "reply", "moderation_reply", "mark_read", "issue_status_set"] as const;
