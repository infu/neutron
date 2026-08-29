import { afterEach, expect, test } from "bun:test";
import { MSG_BUS_MAX_PAYLOAD_BYTES } from "neutron-tools/protocol";
import type { RegisteredEndpoint } from "../src/frame_context.ts";
import {
  approveAgentGrant,
  admitAgentWorkspaceMutation,
  beginAgentRoot,
  clearAgentModeForAuth,
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

test("agent authority is bound to one activated declared root", async () => {
  await grantAgent();
  const caller = tile("agent");
  const resident = background("agent");
  const root = beginAgentRoot({
    caller,
    target: resident,
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
    activated: true,
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
      activated: true,
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
    activated: true,
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
    activated: true,
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
    activated: true,
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
    activated: true,
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
    activated: true,
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

test("agent root starts and workspace mutations are bounded", async () => {
  await grantAgent();
  const resident = background("agent");
  for (let index = 0; index < 6; index += 1) {
    const root = beginAgentRoot({
      caller: tile("agent"),
      target: resident,
      tool: "agent_chat",
      ownerPrincipal: owner,
      installedVersion: 100,
      activated: true,
    })!;
    completeInvocation(root);
  }
  expect(() =>
    beginAgentRoot({
      caller: tile("agent"),
      target: resident,
      tool: "agent_chat",
      ownerPrincipal: owner,
      installedVersion: 100,
      activated: true,
    }),
  ).toThrow("Agent turn start limit reached");
});

test("workspace limits are root-bound and active descendants are app-wide", async () => {
  await grantAgent();
  const root = beginAgentRoot({
    caller: tile("agent"),
    target: background("agent"),
    tool: "agent_chat",
    ownerPrincipal: owner,
    installedVersion: 100,
    activated: true,
  })!;
  const child = createChildInvocation(root, background("wallet"), "send");
  expect(hasActiveInvocationForApp("wallet")).toBe(true);
  const now = Date.now();
  admitAgentWorkspaceMutation(child, true, now);
  expect(() => admitAgentWorkspaceMutation(child, false, now + 1_000)).toThrow(
    "Agent tile focus limit reached",
  );
  expect(() => admitAgentWorkspaceMutation(child, true, now + 2_000)).toThrow(
    "Agent tile opening limit reached",
  );
  admitAgentWorkspaceMutation(child, true, now + 20_000);
  completeInvocation(child);
  completeInvocation(root);
  expect(hasActiveInvocationForApp("wallet")).toBe(false);
});
