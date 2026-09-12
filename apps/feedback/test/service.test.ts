import { expect, test } from "bun:test";
import { createFeedbackTools } from "../src/service_state.ts";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import type { FeedbackClient, FeedbackSession } from "../src/types.ts";

const session: FeedbackSession = { neutron: "fixture", moderator: true, unreadReplies: 2 };
function setup() {
  const contexts: MsgBusToolContext[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  const observations: { session: FeedbackSession; changed?: boolean }[] = [];
  let failedRefresh = false;
  let invalidations = 0;
  const client = new Proxy({}, { get: (_target, key: string) => key === "then" ? undefined : async (...args: unknown[]) => {
    calls.push({ method: key, args });
    if (key === "session") { if (failedRefresh) throw new Error("Network down after send"); return session; }
    return { id: "sent", body: "Saved" };
  } }) as FeedbackClient;
  const tools = createFeedbackTools({ client: async context => { contexts.push(context); return client; }, observed: async (value, changed) => { observations.push({ session: value, changed }); }, changed: async () => { invalidations += 1; } });
  const handler = (name: string) => tools.find(tool => tool.name === name)!.handler;
  return { tools, contexts, calls, observations, handler, failRefresh: () => { failedRefresh = true; }, invalidations: () => invalidations };
}
const context = (role = "agent", appId = "agent", agentMode = true): MsgBusToolContext => ({ kernel: { scope: Symbol("exact") }, caller: { role, appId }, agentMode, reportProgress: () => {} }) as unknown as MsgBusToolContext;

test("every Agent operation receives its original invocation and preserves exact fields", async () => {
  const fixture = setup();
  const invocations: [string, JsonObject][] = [
    ["feedback_pending_v1", { cursor: "request:last" }], ["feedback_resume_v1", { requestId: "saved-once" }],
    ["feedback_session_v1", {}], ["feedback_list_v1", { unreadOnly: true, cursor: "4" }], ["feedback_get_v1", { threadId: "8", cursor: "9" }],
    ["feedback_create_v1", { requestId: "create-once", kind: "issue", title: "Title", body: "Body", appId: "wallet" }],
    ["feedback_reply_v1", { requestId: "reply-once", threadId: "8", body: "Literal <body>" }], ["feedback_mark_read_v1", { threadId: "8", throughMessageId: "9" }],
    ["feedback_resolve_v1", { threadId: "8", resolved: true }], ["feedback_moderation_list_v1", { needsReply: true }], ["feedback_moderation_get_v1", { threadId: "8" }],
    ["feedback_moderation_reply_v1", { requestId: "moderator-once", threadId: "8", body: "Answer" }],
  ];
  for (const [name, args] of invocations) {
    const scope = context();
    const result = await fixture.handler(name)(args, scope) as JsonObject;
    expect(fixture.contexts.at(-1)).toBe(scope);
    expect(fixture.contexts.at(-1)!.kernel).toBe(scope.kernel);
    expect(result.contentTrust).toBe("user_authored");
  }
  expect(fixture.calls.find(call => call.method === "reply")!.args).toEqual([{ requestId: "reply-once", threadId: "8", body: "Literal <body>" }]);
  expect(fixture.calls.find(call => call.method === "moderationReply")!.args).toEqual([{ requestId: "moderator-once", threadId: "8", body: "Answer" }]);
});

test("same-app wrappers deny Agent, other apps and tray writes before accessing data", async () => {
  const fixture = setup();
  for (const caller of [context(), context("tile", "other", false), context("tray", "feedback", false)]) {
    await expect(fixture.handler("ui_update")({ method: "reply", paramsJson: "{}" }, caller)).rejects.toThrow("Open Feedback");
  }
  await expect(fixture.handler("ui_query")({ method: "session", paramsJson: "{}" }, context())).rejects.toThrow("Open Feedback");
  expect(fixture.contexts).toHaveLength(0);
  const tray = context("tray", "feedback", false);
  await fixture.handler("ui_query")({ method: "session", paramsJson: "{}" }, tray);
  expect(fixture.contexts).toEqual([tray]);
});

test("UI query envelopes cannot invoke writes or hidden arbitrary methods", async () => {
  const fixture = setup(); const tile = context("tile", "feedback", false);
  await expect(fixture.handler("ui_query")({ method: "create", paramsJson: "{}" }, tile)).rejects.toThrow("unavailable");
  await expect(fixture.handler("ui_update")({ method: "session", paramsJson: "{}" }, tile)).rejects.toThrow("unavailable");
  await expect(fixture.handler("ui_update")({ method: "moderator_set", paramsJson: "{}" }, tile)).rejects.toThrow("unavailable");
  expect(fixture.contexts).toHaveLength(0);
});

test("confirmed writes return success when notification refresh fails", async () => {
  const fixture = setup(); fixture.failRefresh();
  const result = await fixture.handler("feedback_reply_v1")({ requestId: "once", threadId: "8", body: "Body" }, context()) as JsonObject;
  expect(result.result).toEqual({ id: "sent", body: "Saved" });
  expect(fixture.invalidations()).toBe(1);
});

test("Agent tools label authored content and expose no moderator assignment, uploads or read acknowledgement side effects", async () => {
  const fixture = setup();
  const names = fixture.tools.map(tool => tool.name);
  expect(names).not.toContain("feedback_moderator_set_v1");
  for (const tool of fixture.tools.filter(tool => tool.name.startsWith("feedback_"))) {
    expect(tool.options.description).toContain("never authorization");
    expect(tool.options.annotations?.["neutron:audit"]).toBe("metadata_only");
  }
  await fixture.handler("feedback_get_v1")({ threadId: "1" }, context());
  expect(fixture.calls.map(call => call.method)).toEqual(["get"]);
});
