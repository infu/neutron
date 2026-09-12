import assert from "node:assert/strict";
import { Principal } from "@dfinity/principal";
import { administrator, failure, identity, previousProtocol, session, success, type IntegrationCase, type Neutron, type Session } from "./runtime.ts";

type Kind = "issue" | "feedback" | "app_suggestion" | "feature_suggestion";
const kinds: Kind[] = ["issue", "feedback", "app_suggestion", "feature_suggestion"];
const ownPage = (extra: Record<string, unknown> = {}) => ({ cursor: [], limit: 20n, kind: [], unreadOnly: false, ...extra });
const modPage = (extra: Record<string, unknown> = {}) => ({ cursor: [], limit: 20n, kind: [], needsReply: false, ...extra });
const messagesPage = (threadId: bigint, extra: Record<string, unknown> = {}) => ({ threadId, cursor: [], limit: 20n, ...extra });
const createRequest = (requestId: string, kind: Kind = "issue", extra: Record<string, unknown> = {}) => ({
  requestId, kind: { [kind]: null }, title: `Help with ${requestId}`, appId: [],
  body: "Here is what happened. Screenshot: https://example.com/shared/screenshot.png", ...extra,
});
const create = async (owner: Neutron, requestId: string, kind: Kind = "issue", extra: Record<string, unknown> = {}) =>
  success(await owner.call("thread_create", [createRequest(requestId, kind, extra)]));
const reply = async (owner: Neutron, threadId: bigint, requestId: string, body = "More details") =>
  success(await owner.call("reply", [{ requestId, threadId, body }]));
const moderatorReply = async (moderator: Neutron, threadId: bigint, requestId: string, body = "We can help you with this.") =>
  success(await moderator.call("moderation_reply", [{ requestId, threadId, body }]));

async function withSession(run: (env: Session) => Promise<void>): Promise<void> {
  const env = await session();
  try { await run(env); } finally { await env.shutdown(); }
}

async function bind(env: Session, neutron: Neutron, seed: number) {
  const principal = identity(seed);
  success(await neutron.call("read_delegate_set", [{ browser: principal }]));
  return env.as(principal);
}

async function moderator(env: Session, seed = 220) {
  const neutron = await env.neutron();
  success(await env.admin.moderator_set({ neutron: neutron.canisterId, active: true }));
  return { neutron, browser: await bind(env, neutron, seed) };
}

async function collect(query: (cursor: bigint[]) => Promise<any>, pageLimit = 100): Promise<any[]> {
  let cursor: bigint[] = [];
  const result: any[] = [];
  const cursors = new Set<string>();
  for (let page = 0; page < pageLimit; page += 1) {
    const response = success(await query(cursor));
    result.push(...response.items);
    if (response.nextCursor.length === 0) return result;
    const next = String(response.nextCursor[0]);
    assert.ok(!cursors.has(next), "Pagination must advance its cursor");
    cursors.add(next);
    cursor = response.nextCursor;
  }
  throw new Error("Fixture pagination did not terminate");
}

