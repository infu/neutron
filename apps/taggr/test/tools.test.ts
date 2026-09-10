import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import {
  normalizeToolDescriptor,
  validateToolArguments,
  type JsonObject,
  type JsonValue,
  type MsgBusToolDescriptor,
} from "neutron-tools/src/protocol.ts";
// Wallet's contract, asserted against Wallet's own published schema.
import { walletFundingInputSchema } from "../../wallet/src/funding.ts";
import { REACTIONS, DOWNVOTE_REACTION_ID } from "../src/model.ts";
import { setTaggrTransport, type TaggrTransport } from "../src/taggr_api.ts";

/**
 * Loads the resident background with the SDK stubbed, so every descriptor it
 * registers can be run through the kernel's own `normalizeToolDescriptor`.
 *
 * This is the check that was missing when a tool description carrying 🏴‍☠️ and
 * ❤️ was rejected for the zero-width joiner and variation selectors they
 * contain: `exposeTool` threw during module evaluation, so every tool declared
 * after it — the whole `ui_*` family the tile depends on — never registered,
 * and the tile could only report "Unknown tool 'ui_settings'".
 */
type ToolHandler = (
  args: JsonObject,
  context: { caller?: { appId?: string }; agentMode?: boolean; signal?: AbortSignal; kernel?: { callTool: (call: OutboundCall) => Promise<JsonValue> } },
) => Promise<JsonValue>;

const registered = new Map<string, MsgBusToolDescriptor>();
const handlers = new Map<string, ToolHandler>();

/** Outbound cross-app calls the background makes; the tests decide the reply. */
type OutboundCall = { target: string; name: string; arguments: JsonObject };
const outbound: OutboundCall[] = [];
let answerOutbound: (call: OutboundCall) => JsonValue | Promise<JsonValue> = () => {
  throw new Error("no cross-app reply configured");
};

beforeAll(async () => {
  // The background reads its identity out of the persistent origin's storage.
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => void backing.delete(key),
      setItem: (key: string, value: string) => void backing.set(key, value),
    } satisfies Storage,
  });

  await mock.module("neutron-tools/app", () => ({
    exposeTool: (
      name: string,
      options: Omit<MsgBusToolDescriptor, "name">,
      handler: ToolHandler,
    ): void => {
      registered.set(name, { name, ...options } as MsgBusToolDescriptor);
      handlers.set(name, handler);
    },
    callTool: async (): Promise<JsonValue> => { throw new Error("Ambient authority must not fund registration"); },
    querySelf: async () => ({ secret_key: new Uint8Array(32).fill(7), revision: "1", created_at: "1", updated_at: "1" }),
    updateSelf: async (_method: string, args: unknown[]) => ({
      secret_key: new Uint8Array(32).fill(7),
      canister_id: (args[0] as { canister_id?: string }).canister_id,
      domain: (args[0] as { domain?: string | null }).domain ?? null,
      revision: "2", created_at: "1", updated_at: "2",
    }),
    publishAppStateChange: async () => undefined,
  }));

  await import("../src/service.ts");
});

describe("tool descriptors", () => {
  test("the background registers every tool", () => {
    expect([...registered.keys()].sort()).toEqual([
      "taggr_feed",
      "taggr_post",
      "taggr_react",
      "taggr_realms",
      "taggr_search",
      "taggr_status",
      "taggr_tags",
      "taggr_thread",
      "taggr_user",
      "taggr_user_posts",
      "ui_add_post",
      "ui_configure",
      "ui_identity",
      "ui_read",
      "ui_register",
      "ui_register_with_icp",
      "ui_registration_quote",
      "ui_settings",
      "ui_validate_username",
      "ui_write",
    ]);
  });

  test("every descriptor passes the kernel's own validator", () => {
    for (const [name, descriptor] of registered) {
      expect(() => normalizeToolDescriptor(descriptor), `${name} is invalid`).not.toThrow();
    }
  });

  test("no title or description carries a joiner or variation selector", () => {
    // `normalizeUntrustedText` rejects \p{Cf} and default-ignorable code points,
    // which is what most composed emoji are built from.
    const prohibited = new RegExp(
      "[\\u0000-\\u001f\\u007f-\\u009f\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Zl}\\p{Zp}]",
      "u",
    );
    for (const [name, descriptor] of registered) {
      expect(prohibited.test(descriptor.title ?? ""), `${name} title`).toBe(false);
      expect(prohibited.test(descriptor.description ?? ""), `${name} description`).toBe(false);
    }
  });

  test("the reaction tool still names every reaction id it accepts", () => {
    const description = registered.get("taggr_react")?.description ?? "";
    for (const reaction of REACTIONS) {
      expect(description, `reaction ${reaction.id}`).toContain(String(reaction.id));
    }
    expect(description).toContain(String(DOWNVOTE_REACTION_ID));
  });

  test("the tile-facing tools are hidden from other apps and the agent ones are not", () => {
    for (const [name, descriptor] of registered) {
      const visibility = (descriptor.annotations as Record<string, unknown> | undefined)?.[
        "neutron:visibility"
      ];
      expect(visibility, name).toBe(name.startsWith("ui_") ? "same_app" : undefined);
    }
  });

  test("every tool the tile calls is registered", () => {
    // `src/tile_client.ts` names these; a rename on either side breaks the app
    // at runtime with nothing but "Unknown tool".
    for (const name of [
      "ui_read",
      "ui_write",
      "ui_add_post",
      "ui_settings",
      "ui_configure",
      "ui_identity",
      "ui_validate_username",
      "ui_register",
      "ui_registration_quote",
      "ui_register_with_icp",
    ]) {
      expect(registered.has(name), name).toBe(true);
    }
  });
});

