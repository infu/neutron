import { afterEach, expect, test } from "bun:test";
import { MSG_BUS_MAX_PAYLOAD_BYTES } from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../src/frame_context.ts";
import {
  approveAgentGrant,
  beginAgentRoot,
  clearAgentModeForAuth,
  cancelAgentRoot,
  completeInvocation,
  createChildInvocation,
  invocationMetadata,
  hasActiveInvocationForApp,
  isDirectAgentInvocation,
  requestAgentConsent,
  requestAgentGrant,
  resolveInvocation,
  useAgentModeStore,
} from "../src/ui_attention/agent.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";

const owner = "2muv7-iopdh-zcmmn-yb3ls-ane4w-ei7h2-gketm-rnyra-cxzmm-y6qy2-wqe";

function tile(appId: string, installationUid = "101"): RegisteredEndpoint {
  return {
    endpointId: `app:${appId}:tile:chat:instance:one`,
    source: {} as Window,
    context: {
      role: "tile",
      appId,
      tileId: "chat",
      instanceId: "one",
      workspace: 1,
    },
    sessionId: `${appId}-tile-session-0001`,
    appScope: { appId, installationUid },
  };
}

function background(
  appId: string,
  installationUid = appId === "agent" ? "101" : "201",
): RegisteredEndpoint {
  return {
    endpointId: `app:${appId}:background`,
    source: {} as Window,
    context: { role: "background", appId },
    sessionId: `${appId}-background-session-0001`,
    appScope: { appId, installationUid },
  };
}

function tray(appId: string): RegisteredEndpoint {
  return {
    endpointId: `app:${appId}:tray:instance:panel-one`,
    source: {} as Window,
    context: { role: "tray", appId, instanceId: "panel-one" },
    sessionId: `${appId}-tray-session-0001`,
    appScope: { appId, installationUid: "201" },
  };
}

afterEach(() => {
  clearAgentModeForAuth();
  resetUiAttentionState();
});

async function grantAgent(): Promise<void> {
  const pending = requestAgentGrant({
    appId: "agent",
    appName: "Agent",
    version: 100,
    installationUid: "101",
    entrypoint: "agent_chat",
    ownerPrincipal: owner,
  });
  approveAgentGrant();
  await pending;
}

test("request cancellation removes a pending agent grant", async () => {
  const controller = new AbortController();
  const pending = requestAgentGrant(
    {
      appId: "agent",
      appName: "Agent",
      version: 100,
      installationUid: "101",
      entrypoint: "agent_chat",
      ownerPrincipal: owner,
    },
    controller.signal,
  );
  expect(useAgentModeStore.getState().pendingGrant?.appId).toBe("agent");

  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useAgentModeStore.getState().pendingGrant).toBeNull();

  await grantAgent();
  expect(useAgentModeStore.getState().grant?.appId).toBe("agent");
});

test("an enabled exact root starts without per-turn focus or activation", async () => {
  await grantAgent();
  const caller = tile("agent");
  const resident = background("agent");
  const root = beginAgentRoot({
    caller,
    target: resident,
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  });
  expect(root).not.toBeNull();
  expect(isDirectAgentInvocation(root)).toBe(true);
  expect(resolveInvocation(resident, invocationMetadata(root!, true))).toBe(root);

  expect(() =>
    resolveInvocation(background("other"), invocationMetadata(root!, true)),
  ).toThrow("Invalid invocation context");
  completeInvocation(root!);
  expect(useAgentModeStore.getState().activeRoot).toBeNull();
  expect(() =>
    resolveInvocation(resident, invocationMetadata(root!, true)),
  ).toThrow("Invalid invocation context");
});

test("agent authority does not survive an app reinstall at the same version", async () => {
  await grantAgent();
  expect(
    beginAgentRoot({
      caller: tile("agent", "102"),
      target: background("agent", "102"),
      tool: "agent_chat",
      ownerPrincipal: owner,
      installedVersion: 100,
    }),
  ).toBeNull();
});

