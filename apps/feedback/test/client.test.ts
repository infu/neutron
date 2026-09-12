import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { protocolClient, ProtocolError, threadView, messageView, type ClientDependencies } from "../src/client.ts";
import { parseState, readIdentity, type Kernel } from "../src/store_state.ts";
import { kernelBoundary, stateType, stateResultType, draftType, draftPageType, textResultType } from "./kernel_boundary.ts";
import type { WireMessage, WireSession, WireThread } from "../src/protocol.ts";

const owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const seed = new Uint8Array(32).fill(7);
const identity = Ed25519KeyIdentity.generate(seed);
const wireSession = (moderator = false): WireSession => ({ neutron: owner, moderator, unreadReplies: 2n });
const thread = (): WireThread => ({ id: 9007199254740993n, owner, kind: { issue: null }, title: "Wallet won't open", appId: ["wallet"], resolved: false, needsReply: true, messageCount: 1n, lastMessageId: 9007199254740994n, unreadReplies: 0n, activity: 1n, createdAtNs: 1700000000000000000n, updatedAtNs: 1700000000000000000n });
const message = (): WireMessage => ({ id: 9007199254740994n, threadId: 9007199254740993n, author: owner, role: { moderator: null }, body: "Please share the error text. https://example.com/shared.png", moderatorSequence: 1n, createdAtNs: 1700000000000000000n });
function memoryKernel(savedSeed: Uint8Array | null = seed) {
  const intents = new Map<string, string>();
  const calls: { method: string; args: unknown[] }[] = [];
  let persisted = savedSeed;
  let cleanupFails = false;
  const kernel = {
    querySelf: async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === "feedback_draft") { const value = intents.get(args[0] as string); return kernelBoundary(draftType, value === undefined ? [] : [new TextEncoder().encode(value)]); }
      if (method === "feedback_drafts") return kernelBoundary(draftPageType, { items: [...intents].map(([id, value]) => ({ id, value: new TextEncoder().encode(value) })), nextCursor: [] });
      if (method !== "feedback_state") throw new Error(`Unexpected query ${method}`);
      return kernelBoundary(stateType, { owner, seed: persisted ? [persisted] : [] });
    },
    updateSelf: async (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === "feedback_initialize") {
        persisted ??= new Uint8Array(args[0] as Uint8Array);
        return kernelBoundary(stateResultType, { ok: { owner, seed: [persisted] } });
      }
      const input = args[0] as { id: string; value: Uint8Array };
      const value = new TextDecoder().decode(input.value);
      if (method === "feedback_save_draft") {
        const existing = intents.get(input.id);
        if (existing !== undefined && existing !== value) return { err: "This request ID already has different saved content." };
        intents.set(input.id, value);
        return kernelBoundary(textResultType, { ok: input.id });
      }
      if (method === "feedback_complete_draft") {
        if (cleanupFails) throw new Error("Cleanup temporarily unavailable");
        if (intents.has(input.id) && intents.get(input.id) !== value) return { err: "The saved request does not match." };
        intents.delete(input.id);
        return kernelBoundary(textResultType, { ok: input.id });
      }
      throw new Error(`Unexpected update ${method}`);
    },
  } as unknown as Kernel;
  return { kernel, intents, calls, seed: () => persisted, failCleanup: () => { cleanupFails = true; } };
}
function network(input: { moderator?: boolean; missing?: boolean; sessionError?: Error } = {}) {
  const queries: { name: string; args: unknown[] }[] = [];
  const updates: { name: string; args: unknown[]; kernel: Kernel }[] = [];
  const signers: string[] = [];
  let missing = input.missing ?? false;
  let interruptSend = false;
  const deps: ClientDependencies = {
    makeAgent: async signer => { signers.push(signer.getPrincipal().toText()); return {} as never; },
    makeTransport: ({ kernel }) => ({
      query: async (name: string, args: unknown[] = []) => {
        queries.push({ name, args });
        if (name === "session") {
          if (input.sessionError) throw input.sessionError;
          return missing ? { err: { code: "delegate_required", message: "Restore access" } } : { ok: wireSession(input.moderator) };
        }
        if (name === "thread" || name === "moderation_thread") return { ok: thread() };
        if (name === "messages" || name === "moderation_messages") return { ok: { items: [message()], nextCursor: [9007199254740995n] } };
        return { ok: { items: [thread()], nextCursor: [] } };
      },
      update: async (name: string, args: unknown[]) => {
        updates.push({ name, args, kernel });
        if (name === "read_delegate_set") { missing = false; return { ok: null }; }
        if (interruptSend) { interruptSend = false; throw new Error("Reply was lost after submission"); }
        return { ok: name === "reply" || name === "moderation_reply" ? message() : thread() };
      },
    }) as never,
  };
  return { deps, queries, updates, signers, interruptNextSend: () => { interruptSend = true; } };
}

