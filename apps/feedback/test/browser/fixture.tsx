/** Browser-only protocol fixture. No identities, canisters or live writes. */
import React from "react";
import { createRoot } from "react-dom/client";
import { FeedbackApp } from "../../src/App";
import { FeedbackTray } from "../../src/FeedbackTray";
import type {
  CreateThreadInput, FeedbackClient, FeedbackMessage, FeedbackThread,
  PendingFeedbackRequest, ReplyInput, ThreadListInput,
} from "../../src/types";
import "../../src/style.scss";

const params = new URL(location.href).searchParams;
const pendingEnabled = params.has("pending-api") || params.has("saved-sends") || params.has("pending-filtered") || params.has("oversized-pending");
const ownNeutron = "3rurp-vyaaa-aaaay-aacua-cai";
const anotherNeutron = "233tv-xiaaa-aaaay-aacta-cai";
const date = "2026-09-12T10:00:00.000Z";
const clone = <T,>(value: T): T => structuredClone(value);
const makeThread = (id: string, title: string, kind: FeedbackThread["kind"], owner = ownNeutron): FeedbackThread => ({
  id, title, kind, owner, appId: kind === "issue" ? "files" : null,
  resolved: false, needsReply: kind === "issue", messageCount: 1,
  lastMessageId: `${id}1`, unreadReplies: 0, createdAt: date, updatedAt: date,
});
const threads: FeedbackThread[] = params.has("empty") ? [] : [
  { ...makeThread("1", "Shared file link will not open", "issue"), needsReply: false, unreadReplies: 1, messageCount: 2, lastMessageId: "12" },
  makeThread("2", "The new workspace feels clear", "feedback"),
  makeThread("3", "A simple reading list", "app_suggestion"),
  makeThread("4", "Search across my files", "feature_suggestion"),
  { ...makeThread("5", "Wallet balance is not refreshing", "issue", anotherNeutron), appId: "wallet" },
  makeThread("6", "A calmer notification sound", "feedback", anotherNeutron),
];
const bodies: Record<string, string> = {
  "1": "I shared an image in Files but the link will not open.\nhttps://example.invalid/shared/image.png\n\nWhat I expected: the image opens.",
  "2": "The workspace is much easier to understand. Thank you!",
  "3": "I would like to save articles for later and search them.",
  "4": "Find a document without opening each folder.",
  "5": "My wallet balance has not refreshed since this morning.",
  "6": "A softer notification sound would help me focus.",
};
const messages: Record<string, FeedbackMessage[]> = Object.fromEntries(threads.map(thread => [thread.id, [{
  id: `${thread.id}1`, threadId: thread.id, author: thread.owner, role: "user", body: bodies[thread.id], createdAt: date,
}]]));
if (messages["1"]) messages["1"].push({ id: "12", threadId: "1", author: anotherNeutron, role: "moderator", body: "Thanks for reporting this. Please check that the image is in Shared, then copy its public link again.", createdAt: "2026-09-12T10:05:00.000Z" });
if (params.has("conversation-pages") && messages["1"]) {
  messages["1"].push(
    { id: "13", threadId: "1", author: ownNeutron, role: "user", body: "The link still seems to fail after copying it again.", createdAt: "2026-09-12T10:06:00.000Z" },
    { id: "14", threadId: "1", author: anotherNeutron, role: "moderator", body: "We found the issue with this file. Please try the link once more.", createdAt: "2026-09-12T10:07:00.000Z" },
  );
  Object.assign(threads.find(thread => thread.id === "1")!, { messageCount: 4, lastMessageId: "14", unreadReplies: 2 });
}

export const fixture = {
  moderator: params.has("moderator"),
  failNextSession: params.has("error"),
  failNextCreate: false,
  failNextReply: false,
  failNextList: false,
  failNextResume: false,
  rejectNextCreate: false,
  rejectNextReply: false,
  holdNextMarkRead: params.has("mark-read-race"),
  rejectHeldMarkRead: null as (() => void) | null,
  calls: [] as unknown[][],
  created: new Map<string, FeedbackThread>(),
  replied: new Map<string, FeedbackMessage>(),
  pendingRequests: new Map<string, PendingFeedbackRequest>(),
  copies: [] as string[],
  opened: [] as unknown[],
  dismissed: 0,
  threads,
  messages,
  refresh() { window.dispatchEvent(new CustomEvent("feedback-fixture-state")); },
  requestView(view: string) {
    if (!/^[a-z][a-z0-9_/-]{0,63}$/.test(view)) throw Error("Invalid production tile-view envelope.");
    window.dispatchEvent(new CustomEvent("feedback-fixture-view", { detail: view }));
  },
};
Object.assign(window, { __feedbackTest: fixture });