test("downstream permission requires one exact agent decision", async () => {
  await grantAgent();
  const resident = background("agent");
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: resident,
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;
  const child = createChildInvocation(root, background("wallet"), "send");
  let challengeId = "";

  await requestAgentConsent(
    child,
    {
      kind: "backend_access",
      persistence: "durable",
      risk: "high",
      action: { scope: "principal", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
    },
    async (challenge) => {
      challengeId = challenge.id;
      expect(challenge.requester.appId).toBe("wallet");
      expect(challenge.chain.map((entry) => entry.appId)).toEqual([
        "agent",
        "wallet",
      ]);
      return { decision: "allow", reason: "Needed for the requested transfer" };
    },
  );

  expect(challengeId).not.toBe("");
  expect(useAgentModeStore.getState().decisions.at(-1)).toMatchObject({
    id: challengeId,
    decision: "allow",
    requesterAppId: "wallet",
  });
  completeInvocation(child);
  completeInvocation(root);
});

test("request cancellation settles and removes a nested agent decision", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;
  const child = createChildInvocation(root, background("wallet"), "send");
  const controller = new AbortController();
  let dispatchSignal: AbortSignal | undefined;
  const pending = requestAgentConsent(
    child,
    {
      kind: "connection",
      persistence: "durable",
      risk: "high",
      action: { provider: "wallet" },
    },
    async (_challenge, signal) => {
      dispatchSignal = signal;
      return new Promise(() => undefined);
    },
    controller.signal,
  );

  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(dispatchSignal).toBe(controller.signal);
  expect(dispatchSignal?.aborted).toBe(true);
  expect(child.status).toBe("active");
  expect(useAgentModeStore.getState().decisions).toHaveLength(0);

  await expect(
    requestAgentConsent(child, {
      kind: "frontend_tool",
      persistence: "none",
      risk: "low",
      action: { tool: "read" },
    }, async () => ({ decision: "allow", reason: "Safe read" })),
  ).resolves.toBeUndefined();
  expect(useAgentModeStore.getState().decisions).toHaveLength(1);
  completeInvocation(child);
  completeInvocation(root);
});

test("an oversized agent consent challenge fails before dispatch", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;
  const child = createChildInvocation(root, background("wallet"), "send");
  let dispatched = false;

  await expect(
    requestAgentConsent(
      child,
      {
        kind: "signed_canister_call",
        persistence: "none",
        risk: "high",
        action: { arguments: ["x".repeat(MSG_BUS_MAX_PAYLOAD_BYTES)] },
      },
      async () => {
        dispatched = true;
        return { decision: "allow", reason: "should not run" };
      },
    ),
  ).rejects.toThrow("Agent consent challenge exceeds");
  expect(dispatched).toBe(false);
  completeInvocation(child);
  completeInvocation(root);
});

test("delegated agent calls cannot target a transient tray popout", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;

  expect(() => createChildInvocation(root, tray("wallet"), "send")).toThrow(
    "Tray popouts cannot receive delegated agent calls",
  );
  completeInvocation(root);
});

test("a denial closes the descendant permission path", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;
  const child = createChildInvocation(root, background("untrusted"), "run");
  const summary = {
    kind: "signed_canister_call" as const,
    persistence: "none" as const,
    risk: "high" as const,
    action: { canister: "aaaaa-aa", method: "install_code" },
  };

  await expect(
    requestAgentConsent(child, summary, async () => ({
      decision: "deny",
      reason: "Unrelated and unsafe",
    })),
  ).rejects.toMatchObject({
    code: "AGENT_CONSENT_DENIED",
  });
  await expect(
    requestAgentConsent(child, summary, async () => ({
      decision: "allow",
      reason: "retry",
    })),
  ).rejects.toMatchObject({
    code: "AGENT_MODE_REVOKED",
  });
  completeInvocation(root);
});

test("agent roots can continue beyond the old duration and call budgets, one at a time", async () => {
  await grantAgent();
  const resident = background("agent");
  const start = () => beginAgentRoot({ caller: tile("agent"), target: resident,
    tool: "agent_chat", ownerPrincipal: owner, installedVersion: 100 })!;
  for (let index = 0; index < 25; index += 1) {
    const root = start();
    expect(() => start()).toThrow("Another agent turn is already running");
    for (let call = 0; call < 80; call += 1) {
      completeInvocation(createChildInvocation(root, background("records"), "read"));
    }
    expect(resolveInvocation(resident, invocationMetadata(root))).toBe(root);
    completeInvocation(root);
  }
});

test("a long root retains caller identity and cancellation revokes late capabilities", async () => {
  await grantAgent();
  const resident = background("agent");
  const caller = tile("agent");
  const root = beginAgentRoot({ caller, target: resident, tool: "agent_chat", ownerPrincipal: owner, installedVersion: 100 })!;
  expect(useAgentModeStore.getState().activeRoot?.callerEndpointId).toBe(caller.endpointId);
  const originalNow = Date.now;
  const later = Date.now() + 86_400_000;
  try {
    Date.now = () => later;
    expect(resolveInvocation(resident, invocationMetadata(root))).toBe(root);
  } finally { Date.now = originalNow; }
  cancelAgentRoot(root.id, "Stopped by owner");
  expect(() => resolveInvocation(resident, invocationMetadata(root))).toThrow();
  expect(useAgentModeStore.getState().activeRoot).toBeNull();
});

test("active descendants are tracked app-wide", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
  })!;
  const child = createChildInvocation(root, background("wallet"), "send");
  expect(hasActiveInvocationForApp("wallet")).toBe(true);
  completeInvocation(child);
  completeInvocation(root);
  expect(hasActiveInvocationForApp("wallet")).toBe(false);
});
