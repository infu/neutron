import { describe, expect, test } from "bun:test";
import { ModifyRequest } from "@nktkas/hyperliquid/api/exchange";
import { canonicalize, createL1ActionHash, signL1Action } from "@nktkas/hyperliquid/signing";
import { parse } from "valibot";
import { privateKeyToAccount } from "viem/accounts";
import { createTradingEngine, type TradeIntent } from "../src/trading";
import { MemoryTradingStore, tradingScope } from "../src/trading_store";

// Public, unfunded signing fixture. All venue reads and writes below are injected;
// this suite never accesses a network or an installed Wallet.
const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const binding = { walletAddress: "0x1111111111111111111111111111111111111111", installationId: "modify-test-wallet", environment: "testnet" as const };
const caller = { appId: "agent", installationUid: "modify-test-agent", role: "background" };
const operationId = "0123456789abcdef0123456789abcdef";
const originalOid = 41;
const replacementOid = 42;
const originalCloid = "0x22222222222222222222222222222222";
const otherCloid = "0x33333333333333333333333333333333";
const intent: Extract<TradeIntent, { kind: "modify" }> = { kind: "modify", coin: "ETH", oid: originalOid, side: "sell", size: "0.1", price: "1900", postOnly: false, reduceOnly: true };
type Status = "open" | "canceled" | "filled" | "badAloPxRejected" | "unknownOid";
type Envelope = { action: { type: string; oid: number | string; order: { c: string; p: string; b: boolean; s: string; r: boolean; t: { limit: { tif: string } } }; a?: boolean }; nonce: number; signature: { r: string; s: string; v: number } };

function fixture(options: {
  original?: Status | Error;
  replacement?: Status | Error;
  response?: "default" | "rejected" | "resting" | "filled" | "lost";
  fills?: Array<Record<string, unknown>>;
  alterStatus?: (which: "original" | "replacement", response: Record<string, any>) => Record<string, any>;
} = {}) {
  const store = new MemoryTradingStore();
  const sent: string[] = [];
  const queried: Array<number | string> = [];
  const reviews: unknown[] = [];
  let signed = 0;
  let clock = 1_780_000_000_000;
  const state = { original: options.original ?? "canceled", replacement: options.replacement ?? "badAloPxRejected", response: options.response ?? "rejected" };
  const scope = tradingScope(binding, caller);
  const key = `${scope}:${operationId}`;
  const signer = { ...wallet, async signTypedData(args: any) { signed++; return wallet.signTypedData(args); } };
  const info = async <T>(body: Record<string, unknown>): Promise<T> => {
    if (body.type === "meta") return { universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }] } as T;
    if (body.type === "userFillsByTime") return (options.fills ?? []) as T;
    if (body.type !== "orderStatus") throw new Error(`Unexpected read ${String(body.type)}`);
    queried.push(body.oid as number | string);
    const record = await store.get(key);
    const envelope = record?.envelope as Envelope;
    const which = body.oid === originalOid || body.oid === originalCloid ? "original" : "replacement";
    const status = state[which];
    if (status instanceof Error) throw status;
    if (status === "unknownOid") return { status: "unknownOid" } as T;
    const response = { status: "order", order: { status, statusTimestamp: clock, order: {
      coin: "ETH", oid: which === "original" ? originalOid : replacementOid,
      cloid: which === "original" ? originalCloid : envelope.action.order.c,
      origSz: "0.1", sz: status === "filled" ? "0" : "0.1",
    } } };
    return (options.alterStatus?.(which, response) ?? response) as T;
  };
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body = String(init.body);
    const record = await store.get(key);
    expect(record?.state).toBe("submitting");
    expect(record?.envelopeJson).toBe(body);
    sent.push(body);
    if (state.response === "lost") throw new Error("Exchange reply lost");
    if (state.response === "default") return Response.json({ status: "ok", response: { type: "default" } });
    const status = state.response === "filled" ? { filled: { oid: replacementOid, totalSz: "0.1", avgPx: "2000" } }
      : state.response === "resting" ? { resting: { oid: replacementOid } }
        : { error: "Error placing new order during modify: Post only order would have immediately matched" };
    return Response.json({ status: "ok", response: { type: "order", data: { statuses: [status] } } });
  }) as typeof fetch;
  const make = () => createTradingEngine({ binding, caller, store, data: { info }, signer: async () => signer, authorize: async review => { reviews.push(review); }, fetcher, now: () => clock++ });
  return { make, store, state, sent, queried, reviews, key, signed: () => signed };
}

