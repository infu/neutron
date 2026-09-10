import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { MsgBusToolContext } from "neutron-tools/app";
import type { Fee } from "../src/protocol.ts";

if (process.env.NEUTRON_MARKETPLACE_INSTALL_TEST_CHILD !== "1") {
  test("installer preparation charges only the reviewed quote and recovers the original grant", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_INSTALL_TEST_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  type Data = Record<string, any>;
  const actualClient = await import("../src/client.ts");
  const OPERATION = "ab".repeat(16), OWNER = "3rurp-vyaaa-aaaay-aacua-cai", PROTOCOL = "233tv-xiaaa-aaaay-aacta-cai";
  const SETUP = "https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/install/original-grant/setup.json";
  let latestSetup: string;
  let afterReview: (() => void) | null, prepareGate: Promise<void> | null, prepareStarted: (() => void) | null, revisionReplyError: Error | null;
  let fee: Fee, state: { owner: string; canisterId: string }, prepareError: Error | null, installerError: Error | null, approved: boolean, reviewError: Error | null, counter: number;
  const stored = new Map<string, Uint8Array>(), events: string[] = [], reviews: Data[] = [], offers: Data[] = [], estimates: Data[] = [], updates: Data[] = [];
  const client = {
    get state() { return state; },
    estimateUpdate: async (name: string, request: Data) => { estimates.push({ name, request: structuredClone(request) }); events.push("estimate"); return structuredClone(fee); },
    update: async (name: string, request: Data, charged: Fee) => {
      updates.push({ name, request: structuredClone(request), fee: structuredClone(charged) }); events.push("prepare");
      prepareStarted?.(); if (prepareGate) await prepareGate;
      if (prepareError) throw prepareError;
      return { setupUrl: latestSetup };
    },
  };
  mock.module("../src/client.ts", () => ({ ...actualClient, protocolClient: async () => client, randomId: () => (++counter).toString(16).padStart(32, "0") }));
  const { quoteInstallation, installApplications, installationStatus, recentInstallations, markInstallationOpened, resumeInstallation } = await import("../src/install.ts");
  function context(mode: "owner" | "external" | "agent" = "owner", signal = new AbortController().signal): MsgBusToolContext {
    const isOwner = mode === "owner", isExternal = mode === "external";
    return {
      agentMode: mode === "agent", signal,
      caller: { appId: isOwner ? "marketplace" : isExternal ? "other_app" : "agent", role: isOwner || isExternal ? "tile" : "background", installationUid: "original-installation", endpoint: isOwner ? "app:marketplace:tile:main:instance:install" : isExternal ? "app:other_app:tile:main:instance:external" : "app:agent:background" },
      requestApproval: async (review: Data) => { events.push("agent-review"); reviews.push(review); if (reviewError) throw reviewError; afterReview?.(); },
      presentUserInterface: async (request: Data) => { events.push("external-review"); reviews.push(JSON.parse(request.arguments.reviewJson)); afterReview?.(); return { approved }; },
      kernel: {
        querySelf: async (name: string, args: any[]) => {
          if (name === "marketplace_drafts") {
            const request = args[0], matching = [...stored.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).filter(([id]) => !request.cursor || id > request.cursor);
            const rows = matching.slice(0, Number(request.limit));
            return { items: rows.map(([id, value]) => ({ id, value })), nextCursor: matching.length > rows.length ? rows.at(-1)![0] : null };
          }
          if (name !== "marketplace_draft") throw new Error(`Unexpected self query ${name}`);
          const value = stored.get(args[0]); return value ? [value] : [];
        },
        updateSelf: async (name: string, args: Array<{ id: string; value: Uint8Array; expected?: Uint8Array; revision?: string }>) => {
          const { id, value } = args[0]!;
          if (name === "marketplace_save_draft") {
            const existing = stored.get(id);
            if (existing && !Buffer.from(existing).equals(Buffer.from(value))) return { err: "Different saved intent" };
            stored.set(id, new Uint8Array(value)); events.push("save"); return { ok: id };
          }
          if (name === "marketplace_revise_draft") {
            if (!stored.has(id) || !Buffer.from(stored.get(id)!).equals(Buffer.from(args[0]!.expected!))) return { err: "The original intent changed" };
            stored.set(`history:${id}:${args[0]!.revision}`, new Uint8Array(stored.get(id)!));
            stored.set(id, new Uint8Array(value)); events.push("revise"); if (revisionReplyError) throw revisionReplyError; return { ok: id };
          }
          throw new Error(`Unexpected self update ${name}`);
        },
        callTool: async (call: Data) => {
          if (call.name === "marketplace_owner_review_v1") { events.push("owner-review"); reviews.push(JSON.parse(call.arguments.reviewJson)); return { approved }; }
          expect(call.target).toBe("kernel"); expect(call.name).toBe("apps.install_offer");
          offers.push(call); events.push("installer");
          if (installerError) throw installerError;
          return { accepted: true };
        },
      },
    } as unknown as MsgBusToolContext;
  }
  beforeEach(() => {
    fee = { feeVersion: 7n, processingCycles: 1100000000n, storageCycles: 900000000n, totalCycles: 2000000000n, processingBytes: 1024n, newStorageBytes: 512n };
    latestSetup = SETUP;
    state = { owner: OWNER, canisterId: PROTOCOL }; prepareError = null; installerError = null; reviewError = null; approved = true; counter = 0; afterReview = null; prepareGate = null; prepareStarted = null; revisionReplyError = null;
    stored.clear(); events.length = 0; reviews.length = 0; offers.length = 0; estimates.length = 0; updates.length = 0;
  });
  test("installation quote only estimates the selected original request", async () => {
    const quote = await quoteInstallation(context(), ["editor", "wallet"], OPERATION);
    expect(quote).toMatchObject({ operationId: OPERATION, appIds: ["editor", "wallet"], owner: OWNER, canisterId: PROTOCOL, cycles: { total: "2000000000" } });
    expect(estimates).toEqual([{ name: "install_prepare", request: { requestId: OPERATION, appIds: ["editor", "wallet"] } }]);
    expect(updates).toEqual([]); expect(stored.size).toBe(0); expect(offers).toEqual([]); expect(reviews).toEqual([]);
  });
  test("owner preparation returns the retained foreground handoff without background installer calls", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    const result = await installApplications(ctx, ["editor"], quote);
    expect(reviews).toEqual([]);
    expect(updates).toEqual([{ name: "install_prepare", request: { requestId: OPERATION, appIds: ["editor"] }, fee }]);
    expect(result).toMatchObject({ operationId: OPERATION, state: "pending", nextAction: "resume", installation: { operationId: OPERATION, appIds: ["editor"], setupUrl: SETUP, cycles: { total: "0" } } });
    expect(offers).toEqual([]);
    expect(events.indexOf("save")).toBeLessThan(events.indexOf("prepare"));
    expect(events.indexOf("prepare")).toBeLessThan(events.indexOf("revise"));
  });
  test("owner cannot prepare a charged install without an explicit quote", async () => {
    await expect(installApplications(context(), ["editor"])).rejects.toThrow();
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("external non-agent tile review prepares a foreground handoff without a background offer", async () => {
    const result = await installApplications(context("external"), ["editor", "wallet"]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "installation", quote: { appIds: ["editor", "wallet"], cycles: { total: "2000000000" } } });
    expect(events.indexOf("external-review")).toBeLessThan(events.indexOf("prepare"));
    expect(result).toMatchObject({ state: "pending", nextAction: "resume", installation: { appIds: ["editor", "wallet"], setupUrl: SETUP, cycles: { total: "0" } } });
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
    expect(events).not.toContain("agent-review"); expect(events).not.toContain("installer");
  });
  test("external non-agent review denial cannot spend preparation cycles", async () => {
    approved = false;
    await expect(installApplications(context("external"), ["editor"])).rejects.toThrow();
    expect(reviews).toHaveLength(1); expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("an invocation-scoped agent reviews the exact fee then opens Kernel with its context", async () => {
    const result = await installApplications(context("agent"), ["editor"]);
    expect(result).toMatchObject({ state: "complete", nextAction: "none" });
    expect(offers).toHaveLength(1);
    expect(offers[0]!.arguments).toEqual({ kind: "repository_setup_url", url: SETUP });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "installation", quote: { owner: OWNER, canisterId: PROTOCOL, appIds: ["editor"], cycles: { total: "2000000000" } } });
    expect(events.indexOf("agent-review")).toBeLessThan(events.indexOf("prepare"));
    expect(events).not.toContain("external-review"); expect(events).not.toContain("owner-review");
  });
  test("agent permission rejection stops before any charged update", async () => {
    reviewError = new Error("Rejected exact install request");
    await expect(installApplications(context("agent"), ["editor"])).rejects.toThrow("Rejected");
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("changed selection cannot reuse a reviewed quote", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    await expect(installApplications(ctx, ["editor", "wallet"], quote)).rejects.toThrow();
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("changed marketplace or owning Neutron cannot reuse the fee review", async () => {
    for (const field of ["owner", "canisterId"] as const) {
      state = { owner: OWNER, canisterId: PROTOCOL };
      const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
      state[field] = "rrkah-fqaaa-aaaaa-aaaaq-cai";
      await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow();
    }
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("changed actual charge is rejected before preparation", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    fee = { ...fee, processingCycles: fee.processingCycles + 1n, totalCycles: fee.totalCycles + 1n };
    await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow();
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("displayed fee cannot be reduced while retaining different charged terms", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    await expect(installApplications(ctx, ["editor"], { ...quote, cycles: { ...quote.cycles, total: "1" } })).rejects.toThrow();
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("a lost preparation reply retains the original request for recovery", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    prepareError = new Error("Preparation reply interrupted");
    await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow("interrupted");
    expect(stored.size).toBeGreaterThan(0); expect(offers).toEqual([]);
    expect([...stored.values()].some(value => new TextDecoder().decode(value).includes(OPERATION))).toBe(true);
    prepareError = null;
    const result = await installApplications(ctx, ["editor"], quote);
    expect(updates).toHaveLength(2);
    expect(updates.every(update => update.request.requestId === OPERATION)).toBe(true);
    expect(result.installation?.setupUrl).toBe(SETUP);
    expect(offers).toEqual([]);
  });
  test("a reviewed fee refresh recovers the same interrupted installation identity", async () => {
    const ctx = context("external"), appIds = ["editor", "wallet"], oldQuote = await quoteInstallation(ctx, appIds, OPERATION);
    prepareError = new Error("Original preparation reply interrupted");
    await expect(installApplications(ctx, appIds, oldQuote)).rejects.toThrow("interrupted");
    expect(updates).toHaveLength(1);
    prepareError = null;
    fee = { ...fee, feeVersion: 8n, processingCycles: fee.processingCycles + 100000000n, totalCycles: fee.totalCycles + 100000000n };
    await expect(installApplications(ctx, appIds, oldQuote)).rejects.toThrow(/fee.*changed/);
    expect(updates).toHaveLength(1); expect(reviews).toHaveLength(1);
    const freshQuote = await quoteInstallation(ctx, appIds, OPERATION);
    expect(freshQuote).toMatchObject({ operationId: OPERATION, appIds, cycles: { total: "2100000000" } });
    approved = false;
    await expect(installApplications(ctx, appIds, freshQuote)).rejects.toThrow();
    expect(updates).toHaveLength(1);
    const originalSaved = JSON.parse(new TextDecoder().decode(stored.get(`installation:${OPERATION}`)!));
    expect(originalSaved.quote).toEqual(oldQuote);
    approved = true; events.length = 0;
    await installApplications(ctx, appIds, freshQuote);
    expect(reviews.at(-1)).toEqual({ kind: "installation", quote: freshQuote });
    expect(events.indexOf("external-review")).toBeLessThan(events.indexOf("revise"));
    expect(events.indexOf("revise")).toBeLessThan(events.indexOf("prepare"));
    expect(updates).toHaveLength(2);
    expect(updates.every(update => JSON.stringify(update.request) === JSON.stringify({ requestId: OPERATION, appIds }))).toBe(true);
    expect(updates[1]!.fee).toEqual(fee);
    const retained = JSON.parse(new TextDecoder().decode(stored.get(`installation:${OPERATION}`)!));
    expect(retained.quote).toEqual(freshQuote);
    expect([...stored.entries()].filter(([key]) => key.startsWith(`history:installation:${OPERATION}:`)).some(([, value]) => JSON.parse(new TextDecoder().decode(value)).quote.cycles.total === oldQuote.cycles.total)).toBe(true);
    expect(offers).toEqual([]);
  });
  test("agent installer failure reuses the prepared setup URL without another charged prepare", async () => {
    const ctx = context("agent"), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    installerError = new Error("Installer window interrupted");
    await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow("interrupted");
    expect(updates).toHaveLength(1); expect(offers).toHaveLength(1);
    installerError = null;
    const ready = await quoteInstallation(ctx, ["editor"], OPERATION);
    expect(ready.cycles.total).toBe("0");
    await installApplications(ctx, ["editor"], ready);
    expect(updates).toHaveLength(1); expect(offers).toHaveLength(2);
    expect(offers[1]!.arguments.url).toBe(offers[0]!.arguments.url);
  });
  test("a fee change while review is open stops before charging", async () => {
    afterReview = () => { fee = { ...fee, processingCycles: fee.processingCycles + 1n, totalCycles: fee.totalCycles + 1n }; };
    await expect(installApplications(context("external"), ["editor"])).rejects.toThrow(/fee.*changed/);
    expect(reviews).toHaveLength(1); expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
  test("overlapping same-ID install requests cannot charge preparation twice", async () => {
    let release!: () => void, started!: () => void;
    prepareGate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; }); prepareStarted = started;
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    const first = installApplications(ctx, ["editor"], quote);
    try {
      await began;
      await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow("already being prepared");
      expect(updates).toHaveLength(1);
    } finally { release(); }
    const result = await first;
    expect(result.installation?.setupUrl).toBe(SETUP);
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
  });
  test("lost acknowledgement of saved setup URL still reuses the original grant", async () => {
    const ctx = context("agent"), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    revisionReplyError = new Error("Saved grant acknowledgement interrupted");
    await expect(installApplications(ctx, ["editor"], quote)).rejects.toThrow("acknowledgement interrupted");
    expect(updates).toHaveLength(1); expect(offers).toHaveLength(0);
    revisionReplyError = null;
    const ready = await quoteInstallation(ctx, ["editor"], OPERATION);
    await installApplications(ctx, ["editor"], ready);
    expect(updates).toHaveLength(1); expect(offers).toHaveLength(1);
    expect(offers[0]!.arguments.url).toBe(SETUP);
  });
  test("a remounted owner tile discovers its prepared installation and resumes without another charge", async () => {
    const appIds = ["editor", "wallet"], original = context();
    await installApplications(original, appIds, await quoteInstallation(original, appIds, OPERATION));
    const remounted = context();
    remounted.caller = { ...remounted.caller!, endpoint: "app:marketplace:tile:main:instance:remounted" };
    const recovered = await quoteInstallation(remounted, appIds);
    expect(recovered).toMatchObject({ operationId: OPERATION, appIds, setupUrl: SETUP, cycles: { total: "0" } });
    expect(updates).toHaveLength(1);
    expect(await installationStatus(remounted, OPERATION)).toMatchObject({ operationId: OPERATION, state: "pending", nextAction: "resume", installation: { operationId: OPERATION, setupUrl: SETUP } });
    expect((await recentInstallations(remounted)).some(row => row.operationId === OPERATION)).toBe(true);
    const resumed = await resumeInstallation(remounted, OPERATION);
    expect(resumed.installation?.setupUrl).toBe(SETUP);
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
  });
  test("remount discovers an interrupted preparation before a new installation ID is created", async () => {
    const original = context();
    prepareError = new Error("Original prepare outcome unknown");
    await expect(installApplications(original, ["editor"], await quoteInstallation(original, ["editor"], OPERATION))).rejects.toThrow("unknown");
    prepareError = null;
    const remounted = context(), recovered = await quoteInstallation(remounted, ["editor"]);
    expect(recovered.operationId).toBe(OPERATION);
    expect(recovered.setupUrl).toBeUndefined();
    const result = await installApplications(remounted, ["editor"], recovered);
    expect(result.installation?.setupUrl).toBe(SETUP);
    expect(updates).toHaveLength(2);
    expect(updates.every(update => update.request.requestId === OPERATION)).toBe(true);
    expect(offers).toEqual([]);
  });
  test("legacy prepared records without an opened marker keep their original ready handoff", async () => {
    const ctx = context(), quote = await quoteInstallation(ctx, ["editor"], OPERATION);
    await installApplications(ctx, ["editor"], quote);
    const key = `installation:${OPERATION}`, saved = JSON.parse(new TextDecoder().decode(stored.get(key)!));
    const legacy = { version: saved.version, scope: saved.scope, quote: saved.quote, setupUrl: saved.setupUrl };
    stored.set(key, new TextEncoder().encode(JSON.stringify(legacy)));
    const recovered = await quoteInstallation(context(), ["editor"]);
    expect(recovered).toMatchObject({ operationId: OPERATION, setupUrl: SETUP, cycles: { total: "0" } });
    expect(updates).toHaveLength(1);
  });
  test("opening the exact saved handoff marks it complete without another prepare", async () => {
    const ctx = context(), prepared = await installApplications(ctx, ["editor"], await quoteInstallation(ctx, ["editor"], OPERATION));
    expect(prepared.installation).toBeDefined();
    await markInstallationOpened(ctx, prepared.installation!);
    expect(await installationStatus(ctx, OPERATION)).toMatchObject({ operationId: OPERATION, state: "complete", nextAction: "none" });
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
    expect((await quoteInstallation(ctx, ["editor"])).operationId).not.toBe(OPERATION);
  });
  test("opened-marker cannot substitute another URL or selected apps", async () => {
    const ctx = context(), prepared = await installApplications(ctx, ["editor"], await quoteInstallation(ctx, ["editor"], OPERATION));
    const ready = prepared.installation!;
    await expect(markInstallationOpened(ctx, { ...ready, setupUrl: "https://another.example/setup.json" })).rejects.toThrow();
    await expect(markInstallationOpened(ctx, { ...ready, appIds: ["wallet"] })).rejects.toThrow();
    expect(await installationStatus(ctx, OPERATION)).toMatchObject({ state: "pending", nextAction: "resume" });
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
  });
  test("an agent automatically reuses its unoffered URL after an installer error", async () => {
    const ctx = context("agent"); installerError = new Error("Installer call interrupted");
    await expect(installApplications(ctx, ["editor"])).rejects.toThrow("interrupted");
    const originalId = updates[0]!.request.requestId;
    installerError = null;
    const resumed = await installApplications(context("agent"), ["editor"]);
    expect(resumed.operationId).toBe(originalId);
    expect(updates).toHaveLength(1); expect(offers).toHaveLength(2);
    expect(offers[1]!.arguments).toEqual({ kind: "repository_setup_url", url: SETUP });
    expect(await installationStatus(ctx, originalId)).toMatchObject({ state: "complete", nextAction: "none" });
  });
  test("external non-agent continuation returns its prepared handoff without a background Kernel call", async () => {
    const ctx = context("external"), prepared = await installApplications(ctx, ["editor"]);
    expect(prepared.installation?.setupUrl).toBe(SETUP);
    const resumed = await resumeInstallation(context("external"), prepared.operationId);
    expect(resumed).toMatchObject({ operationId: prepared.operationId, state: "pending", nextAction: "resume", installation: { setupUrl: SETUP, cycles: { total: "0" } } });
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
    expect(reviews).toHaveLength(1);
    expect(events).not.toContain("agent-review"); expect(events).not.toContain("installer");
  });
  test("another application or mode cannot resume a retained installation", async () => {
    const ctx = context();
    await installApplications(ctx, ["editor"], await quoteInstallation(ctx, ["editor"], OPERATION));
    for (const other of [context("external"), context("agent")]) {
      const observed = await resumeInstallation(other, OPERATION);
      expect(observed).toMatchObject({ operationId: OPERATION, nextAction: "none" });
      expect(observed?.installation).toBeUndefined();
      expect((await quoteInstallation(other, ["editor"])).operationId).not.toBe(OPERATION);
    }
    const changed = context(); changed.caller = { ...changed.caller!, installationUid: "another-installation" };
    expect(await resumeInstallation(changed, OPERATION)).toMatchObject({ operationId: OPERATION, nextAction: "none" });
    await expect(quoteInstallation(changed, ["editor"], OPERATION)).rejects.toThrow();
    expect(updates).toHaveLength(1); expect(offers).toEqual([]);
  });
  test("only an explicit fresh installation ID prepares latest while retaining the old ready offer", async () => {
    const ctx = context(), appIds = ["editor", "wallet"], freshId = "cd".repeat(16);
    await installApplications(ctx, appIds, await quoteInstallation(ctx, appIds, OPERATION));
    const originalBytes = new Uint8Array(stored.get(`installation:${OPERATION}`)!);
    latestSetup = "https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/install/latest-grant/setup.json";
    fee = { ...fee, feeVersion: 8n, processingCycles: fee.processingCycles + 100000000n, totalCycles: fee.totalCycles + 100000000n };
    for (const requestId of [undefined, OPERATION]) {
      const existing = await quoteInstallation(ctx, appIds, requestId);
      expect(existing).toMatchObject({ operationId: OPERATION, appIds, setupUrl: SETUP, cycles: { total: "0" } });
    }
    expect(updates).toHaveLength(1);
    const latest = await quoteInstallation(ctx, appIds, freshId);
    expect(latest).toMatchObject({ operationId: freshId, appIds, cycles: { total: "2100000000" } });
    expect(latest.setupUrl).toBeUndefined();
    const prepared = await installApplications(ctx, appIds, latest);
    expect(prepared.installation).toMatchObject({ operationId: freshId, appIds, setupUrl: latestSetup, cycles: { total: "0" } });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ name: "install_prepare", request: { requestId: freshId, appIds }, fee });
    expect(stored.get(`installation:${OPERATION}`)).toEqual(originalBytes);
    expect(await quoteInstallation(ctx, appIds, OPERATION)).toMatchObject({ operationId: OPERATION, setupUrl: SETUP, cycles: { total: "0" } });
    expect(offers).toEqual([]);
  });
  test("an aborted agent request cannot prepare an install", async () => {
    const abort = new AbortController(); abort.abort(new Error("Canceled invocation"));
    await expect(installApplications(context("agent", abort.signal), ["editor"])).rejects.toThrow("Canceled");
    expect(updates).toEqual([]); expect(offers).toEqual([]);
  });
}