export const cases: IntegrationCase[] = [
  {
    name: "clean initialization exposes all four private discussion kinds with correct response expectations",
    run: () => withSession(async env => {
      const info = await env.actor.feedback_info();
      assert.equal(info.protocolVersion, 1n);
      assert.equal(info.schemaVersion, 1n);
      assert.equal(info.administrator.toText(), administrator.toText());
      console.log(`Feedback clean-install metrics: ${JSON.stringify(await env.installationMetrics())}`);
      const owner = await env.neutron();
      const browser = await bind(env, owner, 202);
      assert.deepEqual(success(await browser.my_threads(ownPage())).items, []);
      assert.deepEqual(success(await browser.session()), { neutron: owner.canisterId, moderator: false, unreadReplies: 0n });
      const created = [];
      for (const kind of kinds) {
        const thread = await create(owner, kind, kind, { appId: kind === "issue" ? ["feedback"] : [] });
        created.push(thread);
        assert.equal(thread.owner.toText(), owner.canisterId.toText());
        assert.deepEqual(thread.kind, { [kind]: null });
        assert.equal(thread.resolved, false);
        assert.equal(thread.needsReply, kind === "issue", "Only an issue asks the support team for a response");
        assert.equal(thread.messageCount, 1n);
        assert.equal(thread.unreadReplies, 0n);
        const discussion = success(await browser.messages(messagesPage(thread.id)));
        assert.equal(discussion.items.length, 1);
        assert.deepEqual(discussion.items[0].role, { user: null });
        assert.equal(discussion.items[0].moderatorSequence, 0n);
        assert.equal(discussion.items[0].id, thread.lastMessageId);
        assert.equal(discussion.items[0].body, createRequest(kind, kind).body, "Shared image links remain ordinary message text");
      }
      assert.deepEqual(success(await browser.my_threads(ownPage())).items.map((thread: any) => thread.id), created.reverse().map(thread => thread.id));
    }),
  },
  {
    name: "author isolation, read-only browser delegates, replacement, and delegate ownership",
    run: () => withSession(async env => {
      const first = await env.neutron(), second = await env.neutron();
      const browser = await bind(env, first, 203), other = await bind(env, second, 204);
      const thread = await create(first, "private");
      failure(await env.actor.session());
      failure(await env.actor.thread_create(createRequest("anonymous")));
      failure(await env.as(identity(205)).thread_create(createRequest("browser-cannot-create")));
      failure(await browser.thread_create(createRequest("delegate-cannot-create")));
      failure(await browser.reply({ requestId: "delegate-cannot-reply", threadId: thread.id, body: "No write delegation" }));
      failure(await browser.mark_read({ threadId: thread.id, throughMessageId: thread.lastMessageId }));
      failure(await browser.issue_status_set({ threadId: thread.id, resolved: true }));
      failure(await browser.read_delegate_set({ browser: identity(205) }));
      failure(await other.thread(thread.id));
      failure(await other.messages(messagesPage(thread.id)));
      failure(await second.call("reply", [{ requestId: "foreign", threadId: thread.id, body: "Cannot read or write" }]));
      failure(await second.call("mark_read", [{ threadId: thread.id, throughMessageId: thread.lastMessageId }]));
      assert.deepEqual(success(await other.my_threads(ownPage())).items, []);
      failure(await second.call("read_delegate_set", [{ browser: identity(203) }]));
      assert.equal(success(await browser.thread(thread.id)).id, thread.id, "Failed delegate theft leaves the original binding intact");
      const replacement = await bind(env, first, 206);
      failure(await browser.session());
      failure(await browser.thread(thread.id));
      assert.equal(success(await replacement.thread(thread.id)).id, thread.id, "Replacing a browser preserves Neutron-owned remote history");
      success(await first.call("read_delegate_set", [{ browser: identity(206) }]));
      assert.equal(success(await replacement.session()).neutron.toText(), first.canisterId.toText());
      failure(await first.call("read_delegate_set", [{ browser: Principal.anonymous() }]));
      assert.equal(success(await replacement.thread(thread.id)).id, thread.id, "Rejected bindings do not revoke the current browser");
    }),
  },
  {
    name: "administrator grants and revokes moderators; moderation grants viewing and replies only",
    run: () => withSession(async env => {
      const author = await env.neutron(), mod = await env.neutron();
      const authorBrowser = await bind(env, author, 207), modBrowser = await bind(env, mod, 208);
      const issue = await create(author, "moderation-access");
      failure(await modBrowser.moderation_threads(modPage()));
      failure(await modBrowser.moderation_thread(issue.id));
      failure(await mod.call("moderation_reply", [{ requestId: "before-grant", threadId: issue.id, body: "No grant" }]));
      failure(await authorBrowser.moderator_set({ neutron: mod.canisterId, active: true }));
      failure(await mod.call("moderator_set", [{ neutron: mod.canisterId, active: true }]));
      success(await env.admin.moderator_set({ neutron: mod.canisterId, active: true }));
      const grant = success(await env.admin.moderators({ cursor: [], limit: 20n })).items[0];
      assert.equal(grant.active, true);
      assert.equal(success(await modBrowser.session()).moderator, true);
      assert.equal(success(await modBrowser.moderation_thread(issue.id)).id, issue.id);
      assert.equal(success(await modBrowser.moderation_messages(messagesPage(issue.id))).items.length, 1);
      assert.deepEqual(success(await modBrowser.moderation_threads(modPage())).items.map((thread: any) => thread.id), [issue.id]);
      failure(await modBrowser.moderation_reply({ requestId: "read-delegate", threadId: issue.id, body: "Read-only browser" }));
      const response = await moderatorReply(mod, issue.id, "granted");
      assert.deepEqual(response.role, { moderator: null });
      assert.equal(success(await authorBrowser.session()).unreadReplies, 1n);
      failure(await mod.call("issue_status_set", [{ threadId: issue.id, resolved: true }]));
      failure(await mod.call("mark_read", [{ threadId: issue.id, throughMessageId: response.id }]));
      failure(await mod.call("moderator_set", [{ neutron: author.canisterId, active: true }]));
      failure(await modBrowser.moderators({ cursor: [], limit: 20n }));
      assert.equal(success(await env.admin.moderators({ cursor: [], limit: 20n })).items[0].neutron.toText(), mod.canisterId.toText());
      success(await env.admin.moderator_set({ neutron: mod.canisterId, active: false }));
      const revoked = success(await env.admin.moderators({ cursor: [], limit: 20n })).items[0];
      assert.equal(revoked.id, grant.id);
      assert.equal(success(await modBrowser.session()).moderator, false);
      failure(await modBrowser.moderation_threads(modPage()));
      failure(await modBrowser.moderation_thread(issue.id));
      failure(await modBrowser.moderation_messages(messagesPage(issue.id)));
      failure(await mod.call("moderation_reply", [{ requestId: "after-revoke", threadId: issue.id, body: "No longer assigned" }]));
      failure(await mod.call("moderation_reply", [{ requestId: "granted", threadId: issue.id, body: "We can help you with this." }]), "moderator_required");
      assert.equal(success(await authorBrowser.thread(issue.id)).messageCount, 2n);
    }),
  },
  {
    name: "create and reply retries are idempotent and conflicting request reuse changes no state",
    run: () => withSession(async env => {
      const owner = await env.neutron(), other = await env.neutron();
      const browser = await bind(env, owner, 209);
      const mod = await moderator(env, 210);
      const request = createRequest("same-request");
      const first = success(await owner.call("thread_create", [request]));
      assert.equal(success(await owner.call("thread_create", [request])).id, first.id);
      for (const changed of [{ body: "Changed body" }, { title: "Changed title" }, { kind: { feedback: null } }, { appId: ["wallet"] }]) {
        failure(await owner.call("thread_create", [{ ...request, ...changed }]));
      }
      const second = await create(owner, "another-thread");
      assert.notEqual((await create(other, "same-request")).id, first.id, "Request IDs are scoped to an author");
      const replyRequest = { requestId: "same-request", threadId: first.id, body: "Create IDs and reply IDs have distinct request namespaces." };
      const response = success(await owner.call("reply", [replyRequest]));
      assert.equal(success(await owner.call("reply", [replyRequest])).id, response.id);
      failure(await owner.call("reply", [{ ...replyRequest, body: "Changed reply" }]));
      failure(await owner.call("reply", [{ ...replyRequest, threadId: second.id }]));
      const modRequest = { requestId: "same-request", threadId: first.id, body: "Moderator request IDs are author scoped too." };
      const modResponse = success(await mod.neutron.call("moderation_reply", [modRequest]));
      assert.equal(success(await mod.neutron.call("moderation_reply", [modRequest])).id, modResponse.id);
      failure(await mod.neutron.call("moderation_reply", [{ ...modRequest, body: "Changed moderator reply" }]));
      assert.equal(success(await browser.thread(first.id)).messageCount, 3n);
      assert.equal(success(await browser.thread(second.id)).messageCount, 1n);
      assert.equal(success(await browser.session()).unreadReplies, 1n, "Retries do not duplicate unread responses");
      assert.equal(success(await owner.call("thread_create", [request])).id, first.id, "Create retries continue to work after discussion activity");
      const ownModeratorThread = await create(mod.neutron, "moderator-own-thread");
      const asUser = { requestId: "role-user-first", threadId: ownModeratorThread.id, body: "The same Neutron can participate in either role." };
      success(await mod.neutron.call("reply", [asUser]));
      failure(await mod.neutron.call("moderation_reply", [asUser]), "request_conflict");
      const asModerator = { ...asUser, requestId: "role-moderator-first" };
      success(await mod.neutron.call("moderation_reply", [asModerator]));
      failure(await mod.neutron.call("reply", [asModerator]), "request_conflict");
      assert.equal(success(await mod.browser.thread(ownModeratorThread.id)).messageCount, 3n, "Request retries cannot change author roles");
    }),
  },
  {
    name: "read acknowledgement preserves later responses and aggregates unread across discussions",
    run: () => withSession(async env => {
      const owner = await env.neutron();
      const browser = await bind(env, owner, 211), mod = await moderator(env, 212);
      const first = await create(owner, "first-unread"), second = await create(owner, "second-unread");
      const shown = await moderatorReply(mod.neutron, first.id, "shown");
      assert.equal(shown.moderatorSequence, 1n);
      const shownPage = success(await browser.messages(messagesPage(first.id)));
      assert.equal(shownPage.items.at(-1).id, shown.id);
      const arrivedLater = await moderatorReply(mod.neutron, first.id, "arrived-later");
      await moderatorReply(mod.neutron, second.id, "other-thread");
      assert.equal(success(await browser.session()).unreadReplies, 3n);
      let acknowledged = success(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: shown.id }]));
      assert.equal(acknowledged.unreadReplies, 1n, "The response arriving after the displayed page remains unread");
      assert.equal(success(await browser.session()).unreadReplies, 2n);
      acknowledged = success(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: shown.id }]));
      assert.equal(acknowledged.unreadReplies, 1n, "Repeated acknowledgement is idempotent");
      success(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: first.lastMessageId }]));
      assert.equal(success(await browser.session()).unreadReplies, 2n, "An older displayed message cannot move the read cursor backwards");
      failure(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: second.lastMessageId }]));
      failure(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: 999_999n }]));
      assert.equal(success(await browser.session()).unreadReplies, 2n);
      const followup = await reply(owner, first.id, "user-followup");
      assert.equal(followup.moderatorSequence, arrivedLater.moderatorSequence);
      assert.equal(success(await browser.session()).unreadReplies, 2n, "Sending a user reply is not a read acknowledgement");
      success(await owner.call("mark_read", [{ threadId: first.id, throughMessageId: followup.id }]));
      assert.equal(success(await browser.session()).unreadReplies, 1n);
      assert.equal(success(await browser.thread(first.id)).unreadReplies, 0n);
      assert.deepEqual(success(await browser.my_threads(ownPage({ unreadOnly: true }))).items.map((thread: any) => thread.id), [second.id]);
    }),
  },
  {
    name: "owners resolve and reopen their issues while feedback and suggestions stay response optional",
    run: () => withSession(async env => {
      const owner = await env.neutron(), other = await env.neutron();
      const browser = await bind(env, owner, 213), mod = await moderator(env, 214);
      const issue = await create(owner, "status");
      failure(await other.call("issue_status_set", [{ threadId: issue.id, resolved: true }]));
      let changed = success(await owner.call("issue_status_set", [{ threadId: issue.id, resolved: true }]));
      assert.equal(changed.resolved, true);
      assert.equal(changed.needsReply, false);
      changed = success(await owner.call("issue_status_set", [{ threadId: issue.id, resolved: false }]));
      assert.equal(changed.resolved, false);
      assert.equal(changed.needsReply, true);
      await moderatorReply(mod.neutron, issue.id, "answered");
      assert.equal(success(await browser.thread(issue.id)).needsReply, false);
      success(await owner.call("issue_status_set", [{ threadId: issue.id, resolved: true }]));
      changed = success(await owner.call("issue_status_set", [{ threadId: issue.id, resolved: false }]));
      assert.equal(changed.resolved, false);
      assert.equal(changed.needsReply, false, "Reopening preserves the last moderator answer; a user follow-up requests another reply");
      await reply(owner, issue.id, "followup-after-answer");
      assert.equal(success(await browser.thread(issue.id)).needsReply, true);
      for (const kind of kinds.filter(kind => kind !== "issue")) {
        const thread = await create(owner, `optional-${kind}`, kind);
        failure(await owner.call("issue_status_set", [{ threadId: thread.id, resolved: true }]));
        await moderatorReply(mod.neutron, thread.id, `optional-answer-${kind}`);
        await reply(owner, thread.id, `optional-followup-${kind}`);
        assert.equal(success(await browser.thread(thread.id)).needsReply, false);
      }
    }),
  },
  {
    name: "thread and discussion pagination preserves ordering, filters, and owner isolation",
    run: () => withSession(async env => {
      const owner = await env.neutron(), other = await env.neutron();
      const browser = await bind(env, owner, 215), mod = await moderator(env, 216);
      const created = [];
      for (let index = 0; index < 9; index += 1) created.push(await create(owner, `page-${index}`, kinds[index % 4]!));
      await create(other, "foreign-pagination");
      const moved = created[0];
      await reply(owner, moved.id, "moves-to-front");
      const all = await collect(cursor => browser.my_threads(ownPage({ cursor, limit: 2n })));
      assert.deepEqual(all.map(thread => thread.id), [moved.id, ...created.slice(1).reverse().map(thread => thread.id)]);
      assert.equal(new Set(all.map(thread => String(thread.id))).size, created.length);
      for (const kind of kinds) {
        const filtered = await collect(cursor => browser.my_threads(ownPage({ cursor, limit: 1n, kind: [{ [kind]: null }] })));
        assert.deepEqual(filtered.map(thread => thread.id), all.filter(thread => kind in thread.kind).map(thread => thread.id));
      }
      const responseA = await moderatorReply(mod.neutron, created[1].id, "page-unread-a");
      await moderatorReply(mod.neutron, created[5].id, "page-unread-b");
      const unread = await collect(cursor => browser.my_threads(ownPage({ cursor, limit: 1n, unreadOnly: true })));
      assert.deepEqual(unread.map(thread => thread.id), [created[5].id, created[1].id]);
      success(await owner.call("mark_read", [{ threadId: created[1].id, throughMessageId: responseA.id }]));
      assert.deepEqual((await collect(cursor => browser.my_threads(ownPage({ cursor, limit: 1n, unreadOnly: true })))).map(thread => thread.id), [created[5].id]);
      await moderatorReply(mod.neutron, created[4].id, "page-issue-answer");
      const pending = await collect(cursor => mod.browser.moderation_threads(modPage({ cursor, limit: 1n, needsReply: true, kind: [{ issue: null }] })));
      assert.equal(pending.length, 3, "Includes the other owner's issue and both unanswered owner issues");
      assert.ok(pending.every(thread => thread.needsReply && "issue" in thread.kind));
      for (let index = 0; index < 5; index += 1) await reply(owner, moved.id, `message-page-${index}`);
      const discussion = await collect(cursor => browser.messages(messagesPage(moved.id, { cursor, limit: 2n })));
      assert.equal(discussion.length, 7);
      assert.equal(new Set(discussion.map(message => String(message.id))).size, 7);
      assert.ok(discussion.every((message, index) => index === 0 || message.id > discussion[index - 1].id));
      assert.deepEqual((await collect(cursor => mod.browser.moderation_messages(messagesPage(moved.id, { cursor, limit: 2n })))).map(message => message.id), discussion.map(message => message.id));
    }),
  },
  {
    name: "approved title and message boundaries count Unicode code points for creation and both reply roles",
    run: () => withSession(async env => {
      const owner = await env.neutron(), unassigned = await env.neutron();
      const browser = await bind(env, owner, 221), mod = await moderator(env, 222);
      const title = "🙂".repeat(160), tooLongTitle = title + "🙂";
      const body = "🚀".repeat(16_000), tooLongBody = body + "🚀";
      assert.equal([...title].length, 160);
      assert.equal([...body].length, 16_000);
      assert.equal(title.length, 320, "The fixture distinguishes Unicode code points from UTF-16 code units");
      const exact = await create(owner, "exact-boundaries", "issue", { title, body });
      assert.equal(success(await browser.thread(exact.id)).title, title);
      assert.equal(success(await browser.messages(messagesPage(exact.id))).items[0].body, body);
      failure(await owner.call("thread_create", [createRequest("bad-title", "issue", { title: tooLongTitle, body })]), "title_too_long");
      failure(await owner.call("thread_create", [createRequest("bad-body", "issue", { title, body: tooLongBody })]), "message_too_long");
      assert.equal(success(await browser.my_threads(ownPage())).items.length, 1, "Rejected submissions leave no thread behind");
      const userResponse = await reply(owner, exact.id, "exact-user-reply", body);
      const moderatorResponse = await moderatorReply(mod.neutron, exact.id, "exact-moderator-reply", body);
      assert.equal(userResponse.body, body);
      assert.equal(moderatorResponse.body, body);
      failure(await owner.call("reply", [{ threadId: exact.id, requestId: "bad-user-reply", body: tooLongBody }]), "message_too_long");
      failure(await mod.neutron.call("moderation_reply", [{ threadId: exact.id, requestId: "bad-moderator-reply", body: tooLongBody }]), "message_too_long");
      assert.equal(success(await browser.thread(exact.id)).messageCount, 3n);
      assert.equal(success(await browser.session()).unreadReplies, 1n, "Rejected moderator replies do not create notifications");
      failure(await browser.thread_create(createRequest("unauthorized-long-title", "issue", { title: tooLongTitle, body })), "neutron_required");
      failure(await unassigned.call("moderation_reply", [{ threadId: exact.id, requestId: "unassigned-long-reply", body: tooLongBody }]), "moderator_required");
      const corrected = await create(owner, "bad-title", "issue", { title, body });
      assert.notEqual(corrected.id, exact.id, "A rejected submission did not reserve its request identifier");
      const correctedUser = await reply(owner, exact.id, "bad-user-reply", body);
      const correctedModerator = await moderatorReply(mod.neutron, exact.id, "bad-moderator-reply", body);
      assert.ok(correctedUser.id > moderatorResponse.id);
      assert.ok(correctedModerator.id > correctedUser.id);
    }),
  },
  {
    name: "all thread, message and moderator pages clamp requested sizes to thirty without losing continuations",
    run: () => withSession(async env => {
      const owner = await env.neutron();
      const browser = await bind(env, owner, 223), mod = await moderator(env, 224);
      const threads = [];
      for (let index = 0; index < 32; index += 1) threads.push(await create(owner, `clamped-thread-${index}`));
      for (let index = 0; index < 31; index += 1) await reply(owner, threads[0].id, `clamped-message-${index}`);
      for (let index = 0; index < 31; index += 1) {
        const neutron = await env.pic.createCanister({ cycles: 100_000_000_000n });
        success(await env.admin.moderator_set({ neutron, active: true }));
      }
      const queries: Array<(cursor: bigint[], limit: bigint) => Promise<any>> = [
        (cursor, limit) => browser.my_threads(ownPage({ cursor, limit })),
        (cursor, limit) => mod.browser.moderation_threads(modPage({ cursor, limit })),
        (cursor, limit) => browser.messages(messagesPage(threads[0].id, { cursor, limit })),
        (cursor, limit) => mod.browser.moderation_messages(messagesPage(threads[0].id, { cursor, limit })),
        (cursor, limit) => env.admin.moderators({ cursor, limit }),
      ];
      for (const query of queries) {
        failure(await query([], 0n), "invalid_page");
        const first = success(await query([], 9_000n));
        assert.equal(first.items.length, 30);
        assert.equal(first.nextCursor.length, 1);
        const last = success(await query(first.nextCursor, 9_000n));
        assert.equal(last.items.length, 2);
        assert.deepEqual(last.nextCursor, []);
        assert.equal(new Set([...first.items, ...last.items].map(item => String(item.id))).size, 32, "Clamping retains all results through pagination");
      }
    }),
  },
  {
    name: "upgrade from the retained initial Wasm preserves pre-limit content and its successful request retries",
    async run() {
      const baseline = await previousProtocol();
      const env = await session({ initialWasm: baseline.wasm });
      try {
        assert.notEqual(env.compiled.wasmHash, baseline.sha256, "The successor includes the approved bounds");
        const owner = await env.neutron();
        const browser = await bind(env, owner, 225), mod = await moderator(env, 226);
        const originalCreate = createRequest("pre-limit-create", "issue", { title: "🙂".repeat(161), body: "🚀".repeat(16_001) });
        const thread = success(await owner.call("thread_create", [originalCreate]));
        const originalUser = { threadId: thread.id, requestId: "pre-limit-user-reply", body: "🌍".repeat(16_001) };
        const originalModerator = { threadId: thread.id, requestId: "pre-limit-moderator-reply", body: "🙌".repeat(16_001) };
        const userMessage = success(await owner.call("reply", [originalUser]));
        const moderatorMessage = success(await mod.neutron.call("moderation_reply", [originalModerator]));
        const snapshot = async () => ({
          owner: success(await browser.session()), moderator: success(await mod.browser.session()),
          thread: success(await browser.thread(thread.id)), messages: success(await browser.messages(messagesPage(thread.id))),
          queue: success(await mod.browser.moderation_threads(modPage())), moderators: success(await env.admin.moderators({ cursor: [], limit: 20n })),
        });
        const before = await snapshot();
        assert.equal(before.owner.unreadReplies, 1n);
        await env.upgrade();
        assert.deepEqual(await snapshot(), before, "The approved bounds do not truncate or rewrite existing content or any authorization root");
        assert.equal(success(await owner.call("thread_create", [originalCreate])).id, thread.id);
        assert.equal(success(await owner.call("reply", [originalUser])).id, userMessage.id);
        assert.equal(success(await mod.neutron.call("moderation_reply", [originalModerator])).id, moderatorMessage.id);
        failure(await owner.call("thread_create", [{ ...originalCreate, body: originalCreate.body + "changed" }]), "request_conflict");
        failure(await owner.call("reply", [{ ...originalUser, body: originalUser.body + "changed" }]), "request_conflict");
        failure(await mod.neutron.call("moderation_reply", [{ ...originalModerator, body: originalModerator.body + "changed" }]), "request_conflict");
        failure(await owner.call("thread_create", [{ ...originalCreate, requestId: "new-long-title" }]), "title_too_long");
        failure(await owner.call("thread_create", [{ ...originalCreate, requestId: "new-long-body", title: "Short title" }]), "message_too_long");
        failure(await owner.call("reply", [{ ...originalUser, requestId: "new-long-user-reply" }]), "message_too_long");
        failure(await mod.neutron.call("moderation_reply", [{ ...originalModerator, requestId: "new-long-moderator-reply" }]), "message_too_long");
        assert.deepEqual(await snapshot(), before, "Old retries and rejected new requests leave discussions and unread totals unchanged");
        success(await owner.call("mark_read", [{ threadId: thread.id, throughMessageId: moderatorMessage.id }]));
        assert.equal(success(await browser.session()).unreadReplies, 0n);
        const newMessage = await reply(owner, thread.id, "bounded-after-upgrade", "Thanks, I can continue this existing conversation.");
        assert.ok(newMessage.id > moderatorMessage.id);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "keep-mode upgrade retains every managed root and permits subsequent authenticated writes",
    run: () => withSession(async env => {
      const owner = await env.neutron(), second = await env.neutron();
      const browser = await bind(env, owner, 217), secondBrowser = await bind(env, second, 218);
      const mod = await moderator(env, 219), revoked = await env.neutron();
      success(await env.admin.moderator_set({ neutron: revoked.canisterId, active: true }));
      success(await env.admin.moderator_set({ neutron: revoked.canisterId, active: false }));
      const threads = [];
      for (const kind of kinds) threads.push(await create(owner, `upgrade-${kind}`, kind, { appId: ["feedback"] }));
      const foreign = await create(second, "upgrade-second-owner");
      await moderatorReply(mod.neutron, foreign.id, "upgrade-second-response");
      const shown = await moderatorReply(mod.neutron, threads[0].id, "upgrade-shown");
      success(await owner.call("mark_read", [{ threadId: threads[0].id, throughMessageId: shown.id }]));
      await moderatorReply(mod.neutron, threads[0].id, "upgrade-unread");
      await moderatorReply(mod.neutron, threads[1].id, "upgrade-optional-response");
      const retryRequest = { requestId: "upgrade-reply", threadId: threads[0].id, body: "Keep this discussion and request key." };
      const retryMessage = success(await owner.call("reply", [retryRequest]));
      success(await owner.call("issue_status_set", [{ threadId: threads[0].id, resolved: true }]));
      const snapshot = async () => ({
        info: await env.actor.feedback_info(), owner: success(await browser.session()), second: success(await secondBrowser.session()),
        moderator: success(await mod.browser.session()), mine: success(await browser.my_threads(ownPage())),
        theirs: success(await secondBrowser.my_threads(ownPage())), queue: success(await mod.browser.moderation_threads(modPage())),
        moderators: success(await env.admin.moderators({ cursor: [], limit: 20n })),
        discussions: await Promise.all(threads.map(thread => browser.messages(messagesPage(thread.id)).then(success))),
      });
      const before = await snapshot();
      assert.equal(before.owner.unreadReplies, 2n);
      assert.equal(before.second.unreadReplies, 1n);
      await env.upgrade();
      assert.deepEqual(await snapshot(), before, "Ashroot thread/message/delegate/moderator/owner roots and singleton survive keep-mode upgrade");
      assert.equal(success(await owner.call("thread_create", [createRequest("upgrade-issue", "issue", { appId: ["feedback"] })])).id, threads[0].id);
      assert.equal(success(await owner.call("reply", [retryRequest])).id, retryMessage.id);
      failure(await owner.call("reply", [{ ...retryRequest, body: "Conflicting request after upgrade" }]));
      const next = await create(owner, "after-upgrade");
      assert.ok(next.id > foreign.id, "Thread identifiers continue after restored state");
      assert.ok(next.activity > before.queue.items[0].activity, "Activity ordering continues after restored singleton state");
      const response = await moderatorReply(mod.neutron, next.id, "after-upgrade-response");
      assert.ok(response.id > retryMessage.id, "Message identifiers continue after restored state");
      success(await owner.call("mark_read", [{ threadId: next.id, throughMessageId: response.id }]));
      assert.equal(success(await browser.session()).unreadReplies, 2n);
      success(await env.admin.moderator_set({ neutron: mod.neutron.canisterId, active: false }));
      failure(await mod.browser.moderation_thread(next.id));
      failure(await revoked.call("moderation_reply", [{ requestId: "still-revoked", threadId: next.id, body: "Cannot reply" }]));
    }),
  },
];
