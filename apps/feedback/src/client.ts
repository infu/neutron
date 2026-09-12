import type { MsgBusToolContext } from "neutron-tools/app";
import { makeAgent, makeTransport } from "./transport.ts";
import { fitFeedbackPage } from "./response_state.ts";
import { readIdentity, saveIntent, completeIntent, listIntents, loadIntent } from "./store_state.ts";
import { optional, type Result, type WireKind, type WireMessage, type WirePage, type WireSession, type WireThread } from "./protocol.ts";
import type { AuthorRole, CreateThreadInput, Discussion, FeedbackClient, FeedbackKind, FeedbackMessage, FeedbackPage, FeedbackSession, FeedbackThread, ReplyInput, ThreadListInput, PendingFeedbackRequest } from "./types.ts";

export class ProtocolError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ProtocolError"; }
}
export function response<T>(value: Result<T>): T {
  if ("err" in value) throw new ProtocolError(value.err.code, value.err.message);
  return value.ok;
}
const kinds = ["issue", "feedback", "app_suggestion", "feature_suggestion"] as const;
export function kind(value: unknown): FeedbackKind {
  if (typeof value !== "string" || !kinds.includes(value as FeedbackKind)) throw new Error("Choose an issue, feedback, app idea or feature idea.");
  return value as FeedbackKind;
}
function wireKind(value: FeedbackKind): WireKind { return { [kind(value)]: null }; }
export function identifier(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error("This Feedback link has an invalid discussion or message number.");
  return BigInt(value);
}
function count(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Feedback returned an invalid count.");
  return number;
}
function date(value: bigint): string { return new Date(Number(value / 1_000_000n)).toISOString(); }
export function threadView(value: WireThread): FeedbackThread {
  return { id: String(value.id), owner: value.owner.toText(), kind: kind(Object.keys(value.kind)[0]), title: value.title, appId: value.appId[0] ?? null,
    resolved: value.resolved, needsReply: value.needsReply, messageCount: count(value.messageCount), lastMessageId: String(value.lastMessageId), unreadReplies: count(value.unreadReplies), createdAt: date(value.createdAtNs), updatedAt: date(value.updatedAtNs) };
}
export function messageView(value: WireMessage): FeedbackMessage {
  const role = Object.keys(value.role)[0];
  if (role !== "user" && role !== "moderator") throw new Error("Feedback returned an invalid message author role.");
  return { id: String(value.id), threadId: String(value.threadId), author: value.author.toText(), role: role as AuthorRole, body: value.body, createdAt: date(value.createdAtNs) };
}
export function sessionView(value: WireSession): FeedbackSession {
  return { neutron: value.neutron.toText(), moderator: value.moderator, unreadReplies: count(value.unreadReplies) };
}
function page<T, U>(value: WirePage<T>, view: (value: T) => U): FeedbackPage<U> {
  return { items: value.items.map(view), nextCursor: value.nextCursor[0] === undefined ? null : String(value.nextCursor[0]) };
}
export function pendingView(value: unknown, expectedId?: string): PendingFeedbackRequest {
  const error = () => new Error("A saved Feedback message is invalid. Its original content has been preserved.");
  if (!value || typeof value !== "object" || !("method" in value) || !("args" in value) || !value.args || typeof value.args !== "object") throw error();
  const args = value.args as Record<string, unknown>;
  if (typeof args.requestId !== "string" || !args.requestId || typeof args.body !== "string" || (expectedId !== undefined && expectedId !== `request:${args.requestId}`)) throw error();
  if (value.method === "thread_create") {
    if (typeof args.title !== "string" || (args.appId !== null && typeof args.appId !== "string")) throw error();
    return { requestId: args.requestId, method: "create", body: args.body, title: args.title, kind: kind(args.kind), ...(args.appId === null ? {} : { appId: args.appId as string }) };
  }
  if ((value.method !== "reply" && value.method !== "moderation_reply") || typeof args.threadId !== "string") throw error();
  identifier(args.threadId);
  return { requestId: args.requestId, method: value.method === "reply" ? "reply" : "moderationReply", threadId: args.threadId, body: args.body };
}
export type ClientContext = Pick<MsgBusToolContext, "kernel" | "signal">;
export type ClientDependencies = {
  readIdentity?: typeof readIdentity;
  makeAgent?: typeof makeAgent;
  makeTransport?: typeof makeTransport;
};
/** A facade belongs to exactly one invocation. Never cache its kernel or share
 * in-flight initialization across caller scopes, even when the signer matches. */