test("clean initialization and restored identity reuse the persisted first seed", async () => {
  const memory = memoryKernel(null);
  const [a, b] = await Promise.all([readIdentity(memory.kernel), readIdentity(memory.kernel)]);
  expect(a.identity.getPrincipal().toText()).toBe(b.identity.getPrincipal().toText());
  const original = memory.seed()!;
  const restored = await readIdentity(memory.kernel);
  expect(restored.state.seed).toEqual(original);
  expect(restored.identity.getPrincipal().toText()).toBe(Ed25519KeyIdentity.generate(original).getPrincipal().toText());
  expect(() => parseState({ owner: owner.toText(), seed: [new Uint8Array(31)] })).toThrow("preserved");
});

test("saved read signer is registered only for explicit delegate_required and through the exact scope", async () => {
  const memory = memoryKernel(); const net = network({ missing: true });
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  expect((await client.session()).neutron).toBe(owner.toText());
  expect(net.signers).toEqual([identity.getPrincipal().toText()]);
  expect(net.updates).toHaveLength(1);
  expect(net.updates[0]!.kernel).toBe(memory.kernel);
  expect(net.updates[0]!.name).toBe("read_delegate_set");
  expect((net.updates[0]!.args[0] as { browser: Principal }).browser.toText()).toBe(identity.getPrincipal().toText());
  const unavailable = network({ sessionError: new Error("Replica unavailable") });
  await expect(protocolClient({ kernel: memory.kernel }, unavailable.deps)).rejects.toThrow("Replica unavailable");
  expect(unavailable.updates).toHaveLength(0);
});

test("a denied invocation cannot reuse a previously authorized client's seed or kernel", async () => {
  const memory = memoryKernel(); const net = network();
  await protocolClient({ kernel: memory.kernel }, net.deps);
  const denied = { querySelf: async () => { throw new Error("Invocation denied"); } } as unknown as Kernel;
  await expect(protocolClient({ kernel: denied }, net.deps)).rejects.toThrow("Invocation denied");
  expect(net.signers).toHaveLength(1);
  expect(net.updates).toHaveLength(0);
});

test("query projections preserve large IDs, text, optional app and cursor without marking read", async () => {
  const memory = memoryKernel(); const net = network();
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  const discussion = await client.get("9007199254740993", "9007199254740994");
  expect(discussion.thread.id).toBe("9007199254740993");
  expect(discussion.messages.items[0]!.body).toBe(message().body);
  expect(discussion.messages.nextCursor).toBe("9007199254740995");
  expect(net.queries.find(call => call.name === "messages")!.args).toEqual([{ threadId: 9007199254740993n, cursor: [9007199254740994n], limit: 30n }]);
  expect(net.updates).toHaveLength(0);
  expect(threadView({ ...thread(), appId: [] }).appId).toBeNull();
  expect(messageView(message()).createdAt).toBe("2023-11-14T22:13:20.000Z");
});

test("unknown send retains exact intent across resident recreation; changed retry is rejected before send", async () => {
  const memory = memoryKernel(); const net = network(); net.interruptNextSend();
  const input = { requestId: "retained-operation", kind: "issue" as const, title: "Wallet won't open", body: "The error includes <text> and a shared link.", appId: "wallet" };
  const first = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(first.create(input)).rejects.toThrow("Reply was lost");
  expect(memory.intents.size).toBe(1);
  const restored = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(restored.create({ ...input, body: "Different content" })).rejects.toThrow("different saved content");
  expect(net.updates).toHaveLength(1);
  const created = await restored.create(input);
  expect(created.id).toBe("9007199254740993");
  expect(net.updates).toHaveLength(2);
  expect(net.updates[1]!.args).toEqual(net.updates[0]!.args);
  expect(memory.intents.size).toBe(0);
});

test("reply retries retain method and bytes, while failed cleanup preserves successful send", async () => {
  const memory = memoryKernel(); const net = network({ moderator: true }); net.interruptNextSend();
  const input = { requestId: "reply-id", threadId: "9007199254740993", body: "A moderator answer" };
  const first = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(first.moderationReply(input)).rejects.toThrow("Reply was lost");
  const restored = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(restored.reply(input)).rejects.toThrow("different saved content");
  memory.failCleanup();
  expect((await restored.moderationReply(input)).body).toBe(message().body);
  expect(memory.intents.size).toBe(1);
  expect(net.updates[0]!.args).toEqual(net.updates[1]!.args);
});

