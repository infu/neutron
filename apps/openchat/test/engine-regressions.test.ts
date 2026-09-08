import { afterEach, expect, test } from "bun:test";
import { AnonymousIdentity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { OpenChatEngine } from "../src/engine/engine.ts";
import { KEYS, keystore } from "../src/oc/keystore.ts";
const engines: OpenChatEngine[] = [];
const identity = new AnonymousIdentity();
const recipient = Principal.fromText("aaaaa-aa");
const empty = { Success: { direct_chats: { summaries: [] }, group_chats: { summaries: [] }, communities: { summaries: [] } } };
const profile = { ocPrincipal: "2vxsx-fae", userId: "2vxsx-fae", username: "owner", userCanister: "2vxsx-fae", localUserIndex: "aaaaa-aa", avatarUrl: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function engine(signedIn = true) {
  const e = new OpenChatEngine({ publish() {} });
  engines.push(e);
  await e.whenReady();
  if (signedIn) Object.assign(e, { profile: { ...profile }, ocIdentity: identity });
  return e;
}
afterEach(async () => { for (const e of engines.splice(0)) await e.signOut(); });

test("a fuzzy username result cannot select a different DM recipient", async () => {
  const e = await engine();
  let sends = 0;
  Object.assign(e, {
    userIndex: { search: async () => ({ Success: { users: [{ user_id: recipient.toUint8Array(), username: "alice-other" }] } }) },
    user: { sendMessageV2: async () => { sends++; return { Success: {} }; } },
  });
  const result = await e.dmUser("alice", "private message");
  expect(result.kind).toBe("error");
  expect(result.message).toContain("exact username");
  expect(sends).toBe(0);
});

test("hyphenated usernames resolve an exact case-insensitive match", async () => {
  const e = await engine();
  const searched: string[] = [], recipients: string[] = [];
  Object.assign(e, {
    userIndex: { search: async (_identity: unknown, term: string) => {
      searched.push(term);
      return { Success: { users: [{ user_id: recipient.toUint8Array(), username: "Alice-Person" }] } };
    } },
    user: { sendMessageV2: async (_identity: unknown, _canister: string, to: Principal) => {
      recipients.push(to.toText()); return { Success: {} };
    }, initialState: async () => empty },
  });
  expect((await e.dmUser(" @alice-person ", "hello")).kind).toBe("sent");
  expect(searched).toEqual(["alice-person"]);
  expect(recipients).toEqual([recipient.toText()]);
});

test("signout during recipient lookup prevents submission", async () => {
  const e = await engine();
  const lookup = deferred<unknown>();
  let sends = 0;
  Object.assign(e, { userIndex: { search: () => lookup.promise }, user: { sendMessageV2: async () => { sends++; return { Success: {} }; } } });
  const sending = e.dmUser("alice", "hello");
  await e.signOut();
  lookup.resolve({ Success: { users: [{ user_id: recipient.toUint8Array(), username: "alice" }] } });
  expect((await sending).kind).toBe("error");
  expect(sends).toBe(0);
});

test("initial chat readiness shares a fetch and later subscriptions use its cache", async () => {
  const e = await engine();
  const response = deferred<typeof empty>();
  let reads = 0;
  Object.assign(e, { user: { initialState: () => { reads++; return response.promise; } } });
  const first = e.whenChatsReady(), second = e.whenChatsReady();
  await Promise.resolve(); await Promise.resolve();
  response.resolve(empty);
  await Promise.all([first, second]);
  expect(reads).toBe(1);
  await e.whenChatsReady();
  expect(reads).toBe(1);
});

test("failed initial reads are not an empty account and remain retryable", async () => {
  const e = await engine();
  let fails = true;
  Object.assign(e, { user: { initialState: async () => { if (fails) throw new Error("offline"); return empty; } } });
  await expect(e.whenChatsReady()).rejects.toThrow("offline");
  fails = false;
  await e.whenChatsReady();
  expect(e.listChats()).toEqual([]);
});

test("a late refresh cannot repopulate chats after signout", async () => {
  const e = await engine();
  const response = deferred<unknown>();
  Object.assign(e, { user: { initialState: () => response.promise } });
  const reading = e.refresh();
  await e.signOut();
  response.resolve({ Success: { direct_chats: { summaries: [{ them: recipient.toUint8Array() }] } } });
  await reading;
  expect(e.whoami().status).toBe("logged_out");
  expect(e.listChats()).toEqual([]);
});

test("protocol errors are surfaced for directories, users and messages", async () => {
  const e = await engine();
  Object.assign(e, {
    groupIndex: { exploreGroups: async () => ({ Error: [1, "directory unavailable"] }), exploreCommunities: async () => ({ Error: [1, "directory unavailable"] }) },
    userIndex: { search: async () => ({ Error: [1, "search unavailable"] }) },
    user: { events: async () => ({ Error: [1, "messages unavailable"] }) },
    routes: new Map([["direct:aaaaa-aa", { kind: "direct", them: "aaaaa-aa", canister: "2vxsx-fae", latestEventIndex: 1 }]]),
  });
  await expect(e.exploreGroups()).rejects.toThrow("directory unavailable");
  await expect(e.exploreCommunities()).rejects.toThrow("directory unavailable");
  await expect(e.search("alice")).rejects.toThrow("search unavailable");
  await expect(e.readMessages("direct:aaaaa-aa")).rejects.toThrow("messages unavailable");
  await expect(e.readMessages("missing")).rejects.toThrow("Unknown OpenChat chat");
});

test("a late email response cannot restore pending credentials after signout", async () => {
  const e = await engine(false);
  const started = deferred<void>(), response = deferred<unknown>();
  Object.assign(e, { sie: { generateMagicLink: () => { started.resolve(); return response.promise; } } });
  e.signInStart("owner@example.com");
  await started.promise;
  await e.signOut();
  response.resolve({ kind: "success", userKey: new Uint8Array([1]), expiration: BigInt(Date.now() + 60_000) * 1_000_000n, code: "123" });
  await Promise.resolve(); await Promise.resolve();
  expect(e.signInStatus().phase).toBe("idle");
  expect(await (await keystore()).get(KEYS.pendingEmail)).toBeUndefined();
});

test("replacing an in-flight email request keeps the current email result", async () => {
  const e = await engine(false);
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const first = deferred<unknown>(), second = deferred<unknown>();
  Object.assign(e, { sie: { generateMagicLink: (_identity: unknown, email: string) => {
    if (email === "first@example.com") { firstStarted.resolve(); return first.promise; }
    secondStarted.resolve(); return second.promise;
  } } });
  e.signInStart("first@example.com"); await firstStarted.promise;
  e.signInStart("second@example.com"); await secondStarted.promise;
  const success = { kind: "success", userKey: new Uint8Array([1]), expiration: BigInt(Date.now() + 60_000) * 1_000_000n, code: "123" };
  second.resolve(success); first.resolve(success);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(e.signInStatus()).toMatchObject({ phase: "ready", email: "second@example.com" });
  expect((await (await keystore()).get<{ email: string }>(KEYS.pendingEmail))?.email).toBe("second@example.com");
});

test("sign-in polls share the account check and signout invalidates its result", async () => {
  const e = await engine(false);
  const called = deferred<void>(), response = deferred<unknown>();
  let queries = 0, registrations = 0;
  Object.assign(e, {
    pendingOcIdentity: identity,
    userIndex: { currentUser: () => { queries++; called.resolve(); return response.promise; } },
    lui: { registerUser: async () => { registrations++; return "Success"; } },
  });
  const first = e.signInPoll("owner"), second = e.signInPoll("owner");
  expect(first).toBe(second);
  await called.promise; await e.signOut();
  response.resolve({ Success: { user_id: recipient.toUint8Array(), username: "owner" } });
  expect((await first).status).toBe("pending");
  expect(e.whoami().status).toBe("logged_out");
  expect(queries).toBe(1); expect(registrations).toBe(0);
});

test("an account lookup error cannot trigger new-account registration", async () => {
  const e = await engine(false);
  let registrations = 0;
  Object.assign(e, {
    pendingOcIdentity: identity,
    userIndex: { currentUser: async () => ({ Error: [1, "registry unavailable"] }) },
    lui: { registerUser: async () => { registrations++; return "Success"; } },
  });
  const result = await e.signInPoll("owner");
  expect(result.status).toBe("error"); expect(result.message).toContain("registry unavailable"); expect(registrations).toBe(0);
});

test("malformed magic-link percent encoding returns an error result", async () => {
  const e = await engine(false);
  expect((await e.signInComplete("m=%ZZ&s1=signature")).ok).toBe(false);
});
