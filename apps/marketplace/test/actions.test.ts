import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Principal } from "@dfinity/principal";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, withdrawalType, encodeOpaque, decodeOpaque, type Checkout, type Fee, type WireResult, type WithdrawQuote } from "../src/protocol.ts";
import type { PurchaseQuote, WithdrawalQuote } from "../src/view-types.ts";
import type { PurchaseFundingRequest } from "../src/wallet.ts";

// Client substitution is process-local: production protocol/Wallet parsers and
// the real durable-store adapter remain intact, and other tests see no mocks.
if (process.env.NEUTRON_MARKETPLACE_ACTION_TEST_CHILD !== "1") {
  test("marketplace action recovery preserves Wallet and protocol identities", async () => {
    try {
      const result = await promisify(execFile)(process.execPath, ["test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, NEUTRON_MARKETPLACE_ACTION_TEST_CHILD: "1" }, timeout: 30_000,
      });
      expect(result.stderr).toContain("0 fail");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  }, 35_000);
} else {
  const actualClient = await import("../src/client.ts");
  const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", PROTOCOL = "233tv-xiaaa-aaaay-aacta-cai", LEDGER = "xevnm-gaaaa-aaaar-qafnq-cai";
  const OPERATION = "ab".repeat(16), WITHDRAWAL = "cd".repeat(16);
  const principal = (value: string) => Principal.fromText(value);
  const fee: Fee = { feeVersion: 1n, processingCycles: 100n, storageCycles: 0n, totalCycles: 100n, processingBytes: 0n, newStorageBytes: 0n };
  function checkout(amount = 9000000n): Checkout {
    return {
      request: { requestId: OPERATION, appIds: ["test-app"], ledger: principal(LEDGER), referralCode: [] },
      buyer: principal(OWNER), items: [{ appId: "test-app", listingRevision: 1n, publisher: principal(PROTOCOL), priceUsdMicros: amount,
        paidAtoms: amount, developerAtoms: amount * 3n / 10n, affiliateAtoms: 0n, burnAtoms: amount * 7n / 10n, releaseDigest: new Uint8Array(32).fill(5) }],
      amount, fee: 10000n, affiliate: [], rate: [], spender: { owner: principal(PROTOCOL), subaccount: [new Uint8Array(32).fill(9)] },
      commitment: new Uint8Array(32).fill(7), cycles: fee, quotedAtNs: BigInt(Date.now()) * 1000000n,
    };
  }
  const money = (amount: bigint) => ({ atoms: String(amount), symbol: "ckUSDC", decimals: 6 });
  function view(wire: Checkout): PurchaseQuote {
    return { operationId: wire.request.requestId, commitment: actualClient.hex(wire.commitment), appIds: wire.request.appIds,
      items: [{ id: "test-app", title: "Test app", summary: "", category: "", publisher: PROTOCOL, priceUsdMicros: String(wire.amount), version: "1", rating: null, ratingCount: 0 }],
      token: "ckUSDC", subtotalUsdMicros: String(wire.amount), discountUsdMicros: "0", payment: money(wire.amount), approvalFee: money(10000n),
      collectionFee: money(wire.fee), totalDebit: money(wire.amount + 20000n), allocations: [], cycles: actualClient.cycleView(wire.cycles),
      affiliateCode: "", warnings: [], opaque: encodeOpaque(checkoutType, wire) };
  }
  function withdrawal(): WithdrawQuote {
    return { request: { requestId: WITHDRAWAL, ledger: principal(LEDGER), to: { owner: principal(OWNER), subaccount: [] }, totalDebit: 1000000n },
      owner: principal(OWNER), fee: 10000n, netAmount: 990000n, available: 2000000n, commitment: new Uint8Array(32).fill(2), cycles: fee };
  }
  function withdrawalView(wire: WithdrawQuote): WithdrawalQuote {
    return { operationId: wire.request.requestId, token: "ckUSDC", destination: OWNER, debit: money(wire.request.totalDebit), fee: money(wire.fee),
      receive: money(wire.netAmount), cycles: actualClient.cycleView(wire.cycles), warnings: [], opaque: encodeOpaque(withdrawalType, wire) };
  }
  function result(state: string, kind = "purchase", next = state === "complete" ? "none" : "retry_same_attempt"): WireResult {
    const operation = { requestId: kind === "purchase" ? OPERATION : WITHDRAWAL, state: { [state]: null }, lastError: [] as [] };
    return { ...(kind === "purchase" ? { order: operation } : { withdrawal: operation }), attempt: [], active: false, nextAction: { [next]: null } };
  }
  type WalletCall = { target: string; name: string; arguments: PurchaseFundingRequest };
  let stored: Map<string, Uint8Array>, events: string[], walletCalls: WalletCall[], reviews: JsonObject[], updates: Array<{ name: string; request: { quote: Checkout | WithdrawQuote }; fee: Fee }>;
  let observed: WireResult | null, updateResult: WireResult, fundingError: Error | null, updateError: Error | null, queryError: Error | null;
  let idCounter: number;
  let freshPurchase: Checkout | null, freshWithdrawal: WithdrawQuote | null, ownerApproved: boolean;
  let fundingReplies: Array<"approved" | "pending" | "rejected">;
  let restoreClock: (() => void) | null = null;
  const client = {
    state: { owner: OWNER, canisterId: PROTOCOL },
    token: () => ({ ledger: principal(LEDGER) }),
    purchaseView: async (wire: Checkout) => view(wire), withdrawalView,
    query: async (name: string) => {
      events.push(`query:${name}`); if (queryError) throw queryError;
      if (name === "purchase_quote") {
        const saved = stored.get(`operation:${OPERATION}`);
        return freshPurchase ?? (observed?.quote?.[0] || (saved ? decodeOpaque<Checkout>(checkoutType, JSON.parse(new TextDecoder().decode(saved)).quote.opaque) : checkout()));
      }
      if (name === "withdraw_quote") {
        const saved = stored.get(`operation:${WITHDRAWAL}`);
        return freshWithdrawal ?? (observed?.quote?.[0] || (saved ? decodeOpaque<WithdrawQuote>(withdrawalType, JSON.parse(new TextDecoder().decode(saved)).quote.opaque) : withdrawal()));
      }
      return observed ? [observed] : [];
    },
    update: async (name: string, request: { quote: Checkout | WithdrawQuote }, fees: Fee) => {
      events.push(`update:${name}`); updates.push({ name, request, fee: fees }); if (updateError) throw updateError; return updateResult;
    },
  };
  mock.module("../src/client.ts", () => ({ ...actualClient, protocolClient: async () => client, randomId: () => (++idCounter).toString(16).padStart(32, "0") }));
  const { runPurchase, runWithdrawal, resumeOperation, operationStatus } = await import("../src/actions.ts");
  function context(root = false): MsgBusToolContext {
    return {
      agentMode: root, signal: new AbortController().signal,
      caller: { appId: root ? "agent" : "marketplace", installationUid: "original-installation", role: root ? "background" : "tile", endpoint: root ? "app:agent:background" : "app:marketplace:tile:main:instance:test" },
      requestApproval: async (review: JsonObject) => { events.push("review"); reviews.push(review); },
      kernel: {
        querySelf: async (name: string, args: unknown[]) => {
          if (name !== "marketplace_draft") throw new Error(`Unexpected self query ${name}`);
          const saved = stored.get(args[0] as string); return saved === undefined ? [] : [saved];
        },
        updateSelf: async (name: string, args: Array<{ id: string; value: Uint8Array; expected?: Uint8Array; revision?: string }>) => {
          const { id, value } = args[0]!;
          if (name === "marketplace_revise_draft") {
            if (JSON.stringify([...stored.get(id) ?? []]) !== JSON.stringify([...args[0]!.expected ?? []])) return { err: "The saved operation changed." };
            stored.set(`history:${id}:${args[0]!.revision}`, new Uint8Array(stored.get(id)!));
            stored.set(id, new Uint8Array(value)); events.push("revise"); return { ok: id };
          }
          if (name !== "marketplace_save_draft") throw new Error(`Unexpected self update ${name}`);
          if (stored.has(id) && (stored.get(id)!.length !== value.length || !stored.get(id)!.every((byte, index) => byte === value[index]))) return { err: "This operation ID already belongs to a different saved intent." };
          events.push("save"); stored.set(id, new Uint8Array(value)); return { ok: value };
        },
        callTool: async (call: WalletCall) => {
          if (call.name === "marketplace_owner_review_v1") {
            events.push("owner-review"); reviews.push(JSON.parse((call.arguments as unknown as { reviewJson: string }).reviewJson)); return { approved: ownerApproved };
          }
          events.push("wallet"); walletCalls.push(call);
          if (fundingError) throw fundingError;
          const status = fundingReplies.shift() ?? "approved";
          return { status, commandId: `marketplace:${call.arguments.requestId}`, blockIndex: status === "approved" ? "779988" : null, duplicate: status === "approved" ? false : null, message: status === "rejected" ? "The saved Wallet request expired." : null };
        },
      },
    } as unknown as MsgBusToolContext;
  }
  beforeEach(() => {
    stored = new Map(); events = []; walletCalls = []; reviews = []; updates = []; observed = null; updateResult = result("complete");
    fundingError = null; updateError = null; queryError = null; idCounter = 0; freshPurchase = null; freshWithdrawal = null; ownerApproved = true;
    fundingReplies = [];
  });
  afterEach(() => { restoreClock?.(); restoreClock = null; });
  function storedPurchase() {
    return JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!)) as { scope: unknown; quote: PurchaseQuote; funding: PurchaseFundingRequest };
  }
  function expireFunding(field: "validUntilNs" | "expiresAtNs"): bigint {
    const funding = storedPurchase().funding;
    const expires = field === "validUntilNs" ? funding.validUntilNs : funding.route.expiresAtNs;
    const nowMs = Number(BigInt(expires) / 1_000_000n) + 1000;
    const clock = spyOn(Date, "now").mockReturnValue(nowMs);
    restoreClock = () => clock.mockRestore();
    return BigInt(nowMs) * 1_000_000n;
  }
  function assertRenewed(previousBytes: Uint8Array, now: bigint) {
    const previous = JSON.parse(new TextDecoder().decode(previousBytes)) as ReturnType<typeof storedPurchase>;
    const current = storedPurchase();
    expect(current.scope).toEqual(previous.scope);
    expect(current.quote.operationId).toBe(OPERATION);
    expect(current.quote.opaque).toEqual(previous.quote.opaque);
    expect(current.funding.requestId).not.toBe(previous.funding.requestId);
    expect(current.funding.amountAtoms).toBe(previous.funding.amountAtoms);
    expect(current.funding.route.spender).toBe(previous.funding.route.spender);
    expect(BigInt(current.funding.validUntilNs)).toBeGreaterThan(now);
    expect(BigInt(current.funding.validUntilNs) - now).toBeLessThanOrEqual(240_000_000_000n);
    expect(BigInt(current.funding.route.expiresAtNs)).toBeGreaterThanOrEqual(BigInt(current.funding.validUntilNs));
    expect(BigInt(current.funding.route.expiresAtNs) - now).toBeLessThanOrEqual(300_000_000_000n);
    const history = [...stored.entries()].filter(([key]) => key.startsWith(`history:operation:${OPERATION}:`));
    expect(history.some(([, bytes]) => Buffer.from(bytes).equals(Buffer.from(previousBytes)))).toBe(true);
    expect(events.lastIndexOf("revise")).toBeGreaterThan(events.indexOf("owner-review") >= 0 ? events.indexOf("owner-review") : events.indexOf("review"));
    return current;
  }

  describe("durable purchase funding", () => {
    test("saves exact funding before Wallet and respects the deployed Wallet validity window", async () => {
      const now = BigInt(Date.now()) * 1000000n;
      expect((await runPurchase(context(), view(checkout()))).state).toBe("complete");
      expect(events.indexOf("save")).toBeLessThan(events.indexOf("wallet"));
      expect(events.indexOf("wallet")).toBeLessThan(events.indexOf("update:purchase"));
      const funding = walletCalls[0]!.arguments;
      expect(funding.amountAtoms).toBe("9000000");
      const source = readFileSync(new URL("../../wallet/backend/main.mo", import.meta.url), "utf8");
      const validity = BigInt(source.match(/MAX_FUNDING_VALIDITY_NS\s*:\s*Nat64\s*=\s*([\d_]+)/)![1]!.replaceAll("_", ""));
      const lifetime = BigInt(source.match(/MAX_ALLOWANCE_LIFETIME_NS\s*:\s*Nat64\s*=\s*([\d_]+)/)![1]!.replaceAll("_", ""));
      expect(BigInt(funding.validUntilNs) - now).toBeLessThanOrEqual(validity);
      expect(BigInt(funding.route.expiresAtNs) - now).toBeLessThanOrEqual(lifetime);
      expect(BigInt(funding.route.expiresAtNs)).toBeGreaterThanOrEqual(BigInt(funding.validUntilNs));
      const saved = JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!));
      expect(saved.funding).toEqual(funding);
      expect(updates[0]!.request.quote.request.requestId).toBe(OPERATION);
    });

    test("interrupted Wallet reply resumes byte-identical funding without a new approval identity", async () => {
      const quote = view(checkout());
      fundingError = new Error("Wallet reply interrupted after dispatch");
      await expect(runPurchase(context(), quote)).rejects.toThrow("interrupted");
      expect(updates).toHaveLength(0);
      const first = structuredClone(walletCalls[0]!.arguments);
      fundingError = null;
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      expect(walletCalls).toHaveLength(2);
      expect(walletCalls[1]!.arguments).toEqual(first);
      expect(idCounter).toBe(1);
    });

    test("lost purchase response reconciles its dispatched attempt without another Wallet call", async () => {
      const quote = view(checkout());
      updateError = new Error("Protocol reply interrupted");
      expect((await runPurchase(context(), quote)).state).toBe("pending");
      observed = result("outcome_unknown");
      updateError = null;
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(2);
      expect(encodeOpaque(checkoutType, updates[0]!.request.quote)).toEqual(encodeOpaque(checkoutType, updates[1]!.request.quote));
    });

    test("unavailable status blocks further approval and protocol dispatch", async () => {
      const quote = view(checkout());
      updateError = new Error("Protocol reply lost");
      await runPurchase(context(), quote);
      queryError = new Error("Status offline");
      await expect(resumeOperation(context(), OPERATION)).rejects.toThrow("Status offline");
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(1);
    });

    test("an active call, blocked unresolved outcome, or completed purchase never asks Wallet again", async () => {
      const quote = view(checkout());
      await runPurchase(context(), quote);
      for (const status of [result("dispatched", "purchase", "await_current_call"), result("outcome_unknown", "purchase", "review_required"), result("complete")]) {
        observed = status;
        expect((await resumeOperation(context(), OPERATION)).nextAction).toBe("none");
      }
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(1);
    });

    test("free claims have no Wallet funding", async () => {
      expect((await runPurchase(context(), view(checkout(0n)))).state).toBe("complete");
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!)).funding).toBeNull();
    });

    test("a changed quote under a saved ID is rejected before financial calls", async () => {
      const quote = view(checkout());
      fundingError = new Error("Interrupted");
      await expect(runPurchase(context(), quote)).rejects.toThrow("Interrupted");
      await expect(runPurchase(context(), { ...quote, commitment: "different" })).rejects.toThrow("commitment");
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(0);
    });

    test("competing initial calls cannot overwrite the retained Wallet identity", async () => {
      const quote = view(checkout()), ctx = context();
      const results = await Promise.allSettled([runPurchase(ctx, quote), runPurchase(ctx, quote)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!)).funding).toEqual(walletCalls[0]!.arguments);
    });

    test("restoring a dispatched protocol record after local uninstall never generates another approval", async () => {
      const wire = checkout();
      observed = { ...result("outcome_unknown"), quote: [wire] };
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(1);
      expect(encodeOpaque(checkoutType, updates[0]!.request.quote)).toEqual(encodeOpaque(checkoutType, wire));
    });
  });

  describe("purchase activity without a payment", () => {
    test("an explicitly rejected allowance stays canceled after status reload without any financial call", async () => {
      fundingReplies = ["rejected"];
      const canceled = await runPurchase(context(), view(checkout()));
      expect(canceled).toMatchObject({ state: "failed", nextAction: "none", checkoutCanceled: true, canDismiss: true });
      expect(updates).toHaveLength(0);
      const before = new Map(stored);
      const restored = await operationStatus(context(), OPERATION);
      expect(restored).toEqual(canceled);
      expect(stored).toEqual(before);
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(0);
    });

    test("approval completed before an interrupted purchase is dismissible without discarding its saved request", async () => {
      const ctx = context(), controller = new AbortController();
      ctx.signal = controller.signal;
      const call = ctx.kernel.callTool.bind(ctx.kernel);
      ctx.kernel.callTool = (async (...args: Parameters<typeof call>) => {
        const value = await call(...args);
        controller.abort(new Error("Checkout closed after allowance approval"));
        return value;
      }) as typeof ctx.kernel.callTool;
      await expect(runPurchase(ctx, view(checkout()))).rejects.toThrow("Checkout closed");
      const restored = await operationStatus(context(), OPERATION);
      expect(restored).toMatchObject({ state: "approval_required", nextAction: "resume", canDismiss: true });
      expect(restored.checkoutCanceled).not.toBe(true);
      expect(restored.message).toContain("allowance was approved");
      expect(stored.has(`operation:${OPERATION}`)).toBe(true);
      expect(updates).toHaveLength(0);
      expect(walletCalls).toHaveLength(1);
    });

    test("a lost purchase reply remains recovery work even before the protocol status becomes visible", async () => {
      updateError = new Error("Purchase reply lost");
      await runPurchase(context(), view(checkout()));
      const before = new Map(stored);
      const restored = await operationStatus(context(), OPERATION);
      expect(restored).toMatchObject({ state: "pending", nextAction: "resume" });
      expect(restored.canDismiss).not.toBe(true);
      expect(restored.checkoutCanceled).not.toBe(true);
      expect(stored).toEqual(before);
      expect(updates).toHaveLength(1);
      expect(walletCalls).toHaveLength(1);
      // Retaining the dispatch marker also avoids asking for another allowance
      // when the original purchase status has not propagated to this query.
      updateError = null;
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      expect(walletCalls).toHaveLength(1);
      expect(updates).toHaveLength(2);
      expect(updates[1]!.request.quote).toEqual(updates[0]!.request.quote);
    });

    test("legacy checkout can be dismissed as an observation and later payment evidence resurfaces", async () => {
      await runPurchase(context(true), view(checkout()));
      const previous = JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!));
      delete previous.progress;
      stored.set(`operation:${OPERATION}`, new TextEncoder().encode(JSON.stringify(previous)));
      const legacy = await operationStatus(context(true), OPERATION);
      expect(legacy.canDismiss).toBe(true);
      expect(legacy.checkoutCanceled).not.toBe(true);
      expect(legacy.message).toContain("currently recorded");
      observed = { ...result("outcome_unknown", "purchase", "review_required"), attempt: [{ block: [], state: { outcome_unknown: null }, hadUnknown: true }] };
      const unresolved = await operationStatus(context(true), OPERATION);
      expect(unresolved).toMatchObject({ state: "pending", nextAction: "none" });
      expect(unresolved.canDismiss).not.toBe(true);
      expect(unresolved.checkoutCanceled).not.toBe(true);
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    test("later live payment takes precedence over an old approval rejection", async () => {
      fundingReplies = ["rejected"];
      await runPurchase(context(), view(checkout()));
      observed = { ...result("dispatched", "purchase", "await_current_call"), active: true };
      const restored = await operationStatus(context(), OPERATION);
      expect(restored.state).toBe("pending");
      expect(restored.checkoutCanceled).not.toBe(true);
      expect(restored.canDismiss).not.toBe(true);
      expect(updates).toHaveLength(0);
    });

    test("a rejected approval cannot declare an untracked legacy dispatch canceled", async () => {
      await runPurchase(context(true), view(checkout()));
      const previous = JSON.parse(new TextDecoder().decode(stored.get(`operation:${OPERATION}`)!));
      delete previous.progress;
      stored.set(`operation:${OPERATION}`, new TextEncoder().encode(JSON.stringify(previous)));
      const rejected = { status: "rejected", commandId: `agent:${previous.funding.requestId}`, blockIndex: null, duplicate: null, message: "Declined" };
      const result = await resumeOperation(context(true), OPERATION, rejected);
      expect(result.checkoutCanceled).not.toBe(true);
      expect(result.canDismiss).not.toBe(true);
      expect(result.state).toBe("pending");
      expect(updates).toHaveLength(0);
    });

    test("only a conclusive no-effect attempt is dismissible", async () => {
      await runPurchase(context(true), view(checkout()));
      observed = { ...result("funding_required", "purchase", "funding_required"), attempt: [{ block: [], state: { no_effect: null }, hadUnknown: false }] };
      expect((await operationStatus(context(true), OPERATION)).canDismiss).toBe(true);
      observed.attempt[0]!.hadUnknown = true;
      expect((await operationStatus(context(true), OPERATION)).canDismiss).not.toBe(true);
      observed.attempt[0]!.hadUnknown = false;
      observed.active = true;
      expect((await operationStatus(context(true), OPERATION)).canDismiss).not.toBe(true);
      expect(updates).toHaveLength(0);
    });

    test("an explicit protocol refusal is durable and cannot be confused with a lost response", async () => {
      updateError = new actualClient.ProtocolError("quote_changed", "Review current costs");
      const rejected = await runPurchase(context(), view(checkout()));
      expect(rejected).toMatchObject({ state: "failed", nextAction: "review", canDismiss: true });
      expect(await operationStatus(context(), OPERATION)).toEqual(rejected);
      expect(updates).toHaveLength(1);
      expect(walletCalls).toHaveLength(1);
    });
  });

  describe("reviewed same-ID quote revisions", () => {
    test("changed purchase terms retain old evidence and require owner review before new funding", async () => {
      const wire = checkout(); updateError = new actualClient.ProtocolError("quote_changed", "Review current costs");
      expect((await runPurchase(context(), view(wire))).state).toBe("failed");
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      freshPurchase = { ...checkout(9100000n), commitment: new Uint8Array(32).fill(8), spender: { owner: principal(PROTOCOL), subaccount: [new Uint8Array(32).fill(10)] } };
      updateError = null; ownerApproved = false;
      await expect(resumeOperation(context(), OPERATION)).rejects.toThrow("declined");
      expect(stored.get(`operation:${OPERATION}`)).toEqual(old); expect(walletCalls).toHaveLength(1);
      ownerApproved = true;
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      expect(walletCalls).toHaveLength(2);
      expect(walletCalls[1]!.arguments.requestId).not.toBe(walletCalls[0]!.arguments.requestId);
      expect(walletCalls[1]!.arguments.amountAtoms).toBe("9100000");
      expect(updates[1]!.request.quote.request.requestId).toBe(OPERATION);
      expect([...stored.entries()].some(([key, bytes]) => key.startsWith(`history:operation:${OPERATION}:`) && Buffer.from(bytes).equals(Buffer.from(old)))).toBe(true);
      expect(events.lastIndexOf("owner-review")).toBeLessThan(events.lastIndexOf("wallet"));
    });
    test("frozen unknown outcomes reject different supplied costs without replacing funding", async () => {
      const wire = checkout(); updateError = new Error("lost response"); await runPurchase(context(), view(wire));
      const history = [...stored.keys()].filter(key => key.startsWith("history:"));
      observed = { ...result("outcome_unknown"), quote: [wire] }; updateError = null;
      const changed = { ...checkout(9100000n), commitment: new Uint8Array(32).fill(8) };
      await expect(runPurchase(context(), view(changed))).rejects.toThrow("original terms");
      expect(walletCalls).toHaveLength(1); expect(updates).toHaveLength(1);
      expect([...stored.keys()].filter(key => key.startsWith("history:"))).toEqual(history);
    });
    test("changed withdrawal fee preserves the original recipient and total debit", async () => {
      updateError = new actualClient.ProtocolError("quote_changed", "Review current fee");
      expect((await runWithdrawal(context(), withdrawalView(withdrawal()))).state).toBe("failed");
      freshWithdrawal = { ...withdrawal(), fee: 11000n, netAmount: 989000n, commitment: new Uint8Array(32).fill(4) };
      updateError = null; updateResult = result("complete", "withdrawal");
      expect((await resumeOperation(context(), WITHDRAWAL)).state).toBe("complete");
      expect(walletCalls).toHaveLength(0);
      expect((updates[1]!.request.quote as WithdrawQuote).request).toEqual(withdrawal().request);
      expect((updates[1]!.request.quote as WithdrawQuote).fee).toBe(11000n);
      expect(reviews).toHaveLength(1);
    });
  });

  describe("expired Wallet funding renewal", () => {
    test("a terminal expired rejection needs owner review before archiving and renewing the bounded approval", async () => {
      fundingReplies = ["pending"];
      expect((await runPurchase(context(), view(checkout()))).state).toBe("pending");
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      events = [];
      const now = expireFunding("validUntilNs");
      fundingReplies = ["rejected"]; ownerApproved = false;
      await expect(resumeOperation(context(), OPERATION)).rejects.toThrow("declined");
      expect(stored.get(`operation:${OPERATION}`)).toEqual(old);
      expect(updates).toHaveLength(0);
      expect(events).not.toContain("revise");
      fundingReplies = ["rejected", "approved"]; ownerApproved = true;
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      const current = assertRenewed(old, now);
      expect(walletCalls.at(-1)!.arguments).toEqual(current.funding);
      expect(walletCalls.slice(0, -1).every(call => call.arguments.requestId === walletCalls[0]!.arguments.requestId)).toBe(true);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.request.quote.request.requestId).toBe(OPERATION);
      expect(events.lastIndexOf("owner-review")).toBeLessThan(events.lastIndexOf("revise"));
      expect(events.slice(events.lastIndexOf("owner-review") + 1, events.lastIndexOf("wallet"))).toContain("revise");
    });

    test("a confirmed old approval renews after allowance expiry only with a known no-effect funding-required attempt", async () => {
      updateResult = { ...result("failed", "purchase", "funding_required"), attempt: [{ block: [], state: { no_effect: null }, hadUnknown: false }] };
      expect((await runPurchase(context(), view(checkout()))).state).toBe("failed");
      observed = updateResult;
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      const now = expireFunding("expiresAtNs");
      updateResult = result("complete");
      expect((await resumeOperation(context(), OPERATION)).state).toBe("complete");
      const current = assertRenewed(old, now);
      expect(walletCalls).toHaveLength(3);
      expect(walletCalls[1]!.arguments).toEqual(walletCalls[0]!.arguments);
      expect(walletCalls[2]!.arguments).toEqual(current.funding);
      expect(updates).toHaveLength(2);
      expect(encodeOpaque(checkoutType, updates[1]!.request.quote)).toEqual(encodeOpaque(checkoutType, updates[0]!.request.quote));
    });

    for (const outcome of ["pending", "throw"] as const) test(`an expired ${outcome} Wallet outcome never rotates its identity`, async () => {
      fundingReplies = ["pending"];
      await runPurchase(context(), view(checkout()));
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      events = [];
      expireFunding("expiresAtNs");
      if (outcome === "throw") {
        fundingError = new Error("Wallet transport interrupted");
        await expect(resumeOperation(context(), OPERATION)).rejects.toThrow("transport interrupted");
      } else {
        fundingReplies = ["pending"];
        expect((await resumeOperation(context(), OPERATION)).state).toBe("pending");
      }
      expect(stored.get(`operation:${OPERATION}`)).toEqual(old);
      expect(walletCalls).toHaveLength(2);
      expect(walletCalls[1]!.arguments).toEqual(walletCalls[0]!.arguments);
      expect(updates).toHaveLength(0);
      expect(events).not.toContain("revise");
      expect(idCounter).toBe(1);
    });

    for (const state of ["outcome_unknown", "failed"]) test(`a ${state} attempt with prior uncertainty cannot renew an expired approval`, async () => {
      updateError = new Error("Protocol reply lost");
      await runPurchase(context(), view(checkout()));
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      events = [];
      expireFunding("expiresAtNs");
      observed = { ...result(state, "purchase", "funding_required"), attempt: [{ block: [], state: { [state === "failed" ? "no_effect" : "outcome_unknown"]: null }, hadUnknown: true }] };
      updateResult = observed; updateError = null; fundingReplies = ["rejected"];
      await resumeOperation(context(), OPERATION);
      expect(stored.get(`operation:${OPERATION}`)).toEqual(old);
      expect(events).not.toContain("revise");
      expect(walletCalls.every(call => call.arguments.requestId === walletCalls[0]!.arguments.requestId)).toBe(true);
      expect(idCounter).toBe(1);
    });

    test("root missing evidence returns the original instruction, while terminal expired rejection requires a new exact reviewed instruction", async () => {
      const ctx = context(true);
      const initial = await runPurchase(ctx, view(checkout()));
      const oldInstruction = initial.fundingInstructions![0]!;
      const old = new Uint8Array(stored.get(`operation:${OPERATION}`)!);
      const now = expireFunding("validUntilNs");
      expect((await resumeOperation(ctx, OPERATION)).fundingInstructions).toEqual(initial.fundingInstructions);
      expect(stored.get(`operation:${OPERATION}`)).toEqual(old);
      expect(events).not.toContain("revise");
      const renewed = await resumeOperation(ctx, OPERATION, { status: "rejected", commandId: `agent:${oldInstruction.arguments.requestId}`, blockIndex: null, duplicate: null, message: "Expired" });
      expect(renewed.state).toBe("approval_required");
      const current = assertRenewed(old, now);
      const instruction = renewed.fundingInstructions![0]!;
      expect(instruction.name).toBe("wallet_fund_root_v1");
      expect(instruction.arguments).toEqual(current.funding);
      expect((reviews.at(-1)!.quote as unknown as PurchaseQuote).opaque).toEqual(storedPurchase().quote.opaque);
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
      const success = { status: "approved", commandId: `agent:${oldInstruction.arguments.requestId}`, blockIndex: "780000", duplicate: false, message: null };
      await expect(resumeOperation(ctx, OPERATION, success)).rejects.toThrow("caller");
      expect(updates).toHaveLength(0);
      expect((await resumeOperation(ctx, OPERATION, { ...success, commandId: `agent:${instruction.arguments.requestId}` })).state).toBe("complete");
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.request.quote.request.requestId).toBe(OPERATION);
    });
  });

  describe("root and normal approval authority", () => {
    test("root returns the exact saved instruction and never invokes nested root Wallet", async () => {
      const ctx = context(true), quote = view(checkout());
      const first = await runPurchase(ctx, quote), repeated = await resumeOperation(ctx, OPERATION);
      expect(first.state).toBe("approval_required");
      expect(repeated.fundingInstructions).toEqual(first.fundingInstructions);
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
      const instruction = first.fundingInstructions![0]!;
      expect(instruction.name).toBe("wallet_fund_root_v1");
      const approval = { status: "approved", commandId: `agent:${instruction.arguments.requestId}`, blockIndex: "780000", duplicate: false, message: null };
      await expect(resumeOperation(ctx, OPERATION, { ...approval, commandId: `marketplace:${instruction.arguments.requestId}` })).rejects.toThrow("caller");
      expect(updates).toHaveLength(0);
      expect((await resumeOperation(ctx, OPERATION, approval)).state).toBe("complete");
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(1);
    });

    test("rejected normal-agent review leaves the saved request unsigned", async () => {
      const ctx = context(false);
      ctx.caller = { ...ctx.caller!, appId: "agent", role: "background" };
      ctx.presentUserInterface = async () => ({ approved: false }) as never;
      await expect(runPurchase(ctx, view(checkout()))).rejects.toThrow("declined");
      expect(stored.has(`operation:${OPERATION}`)).toBe(true);
      const saved = new Map(stored);
      const restored = await operationStatus(ctx, OPERATION);
      expect(restored).toMatchObject({ state: "approval_required", nextAction: "resume", canDismiss: true });
      expect(restored.message).toContain("payment has not been requested");
      expect(stored).toEqual(saved);
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    test("resuming from another caller does not replace the saved funding scope", async () => {
      const quote = view(checkout());
      await runPurchase(context(true), quote);
      await expect(resumeOperation(context(false), OPERATION)).rejects.toThrow("original application");
      expect(walletCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });

    test("purchase review is reconstructed from executable terms instead of supplied display labels", async () => {
      const quote = view(checkout());
      await expect(runPurchase(context(true), { ...quote, appIds: ["another-app"] })).rejects.toThrow("display");
      expect(stored.size).toBe(0);
      expect(reviews).toHaveLength(0);
      const forged = { ...quote, items: [{ ...quote.items[0]!, title: "Another app", publisher: OWNER }], totalDebit: money(1n) };
      expect((await runPurchase(context(true), forged)).state).toBe("approval_required");
      const reviewed = reviews[0]!.quote as unknown as PurchaseQuote;
      expect(reviewed.items[0]!.title).toBe("Test app");
      expect(reviewed.items[0]!.publisher).toBe(PROTOCOL);
      expect(reviewed.totalDebit).toEqual(quote.totalDebit);
      expect(walletCalls).toHaveLength(0);
    });
  });

  test("withdrawal retry keeps the exact original debit, account and ID and never calls Wallet funding", async () => {
    const wire = withdrawal(), quote = withdrawalView(wire);
    updateError = new Error("Withdrawal reply lost");
    expect((await runWithdrawal(context(), quote)).state).toBe("pending");
    observed = result("outcome_unknown", "withdrawal");
    updateResult = result("complete", "withdrawal"); updateError = null;
    expect((await resumeOperation(context(), WITHDRAWAL)).state).toBe("complete");
    expect(walletCalls).toHaveLength(0);
    expect(updates).toHaveLength(2);
    expect(encodeOpaque(withdrawalType, updates[0]!.request.quote)).toEqual(encodeOpaque(withdrawalType, updates[1]!.request.quote));
  });
}
