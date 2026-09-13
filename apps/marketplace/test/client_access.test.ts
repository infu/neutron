import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import type { Identity } from "@dfinity/agent";
import type { MsgBusToolContext } from "neutron-tools/app";
import type { StoredState } from "../src/store.ts";
import type { Info, WireApp, WireCandidate, WireChannelApp, WireChannelMode } from "../src/protocol.ts";

// Exercise the real client state machine; only its network/signing boundaries
// are fixtures. Module substitutions must not escape into other app suites.
if (process.env.NEUTRON_MARKETPLACE_CLIENT_ACCESS_CHILD !== "1") {
  test("Marketplace automatically restores this Neutron's permanent read access", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_CLIENT_ACCESS_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const OWNER = Principal.fromText("3rurp-vyaaa-aaaay-aacua-cai");
  const PROTOCOL = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const OTHER_PROTOCOL = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  const DELEGATE = Principal.selfAuthenticating(new Uint8Array(65).fill(19));
  const SEED = new Uint8Array(32).fill(7);
  const accessIdentity = { getPrincipal: () => DELEGATE } as Identity;
  type Authorization = "missing" | "required" | "active" | "revoked";
  type Deferred = { promise: Promise<void>; resolve: () => void };
  function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  let state: StoredState;
  let authorization: Map<string, Authorization>;
  let failEarnings: boolean;
  let waitEarnings: Deferred | null;
  let waitReserve: { canister: string; gate: Deferred } | null;
  let earningsEntered: Deferred, reserveEntered: Deferred;
  let installed: string[], failInstalled: boolean, waitInstalled: Deferred | null, installedEntered: Deferred;
  let appOverrides: Map<string, Partial<WireApp>>;
  let preferences: { betaEnabled: boolean; revision: string }, includeBetaOnly: boolean;
  let waitCatalog: Deferred | null, catalogEntered: Deferred;
  const calls = {
    stateReads: [] as string[],
    localWrites: [] as Array<{ method: string; args: unknown[] }>,
    access: [] as Array<{ canister: string; innerPrincipal: string; kernel: unknown }>,
    agents: [] as Array<{ canister: string; identity: string | null }>,
    queries: [] as Array<{ canister: string; method: string; args: unknown[] }>,
    reservations: [] as string[],
    updates: [] as Array<{ canister: string; method: string; args: Array<{ browser: Principal; active: boolean; feeVersion: bigint }>; cycles: bigint }>,
    installedReads: [] as string[],
    appDescriptions: [] as string[],
    preferenceReads: [] as string[],
  };
  const rawState = () => ({ seed: state.seed, canister: state.canisterId ? [state.canisterId] : [], host: state.host, owner: state.owner, revision: state.revision });
  const context = (signal = new AbortController().signal) => ({ signal, kernel: {
    querySelf: async (method: string) => {
      calls.stateReads.push(method);
      if (method !== "marketplace_state") throw new Error(`Unexpected self query ${method}`);
      return rawState();
    },
    updateSelf: async (method: string, args: unknown[]) => {
      calls.localWrites.push({ method, args });
      if (method === "marketplace_initialize") state = { ...state, seed: new Uint8Array(args[0] as Uint8Array), revision: state.revision + 1 };
      else if (method === "marketplace_configure") {
        const input = args[0] as { canister: string; host: string };
        state = { ...state, canisterId: input.canister, host: input.host, revision: state.revision + 1 };
      } else throw new Error(`Unexpected self update ${method}`);
      return rawState();
    },
    listApps: async () => {
      calls.installedReads.push(state.owner);
      installedEntered.resolve();
      if (waitInstalled) await waitInstalled.promise;
      if (failInstalled) throw new Error("Kernel app list is temporarily unavailable");
      return { apps: installed.map(id => ({ id, description: `${id} description` })) };
    },
    describeApp: async (id: string) => {
      calls.appDescriptions.push(id);
      return { version: 100 };
    },
    listTools: async (target: string) => { expect(target).toBe("kernel"); return [{ name: "updates.preferences" }]; },
    callTool: async (request: unknown) => { expect(request).toEqual({ target: "kernel", name: "updates.preferences", arguments: {} }); calls.preferenceReads.push(preferences.revision); return { ...preferences }; },
  } }) as unknown as MsgBusToolContext;
  const info = (canister: string): Info => ({
    version: 1n, canister: Principal.fromText(canister), tokens: [],
    fees: { version: 1n, updateBase: 100n, updateByte: 2n, storageByteYear: 3n, purchase: 200n, withdraw: 200n, grant: 200n, xrc: 300n },
    referralTerms: { version: 1n, discountBps: 1000n, affiliateBps: 3000n, developerBps: 3000n },
  });
  const app = (appId: string): WireApp => ({ appId, title: appId, summary: `${appId} summary`, description: `${appId} description`, publisher: OWNER,
    priceUsdMicros: 0n, revision: 1n, version: [101n], iconUrl: [], screenshots: [], iconArtifact: [], screenshotArtifacts: [], ratingCount: 0n, ratingTotal: 0n,
    ...(appId === "notes" ? { acquisitionCounts: [{ free: 9007199254740993n, paid: 7n }] as [{ free: bigint; paid: bigint }] } : {}), owned: false, visible: true, ...appOverrides.get(appId) });
  function channelApp(appId: string, mode: WireChannelMode): WireChannelApp {
    const value = app(appId), betaOnly = appId === "beta_only";
    const stable: WireCandidate = { id: 1010n, appId, version: 101n, publisher: OWNER, digest: new Uint8Array(32).fill(1), sourceDigest: [], state: { approved: null }, createdAtNs: 1n };
    const beta: WireCandidate = { ...stable, id: 1020n, version: 102n, digest: new Uint8Array(32).fill(2) };
    const selected = "beta" in mode ? beta : betaOnly ? null : stable;
    return { app: { ...value, version: selected ? [selected.version] : [], visible: value.visible && selected !== null }, stableHead: { revision: betaOnly ? 0n : 1n, candidate: betaOnly ? [] : [stable], releaseNotes: "Stable notes" }, betaHead: { revision: 2n, candidate: [beta], releaseNotes: "Beta notes" }, selected: selected ? [selected] : [], selectedChannel: selected ? [mode] : [] };
  }
  const actualTransport = await import("../src/transport.ts");
  mock.module("../src/transport.ts", () => ({
    ...actualTransport,
    makeAgent: async (saved: StoredState, identity?: Identity) => {
      calls.agents.push({ canister: saved.canisterId!, identity: identity?.getPrincipal().toText() ?? null });
      return { identity };
    },
    makeTransport: ({ canisterId }: { canisterId: string }) => ({
      query: async (method: string, args: unknown[] = []) => {
        calls.queries.push({ canister: canisterId, method, args });
        if (method === "marketplace_info") return info(canisterId);
        if (method === "earnings_query") {
          earningsEntered.resolve();
          if (waitEarnings) await waitEarnings.promise;
          if (failEarnings) throw new Error("Certified query is temporarily unavailable");
          const mode = authorization.get(canisterId) ?? "missing";
          if (mode !== "active") return { err: { code: mode === "required" ? "authentication_required" : mode === "revoked" ? "delegate_revoked" : "delegate_required", message: mode === "revoked" ? "Read access was revoked" : "Read access is not registered" } };
          return { ok: { credits: [], referral: [] } };
        }
        if (method === "catalog_query_v2") {
          const request = args[0] as { mode: WireChannelMode };
          const apps = ["kernel", "notes", "marketplace", "wallet", ...(includeBetaOnly ? ["beta_only"] : [])].map(id => channelApp(id, request.mode)).filter(value => value.app.visible && value.selected.length > 0);
          catalogEntered.resolve();
          if (waitCatalog) await waitCatalog.promise;
          return { ok: { apps, nextCursor: [{ generation: 3n, offset: 24n }], asOfNs: 1_789_056_000_000_000_000n, refreshing: false } };
        }
        if (method === "app_detail") return { ok: { app: app(args[0] as string), candidate: [], audit: [], rating: [] } };
        if (method === "app_detail_v2") { const request = args[0] as { appId: string; mode: WireChannelMode }; return { ok: { release: channelApp(request.appId, request.mode), audit: [], rating: [] } }; }
        if (method === "rating_summary_v2") return { ok: { one: 0n, two: 0n, three: 0n, four: 0n, five: 0n, count: 0n, total: 0n, complete: true } };
        if (method === "version_comments_v2") return { ok: { comments: [], nextCursor: [], ownComment: [] } };
        if (method === "library_query_v2") { const request = args[0] as { mode: WireChannelMode }; return { ok: { apps: ["notes", "wallet", ...(includeBetaOnly ? ["beta_only"] : [])].map(id => channelApp(id, request.mode)).filter(value => value.app.owned), nextCursor: [] } }; }
        throw new Error(`Unexpected protocol query ${method}`);
      },
      reserve: async () => {
        calls.reservations.push(canisterId);
        reserveEntered.resolve();
        if (waitReserve?.canister === canisterId) await waitReserve.gate.promise;
      },
      update: async (method: string, args: Array<{ browser: Principal; active: boolean; feeVersion: bigint }>, cycles: bigint) => {
        calls.updates.push({ canister: canisterId, method, args, cycles });
        if (method !== "read_delegate_set") throw new Error(`Unexpected protocol update ${method}`);
        if (args[0]?.browser.toText() !== DELEGATE.toText() || args[0]?.active !== true) throw new Error("Registration did not use the permanent delegated principal");
        authorization.set(canisterId, "active");
        return { ok: null };
      },
    }),
  }));
  mock.module("../src/read_access.ts", () => ({
    readAccess: async (kernel: unknown, saved: StoredState, inner: Ed25519KeyIdentity) => {
      calls.access.push({ canister: saved.canisterId!, innerPrincipal: inner.getPrincipal().toText(), kernel });
      return accessIdentity;
    },
  }));
  const { initialize, connect, configured, clearClient, protocolClient } = await import("../src/client.ts");
  beforeEach(() => {
    clearClient();
    state = { seed: new Uint8Array(SEED), canisterId: PROTOCOL.toText(), host: "https://icp-api.io", owner: OWNER.toText(), revision: 1 };
    authorization = new Map(); failEarnings = false; waitEarnings = null; waitReserve = null;
    earningsEntered = deferred(); reserveEntered = deferred();
    installed = []; failInstalled = false; waitInstalled = null; installedEntered = deferred(); appOverrides = new Map();
    preferences = { betaEnabled: false, revision: "0" }; includeBetaOnly = false; waitCatalog = null; catalogEntered = deferred();
    for (const entries of Object.values(calls)) entries.length = 0;
  });

  test("first open initializes its saved session key and registers the permanent principal automatically", async () => {
    state.seed = null;
    const ctx = context();
    const result = await initialize(ctx);
    expect(result).toMatchObject({ configured: true, connected: true, account: OWNER.toText(), canisterId: PROTOCOL.toText() });
    expect(result.connectionError).toBeUndefined();
    expect(calls.localWrites.map(call => call.method)).toEqual(["marketplace_initialize"]);
    expect(state.seed).toHaveLength(32);
    expect(calls.access).toHaveLength(1);
    expect(calls.access[0]?.kernel).toBe(ctx.kernel);
    expect(calls.access[0]?.innerPrincipal).not.toBe(DELEGATE.toText());
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.method).toBe("read_delegate_set");
    expect(calls.updates[0]?.args[0]?.browser.toText()).toBe(DELEGATE.toText());
    expect(calls.updates[0]?.args[0]?.feeVersion).toBe(1n);
    expect(calls.updates[0]!.cycles > 100n).toBe(true);
    expect(calls.agents.every(agent => agent.identity === DELEGATE.toText())).toBe(true);
  });

  test("reopening and reloading a registered account do not write another registration", async () => {
    const ctx = context();
    expect((await initialize(ctx)).connected).toBe(true);
    expect((await initialize(ctx)).connected).toBe(true);
    expect(calls.access).toHaveLength(1);
    clearClient();
    expect((await initialize(ctx)).connected).toBe(true);
    expect(calls.access).toHaveLength(2);
    expect(calls.updates).toHaveLength(1);
    expect(calls.reservations).toEqual([PROTOCOL.toText()]);
    expect(calls.localWrites).toEqual([]);
    expect(calls.access.every(access => access.innerPrincipal === Ed25519KeyIdentity.generate(SEED).getPrincipal().toText())).toBe(true);
  });

  test("a newly created browser session still reads through the existing permanent delegate", async () => {
    expect((await initialize(context())).connected).toBe(true);
    clearClient();
    state.seed = new Uint8Array(32).fill(8);
    expect((await initialize(context())).connected).toBe(true);
    expect(calls.access[0]?.innerPrincipal).not.toBe(calls.access[1]?.innerPrincipal);
    expect(calls.updates).toHaveLength(1);
    expect(calls.agents.every(agent => agent.identity === DELEGATE.toText())).toBe(true);
  });

  test("concurrent first-open calls register once", async () => {
    const gate = deferred(); waitEarnings = gate;
    const ctx = context();
    const pending = [initialize(ctx), initialize(ctx), connect(ctx)];
    await earningsEntered.promise;
    expect(calls.queries.filter(call => call.method === "earnings_query")).toHaveLength(1);
    expect(calls.updates).toHaveLength(0);
    gate.resolve();
    const results = await Promise.all(pending);
    expect(results.every(result => result.connected)).toBe(true);
    expect(calls.access).toHaveLength(1);
    expect(calls.reservations).toHaveLength(1);
    expect(calls.updates).toHaveLength(1);
  });

  test("a transient private read failure is recoverable and never treated as missing authorization", async () => {
    authorization.set(PROTOCOL.toText(), "active"); failEarnings = true;
    const ctx = context();
    const result = await initialize(ctx);
    expect(result).toMatchObject({ configured: true, connected: false, connectionError: "Certified query is temporarily unavailable" });
    expect(calls.reservations).toEqual([]);
    expect(calls.updates).toEqual([]);
    const publicCatalog = await (await protocolClient(ctx)).catalog({ tier: "free", window: "week", search: "" });
    expect(publicCatalog.items.map(app => app.id)).toEqual(["notes", "wallet"]);
    failEarnings = false;
    expect((await initialize(ctx)).connected).toBe(true);
    expect(calls.updates).toEqual([]);
  });

  test("automatic setup preserves explicit revocation; explicit Retry can restore it", async () => {
    authorization.set(PROTOCOL.toText(), "revoked");
    const ctx = context();
    expect(await initialize(ctx)).toMatchObject({ connected: false, connectionError: "Read access was revoked" });
    expect(calls.updates).toEqual([]);
    expect(calls.reservations).toEqual([]);
    expect((await connect(ctx)).connected).toBe(true);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]?.args[0]?.active).toBe(true);
  });

  test("an existing read delegate still requests current mutation access before its next update", async () => {
    authorization.set(PROTOCOL.toText(), "active");
    const ctx = context();
    expect((await initialize(ctx)).connected).toBe(true);
    expect(calls.reservations).toEqual([]);
    const client = await protocolClient(ctx);
    await client.update("read_delegate_set", { browser: DELEGATE, active: true });
    expect(calls.reservations).toEqual([PROTOCOL.toText()]);
    expect(calls.updates).toHaveLength(1);
  });

  test("revocation after a successful open is observed instead of trusting cached connected state", async () => {
    const ctx = context();
    expect((await initialize(ctx)).connected).toBe(true);
    authorization.set(PROTOCOL.toText(), "revoked");
    expect(await initialize(ctx)).toMatchObject({ connected: false, connectionError: "Read access was revoked" });
    expect(calls.updates).toHaveLength(1);
  });

  test("configuration change during permission setup cannot register or mark the old marketplace connected", async () => {
    const gate = deferred(); waitReserve = { canister: PROTOCOL.toText(), gate };
    const ctx = context();
    const oldSetup = initialize(ctx);
    await reserveEntered.promise;
    const changed = await configured(ctx, { canisterId: OTHER_PROTOCOL.toText(), host: "https://icp-api.io" });
    expect(changed).toMatchObject({ canisterId: OTHER_PROTOCOL.toText(), connected: false });
    const current = await initialize(ctx);
    expect(current).toMatchObject({ canisterId: OTHER_PROTOCOL.toText(), connected: true });
    gate.resolve();
    expect(await oldSetup).toMatchObject({ canisterId: OTHER_PROTOCOL.toText(), connected: false, connectionError: "Marketplace settings changed during setup. Retry using the current marketplace." });
    expect(calls.updates.map(call => call.canister)).toEqual([OTHER_PROTOCOL.toText()]);
    expect((await initialize(ctx)).connected).toBe(true);
    expect(calls.updates).toHaveLength(1);
  });

  test("unconfigured app does not initialize signing or request protocol access", async () => {
    state.canisterId = null;
    expect(await initialize(context())).toMatchObject({ configured: false, connected: false, canisterId: "" });
    expect(calls.access).toEqual([]);
    expect(calls.agents).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(calls.localWrites).toEqual([]);
  });

  test("store catalog hides system packages and preserves its server pagination cursor", async () => {
    const client = await protocolClient(context());
    const page = await client.catalog({ tier: "free", window: "month", search: "" });
    expect(page.items.map(app => app.id)).toEqual(["notes", "wallet"]);
    expect(page.items[0]).toMatchObject({ freeAcquisitions: "9007199254740993", paidPurchases: "7" });
    expect(page.items[1]!.freeAcquisitions).toBeUndefined();
    expect(page.items[1]!.paidPurchases).toBeUndefined();
    expect(page.nextCursor).toBe(JSON.stringify({ page: { generation: "3", offset: "24" }, releasePreferences: preferences }));
    await client.catalog({ tier: "free", window: "month", search: "", cursor: page.nextCursor! });
    expect(calls.queries.at(-1)).toMatchObject({ method: "catalog_query_v2", args: [{ request: { cursor: [{ generation: 3n, offset: 24n }], tier: { free: null }, window: { month: null } }, mode: { stable: null } }] });
    expect(calls.updates).toEqual([]);
  });

  for (const priceUsdMicros of [0n, 9000000n]) for (const owned of [false, true]) {
    test(`${priceUsdMicros === 0n ? "free" : "paid"} installed apps are recognized independently of ${owned ? "recorded" : "missing"} Marketplace ownership`, async () => {
      installed = ["notes"];
      appOverrides.set("notes", { priceUsdMicros, owned });
      appOverrides.set("wallet", { owned: true });
      const client = await protocolClient(context());
      const catalog = await client.catalog({ tier: priceUsdMicros === 0n ? "free" : "paid", window: "week", search: "" });
      expect(catalog.items[0]).toMatchObject({ id: "notes", priceUsdMicros: String(priceUsdMicros), owned, installed: true });
      expect(catalog.items[0]?.installedVersion).toBeUndefined();
      expect(catalog.items[1]).toMatchObject({ id: "wallet", owned: true, installed: false });
      expect(await client.detail("notes")).toMatchObject({ id: "notes", owned, installed: true });
      expect(calls.installedReads).toHaveLength(2);
      expect(calls.appDescriptions).toEqual([]);
      expect(calls.reservations).toEqual([]);
      expect(calls.updates).toEqual([]);
    });
  }

  test("concurrent catalog sections and details share one pending installed-app read", async () => {
    installed = ["notes", "wallet"];
    const gate = deferred(); waitInstalled = gate;
    const firstClient = await protocolClient(context()), secondClient = await protocolClient(context());
    const pending = [
      firstClient.catalog({ tier: "free", window: "week", search: "" }),
      secondClient.catalog({ tier: "paid", window: "week", search: "" }),
      secondClient.detail("notes"),
    ];
    await installedEntered.promise;
    expect(calls.installedReads).toHaveLength(1);
    gate.resolve();
    const [free, paid, detail] = await Promise.all(pending);
    expect(free).toMatchObject({ items: [{ installed: true }, { installed: true }] });
    expect(paid).toMatchObject({ items: [{ installed: true }, { installed: true }] });
    expect(detail).toMatchObject({ installed: true, owned: false });
    expect(calls.appDescriptions).toEqual([]);
  });

  test("a later listing read observes installation and uninstallation without keeping a cached snapshot", async () => {
    const client = await protocolClient(context());
    expect(await client.detail("notes")).toMatchObject({ installed: false, owned: false });
    installed = ["notes"];
    expect(await client.detail("notes")).toMatchObject({ installed: true, owned: false });
    installed = [];
    expect(await client.detail("notes")).toMatchObject({ installed: false, owned: false });
    expect(calls.installedReads).toHaveLength(3);
  });

  test("an unavailable installed-app read leaves status unknown and can be retried", async () => {
    installed = ["notes"]; failInstalled = true;
    appOverrides.set("notes", { owned: true });
    const client = await protocolClient(context());
    const catalog = await client.catalog({ tier: "free", window: "week", search: "" });
    expect(catalog.warning).toBe("Installed-app status is unavailable.");
    expect(catalog.items[0]?.installed).toBeUndefined();
    expect(catalog.items[0]?.owned).toBe(true);
    failInstalled = false;
    expect(await client.detail("notes")).toMatchObject({ owned: true, installed: true });
    expect(calls.updates).toEqual([]);
  });

  test("My Apps still contains only Marketplace acquisitions and retains installed versions", async () => {
    installed = ["notes", "wallet"];
    appOverrides.set("wallet", { owned: true });
    const client = await protocolClient(context());
    const library = await client.library();
    expect(library.items).toHaveLength(1);
    expect(library.items[0]).toMatchObject({ id: "wallet", owned: true, installedVersion: "100" });
    expect(calls.appDescriptions).toEqual(["wallet"]);
    expect(calls.updates).toEqual([]);
  });

  test("catalog, detail and library request the current stable or beta mode without resetting acquisition statistics", async () => {
    appOverrides.set("notes", { owned: true });
    const client = await protocolClient(context());
    for (const betaEnabled of [false, true]) {
      preferences = { betaEnabled, revision: betaEnabled ? "1" : "0" };
      const catalog = await client.catalog({ tier: "free", window: "week", search: "" });
      const detail = await client.detail("notes"), library = await client.library();
      const mode = betaEnabled ? "beta" : "stable", version = betaEnabled ? "102" : "101";
      for (const value of [catalog.items[0]!, detail, library.items[0]!]) {
        expect(value).toMatchObject({ id: "notes", version, channel: mode, owned: true, freeAcquisitions: "9007199254740993", paidPurchases: "7", releasePreferences: preferences });
        expect(value.releaseSelection).toMatchObject({ appId: "notes", version, channel: mode, candidateId: betaEnabled ? "1020" : "1010", revision: betaEnabled ? "2" : "1" });
      }
      expect(detail.releaseNotes).toBe(betaEnabled ? "Beta notes" : "Stable notes");
      const reads = calls.queries.filter(call => ["catalog_query_v2", "app_detail_v2", "library_query_v2"].includes(call.method)).slice(-3);
      const expectedMode: WireChannelMode = betaEnabled ? { beta: null } : { stable: null };
      expect(reads.map(call => (call.args[0] as { mode: WireChannelMode }).mode)).toEqual([expectedMode, expectedMode, expectedMode]);
      expect(calls.queries.filter(call => call.method === "version_comments_v2").at(-1)?.args[0]).toMatchObject({ appId: "notes", version: BigInt(version), candidateId: betaEnabled ? 1020n : 1010n, digest: new Uint8Array(32).fill(betaEnabled ? 2 : 1) });
    }
    expect(calls.updates).toEqual([]);
  });

  test("beta-only apps appear only in the opted-in catalog while retained acquisitions remain visible in My Apps", async () => {
    includeBetaOnly = true;
    appOverrides.set("beta_only", { owned: true });
    const client = await protocolClient(context());
    expect((await client.catalog({ tier: "free", window: "week", search: "" })).items.map(value => value.id)).toEqual(["notes", "wallet"]);
    expect((await client.library()).items).toMatchObject([{ id: "beta_only", owned: true, available: false, unavailableReason: "No stable release is currently available. Your ownership is retained." }]);
    preferences = { betaEnabled: true, revision: "1" };
    expect((await client.catalog({ tier: "free", window: "week", search: "" })).items.map(value => value.id)).toEqual(["notes", "wallet", "beta_only"]);
    expect((await client.library()).items).toMatchObject([{ id: "beta_only", owned: true, available: true, version: "102", channel: "beta" }]);
    expect(calls.updates).toEqual([]);
  });

  test("a preference change during a pending catalog read rejects its old selection before returning results", async () => {
    waitCatalog = deferred();
    const client = await protocolClient(context());
    const pending = client.catalog({ tier: "free", window: "week", search: "" });
    await catalogEntered.promise;
    preferences = { betaEnabled: true, revision: "1" };
    waitCatalog.resolve();
    await expect(pending).rejects.toThrow("Beta updates changed");
    waitCatalog = null;
    expect((await client.catalog({ tier: "free", window: "week", search: "" })).items[0]).toMatchObject({ version: "102", channel: "beta", releasePreferences: preferences });
    expect(calls.updates).toEqual([]);
  });

  for (const changed of [{ betaEnabled: true, revision: "1" }, { betaEnabled: false, revision: "2" }]) {
    test(`saved catalog cursors cannot cross preference ${JSON.stringify(changed)}`, async () => {
      const client = await protocolClient(context());
      const page = await client.catalog({ tier: "free", window: "week", search: "" });
      const before = calls.queries.length;
      preferences = changed;
      await expect(client.catalog({ tier: "free", window: "week", search: "", cursor: page.nextCursor! })).rejects.toThrow("Beta updates changed");
      expect(calls.queries).toHaveLength(before);
      expect(calls.updates).toEqual([]);
    });
  }
}