describe("Modify time-in-force and signed wire compatibility", () => {
  // API reference: exchange-endpoint#modify-an-order. Without action-level a,
  // the venue converts GTC to ALO; a:false must be omitted from signed bytes.
  for (const side of ["buy", "sell"] as const) for (const marketable of [false, true]) for (const postOnly of [false, true]) for (const reduceOnly of [false, true]) {
    test(`${side} ${marketable ? "marketable" : "resting"} replacement: postOnly=${postOnly}, reduceOnly=${reduceOnly}`, async () => {
      // Synthetic bid/ask 2000/2001: these values are deliberately either side.
      const price = side === "buy" ? marketable ? "2100" : "1900" : marketable ? "1900" : "2100";
      const state = fixture({ response: "default", replacement: "open" });
      const result = await state.make().execute({ operationId, intent: { ...intent, side, price, postOnly, reduceOnly } });
      const envelope = JSON.parse(state.sent[0]!) as Envelope;
      const action = envelope.action;
      expect(action.order).toMatchObject({ b: side === "buy", p: price, r: reduceOnly, t: { limit: { tif: postOnly ? "Alo" : "Gtc" } } });
      expect(Object.hasOwn(action, "a")).toBe(!postOnly);
      if (!postOnly) expect(action.a).toBe(true);
      // Compare the actual signed/serialized action to the independently defined
      // installed SDK schema, rather than another hand-written app encoder.
      const sdk = canonicalize(ModifyRequest.entries.action, parse(ModifyRequest.entries.action, action));
      expect(JSON.stringify(action)).toBe(JSON.stringify(sdk));
      expect(createL1ActionHash({ action, nonce: envelope.nonce })).toBe(createL1ActionHash({ action: sdk, nonce: envelope.nonce }));
      expect(result.review).toMatchObject({ alwaysPlace: !postOnly, postOnly, reduceOnly });
      expect(result.review.action).toEqual(action);
      expect(result.modification?.originalLive).toBe(false);
      expect(result.modification?.replacementLive).toBe(true);
      expect(state.queried).toContain(originalOid);
      expect(state.queried).toContain(action.order.c);
    });
  }

  test("explicit always-place overrides are disclosed and false is never signed", async () => {
    const engine = fixture().make();
    const cancelDependent = await engine.preview({ ...intent, alwaysPlace: false });
    expect(cancelDependent.action).not.toHaveProperty("a");
    expect(cancelDependent.review).toMatchObject({ alwaysPlace: false, postOnly: true });
    expect(JSON.stringify(cancelDependent.review)).toMatch(/post.only|ALO/i);
    const alwaysPostOnly = await engine.preview({ ...intent, postOnly: true, alwaysPlace: true });
    expect(alwaysPostOnly.action).toMatchObject({ a: true, order: { t: { limit: { tif: "Alo" } } } });
    expect(alwaysPostOnly.review).toMatchObject({ alwaysPlace: true, postOnly: true });
    expect(alwaysPostOnly.review.details.join(" ")).toMatch(/even if.*cancel|regardless.*cancel/i);
  });
});

