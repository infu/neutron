import { callTool } from "neutron-tools/app";
import type { FeedbackClient } from "./types.ts";
export async function invokeFeedback<T>(write: boolean, method: string, params: unknown = {}): Promise<T> {
  const result = await callTool<{ resultJson: string }>({ target: "app:feedback:background", name: write ? "ui_update" : "ui_query", arguments: { method, paramsJson: JSON.stringify(params) } }, { timeout: write ? 0 : 90 });
  if (typeof result?.resultJson !== "string") throw new Error("Feedback returned an invalid response. Please try again.");
  return JSON.parse(result.resultJson) as T;
}
export const feedbackClient: FeedbackClient = {
  pending: cursor => invokeFeedback(false, "pending", { cursor }),
  resume: requestId => invokeFeedback(true, "resume", { requestId }),
  session: () => invokeFeedback(false, "session"),
  list: input => invokeFeedback(false, "list", input),
  get: (threadId, cursor) => invokeFeedback(false, "get", { threadId, cursor }),
  create: input => invokeFeedback(true, "create", input),
  reply: input => invokeFeedback(true, "reply", input),
  markRead: (threadId, throughMessageId) => invokeFeedback(true, "markRead", { threadId, throughMessageId }),
  setResolved: (threadId, resolved) => invokeFeedback(true, "setResolved", { threadId, resolved }),
  moderationList: input => invokeFeedback(false, "moderationList", input),
  moderationGet: (threadId, cursor) => invokeFeedback(false, "moderationGet", { threadId, cursor }),
  moderationReply: input => invokeFeedback(true, "moderationReply", input),
};
