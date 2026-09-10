import { afterEach, beforeEach, expect, test } from "bun:test";
import { KernelPolicyError } from "neutron-tools";
import type { RepositoryAccessApproval } from "../src/repository_access/client.ts";
import {
  approveInstallOffer,
  clearInstallOffer,
  reconcileInstallOffer,
  rejectInstallOffer,
  requestInstallOffer,
} from "../src/install_offers/service.ts";
import { useInstallOfferStore } from "../src/install_offers/store.ts";
import type { InstallOfferRequestInput } from "../src/install_offers/types.ts";
import {
  resetUiAttentionState,
  useUiAttentionStore,
} from "../src/ui_attention/owner.ts";

beforeEach(() => {
  clearInstallOffer("test reset");
  resetUiAttentionState();
});

afterEach(() => {
  clearInstallOffer("test cleanup");
  resetUiAttentionState();
});

test("presents one inert offer with a request id and owner-attention token", () => {
  let approved = false;
  const first = requestInstallOffer(
    appPackageInput(() => {
      approved = true;
    }),
  );

  expect(first.requestId).toMatch(/^[0-9a-f]{32}$/);
  expect(useInstallOfferStore.getState().pending).toMatchObject({
    requestId: first.requestId,
    offer: {
      kind: "package_url",
      url: "https://packages.example/mail.neutron?campaign=private",
    },
    requester: {
      kind: "app",
      appId: "mail",
      appName: "Mail",
      surface: "tile",
    },
  });
  expect(useUiAttentionStore.getState().active).toMatchObject({
    appId: "mail",
    kind: "install_offer",
  });
  expect(approved).toBe(false);

  expect(() =>
    requestInstallOffer(appPackageInput(() => undefined)),
  ).toThrow("Another install offer is already active");
  rejectInstallOffer(first.requestId);
});

test("approval re-attests then releases the prompt before handoff", async () => {
  const events: string[] = [];
  const handle = requestInstallOffer({
    ...appPackageInput(async (approval) => {
      events.push(`approve:${approval.requestId}`);
      expect(useInstallOfferStore.getState().pending).toBeNull();
      expect(useUiAttentionStore.getState().active).toBeNull();
    }),
    assertCurrent: () => {
      events.push("assert");
    },
  });

  approveInstallOffer(handle.requestId);
  const approval = await handle.completion;

  expect(approval.requestId).toBe(handle.requestId);
  expect(events).toEqual([
    "assert",
    `approve:${handle.requestId}`,
  ]);
  expect(useInstallOfferStore.getState().pending).toBeNull();
});

test("owner approval hands off the exact displayed access fee and freezes it before async work", async () => {
  const descriptor = { protocol: "neutron-repo-access-v1" as const, fee_version: "7", cycles: "123456789" };
  const approvals: RepositoryAccessApproval[] = [{ source: "233tv-xiaaa-aaaay-aacta-cai", descriptor }];
  let delivered: readonly RepositoryAccessApproval[] | undefined;
  const handle = requestInstallOffer(appPackageInput((approval) => {
    delivered = approval.approvedAccess;
  }));

  approveInstallOffer(handle.requestId, approvals);
  descriptor.cycles = "999999999";
  approvals.length = 0;
  const approved = await handle.completion;

  expect(delivered).toEqual([{
    source: "233tv-xiaaa-aaaay-aacta-cai",
    descriptor: { protocol: "neutron-repo-access-v1", fee_version: "7", cycles: "123456789" },
  }]);
  expect(approved.approvedAccess).toBe(delivered);
  expect(Object.isFrozen(delivered)).toBe(true);
  expect(Object.isFrozen(delivered?.[0]?.descriptor)).toBe(true);
});