function requireThread(id: string, moderation = false) {
  if (moderation && !fixture.moderator) throw Error("Moderator access is no longer available.");
  const thread = threads.find(item => item.id === id && (moderation || item.owner === ownNeutron));
  if (!thread) throw Error("This message could not be found.");
  return thread;
}
function list(input: ThreadListInput = {}, moderation = false) {
  if (moderation && !fixture.moderator) throw Error("Moderator access is no longer available.");
  if (fixture.failNextList) { fixture.failNextList = false; throw Error("Messages are temporarily unavailable. Try again."); }
  let items = threads.filter(item => (moderation || item.owner === ownNeutron) && (!input.kind || item.kind === input.kind) && (!input.unreadOnly || item.unreadReplies > 0) && (!input.needsReply || item.needsReply));
  if (params.has("paged")) {
    const offset = Number(input.cursor || "0");
    const next = offset + 2;
    return clone({ items: items.slice(offset, next), nextCursor: next < items.length ? String(next) : null });
  }
  return clone({ items, nextCursor: null });
}
function discussion(id: string, cursor: string | undefined, moderation = false) {
  const thread = requireThread(id, moderation);
  if (!params.has("conversation-pages")) return clone({ thread, messages: { items: messages[id], nextCursor: null } });
  const offset = Number(cursor || "0"), next = offset + 2;
  return clone({ thread, messages: { items: messages[id].slice(offset, next), nextCursor: next < messages[id].length ? String(next) : null } });
}
function append(input: ReplyInput, moderation: boolean) {
  const thread = requireThread(input.threadId, moderation);
  const key = `${moderation ? "support" : "user"}:${input.requestId}`;
  const known = fixture.replied.get(key);
  if (known) return clone(known);
  if (Array.from(input.body).length > 16_000) {
    throw Error("Messages can contain up to 16,000 characters.");
  }
  const message: FeedbackMessage = {
    id: String(Number(thread.lastMessageId) + 1), threadId: input.threadId, author: ownNeutron,
    role: moderation ? "moderator" : "user", body: input.body, createdAt: "2026-09-12T11:00:00.000Z",
  };
  messages[thread.id].push(message);
  thread.lastMessageId = message.id;
  thread.messageCount++;
  thread.needsReply = !moderation && thread.kind === "issue";
  thread.updatedAt = message.createdAt;
  fixture.replied.set(key, clone(message));
  // A lost successful response must retain the original request ID on retry.
  if (fixture.failNextReply) { fixture.failNextReply = false; throw Error("Reply confirmation was lost. Your draft is saved; try again."); }
  return clone(message);
}
function remember(request: PendingFeedbackRequest) {
  if (pendingEnabled && !fixture.pendingRequests.has(request.requestId)) fixture.pendingRequests.set(request.requestId, clone(request));
}
function reply(input: ReplyInput, moderation: boolean) {
  remember({ ...input, method: moderation ? "moderationReply" : "reply" });
  if (fixture.rejectNextReply) {
    fixture.rejectNextReply = false;
    fixture.pendingRequests.delete(input.requestId);
    throw Error("The reply was not accepted. Please revise it.");
  }
  const result = append(input, moderation);
  fixture.pendingRequests.delete(input.requestId);
  return result;
}
export const client: FeedbackClient = {
  async session() {
    fixture.calls.push(["session"]);
    if (fixture.failNextSession) { fixture.failNextSession = false; throw Error("Feedback is temporarily unavailable. Try again."); }
    return { neutron: ownNeutron, moderator: fixture.moderator, unreadReplies: threads.filter(item => item.owner === ownNeutron).reduce((sum, item) => sum + item.unreadReplies, 0) };
  },
  async list(input) { fixture.calls.push(["list", clone(input)]); return list(input); },
  async get(id, cursor) { fixture.calls.push(["get", id, cursor]); return discussion(id, cursor); },
  async create(input: CreateThreadInput) {
    fixture.calls.push(["create", clone(input)]);
    remember({ ...input, method: "create" });
    if (fixture.rejectNextCreate) {
      fixture.rejectNextCreate = false;
      fixture.pendingRequests.delete(input.requestId);
      throw Error("The message was not accepted. Please revise it.");
    }
    const known = fixture.created.get(input.requestId);
    if (known) { fixture.pendingRequests.delete(input.requestId); return clone(known); }
    if (Array.from(input.title).length > 160 || Array.from(input.body).length > 16_000) {
      throw Error(Array.from(input.title).length > 160 ? "Titles can contain up to 160 characters." : "Messages can contain up to 16,000 characters.");
    }
    const thread = makeThread(String(threads.length + 10), input.title, input.kind);
    thread.appId = input.appId || null;
    threads.unshift(thread);
    messages[thread.id] = [{ id: thread.lastMessageId, threadId: thread.id, author: ownNeutron, role: "user", body: input.body, createdAt: date }];
    fixture.created.set(input.requestId, clone(thread));
    if (fixture.failNextCreate) { fixture.failNextCreate = false; throw Error("Message confirmation was lost. Your draft is saved; try again."); }
    fixture.pendingRequests.delete(input.requestId);
    return clone(thread);
  },
  async reply(input) { fixture.calls.push(["reply", clone(input)]); return reply(input, false); },
  async markRead(id, throughMessageId) {
    fixture.calls.push(["markRead", id, throughMessageId]);
    if (fixture.holdNextMarkRead) {
      fixture.holdNextMarkRead = false;
      await new Promise<void>((_resolve, reject) => {
        fixture.rejectHeldMarkRead = () => { fixture.rejectHeldMarkRead = null; reject(Error("Read acknowledgement was not confirmed.")); };
      });
    }
    const thread = requireThread(id);
    thread.unreadReplies = messages[id].filter(item => item.role === "moderator" && BigInt(item.id) > BigInt(throughMessageId)).length;
    return clone(thread);
  },
  async setResolved(id, resolved) { fixture.calls.push(["setResolved", id, resolved]); const thread = requireThread(id); thread.resolved = resolved; return clone(thread); },
  async moderationList(input) { fixture.calls.push(["moderationList", clone(input)]); return list(input, true); },
  async moderationGet(id, cursor) { fixture.calls.push(["moderationGet", id, cursor]); return discussion(id, cursor, true); },
  async moderationReply(input) { fixture.calls.push(["moderationReply", clone(input)]); return reply(input, true); },
};

