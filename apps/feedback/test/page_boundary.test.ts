import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { assertBoundedJson } from "neutron-tools/protocol";
import { protocolClient, type ClientDependencies } from "../src/client.ts";
import type { WireMessage, WireSession, WireThread } from "../src/protocol.ts";
import type { Kernel } from "../src/store_state.ts";
import type { FeedbackMessage, PendingFeedbackRequest } from "../src/types.ts";
import { draftPageType, kernelBoundary, stateType } from "./kernel_boundary.ts";

const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const seed = new Uint8Array(32).fill(7);
const timestamp = 1_700_000_000_000_000_000n;
const session: WireSession = { neutron: owner, moderator: true, unreadReplies: 30n };
const thread: WireThread = {
  id: 41n, owner, kind: { issue: null }, title: "A discussion with full-length messages", appId: [],
  resolved: false, needsReply: true, messageCount: 30n, lastMessageId: 1030n, unreadReplies: 30n,
  activity: 1n, createdAtNs: timestamp, updatedAtNs: timestamp,
};

function assertPublicEnvelopes(result: unknown): void {
  // The view serializes its result a second time inside the message bus JSON.
  // Escaped control characters therefore cost more here than in Agent output.
  assertBoundedJson({ resultJson: JSON.stringify(result) }, "Feedback UI result");
  assertBoundedJson({ version: 1, contentTrust: "user_authored", result }, "Feedback Agent result");
}

function identityKernel(): Kernel {
  return {
    querySelf: async (method: string) => {
      if (method !== "feedback_state") throw new Error(`Unexpected query ${method}`);
      return kernelBoundary(stateType, { owner, seed: [seed] });
    },
    updateSelf: async () => { throw new Error("Reading a page must not change saved state"); },
  } as unknown as Kernel;
}

const textCases = [
  { name: "16,000 emoji", body: "🪐".repeat(16_000) },
  { name: "16,000 escaped NUL characters", body: "\0".repeat(16_000) },
];