test("moderator tools fail before private query or saved reply for ordinary users", async () => {
  const memory = memoryKernel(); const net = network();
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(client.moderationList()).rejects.toBeInstanceOf(ProtocolError);
  await expect(client.moderationGet("1")).rejects.toThrow("assigned moderators");
  await expect(client.moderationReply({ requestId: "x", threadId: "1", body: "No" })).rejects.toThrow("assigned moderators");
  expect(net.queries.map(call => call.name)).toEqual(["session"]);
  expect(net.updates).toHaveLength(0);
  expect(memory.intents.size).toBe(0);
});

test("moderator reading and owner acknowledgement route to separate protocol methods", async () => {
  const memory = memoryKernel(); const net = network({ moderator: true });
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  await client.moderationList({ needsReply: true, kind: "issue" });
  await client.moderationGet("9007199254740993");
  await client.markRead("9007199254740993", "9007199254740994");
  await client.setResolved("9007199254740993", true);
  expect(net.queries.map(call => call.name)).toEqual(["session", "moderation_threads", "moderation_thread", "moderation_messages"]);
  expect(net.updates.map(call => call.name)).toEqual(["mark_read", "issue_status_set"]);
  expect(net.updates[0]!.args).toEqual([{ threadId: 9007199254740993n, throughMessageId: 9007199254740994n }]);
});

test("aborted invocation performs no durable setup or query", async () => {
  const memory = memoryKernel(); const net = network(); const controller = new AbortController(); controller.abort();
  await expect(protocolClient({ kernel: memory.kernel, signal: controller.signal }, net.deps)).rejects.toThrow();
  expect(memory.calls).toHaveLength(0); expect(net.queries).toHaveLength(0);
});


test("saved interrupted requests can be discovered and resumed by ID after a reload", async () => {
  const memory = memoryKernel(); const net = network(); net.interruptNextSend();
  const input = { requestId: "recover-after-reload", kind: "issue" as const, title: "Cannot open app", body: "Original message", appId: "wallet" };
  const original = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(original.create(input)).rejects.toThrow("Reply was lost");
  const reloaded = await protocolClient({ kernel: memory.kernel }, net.deps);
  const pending = await reloaded.pending!();
  expect(pending.items).toEqual([{ ...input, method: "create" }]);
  expect((await reloaded.resume!(input.requestId)).id).toBe("9007199254740993");
  expect(net.updates[1]!.args).toEqual(net.updates[0]!.args);
  expect((await reloaded.pending!()).items).toEqual([]);
});

test("revoked moderator requests cannot be exposed or resumed through user recovery tools", async () => {
  const memory = memoryKernel(); const moderator = network({ moderator: true }); moderator.interruptNextSend();
  const admin = await protocolClient({ kernel: memory.kernel }, moderator.deps);
  await expect(admin.moderationReply({ requestId: "admin-pending", threadId: "1", body: "Private answer" })).rejects.toThrow("Reply was lost");
  const ordinary = network();
  const revoked = await protocolClient({ kernel: memory.kernel }, ordinary.deps);
  expect((await revoked.pending!()).items).toEqual([]);
  await expect(revoked.resume!("admin-pending")).rejects.toThrow("assigned moderators");
  expect(ordinary.updates).toEqual([]);
  expect(memory.intents.size).toBe(1);
});

test("authoritative protocol rejection unlocks the request while unknown outcomes remain saved", async () => {
  const memory = memoryKernel(); const net = network();
  const original = net.deps.makeTransport!;
  net.deps.makeTransport = input => {
    const transport = original(input);
    return { ...transport, update: async () => ({ err: { code: "title_required", message: "Enter a title" } }) } as never;
  };
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(client.create({ requestId: "invalid", kind: "issue", title: "", body: "Content" })).rejects.toThrow("Enter a title");
  expect(memory.intents.size).toBe(0);
});


test("role revoked between session and retry cannot erase an earlier uncertain moderator reply", async () => {
  const memory = memoryKernel(); const net = network({ moderator: true }); net.interruptNextSend();
  const client = await protocolClient({ kernel: memory.kernel }, net.deps);
  const input = { requestId: "revocation-race", threadId: "1", body: "An earlier answer" };
  await expect(client.moderationReply(input)).rejects.toThrow("Reply was lost");
  const original = net.deps.makeTransport!;
  net.deps.makeTransport = options => {
    const transport = original(options);
    return { ...transport, update: async () => ({ err: { code: "moderator_required", message: "Moderator access was revoked" } }) } as never;
  };
  const reloaded = await protocolClient({ kernel: memory.kernel }, net.deps);
  await expect(reloaded.resume!(input.requestId)).rejects.toThrow("revoked");
  expect(memory.intents.size).toBe(1);
  expect((await reloaded.pending!()).items[0]!.requestId).toBe(input.requestId);
});