if (pendingEnabled) {
  client.pending = async cursor => {
    fixture.calls.push(["pending", cursor]);
    if (params.has("pending-filtered")) {
      const items = [...fixture.pendingRequests.values()].filter(request => cursor ? request.method !== "moderationReply" : request.method === "moderationReply");
      return { items: clone(items), nextCursor: cursor ? null : "visible" };
    }
    return { items: clone([...fixture.pendingRequests.values()]), nextCursor: null };
  };
  client.resume = async requestId => {
    fixture.calls.push(["resume", requestId]);
    if (fixture.failNextResume) { fixture.failNextResume = false; throw Error("Saved send confirmation is temporarily unavailable. Try again."); }
    const request = fixture.pendingRequests.get(requestId);
    if (!request) throw Error("This saved send was already confirmed.");
    if (request.method === "create") return client.create({ requestId, title: request.title!, kind: request.kind!, body: request.body, ...(request.appId ? { appId: request.appId } : {}) });
    const input = { requestId, threadId: request.threadId!, body: request.body };
    return request.method === "moderationReply" ? client.moderationReply(input) : client.reply(input);
  };
}
if (params.has("saved-sends") || params.has("pending-filtered")) {
  const request: PendingFeedbackRequest = { method: "create", requestId: "saved-create-001", kind: "issue", title: "My saved report about Files", appId: "files", body: "A report saved before the app closed.\nThe original message should only be sent once." };
  const thread = makeThread("70", request.title!, request.kind!);
  threads.unshift(thread);
  messages[thread.id] = [{ id: thread.lastMessageId, threadId: thread.id, author: ownNeutron, role: "user", body: request.body, createdAt: date }];
  fixture.created.set(request.requestId, clone(thread));
  fixture.pendingRequests.set(request.requestId, request);
  const savedReply: PendingFeedbackRequest = { method: "reply", requestId: "saved-reply-001", threadId: "1", body: "This reply was saved before the app closed." };
  append({ requestId: savedReply.requestId, threadId: savedReply.threadId!, body: savedReply.body }, false);
  fixture.pendingRequests.set(savedReply.requestId, savedReply);
  if (fixture.moderator || params.has("pending-filtered")) {
    const savedSupport: PendingFeedbackRequest = { method: "moderationReply", requestId: "saved-support-001", threadId: "5", body: "A support response saved before the app closed." };
    const currentModerator = fixture.moderator;
    fixture.moderator = true;
    append({ requestId: savedSupport.requestId, threadId: savedSupport.threadId!, body: savedSupport.body }, true);
    fixture.moderator = currentModerator;
    fixture.pendingRequests.set(savedSupport.requestId, savedSupport);
  }
}
if (params.has("oversized-pending")) {
  // This response was lost before the new limits existed. Replay must reconcile
  // the original committed operation before applying new-write validation.
  const request: PendingFeedbackRequest = { method: "create", requestId: "saved-oversized-committed", kind: "issue", appId: "files", title: "🪐".repeat(161), body: "🪐".repeat(16_001) };
  const thread = makeThread("80", request.title!, request.kind!);
  threads.unshift(thread);
  messages[thread.id] = [{ id: thread.lastMessageId, threadId: thread.id, author: ownNeutron, role: "user", body: request.body, createdAt: date }];
  fixture.created.set(request.requestId, clone(thread));
  fixture.pendingRequests.set(request.requestId, request);
  const replyRequestId = params.has("prototype-id") ? "constructor" : "saved-oversized-uncommitted";
  fixture.pendingRequests.set(replyRequestId, { method: "reply", requestId: replyRequestId, threadId: "1", body: "🪐".repeat(16_001) });
  if (fixture.moderator) fixture.pendingRequests.set("saved-oversized-support", { method: "moderationReply", requestId: "saved-oversized-support", threadId: "5", body: "🪐".repeat(16_001) });
}

createRoot(document.getElementById("root")!).render(params.has("tray") ? <FeedbackTray client={client} /> : <FeedbackApp client={client} />);
