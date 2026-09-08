import { expect, test } from "bun:test";
import { createMsgBusClient, type JsonObject, type MsgBusToolContext, type ProviderPresentationRequest } from "neutron-tools/app";
import { authorizeTrade } from "../src/provider.ts";

const owner = { appId: "hyperliquid", installationUid: "17", role: "tile", endpoint: "app:hyperliquid:tile:hyperliquid:instance:owner-1" };
const external = { appId: "kitchensink", installationUid: "23", role: "tile", endpoint: "app:kitchensink:tile:main:instance:external-1" };
const review: JsonObject = {
  title: "Buy ETH perpetual", walletAddress: `0x${"11".repeat(20)}`, environment: "mainnet",
  operationId: "a".repeat(32), caller: { appId: "agent", installationUid: "31" },
  action: { type: "order", orders: [{ a: 1, b: true, p: "4300.5", s: "0.1234", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
};
function context(overrides: Partial<MsgBusToolContext> = {}): MsgBusToolContext {
  const kernel = createMsgBusClient();
  kernel.callTool = async () => { throw new Error("Unexpected owner endpoint call"); };
  return {
    caller: owner, kernel, reportProgress: () => {},
    presentUserInterface: async () => { throw new Error("Unexpected foreground presentation"); },
    ...overrides,
  };
}

test("Agent authority receives the exact prepared review without opening owner UI", async () => {
  const seen: JsonObject[] = [];
  const ctx = context({ caller: external, agentMode: true, requestApproval: async (value) => { seen.push(value); } });
  await authorizeTrade(ctx, review);
  expect(seen).toEqual([review]);
  expect(seen[0]).toBe(review);
});

test("Agent refusal and cancellation prevent authorization from returning successfully", async () => {
  for (const mode of ["rejected", "cancelled"] as const) {
    const abort = new AbortController();
    let called = 0;
    const ctx = context({ caller: external, agentMode: true, signal: abort.signal, requestApproval: async () => {
      called += 1;
      if (mode === "rejected") throw new Error("The owner's intent does not authorize this trade");
      abort.abort(new Error("Invocation cancelled"));
    } });
    await expect(authorizeTrade(ctx, review)).rejects.toThrow(mode === "rejected" ? "does not authorize" : "Invocation cancelled");
    expect(called).toBe(1);
  }
});

test("Agent context without the Kernel approval callback cannot fall back to owner UI", async () => {
  await expect(authorizeTrade(context({ caller: external, agentMode: true }), review)).rejects.toThrow("exact Agent trading review");
});

test("the owner's review returns to the exact originating tile instance", async () => {
  const abort = new AbortController();
  const ctx = context({ signal: abort.signal });
  const calls: unknown[] = [];
  ctx.kernel.callTool = async <T>(call: unknown, options: unknown) => {
    calls.push({ call, options });
    return { approved: true } as T;
  };
  await authorizeTrade(ctx, review);
  expect(calls).toEqual([{ call: { target: owner.endpoint, name: "hl_owner_review_v1", arguments: { reviewJson: JSON.stringify(review) } }, options: { signal: abort.signal } }]);
});

test("external human callers use Kernel foreground presentation, independent of review identity fields", async () => {
  const calls: ProviderPresentationRequest[] = [];
  const ctx = context({ caller: external, presentUserInterface: async <T>(request: ProviderPresentationRequest) => { calls.push(request); return { approved: true } as T; } });
  const forgedReview: JsonObject = { ...review, caller: owner, endpoint: owner.endpoint, appId: "hyperliquid", installationUid: owner.installationUid };
  await authorizeTrade(ctx, forgedReview);
  expect(calls).toEqual([{ tileId: "hyperliquid", tool: "hl_review_v1", arguments: { reviewJson: JSON.stringify(forgedReview) } }]);
});

test("an external endpoint cannot opt into the owner route by resembling an owner tile", async () => {
  let presentations = 0;
  const ctx = context({ caller: { ...external, endpoint: owner.endpoint }, presentUserInterface: async <T>() => { presentations += 1; return { approved: true } as T; } });
  await authorizeTrade(ctx, review);
  expect(presentations).toBe(1);
});

test("missing or invalid caller installation is rejected before any approval callback", async () => {
  for (const caller of [undefined, { ...owner, installationUid: "" }, { ...owner, installationUid: "-1" }, { ...owner, appId: "" }]) {
    let approvals = 0;
    const ctx = context({ agentMode: true, requestApproval: async () => { approvals += 1; } });
    if (caller) ctx.caller = caller; else delete ctx.caller;
    await expect(authorizeTrade(ctx, review)).rejects.toThrow("Kernel-authenticated caller installation identity");
    expect(approvals).toBe(0);
  }
});

test("same-app background, wrong tile and non-instance endpoints cannot request owner approval", async () => {
  const callers = [
    { ...owner, role: "background", endpoint: "app:hyperliquid:background" },
    { ...owner, endpoint: "app:hyperliquid:tile:hyperliquid" },
    { ...owner, endpoint: "app:hyperliquid:tile:other:instance:owner-1" },
    { ...owner, endpoint: "app:kitchensink:tile:hyperliquid:instance:owner-1" },
    { ...owner, endpoint: owner.endpoint + ":other" },
  ];
  for (const caller of callers) await expect(authorizeTrade(context({ caller }), review)).rejects.toThrow("originating Hyperliquid tile");
});

test("human decline and malformed approval responses cannot authorize a trade", async () => {
  for (const outcome of [{ approved: false }, {}, { approved: "true" }, null]) {
    for (const own of [true, false]) {
      const ctx = context({ caller: own ? owner : external });
      ctx.kernel.callTool = async <T>() => outcome as T;
      ctx.presentUserInterface = async <T>() => outcome as T;
      await expect(authorizeTrade(ctx, review)).rejects.toThrow("Trade review declined");
    }
  }
});

test("cancellation before or during human review is preserved on both routes", async () => {
  for (const own of [true, false]) {
    for (const before of [true, false]) {
      const abort = new AbortController();
      let calls = 0;
      const approve = async <T>() => { calls += 1; abort.abort(new Error("Review cancelled")); return { approved: true } as T; };
      const ctx = context({ caller: own ? owner : external, signal: abort.signal, presentUserInterface: approve });
      ctx.kernel.callTool = approve;
      if (before) abort.abort(new Error("Review cancelled"));
      await expect(authorizeTrade(ctx, review)).rejects.toThrow("Review cancelled");
      expect(calls).toBe(before ? 0 : 1);
    }
  }
});
