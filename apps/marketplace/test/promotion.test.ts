import { beforeEach, expect, mock, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Principal } from "@dfinity/principal";
import type { MsgBusToolContext } from "neutron-tools/app";
import type { Fee, WirePromotionEntry, WirePromotionReceipt } from "../src/protocol.ts";

// Keep the client replacement out of the other suites' shared Bun module cache.
if (process.env.NEUTRON_MARKETPLACE_PROMOTION_TEST_CHILD !== "1") {
  test("promotion retains exact reviewed releases and reconciles interrupted requests", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_PROMOTION_TEST_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  type Data = Record<string, any>;
  type Request = { requestId: string; entries: WirePromotionEntry[] };
  const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", PROTOCOL = "233tv-xiaaa-aaaay-aacta-cai";
  const OTHER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  const owner = Principal.fromText(OWNER);
  const originalEntry = (): WirePromotionEntry => ({
    appId: "editor", candidateId: 9_007_199_254_740_993n, version: 118n,
    digest: Uint8Array.from({ length: 32 }, (_, index) => index),
    sourceDigest: [Uint8Array.from({ length: 32 }, (_, index) => 255 - index)],
    packageSize: 9_007_199_254_740_995n, sourceSize: [9_007_199_254_740_997n],
    dependencies: [{ appId: "kernel", minVersion: 9_007_199_254_740_999n }],
    expectedBetaRevision: 9_007_199_254_741_001n,
    expectedStableCandidate: [9_007_199_254_740_991n], expectedStableRevision: 9_007_199_254_741_003n,
  });
  let currentBeta: WirePromotionEntry, fee: Fee, cachedFee: Fee, state: { owner: string; canisterId: string }, counter: number;
  let updateError: Error | null, statusError: Error | null, saveError: Error | null, loseReply: boolean;
  let revisionFailure: "before" | "after" | null;
  let receiptChange: ((receipt: WirePromotionReceipt) => WirePromotionReceipt) | null;
  let stableCandidate: bigint, transitions: number;
  const stored = new Map<string, Uint8Array>(), receipts = new Map<string, WirePromotionReceipt>();
  const events: string[] = [], queries: Array<{ name: string; args: any[] }> = [];
  const estimates: Array<{ name: string; request: Request }> = [];
  const updates: Array<{ name: string; request: Request; fee: Fee }> = [];
  const saved = (requestId: string): Data => JSON.parse(new TextDecoder().decode(stored.get(`promotion:${requestId}`)!));
  const makeReceipt = (request: Request): WirePromotionReceipt => ({
    id: 9_007_199_254_741_005n, owner, publisher: owner, requestId: request.requestId,
    operation: "promote", channel: "stable", entries: structuredClone(request.entries), createdAtNs: 1n,
  });
  const actualClient = await import("../src/client.ts");
  const client = {
    get state() { return state; },
    query: async (name: string, args: any[]) => {
      queries.push({ name, args: structuredClone(args) }); events.push(name);
      if (name === "promotion_prepare") {
        expect(args).toEqual([{ appIds: ["editor"] }]);
        return { entries: [structuredClone(currentBeta)] };
      }
      if (name === "promotion_status") {
        if (statusError) throw statusError;
        const receipt = receipts.get(args[0].requestId);
        return receipt ? [receipt] : [];
      }
      throw new Error(`Unexpected protocol query ${name}`);
    },
    estimateUpdate: async (name: string, request: Request) => {
      estimates.push({ name, request: structuredClone(request) }); events.push("estimate");
      return structuredClone(cachedFee);
    },
    refreshFeeSchedule: async () => { events.push("refresh-fee"); cachedFee = structuredClone(fee); },
    update: async (name: string, request: Request, charged: Fee) => {
      updates.push({ name, request: structuredClone(request), fee: structuredClone(charged) }); events.push("promote");
      expect(name).toBe("release_promote");
      expect(saved(request.requestId)).toMatchObject({ state: "pending", plan: { requestId: request.requestId } });
      if (updateError) throw updateError;
      if (stableCandidate !== request.entries[0]!.candidateId) {
        stableCandidate = request.entries[0]!.candidateId; transitions++;
      }
      let receipt = makeReceipt(request);
      if (receiptChange) receipt = receiptChange(receipt);
      receipts.set(request.requestId, receipt);
      if (loseReply) throw new Error("Promotion reply interrupted");
      return receipt;
    },
  };
  mock.module("../src/client.ts", () => ({
    ...actualClient, protocolClient: async () => client, randomId: () => (++counter).toString(16).padStart(32, "0"),
  }));
  const { quotePromotion, promote, pendingPromotions } = await import("../src/promotion.ts");
  function context(): MsgBusToolContext {
    return { signal: new AbortController().signal, kernel: {
      querySelf: async (name: string, args: any[]) => {
        if (name === "marketplace_draft") {
          const value = stored.get(args[0]); return value ? [new Uint8Array(value)] : [];
        }
        if (name === "marketplace_drafts") {
          const request = args[0];
          const rows = [...stored.entries()].sort(([left], [right]) => left.localeCompare(right)).filter(([id]) => !request.cursor || id > request.cursor);
          const page = rows.slice(0, Number(request.limit));
          return { items: page.map(([id, value]) => ({ id, value: new Uint8Array(value) })), nextCursor: rows.length > page.length ? page.at(-1)![0] : null };
        }
        throw new Error(`Unexpected self query ${name}`);
      },
      updateSelf: async (name: string, args: Array<{ id: string; value: Uint8Array; expected?: Uint8Array; revision?: string }>) => {
        const request = args[0]!, existing = stored.get(request.id);
        if (name === "marketplace_save_draft") {
          if (saveError) throw saveError;
          if (existing && !Buffer.from(existing).equals(Buffer.from(request.value))) return { err: "Different saved intent" };
          stored.set(request.id, new Uint8Array(request.value)); events.push("save"); return { ok: request.id };
        }
        if (name === "marketplace_revise_draft") {
          if (!existing || !request.expected || !Buffer.from(existing).equals(Buffer.from(request.expected))) return { err: "The original intent changed" };
          const revision = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(request.expected))).toString("hex");
          expect(request.revision).toBe(revision);
          if (revisionFailure === "before") throw new Error("Completion could not be saved");
          stored.set(request.id, new Uint8Array(request.value)); events.push("revise");
          if (revisionFailure === "after") throw new Error("Completion acknowledgement interrupted");
          return { ok: request.id };
        }
        throw new Error(`Unexpected self update ${name}`);
      },
    } } as unknown as MsgBusToolContext;
  }
  function replaceBeta(): void {
    currentBeta = { ...originalEntry(), candidateId: 9_007_199_254_741_010n, version: 119n,
      digest: new Uint8Array(32).fill(77), sourceDigest: [new Uint8Array(32).fill(88)], expectedBetaRevision: currentBeta.expectedBetaRevision + 1n };
  }
  beforeEach(() => {
    currentBeta = originalEntry(); stableCandidate = currentBeta.expectedStableCandidate[0]!; transitions = 0;
    fee = { feeVersion: 7n, processingCycles: 9_007_199_254_741_007n, storageCycles: 500n,
      totalCycles: 9_007_199_254_741_507n, processingBytes: 1024n, newStorageBytes: 512n };
    cachedFee = structuredClone(fee);
    state = { owner: OWNER, canisterId: PROTOCOL }; counter = 0;
    updateError = null; statusError = null; saveError = null; loseReply = false; receiptChange = null; revisionFailure = null;
    stored.clear(); receipts.clear(); events.length = 0; queries.length = 0; estimates.length = 0; updates.length = 0;
  });

  test("quotes exact beta bytes and heads, then persists all terms before checking or changing the release", async () => {
    const ctx = context(), quote = await quotePromotion(ctx, "editor");
    expect(quote).toMatchObject({ appId: "editor", release: {
      candidateId: "9007199254740993", version: "118", digest: actualClient.hex(currentBeta.digest),
      sourceDigest: actualClient.hex(currentBeta.sourceDigest[0]!),
    }, cycles: { total: "9007199254741507", processing: "9007199254741007", storage: "500", schedule: "7" } });
    expect(estimates).toEqual([{ name: "release_promote", request: { requestId: quote.operationId, entries: [currentBeta] } }]);
    expect(stored.size).toBe(0); expect(updates).toEqual([]);
    expect(() => JSON.stringify(quote)).not.toThrow();
    await expect(promote(ctx, JSON.parse(JSON.stringify(quote)))).resolves.toEqual({ message: "editor v118 was released to stable." });
    expect(updates).toEqual([{ name: "release_promote", request: { requestId: quote.operationId, entries: [currentBeta] }, fee }]);
    expect(saved(quote.operationId)).toEqual({ version: 1, state: "complete", receiptId: "9007199254741005", plan: {
      version: 1, requestId: quote.operationId, canister: PROTOCOL, owner: OWNER,
      entry: { appId: "editor", candidateId: "9007199254740993", version: "118", digest: [...currentBeta.digest],
        sourceDigest: [...currentBeta.sourceDigest[0]!], packageSize: "9007199254740995", sourceSize: "9007199254740997",
        dependencies: [{ appId: "kernel", minVersion: "9007199254740999" }], expectedBetaRevision: "9007199254741001",
        expectedStableCandidate: "9007199254740991", expectedStableRevision: "9007199254741003" },
      fee: { feeVersion: "7", processingCycles: "9007199254741007", storageCycles: "500", totalCycles: "9007199254741507", processingBytes: "1024", newStorageBytes: "512" },
    } });
    expect(events).toEqual(["promotion_prepare", "estimate", "save", "promotion_status", "promote", "revise"]);
    expect(await pendingPromotions(ctx)).toEqual([]);
  });

  test("a failed durable save cannot send a promotion mutation", async () => {
    const ctx = context(), quote = await quotePromotion(ctx, "editor");
    saveError = new Error("Draft storage unavailable");
    await expect(promote(ctx, quote)).rejects.toThrow("Draft storage unavailable");
    expect(stored.size).toBe(0); expect(updates).toEqual([]);
    expect(queries.map(query => query.name)).toEqual(["promotion_prepare"]);
  });

  test("unresolved transport failure retains original request and digests after beta is replaced", async () => {
    const quote = await quotePromotion(context(), "editor"), original = structuredClone(currentBeta);
    updateError = new Error("Connection interrupted before a receipt was received");
    await expect(promote(context(), quote)).rejects.toThrow("Connection interrupted");
    expect(saved(quote.operationId).state).toBe("pending");
    replaceBeta(); updateError = null;
    const resumed = await quotePromotion(context(), "editor");
    expect(resumed).toEqual(quote); expect(await pendingPromotions(context())).toEqual([quote]);
    await promote(context(), JSON.parse(JSON.stringify(resumed)));
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update).toEqual({ name: "release_promote", request: { requestId: quote.operationId, entries: [original] }, fee });
    expect(queries.filter(query => query.name === "promotion_prepare")).toHaveLength(1);
    expect(estimates).toHaveLength(1);
    expect(events).not.toContain("refresh-fee");
  });

  test("lost successful reply remains discoverable after reload when the same beta is already stable", async () => {
    const quote = await quotePromotion(context(), "editor");
    loseReply = true;
    await expect(promote(context(), quote)).rejects.toThrow("Promotion reply interrupted");
    expect(stableCandidate).toBe(currentBeta.candidateId); expect(transitions).toBe(1);
    expect(saved(quote.operationId).state).toBe("pending");
    const reloaded = await import(new URL("../src/promotion.ts?promotion-reload", import.meta.url).href);
    const [resumed] = await reloaded.pendingPromotions(context());
    expect(resumed).toEqual(quote);
    expect(await reloaded.quotePromotion(context(), "editor")).toEqual(quote);
    loseReply = false;
    await expect(reloaded.promote(context(), resumed)).resolves.toEqual({ message: "editor v118 was released to stable." });
    expect(updates).toHaveLength(1); expect(transitions).toBe(1);
    expect(saved(quote.operationId)).toMatchObject({ state: "complete", receiptId: "9007199254741005" });
    expect(await reloaded.pendingPromotions(context())).toEqual([]);
  });

  test("status read failure preserves recovery and cannot trigger a second mutation or replacement quote", async () => {
    const quote = await quotePromotion(context(), "editor");
    loseReply = true;
    await expect(promote(context(), quote)).rejects.toThrow("Promotion reply interrupted");
    replaceBeta(); loseReply = false; statusError = new Error("Receipt status unavailable");
    await expect(promote(context(), quote)).rejects.toThrow("Receipt status unavailable");
    expect(updates).toHaveLength(1); expect(saved(quote.operationId).state).toBe("pending");
    expect(await quotePromotion(context(), "editor")).toEqual(quote);
    statusError = null;
    await promote(context(), quote);
    expect(updates).toHaveLength(1); expect(estimates).toHaveLength(1);
  });

  test("a status query error cannot turn an unresolved request into a definitive rejection", async () => {
    const quote = await quotePromotion(context(), "editor");
    statusError = new actualClient.ProtocolError("channel_conflict", "Status response is unavailable");
    await expect(promote(context(), quote)).rejects.toThrow("Status response is unavailable");
    expect(updates).toEqual([]); expect(saved(quote.operationId).state).toBe("pending");
    expect(await pendingPromotions(context())).toEqual([quote]);
  });

  test("failed completion persistence recovers the original receipt without another mutation", async () => {
    const quote = await quotePromotion(context(), "editor");
    revisionFailure = "before";
    await expect(promote(context(), quote)).rejects.toThrow("Completion could not be saved");
    expect(saved(quote.operationId).state).toBe("pending");
    revisionFailure = null; replaceBeta();
    await promote(context(), quote);
    expect(updates).toHaveLength(1); expect(transitions).toBe(1);
    expect(saved(quote.operationId)).toMatchObject({ state: "complete", plan: quote.opaque });
  });

  test("a lost completion save acknowledgement resolves locally without repeating remote calls", async () => {
    const quote = await quotePromotion(context(), "editor");
    revisionFailure = "after";
    await expect(promote(context(), quote)).rejects.toThrow("Completion acknowledgement interrupted");
    expect(saved(quote.operationId).state).toBe("complete");
    revisionFailure = null; statusError = new Error("No further status read expected");
    await promote(context(), quote);
    expect(updates).toHaveLength(1);
    expect(queries.filter(query => query.name === "promotion_status")).toHaveLength(1);
  });

  test("definitive channel conflict retains a rejected request and allows a fresh quote for the current beta", async () => {
    const quote = await quotePromotion(context(), "editor");
    replaceBeta();
    updateError = new actualClient.ProtocolError("channel_conflict", "The beta head changed");
    await expect(promote(context(), quote)).rejects.toThrow("The beta head changed");
    expect(saved(quote.operationId)).toMatchObject({ state: "rejected", error: "The beta head changed", plan: quote.opaque });
    expect(await pendingPromotions(context())).toEqual([]);
    await expect(promote(context(), quote)).rejects.toThrow("The beta head changed");
    expect(updates).toHaveLength(1);
    const fresh = await quotePromotion(context(), "editor");
    expect(fresh.operationId).not.toBe(quote.operationId);
    expect(fresh.release).toMatchObject({ candidateId: String(currentBeta.candidateId), version: "119", digest: actualClient.hex(currentBeta.digest), sourceDigest: actualClient.hex(currentBeta.sourceDigest[0]!) });
    updateError = null;
    await promote(context(), fresh);
    expect(updates[1]!.request).toEqual({ requestId: fresh.operationId, entries: [currentBeta] });
    expect(saved(quote.operationId).state).toBe("rejected");
    expect(saved(fresh.operationId).state).toBe("complete");
  });

  test("an unknown protocol error remains pending until its outcome can be reconciled", async () => {
    const quote = await quotePromotion(context(), "editor");
    updateError = new actualClient.ProtocolError("temporarily_unavailable", "Try this request again");
    await expect(promote(context(), quote)).rejects.toThrow("Try this request again");
    expect(saved(quote.operationId).state).toBe("pending");
    expect(await pendingPromotions(context())).toEqual([quote]);
  });

  test("a definitive fee schedule change reviews a new fee for the same saved release and request", async () => {
    const quote = await quotePromotion(context(), "editor"), original = structuredClone(currentBeta);
    updateError = new actualClient.ProtocolError("cycle_fee_version", "Review the new cycle fee schedule");
    await expect(promote(context(), quote)).rejects.toThrow("Review the new cycle fee schedule");
    expect(saved(quote.operationId)).toMatchObject({ state: "fee_review", plan: quote.opaque });
    expect(await pendingPromotions(context())).toEqual([quote]);
    await expect(promote(context(), quote)).rejects.toThrow();
    expect(updates).toHaveLength(1);
    expect(events).not.toContain("refresh-fee");
    replaceBeta();
    fee = { ...fee, feeVersion: fee.feeVersion + 1n, processingCycles: fee.processingCycles + 100n, totalCycles: fee.totalCycles + 100n };
    expect(cachedFee.feeVersion).toBe(BigInt(quote.cycles.schedule));
    expect(cachedFee.feeVersion).not.toBe(fee.feeVersion);
    const beforeReview = events.length;
    const refreshed = await quotePromotion(context(), "editor");
    expect(events.slice(beforeReview)).toEqual(["refresh-fee", "estimate", "revise"]);
    expect(refreshed.operationId).toBe(quote.operationId);
    expect(refreshed.release).toEqual(quote.release);
    expect(refreshed.cycles).toEqual(actualClient.cycleView(fee));
    expect(estimates).toHaveLength(2);
    expect(estimates[1]).toEqual({ name: "release_promote", request: { requestId: quote.operationId, entries: [original] } });
    expect(queries.filter(query => query.name === "promotion_prepare")).toHaveLength(1);
    expect(saved(quote.operationId)).toMatchObject({ state: "pending", plan: refreshed.opaque });
    expect(await pendingPromotions(context())).toEqual([refreshed]);
    expect(await quotePromotion(context(), "editor")).toEqual(refreshed);
    await expect(promote(context(), quote)).rejects.toThrow();
    expect(updates).toHaveLength(1);
    updateError = null;
    await promote(context(), refreshed);
    expect(updates[1]).toEqual({ name: "release_promote", request: { requestId: quote.operationId, entries: [original] }, fee });
    expect(saved(quote.operationId).state).toBe("complete");
    expect(events.filter(event => event === "refresh-fee")).toHaveLength(1);
  });

  test("a matching no-op receipt is retained and completed retries never send another update", async () => {
    currentBeta = { ...originalEntry(), sourceDigest: [], sourceSize: [], dependencies: [], expectedStableCandidate: [] };
    const quote = await quotePromotion(context(), "editor");
    stableCandidate = currentBeta.candidateId;
    await promote(context(), quote);
    expect(transitions).toBe(0);
    expect(updates[0]!.request.entries).toEqual([currentBeta]);
    expect(saved(quote.operationId)).toMatchObject({ state: "complete", receiptId: "9007199254741005", plan: { entry: {
      sourceDigest: null, sourceSize: null, dependencies: [], expectedStableCandidate: null,
    } } });
    receipts.clear(); statusError = new Error("The receipt query should not be repeated");
    await expect(promote(context(), JSON.parse(JSON.stringify(quote)))).resolves.toEqual({ message: "editor v118 was released to stable." });
    expect(updates).toHaveLength(1);
    expect(queries.filter(query => query.name === "promotion_status")).toHaveLength(1);
  });

  test("zero optional amounts, stable candidate and receipt ID survive persistence", async () => {
    currentBeta = { ...originalEntry(), sourceSize: [0n], expectedStableCandidate: [0n] };
    receiptChange = receipt => ({ ...receipt, id: 0n });
    const quote = await quotePromotion(context(), "editor");
    await promote(context(), JSON.parse(JSON.stringify(quote)));
    expect(updates[0]!.request.entries).toEqual([currentBeta]);
    expect(saved(quote.operationId)).toMatchObject({ state: "complete", receiptId: "0", plan: { entry: {
      sourceSize: "0", expectedStableCandidate: "0",
    } } });
  });

  test("owner or marketplace changes hide pending requests and cannot resume an original quote", async () => {
    const quote = await quotePromotion(context(), "editor");
    updateError = new Error("Connection interrupted");
    await expect(promote(context(), quote)).rejects.toThrow("Connection interrupted");
    for (const field of ["owner", "canisterId"] as const) {
      state = { owner: OWNER, canisterId: PROTOCOL, [field]: OTHER };
      expect(await pendingPromotions(context())).toEqual([]);
      await expect(promote(context(), quote)).rejects.toThrow("original marketplace and Neutron");
      expect(updates).toHaveLength(1);
    }
    state = { owner: OWNER, canisterId: PROTOCOL };
    expect(await pendingPromotions(context())).toEqual([quote]);
  });

  test("displayed release or fee edits cannot change the reviewed selection", async () => {
    const quote = await quotePromotion(context(), "editor");
    const changes = [
      { ...quote, operationId: "ff".repeat(16) }, { ...quote, appId: "wallet" },
      { ...quote, release: { ...quote.release, candidateId: "42" } },
      { ...quote, release: { ...quote.release, version: "119" } },
      { ...quote, release: { ...quote.release, digest: "ff".repeat(32) } },
      { ...quote, release: { ...quote.release, sourceDigest: null } },
      { ...quote, cycles: { ...quote.cycles, total: "0" } },
    ];
    for (const changed of changes) await expect(promote(context(), changed)).rejects.toThrow("selection changed after review");
    expect(updates).toEqual([]); expect(stored.size).toBe(0);
  });

  test("the same saved request ID cannot be reused with mutated release identity or expected heads", async () => {
    const quote = await quotePromotion(context(), "editor");
    updateError = new Error("Connection interrupted");
    await expect(promote(context(), quote)).rejects.toThrow("Connection interrupted");
    const identityChange = JSON.parse(JSON.stringify(quote));
    identityChange.release.digest = "ee".repeat(32); identityChange.opaque.entry.digest = Array(32).fill(238);
    const headChange = JSON.parse(JSON.stringify(quote)); headChange.opaque.entry.expectedBetaRevision = "42";
    for (const changed of [identityChange, headChange]) await expect(promote(context(), changed)).rejects.toThrow("ID belongs to a different selection");
    expect(updates).toHaveLength(1);
    expect(saved(quote.operationId)).toMatchObject({ state: "pending", plan: quote.opaque });
  });

  test("receipts for a different owner, scope, release or expected heads cannot complete a retained request", async () => {
    const changes: Array<(receipt: WirePromotionReceipt) => WirePromotionReceipt> = [
      receipt => ({ ...receipt, requestId: "ff".repeat(16) }),
      receipt => ({ ...receipt, owner: Principal.fromText(OTHER) }),
      receipt => ({ ...receipt, publisher: Principal.fromText(OTHER) }),
      receipt => ({ ...receipt, operation: "publish" }),
      receipt => ({ ...receipt, channel: "beta" }),
      receipt => ({ ...receipt, entries: [] }),
      receipt => ({ ...receipt, entries: [...receipt.entries, receipt.entries[0]!] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, appId: "wallet" }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, candidateId: 42n }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, version: 119n }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, digest: new Uint8Array(32).fill(99) }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, sourceDigest: [] }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, packageSize: 42n }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, sourceSize: [] }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, dependencies: [] }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, expectedBetaRevision: 42n }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, expectedStableCandidate: [] }] }),
      receipt => ({ ...receipt, entries: [{ ...receipt.entries[0]!, expectedStableRevision: 42n }] }),
    ];
    for (const change of changes) {
      stored.clear(); receipts.clear(); receiptChange = change;
      const quote = await quotePromotion(context(), "editor");
      await expect(promote(context(), quote)).rejects.toThrow("receipt for a different release");
      expect(saved(quote.operationId).state).toBe("pending");
      expect(await pendingPromotions(context())).toEqual([quote]);
      const count = updates.length;
      await expect(promote(context(), quote)).rejects.toThrow("receipt for a different release");
      expect(updates).toHaveLength(count);
    }
  });
}
