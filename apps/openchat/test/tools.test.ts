import { expect, test } from "bun:test";
import type { JsonValue, MsgBusToolContext, MsgBusToolHandler } from "neutron-tools/protocol";
import type { OpenChatEngine } from "../src/engine/engine.ts";
import { TOOLS } from "../src/shared/protocol.ts";
import { registerTools } from "../src/tools/surface.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function tools(engine: Partial<OpenChatEngine>) {
  const handlers = new Map<string, MsgBusToolHandler>();
  registerTools({
    whenReady: async () => {},
    whenChatsReady: async () => {},
    ...engine,
  } as OpenChatEngine, (name, _options, handler) => { handlers.set(name, handler); });
  return (name: string) => handlers.get(name)!;
}

function context(callTool: MsgBusToolContext["kernel"]["callTool"] = async () => {
  throw new Error("Unexpected Kernel call");
}, signal?: AbortSignal): MsgBusToolContext {
  return {
    kernel: { callTool } as MsgBusToolContext["kernel"],
    reportProgress() {},
    ...(signal ? { signal } : {}),
  };
}

test("agent chat reads wait for the restored session's chat snapshot", async () => {
  const initialChats = deferred();
  let reads = 0;
  const handler = tools({
    whenChatsReady: () => initialChats.promise,
    listChats: () => { reads++; return []; },
  })(TOOLS.listChats);
  const result = handler({}, context());
  await Promise.resolve();
  expect(reads).toBe(0);
  initialChats.resolve();
  expect(await result).toEqual({ chats: [] });
  expect(reads).toBe(1);
});

test("restoration failure cannot become a successful empty chat list", async () => {
  let reads = 0;
  const handler = tools({
    whenChatsReady: async () => { throw new Error("Chat snapshot unavailable"); },
    listChats: () => { reads++; return []; },
  })(TOOLS.listChats);
  await expect(handler({}, context())).rejects.toThrow("Chat snapshot unavailable");
  expect(reads).toBe(0);
});

test("whoami waits for session restore without waiting for chat network reads", async () => {
  const restore = deferred();
  let reads = 0;
  const handler = tools({
    whenReady: () => restore.promise,
    whenChatsReady: async () => { throw new Error("Chat read must not delay account identity"); },
    whoami: () => {
      reads++;
      return { status: "logged_out", ocPrincipal: null, userId: null, username: null, pendingEmail: null };
    },
  })(TOOLS.whoami);
  const result = handler({}, context());
  await Promise.resolve();
  expect(reads).toBe(0);
  restore.resolve();
  expect(await result).toHaveProperty("status", "logged_out");
});

test("public discovery remains available when local session restoration is unavailable", async () => {
  const handler = tools({
    whenReady: async () => { throw new Error("Local session storage is unavailable"); },
    exploreCommunities: async () => [],
  })(TOOLS.exploreCommunities);
  expect(await handler({}, context())).toEqual({ communities: [] });
});

test("sign-out cannot race pending session restoration", async () => {
  const restore = deferred();
  let signedOut = false;
  const handler = tools({
    whenReady: () => restore.promise,
    signOut: async () => { signedOut = true; },
  })(TOOLS.signOut);
  const result = handler({}, context());
  await Promise.resolve();
  expect(signedOut).toBe(false);
  restore.resolve();
  expect(await result).toEqual({ ok: true });
  expect(signedOut).toBe(true);
});

test("cancelling while restoring does not send a message afterwards", async () => {
  const restore = deferred();
  const abort = new AbortController();
  let sends = 0;
  const handler = tools({
    whenChatsReady: () => restore.promise,
    sendMessage: async () => { sends++; return { kind: "sent", messageId: "1", message: null }; },
  })(TOOLS.sendMessage);
  const result = handler({ chatId: "group:example", text: "message" }, context(undefined, abort.signal));
  abort.abort(new Error("Request cancelled"));
  restore.resolve();
  await expect(result).rejects.toThrow("Request cancelled");
  expect(sends).toBe(0);
});

const selected = { ok: true, chatId: "group:example", title: "Example", message: null } as const;

test("show_chat opens the requested tile through the current invocation's scoped Kernel client", async () => {
  const restore = deferred();
  const calls: unknown[] = [];
  const handler = tools({
    whenChatsReady: () => restore.promise,
    showChat: () => selected,
  })(TOOLS.showChat);
  const result = handler({ query: "Example" }, context(async <T extends JsonValue>(request: unknown) => {
    calls.push(request);
    return { opened: true, workspace: 1, instanceId: "example" } as unknown as T;
  }));
  await Promise.resolve();
  expect(calls).toEqual([]);
  restore.resolve();
  expect(await result).toEqual(selected);
  expect(calls).toEqual([{
    target: "kernel",
    name: "workspace.open_tile",
    arguments: { appId: "openchat", tileId: "chats", reuseExisting: true, view: "chat" },
  }]);
});

test("show_chat reports a declined tile open rather than claiming it opened", async () => {
  const handler = tools({ showChat: () => selected })(TOOLS.showChat);
  expect(await handler({ query: "Example" }, context(async () => {
    throw new Error("Owner declined");
  }))).toEqual({
    ...selected,
    ok: false,
    message: "Chat selected, but its tile could not be opened: Owner declined",
  });
});

test("an unknown chat does not request an unrelated tile", async () => {
  const unknown = { ok: false, chatId: null, title: null, message: "No matching chat" };
  const handler = tools({ showChat: () => unknown })(TOOLS.showChat);
  expect(await handler({ query: "missing" }, context())).toEqual(unknown);
});