export async function protocolClient(context: ClientContext, dependencies: ClientDependencies = {}): Promise<FeedbackClient> {
  const check = () => context.signal?.throwIfAborted();
  check();
  const { state, identity } = await (dependencies.readIdentity ?? readIdentity)(context.kernel);
  check();
  const agent = await (dependencies.makeAgent ?? makeAgent)(identity);
  check();
  const transport = (dependencies.makeTransport ?? makeTransport)({ kernel: context.kernel, agent });
  let current: WireSession;
  try { current = response(await transport.query<Result<WireSession>>("session")); }
  catch (error) {
    if (!(error instanceof ProtocolError) || error.code !== "delegate_required") throw error;
    check();
    response(await transport.update<Result<null>>("read_delegate_set", [{ browser: identity.getPrincipal() }]));
    current = response(await transport.query<Result<WireSession>>("session"));
  }
  if (current.neutron.toText() !== state.owner) throw new Error("Feedback read access belongs to a different Neutron. Your saved identity has been preserved.");
  check();
  async function query<T>(name: string, args: unknown[] = []): Promise<T> {
    check();
    const value = response(await transport.query<Result<T>>(name, args));
    check();
    return value;
  }
  async function update<T>(name: string, args: unknown[]): Promise<T> {
    check();
    return response(await transport.update<Result<T>>(name, args));
  }
  function requireModerator(moderation: boolean): void {
    if (moderation && !current.moderator) throw new ProtocolError("moderator_required", "The support inbox is available to assigned moderators.");
  }
  async function send<T>(requestId: string, method: string, saved: unknown, args: unknown[]): Promise<T> {
    check();
    await saveIntent(context.kernel, requestId, method, saved);
    try {
      const result = await update<T>(method, args);
      await completeIntent(context.kernel, requestId, method, saved).catch(() => undefined);
      return result;
    } catch (error) {
      // These validation errors occur after the protocol's permanent request
      // lookup and prove this exact message was not accepted. An access error
      // during a retry cannot disprove a previous accepted-but-lost response.
      if (error instanceof ProtocolError && ["request_id_required", "title_required", "message_required"].includes(error.code)) await completeIntent(context.kernel, requestId, method, saved).catch(() => undefined);
      throw error;
    }
  }
  const list = async (moderation: boolean, input: ThreadListInput = {}) => {
    requireModerator(moderation);
    const wire = await query<WirePage<WireThread>>(moderation ? "moderation_threads" : "my_threads", [{
    cursor: optional(input.cursor === undefined ? undefined : identifier(input.cursor)), limit: 30n, kind: optional(input.kind === undefined ? undefined : wireKind(input.kind)),
    ...(moderation ? { needsReply: input.needsReply ?? false } : { unreadOnly: input.unreadOnly ?? false }),
  }]);
    const cursors = new Map(wire.items.map(thread => [String(thread.id), String(thread.activity)]));
    return fitFeedbackPage(page(wire, threadView), thread => cursors.get(thread.id)!, value => value);
  };
  async function get(moderation: boolean, threadId: string, cursor?: string): Promise<Discussion> {
    requireModerator(moderation);
    const id = identifier(threadId);
    // The protocol checks each private read independently, including role
    // changes between opening a discussion and requesting another page.
    const thread = await query<WireThread>(moderation ? "moderation_thread" : "thread", [id]);
    const messages = await query<WirePage<WireMessage>>(moderation ? "moderation_messages" : "messages", [{ threadId: id, cursor: optional(cursor === undefined ? undefined : identifier(cursor)), limit: 30n }]);
    const summary = threadView(thread);
    return fitFeedbackPage(page(messages, messageView), message => message.id, selected => ({ thread: summary, messages: selected }));
  }
  async function reply(moderation: boolean, input: ReplyInput): Promise<FeedbackMessage> {
    requireModerator(moderation);
    const method = moderation ? "moderation_reply" : "reply";
    const saved = { requestId: input.requestId, threadId: input.threadId, body: input.body };
    const args = { ...saved, threadId: identifier(input.threadId) };
    return messageView(await send<WireMessage>(input.requestId, method, saved, [args]));
  }
  const client: FeedbackClient = {
    pending: async cursor => {
      check();
      const result = await listIntents(context.kernel, cursor);
      const pending = { items: result.items.map(row => pendingView(row.value, row.id)).filter(intent => current.moderator || intent.method !== "moderationReply"), nextCursor: result.nextCursor };
      return fitFeedbackPage(pending, intent => `request:${intent.requestId}`, value => value);
    },
    resume: async requestId => {
      check();
      const saved = await loadIntent(context.kernel, requestId);
      if (saved === null) throw new Error("This saved message has already been confirmed or is unavailable. Check the discussion before sending it again.");
      const value = pendingView(saved, `request:${requestId}`);
      if (value.method === "create") return client.create({ requestId: value.requestId, kind: value.kind!, title: value.title!, body: value.body, ...(value.appId === undefined ? {} : { appId: value.appId }) });
      const input = { requestId: value.requestId, threadId: value.threadId!, body: value.body };
      return value.method === "moderationReply" ? client.moderationReply(input) : client.reply(input);
    },
    session: async () => sessionView(await query<WireSession>("session")),
    list: input => list(false, input), get: (id, cursor) => get(false, id, cursor),
    create: async (input: CreateThreadInput) => {
      const saved = { requestId: input.requestId, kind: kind(input.kind), title: input.title, body: input.body, appId: input.appId ?? null };
      return threadView(await send<WireThread>(input.requestId, "thread_create", saved, [{ ...saved, kind: wireKind(saved.kind), appId: optional(saved.appId) }]));
    },
    reply: input => reply(false, input),
    markRead: async (threadId, throughMessageId) => threadView(await update<WireThread>("mark_read", [{ threadId: identifier(threadId), throughMessageId: identifier(throughMessageId) }])),
    setResolved: async (threadId, resolved) => threadView(await update<WireThread>("issue_status_set", [{ threadId: identifier(threadId), resolved }])),
    moderationList: input => list(true, input), moderationGet: (id, cursor) => get(true, id, cursor), moderationReply: input => reply(true, input),
  };
  return client;
}