for (const { name, body } of textCases) {
  for (const moderation of [false, true]) {
    test(`${moderation ? "moderationGet" : "get"} paginates ${name} through both public envelopes without losing text`, async () => {
      const messages: WireMessage[] = Array.from({ length: 30 }, (_, index) => ({
        id: BigInt(1001 + index), threadId: thread.id, author: owner,
        role: { moderator: null }, body, moderatorSequence: BigInt(index + 1), createdAtNs: timestamp,
      }));
      const requestedCursors: (bigint | undefined)[] = [];
      const dependencies: ClientDependencies = {
        makeAgent: async () => ({} as never),
        makeTransport: () => ({
          query: async (method: string, args: unknown[] = []) => {
            if (method === "session") return { ok: session };
            if (method === (moderation ? "moderation_thread" : "thread")) return { ok: thread };
            if (method !== (moderation ? "moderation_messages" : "messages")) throw new Error(`Unexpected protocol query ${method}`);
            const request = args[0] as { threadId: bigint; cursor: [] | [bigint]; limit: bigint };
            expect(request.threadId).toBe(thread.id);
            requestedCursors.push(request.cursor[0]);
            const remaining = messages.filter(message => request.cursor[0] === undefined || message.id > request.cursor[0]);
            const items = remaining.slice(0, Number(request.limit));
            return { ok: { items, nextCursor: remaining.length > items.length ? [items.at(-1)!.id] : [] } };
          },
          update: async () => { throw new Error("Reading a discussion must not send an update"); },
        }) as never,
      };
      const client = await protocolClient({ kernel: identityKernel() }, dependencies);
      const recovered: FeedbackMessage[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const discussion = await (moderation ? client.moderationGet("41", cursor) : client.get("41", cursor));
        assertPublicEnvelopes(discussion);
        expect(discussion.thread.id).toBe("41");
        expect(discussion.messages.items.length).toBeGreaterThan(0);
        for (const message of discussion.messages.items) {
          expect(message.body).toBe(body);
          expect(message.threadId).toBe("41");
          expect(message.role).toBe("moderator");
        }
        recovered.push(...discussion.messages.items);
        const next = discussion.messages.nextCursor;
        if (next !== null) {
          expect(next).toBe(discussion.messages.items.at(-1)!.id);
          expect(cursors.has(next)).toBe(false);
          cursors.add(next);
        }
        cursor = next ?? undefined;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(messages.length);
      } while (cursor !== undefined);
      expect(pages).toBeGreaterThan(1);
      expect(requestedCursors[0]).toBeUndefined();
      expect(recovered.map(message => message.id)).toEqual(messages.map(message => String(message.id)));
      expect(new Set(recovered.map(message => message.id)).size).toBe(30);
    });
  }

  test(`saved sends paginate ${name} across Kernel binary and public JSON boundaries without losing requests`, async () => {
    const expected: PendingFeedbackRequest[] = [];
    const stored = Array.from({ length: 30 }, (_, index) => {
      const requestId = `req${String(index).padStart(3, "0")}`;
      let saved: { method: string; args: Record<string, unknown> };
      if (index % 3 === 0) {
        saved = { method: "thread_create", args: { requestId, kind: "issue", title: `Saved problem ${index}`, body, appId: "wallet" } };
        expected.push({ requestId, method: "create", kind: "issue", title: `Saved problem ${index}`, body, appId: "wallet" });
      } else {
        const moderator = index % 3 === 2;
        saved = { method: moderator ? "moderation_reply" : "reply", args: { requestId, threadId: "41", body } };
        expected.push({ requestId, method: moderator ? "moderationReply" : "reply", threadId: "41", body });
      }
      return { id: `request:${requestId}`, value: new TextEncoder().encode(JSON.stringify(saved)) };
    });
    // Exercise the existing real bound, rather than inventing a fake network
    // error. A full page is too large even before the resident's JSON output.
    expect(() => kernelBoundary(draftPageType, { items: stored, nextCursor: [] })).toThrow(/Candid reply exceeds the (aggregate binary byte|raw byte) limit/);
    const requests: { cursor: string | null; limit: number }[] = [];
    const rejectedLimits: number[] = [];
    const kernel = {
      querySelf: async (method: string, args: unknown[] = []) => {
        if (method === "feedback_state") return kernelBoundary(stateType, { owner, seed: [seed] });
        if (method !== "feedback_drafts") throw new Error(`Unexpected query ${method}`);
        const request = args[0] as { cursor: string | null; limit: string };
        const limit = Number(request.limit);
        requests.push({ cursor: request.cursor, limit });
        const remaining = stored.filter(row => request.cursor === null || row.id > request.cursor);
        const items = remaining.slice(0, limit);
        try {
          return kernelBoundary(draftPageType, { items, nextCursor: remaining.length > items.length ? [items.at(-1)!.id] : [] });
        } catch (error) {
          rejectedLimits.push(limit);
          throw error;
        }
      },
      updateSelf: async () => { throw new Error("Listing saved sends must not rewrite or complete them"); },
    } as unknown as Kernel;
    const dependencies: ClientDependencies = {
      makeAgent: async () => ({} as never),
      makeTransport: () => ({
        query: async (method: string) => {
          if (method !== "session") throw new Error(`Unexpected protocol query ${method}`);
          return { ok: session };
        },
        update: async () => { throw new Error("Listing saved sends must not send them"); },
      }) as never,
    };
    const client = await protocolClient({ kernel }, dependencies);
    const recovered: PendingFeedbackRequest[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.pending!(cursor);
      assertPublicEnvelopes(page);
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) expect(item.body).toBe(body);
      recovered.push(...page.items);
      if (page.nextCursor !== null) {
        expect(page.nextCursor).toBe(`request:${page.items.at(-1)!.requestId}`);
        expect(cursors.has(page.nextCursor)).toBe(false);
        cursors.add(page.nextCursor);
      }
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(stored.length);
    } while (cursor !== undefined);
    expect(requests.slice(0, 2)).toEqual([{ cursor: null, limit: 30 }, { cursor: null, limit: 15 }]);
    expect(rejectedLimits[0]).toBe(30);
    expect(pages).toBeGreaterThan(1);
    expect(recovered).toEqual(expected);
    expect(new Set(recovered.map(item => item.requestId)).size).toBe(30);
    expect(stored).toHaveLength(30);
  });
}