describe("Modify original and replacement reconciliation", () => {
  test("accepted modification follows propagation without a second signature or dispatch", async () => {
    const state = fixture({ original: "open", replacement: "unknownOid", response: "default" });
    const first = await state.make().execute({ operationId, intent });
    expect(first.state).toBe("accepted");
    expect(first.needsReconciliation).toBe(true);
    expect(first.canRetryExact).toBe(false);
    expect(first.message).toContain("order outcome is not confirmed");
    expect(first.modification).toMatchObject({ originalLive: true, replacementLive: null });
    expect((await state.make().history())[0]?.needsReconciliation).toBe(true);
    state.state.original = "canceled";
    state.state.replacement = "filled";
    const final = await state.make().reconcile(operationId);
    expect(final.state).toBe("filled");
    expect(final.needsReconciliation).toBe(false);
    expect(final.modification).toMatchObject({ originalLive: false, replacementLive: false });
    expect(final.message).not.toContain("not confirmed");
    expect((await state.make().history())[0]?.needsReconciliation).toBe(false);
    expect(state.sent).toHaveLength(1);
    expect(state.signed()).toBe(1);
    expect(state.reviews).toHaveLength(1);
  });

  for (const original of ["open", "canceled", "filled", "unknownOid"] as const) for (const replacement of ["badAloPxRejected", "filled", "open"] as const) {
    test(`original ${original}; replacement ${replacement}`, async () => {
      const state = fixture({ original, replacement, response: "default", fills: [
        { oid: originalOid, coin: "ETH", sz: "0.1", px: "2222", tid: 1, hash: "original-fill" },
        ...(replacement === "filled" ? [{ oid: replacementOid, coin: "ETH", sz: "0.1", px: "2000", tid: 2, hash: "replacement-fill" }] : []),
      ] });
      const result = await state.make().execute({ operationId, intent });
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0]?.oid).toBe(replacementOid);
      expect(result.state).toBe(replacement === "open" ? "resting" : replacement === "filled" ? "filled" : "rejected");
      expect(result.modification).toMatchObject({
        originalLive: original === "unknownOid" ? null : original === "open",
        replacementLive: replacement === "open", errors: [],
        original: { oid: originalOid, state: original === "unknownOid" ? "unknown" : original === "open" ? "resting" : original },
      });
      expect(result.modification?.checkedAt).toBeGreaterThan(0);
      expect(result.needsReconciliation).toBe(original === "unknownOid");
      expect(result.message).toContain(`Original order ${originalOid}`);
      if (replacement === "filled") expect(result.orders[0]).toMatchObject({ filledSize: "0.1", averagePrice: "2000" });
      else {
        expect(result.orders[0]?.averagePrice).toBeUndefined();
        expect(result.orders[0]?.filledSize === undefined || result.orders[0]?.filledSize === "0").toBe(true);
      }
      expect(state.sent).toHaveLength(1);
      expect(state.queried).toContain(originalOid);
      expect(state.queried).toContain(result.orders[0]!.cloid!);
    });
  }

  test("failed modify reports original canceled immediately and retry only refreshes evidence", async () => {
    const state = fixture();
    const engine = state.make();
    const first = await engine.execute({ operationId, intent });
    expect(first.state).toBe("rejected");
    expect(first.modification).toMatchObject({ originalLive: false, replacementLive: false, original: { venueStatus: "canceled" } });
    expect(first.message).toContain("is no longer working");
    expect(first.canRetryExact).toBe(false);
    const second = await state.make().retryExact(operationId);
    expect(second.state).toBe("rejected");
    expect(state.sent).toHaveLength(1);
    expect(state.signed()).toBe(1);
    expect(state.reviews).toHaveLength(1);
    expect(state.queried.filter(oid => oid === originalOid)).toHaveLength(2);
  });

  test("original lookup failure never hides a confirmed replacement or claims the old order closed", async () => {
    const state = fixture({ original: new Error("Original lookup rate limited"), replacement: "filled", response: "filled" });
    const result = await state.make().execute({ operationId, intent });
    expect(result.state).toBe("filled");
    expect(result.orders[0]).toMatchObject({ oid: replacementOid, filledSize: "0.1", averagePrice: "2000" });
    expect(result.modification).toMatchObject({ originalLive: null, replacementLive: false, original: { oid: originalOid, state: "unknown" } });
    expect(result.modification?.errors).toContain("Original order: Original lookup rate limited");
    expect(result.needsReconciliation).toBe(true);
    expect(result.message).toContain("could not be verified");
    expect(state.sent).toHaveLength(1);
  });

  test("authoritative replacement fill supersedes an earlier rejection without stale error prose", async () => {
    const state = fixture({ response: "rejected", replacement: "filled", fills: [
      { oid: replacementOid, coin: "ETH", sz: "0.1", px: "2000", tid: 2, hash: "replacement-fill" },
    ] });
    const result = await state.make().execute({ operationId, intent });
    expect(result.state).toBe("filled");
    expect(result.orders[0]?.filledSize).toBe("0.1");
    expect(result.orders[0]?.error).toBeUndefined();
    expect(result.message).not.toContain("Post only order would have immediately matched");
    expect(state.sent).toHaveLength(1);
  });

  for (const which of ["original", "replacement"] as const) for (const identifier of ["oid", "cloid"] as const) {
    test(`rejects ${which} evidence with mismatching ${identifier}`, async () => {
      const state = fixture({ response: which === "replacement" && identifier === "oid" ? "resting" : "default", replacement: "filled", alterStatus: (target, response) => {
        if (target === which) response.order.order[identifier] = identifier === "oid" ? 999 : otherCloid;
        return response;
      } });
      // String-target mode binds the original lookup to the requested cloid;
      // numeric-response mode binds replacement's exchange-returned oid.
      const result = await state.make().execute({ operationId, intent: { ...intent, ...(which === "original" && identifier === "cloid" ? { oid: originalCloid } : {}) } });
      expect(result.modification?.errors.some(error => error.includes(`different ${identifier === "oid" ? "venue" : "client"} order ID`))).toBe(true);
      if (which === "original") expect(result.modification?.originalLive).toBeNull();
      else {
        expect(result.modification?.replacementLive).toBeNull();
        expect(result.orders[0]?.filledSize).toBeUndefined();
        expect(result.state).not.toBe("filled");
      }
    });
  }

  test("old signed modifications retain omitted always-place and the exact envelope on retry", async () => {
    const state = fixture({ original: "unknownOid", replacement: "unknownOid", response: "lost" });
    const engine = state.make();
    await engine.execute({ operationId, intent });
    const record = (await state.store.get(state.key))!;
    const previousEnvelope = structuredClone(record.envelope) as Envelope;
    delete previousEnvelope.action.a;
    // Construct a historical pre-fix envelope in the synthetic durable store.
    // Its old nonce/signature are retained by the new runtime, never regenerated.
    previousEnvelope.signature = await signL1Action({ wallet, action: previousEnvelope.action, nonce: previousEnvelope.nonce, isTestnet: true });
    const oldBytes = JSON.stringify(previousEnvelope);
    const oldReview: Record<string, unknown> = { ...(record.review as Record<string, unknown>), action: previousEnvelope.action };
    delete oldReview.alwaysPlace;
    await state.store.update({ ...record, revision: record.revision + 1, action: previousEnvelope.action, review: oldReview, envelope: previousEnvelope, envelopeJson: oldBytes }, record.revision);
    const result = await state.make().retryExact(operationId);
    expect(result.state).toBe("uncertain");
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1]).toBe(oldBytes);
    expect(JSON.parse(state.sent[1]!).action).not.toHaveProperty("a");
    expect(state.signed()).toBe(1);
    expect(state.reviews).toHaveLength(2);
  });
});