/**
 * The Wallet seam, driven through the real `ui_register_with_icp` handler.
 *
 * Wallet's `wallet_fund_v1` carries the `provider_once` consent annotation: the
 * kernel suspends this call, opens Wallet's own tile, and Wallet decides. This
 * app only names a destination and an amount, so what has to hold is that it
 * names the right ones, spends nothing when Taggr says the invoice is already
 * paid, and never reports an account it did not create.
 */
describe("registering by paying Taggr's invoice through Wallet", () => {
  const OWN_TILE = {
    caller: { appId: "taggr", role: "tile" }, agentMode: false,
    kernel: { callTool: async (call: OutboundCall): Promise<JsonValue> => {
      outbound.push(call);
      return answerOutbound(call);
    } },
  };

  /** Answers Taggr's non-Candid endpoints with the raw JSON it really returns. */
  const stubTaggr = (replies: Record<string, string | ((payload: string) => string)>): string[] => {
    const seen: string[] = [];
    const answer = async (method: string, payload: string): Promise<string> => {
      seen.push(method);
      const reply = replies[method];
      if (reply === undefined) throw new Error(`unstubbed Taggr method: ${method}`);
      return typeof reply === "function" ? reply(payload) : reply;
    };
    setTaggrTransport({
      query: answer,
      update: answer,
      addPost: async () => {
        throw new Error("not used here");
      },
    } satisfies TaggrTransport);
    return seen;
  };

  const UNPAID = JSON.stringify({ Ok: { e8s: 1_234_567, paid_e8s: 0, paid: false } });
  const PAID = JSON.stringify({ Ok: { e8s: 1_234_567, paid_e8s: 1_234_567, paid: true } });
  const quotedThenSettled = (payload: string): string => payload === "0" ? UNPAID : PAID;
  // `user` is a query and answers with the record itself, not a `Result`.
  const ACCOUNT = JSON.stringify({
    id: 7,
    name: "alice",
    principal: "2vxsx-fae",
    followers: [],
    followees: [],
    realms: [],
  });

  const transferred = (call: OutboundCall): JsonValue => ({
    status: "transferred",
    commandId: `taggr:${call.arguments.requestId as string}`,
    blockIndex: "42",
    duplicate: false,
    message: null,
  });

  const register = (name = "alice"): Promise<JsonValue> =>
    handlers.get("ui_register_with_icp")!({ name }, OWN_TILE);

  beforeEach(() => {
    outbound.length = 0;
    answerOutbound = () => {
      throw new Error("no cross-app reply configured");
    };
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith("taggr.registration-funding.v1:")) localStorage.removeItem(key);
    }
  });

  test("asks Wallet to fund Taggr's own invoice account for this identity", async () => {
    stubTaggr({
      user: `${JSON.stringify(null)}`,
      mint_credits_with_icp: quotedThenSettled,
      create_user: JSON.stringify({ Ok: null }),
    });
    answerOutbound = transferred;

    const result = (await register()) as Record<string, JsonValue>;
    expect(result.registered).toBe(true); // create_user success remains authoritative
    expect(result.blockIndex).toBe("42");

    expect(outbound).toHaveLength(1);
    const call = outbound[0]!;
    expect(call.target).toBe("app:wallet:background");
    expect(call.name).toBe("wallet_fund_v1");
    // The amount is Taggr's, not this app's.
    expect(call.arguments.amountAtoms).toBe("1234567");
    expect(call.arguments.ledger).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
    // And it is a request Wallet will actually accept.
    expect(() =>
      validateToolArguments(
        { name: "wallet_fund_v1", inputSchema: walletFundingInputSchema } as never,
        call.arguments as never,
      ),
    ).not.toThrow();

    // The destination is Taggr's canister with this installation's own
    // subaccount, which is the only account whose payment Taggr will credit.
    const quote = (await handlers.get("ui_registration_quote")!({}, OWN_TILE)) as Record<
      string,
      JsonValue
    >;
    expect((call.arguments.route as Record<string, JsonValue>).to).toBe(quote.account);
  });

  test("settles the invoice before creating the account", async () => {
    const seen = stubTaggr({
      user: `${JSON.stringify(null)}`,
      mint_credits_with_icp: quotedThenSettled,
      create_user: JSON.stringify({ Ok: null }),
    });
    answerOutbound = transferred;
    await register();

    // A funded balance is not yet a paid invoice: `create_user` checks the
    // invoice, so the settling call has to happen between the two.
    expect(seen.filter((method) => method === "mint_credits_with_icp")).toHaveLength(2);
    expect(seen.indexOf("create_user")).toBeGreaterThan(seen.lastIndexOf("mint_credits_with_icp"));
  });

  test("spends nothing when Taggr already holds a paid invoice", async () => {
    stubTaggr({
      user: `${JSON.stringify(null)}`,
      mint_credits_with_icp: PAID,
      create_user: JSON.stringify({ Ok: null }),
    });
    await register();
    expect(outbound).toHaveLength(0);
  });

  test("spends nothing when the account already exists", async () => {
    stubTaggr({ user: ACCOUNT });
    const result = (await register()) as Record<string, JsonValue>;
    expect(result).toEqual({ registered: true, step: "already registered", blockIndex: null });
    expect(outbound).toHaveLength(0);
  });

  test("stops at a decision that was not a completed transfer", async () => {
    stubTaggr({ user: `${JSON.stringify(null)}`, mint_credits_with_icp: UNPAID });
    answerOutbound = (call) => ({
      status: "rejected",
      commandId: `taggr:${call.arguments.requestId as string}`,
      blockIndex: null,
      duplicate: false,
      message: "Not enough ICP",
    });
    // Wallet's own reason, and no `create_user` — an unstubbed method here would
    // throw a different message.
    await expect(register()).rejects.toThrow("Not enough ICP");
  });

  test("refuses a reply that answers some other funding request", async () => {
    stubTaggr({ user: `${JSON.stringify(null)}`, mint_credits_with_icp: UNPAID });
    answerOutbound = () => ({
      status: "transferred",
      commandId: "taggr:00000000000000000000000000000000",
      blockIndex: "42",
      duplicate: false,
      message: null,
    });
    await expect(register()).rejects.toThrow(/different funding request/);
  });

  test("explains a Wallet that is not installed", async () => {
    stubTaggr({ user: `${JSON.stringify(null)}`, mint_credits_with_icp: UNPAID });
    answerOutbound = () => {
      throw new Error("Unknown tool 'wallet_fund_v1' on 'app:wallet:background'");
    };
    await expect(register()).rejects.toThrow(/Wallet is not installed/);
  });

  test("lost Wallet replies retain the exact request across background remount", async () => {
    stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    answerOutbound = () => { throw new Error("reply interrupted"); };
    await expect(register()).rejects.toThrow("Saved payment request");
    const original = structuredClone(outbound[0]!.arguments);
    // Reload only the resident module; the persistent browser store outlives it.
    await import(new URL("../src/service.ts", import.meta.url).href + "?funding-remount");
    stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    answerOutbound = transferred;
    expect((await register() as JsonObject).registered).toBe(true);
    expect(outbound).toHaveLength(2);
    expect(outbound[1]!.arguments).toEqual(original);
  });

  test("pending Wallet outcomes keep their request instead of paying with a new id", async () => {
    stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    answerOutbound = (call) => ({ status: "pending", commandId: `taggr:${call.arguments.requestId}`, blockIndex: null, message: null });
    await expect(register()).rejects.toThrow("will be reused");
    const original = structuredClone(outbound[0]!.arguments);
    answerOutbound = transferred;
    await register();
    expect(outbound[1]!.arguments).toEqual(original);
  });

  test("settlement retry never repeats a confirmed Wallet transfer", async () => {
    stubTaggr({ user: "null", mint_credits_with_icp: (payload) => payload === "0" ? UNPAID : '{"Err":"settlement unavailable"}' });
    answerOutbound = transferred;
    await expect(register()).rejects.toThrow("settlement unavailable");
    expect(outbound).toHaveLength(1);
    stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    expect((await register() as JsonObject).registered).toBe(true);
    expect(outbound).toHaveLength(1);
  });

  test("an unpaid settlement result cannot create an account or pay again", async () => {
    const seen = stubTaggr({ user: "null", mint_credits_with_icp: UNPAID });
    answerOutbound = transferred;
    await expect(register()).rejects.toThrow("has not settled");
    await expect(register()).rejects.toThrow("has not settled");
    expect(outbound).toHaveLength(1);
    expect(seen).not.toContain("create_user");
  });

  test("concurrent registration clicks share the same Wallet handoff", async () => {
    stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    answerOutbound = async (call) => { began(); await waiting; return transferred(call); };
    const first = register();
    const second = register();
    await started;
    expect(outbound).toHaveLength(1);
    release();
    expect(await first).toEqual(await second);
    expect(outbound).toHaveLength(1);
  });

  test("a changed deployment cannot receive the original registration continuation", async () => {
    const seen = stubTaggr({ user: "null", domains: "[]", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    answerOutbound = async (call) => { began(); await waiting; return transferred(call); };
    const first = register();
    const rejected = first.then(() => null, (error: unknown) => error);
    await started;
    await handlers.get("ui_configure")!({ canister: "ryjl3-tyaaa-aaaaa-aaaba-cai", domain: null }, OWN_TILE);
    release();
    expect(String(await rejected)).toContain("account or deployment changed");
    expect(seen).not.toContain("create_user");
    await handlers.get("ui_configure")!({ canister: "6qfxa-ryaaa-aaaai-qbhsq-cai", domain: null }, OWN_TILE);
    await register();
    expect(outbound).toHaveLength(1);
  });

  test("confirmed registration remains successful when journal cleanup fails", async () => {
    const seen = stubTaggr({ user: "null", mint_credits_with_icp: quotedThenSettled, create_user: '{"Ok":null}' });
    answerOutbound = transferred;
    const remove = localStorage.removeItem;
    localStorage.removeItem = () => { throw new Error("storage unavailable"); };
    try {
      const result = await register() as JsonObject;
      expect(result.registered).toBe(true);
      expect(result.step).toContain("record is retained");
      expect(seen.filter((method) => method === "user")).toHaveLength(1);
    } finally {
      localStorage.removeItem = remove;
    }
  });

  test("failed local journal persistence stops before the Wallet handoff", async () => {
    stubTaggr({ user: "null", mint_credits_with_icp: UNPAID });
    answerOutbound = transferred;
    const set = localStorage.setItem;
    localStorage.setItem = () => { throw new Error("quota exceeded"); };
    try {
      await expect(register()).rejects.toThrow("could not be saved");
      expect(outbound).toHaveLength(0);
    } finally {
      localStorage.setItem = set;
    }
  });

  test("a failed domain lookup is retried instead of cached for the whole session", async () => {
    let attempts = 0;
    const canonical = "6qfxa-ryaaa-aaaai-qbhsq-cai.icp0.io";
    stubTaggr({ domains: () => {
      attempts++;
      if (attempts === 1) throw new Error("temporarily offline");
      return JSON.stringify({ [canonical]: { max_downvotes: 5, sub_config: { BlackListedRealms: [] } } });
    } });
    await handlers.get("ui_configure")!({ canister: "6qfxa-ryaaa-aaaai-qbhsq-cai", domain: null }, OWN_TILE);
    const settings = await handlers.get("ui_settings")!({}, OWN_TILE) as JsonObject;
    expect(settings.domain).toBe(canonical);
    expect(settings.domains).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  test("agent search identifies each result target and returns the actual snippet", async () => {
    stubTaggr({ search: JSON.stringify([
      { id: 42, user_id: 7, result: "post", relevant: "actual matching text", generic_id: "" },
      { id: 8, user_id: 0, result: "user", relevant: "alice", generic_id: "" },
      { id: 0, user_id: 0, result: "realm", relevant: "topic", generic_id: "TOPIC" },
      { id: 0, user_id: 0, result: "tag", relevant: "icp", generic_id: "" },
    ]) });
    const result = await handlers.get("taggr_search")!({ query: "topic" }, OWN_TILE) as JsonObject;
    const entries = result.results as JsonObject[];
    expect(entries[0]).toMatchObject({ kind: "post", postId: 42, userId: 7, snippet: "actual matching text" });
    expect(entries[1]).toMatchObject({ kind: "user", postId: null, userId: 8 });
    expect(entries[2]).toMatchObject({ kind: "realm", postId: null, realm: "TOPIC" });
    expect(entries[3]).toMatchObject({ kind: "tag", postId: null, tag: "icp" });
  });

  test("is closed to other apps and to the agent", async () => {
    stubTaggr({ user: ACCOUNT });
    for (const context of [
      { caller: { appId: "other", role: "background" } },
      { caller: { appId: "taggr", role: "tile" }, agentMode: true },
    ]) {
      await expect(
        handlers.get("ui_register_with_icp")!({ name: "alice" }, context),
      ).rejects.toThrow(/only to this app's own tile/);
      await expect(handlers.get("ui_registration_quote")!({}, context)).rejects.toThrow(
        /only to this app's own tile/,
      );
    }
    expect(outbound).toHaveLength(0);
  });
});