test("canceling a priced install offer never starts acquisition", async () => {
  let acquisitions = 0;
  const handle = requestInstallOffer(appPackageInput(() => { acquisitions += 1; }));
  rejectInstallOffer(handle.requestId);
  approveInstallOffer(handle.requestId, [{
    source: "233tv-xiaaa-aaaay-aacta-cai",
    descriptor: { protocol: "neutron-repo-access-v1", fee_version: "1", cycles: "100" },
  }]);
  await expect(handle.completion).rejects.toThrow("dismissed");
  expect(acquisitions).toBe(0);
});

test("reconciliation cancels a stale request without handoff", async () => {
  let current = true;
  let approved = false;
  const handle = requestInstallOffer({
    ...appPackageInput(() => {
      approved = true;
    }),
    assertCurrent: () => current,
  });
  current = false;

  expect(reconcileInstallOffer()).toBe(false);
  await expect(handle.completion).rejects.toMatchObject({
    name: "KernelPolicyError",
    code: "REQUEST_CANCELLED",
  });
  expect(approved).toBe(false);
  expect(useUiAttentionStore.getState().active).toBeNull();
});

test("approval converts an attestation exception into a stale cancellation", async () => {
  let approved = false;
  const handle = requestInstallOffer({
    ...appPackageInput(() => {
      approved = true;
    }),
    assertCurrent: () => {
      throw new Error("private endpoint detail");
    },
  });

  approveInstallOffer(handle.requestId);
  await expect(handle.completion).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
    message: "The requesting app or agent is no longer active",
  });
  expect(approved).toBe(false);
});

test("timeout rejects and releases state without invoking install code", async () => {
  let approved = false;
  const handle = requestInstallOffer({
    ...appPackageInput(() => {
      approved = true;
    }),
    timeoutMs: 5,
  });

  await expect(handle.completion).rejects.toMatchObject({
    code: "REQUEST_EXPIRED",
  });
  expect(approved).toBe(false);
  expect(useInstallOfferStore.getState().pending).toBeNull();
  expect(useUiAttentionStore.getState().active).toBeNull();
});

test("agent requests retain Kernel-attested agent attribution", async () => {
  const handle = requestInstallOffer({
    offer: {
      kind: "repository_setup_url",
      url:
        "https://apps.example/install#repo=aaaaa-aa&manifest=social&digest=" +
        "a".repeat(64),
      reference: {
        repo: "aaaaa-aa",
        manifest: "social",
        digest: "a".repeat(64),
      },
    },
    requester: {
      kind: "agent",
      appId: "assistant",
      appName: "Assistant",
      rootAppId: "assistant",
      rootAppName: "Assistant",
      entrypoint: "research",
      tool: "research",
      rootId: "root-17",
    },
    assertCurrent: () => true,
    onApprove: () => undefined,
  });

  expect(useInstallOfferStore.getState().pending?.requester).toEqual({
    kind: "agent",
    appId: "assistant",
    appName: "Assistant",
    rootAppId: "assistant",
    rootAppName: "Assistant",
    entrypoint: "research",
    tool: "research",
    rootId: "root-17",
  });
  approveInstallOffer(handle.requestId);
  await expect(handle.completion).resolves.toMatchObject({
    requester: { kind: "agent", rootId: "root-17" },
  });
});

test("invalid trusted inputs fail before reserving owner attention", () => {
  expect(() =>
    requestInstallOffer({
      ...appPackageInput(() => undefined),
      offer: { kind: "package_url", url: "javascript:alert(1)" },
    }),
  ).toThrow(
    new KernelPolicyError(
      "INVALID_REQUEST",
      "Install offer URL is invalid",
    ),
  );
  expect(useInstallOfferStore.getState().pending).toBeNull();
  expect(useUiAttentionStore.getState().active).toBeNull();
});

function appPackageInput(
  onApprove: InstallOfferRequestInput["onApprove"],
): InstallOfferRequestInput {
  return {
    offer: {
      kind: "package_url",
      url: "https://packages.example/mail.neutron?campaign=private",
    },
    requester: {
      kind: "app",
      appId: "mail",
      appName: "Mail",
      surface: "tile",
    },
    assertCurrent: () => true,
    onApprove,
  };
}
