import { afterEach, expect, test } from "bun:test";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import {
  abortPendingInstallRecovery,
  inspectPendingInstallRecovery,
  normalizePendingInstallReservationBlockers,
  releasePendingInstallReservation,
  useAppsStore,
} from "../src/reducer/apps.ts";

const deploymentId = "deploy00000000000000000000000000";

afterEach(() => {
  useAppsStore.getState().setPendingInstallRecovery(null);
  useAppsStore.getState().setRuntimeAuthorityFence(null);
});

test("pending install recovery exposes only authoritative reservation blockers", () => {
  expect(
    normalizePendingInstallReservationBlockers([
      {
        reason: { scope_conflict: null },
        reservation: {
          id: 9n,
          app_id: "mail",
          installation_uid: 4n,
          scope_kind: "exact",
          principal: [{ toText: () => "rrkah-fqaaa-aaaaa-aaaaq-cai" }],
          method: ["app_mail__mail_v1_update"],
          created_at: 12n,
          created_by: { toText: () => "aaaaa-aa" },
        },
      },
    ]),
  ).toEqual([
    {
      id: 9n,
      appId: "mail",
      installationUid: 4n,
      scope:
        "rrkah-fqaaa-aaaaa-aaaaq-cai · app_mail__mail_v1_update",
      reason: "scope_conflict",
    },
  ]);
  expect(() =>
    normalizePendingInstallReservationBlockers([
      {
        reason: { app_capacity: null },
        reservation: {
          id: 1n,
          app_id: "hidden_claim",
          installation_uid: 0n,
          scope_kind: "method",
          principal: [],
          method: ["app_hidden__call"],
          created_at: 12n,
          created_by: { toText: () => "aaaaa-aa" },
        },
      },
    ]),
  ).toThrow(/claim was exposed/);
  expect(() =>
    normalizePendingInstallReservationBlockers([
      {
        id: 9n,
        app_id: "mail",
        installation_uid: 4n,
        scope_kind: "method",
        principal: [],
        method: ["app_mail__mail_v1_update"],
      },
    ]),
  ).toThrow(/pending install blocker/i);
});

test("predecessor recovery inspection is a quick read and never retries activation", async () => {
  useAppsStore.getState().setPendingInstallRecovery({ deploymentId });
  const calls: string[] = [];
  const actor = {
    async kernel_install_status() {
      calls.push("status");
      return [
        {
          deployment_id: deploymentId,
          copy_count: 0n,
          clear_count: 0n,
          removed_apps: [],
          committed_app_instances: [],
          target_app_instances: [],
        },
      ];
    },
    async kernel_runtime_info() {
      calls.push("runtime");
      return {
        deployment_id: "old00000000000000000000000000000",
        assembler_id: ASSEMBLER_ID,
        compiler_id: "fixture",
        apps: [],
        memories: [],
      };
    },
    async kernel_install_wasm_chunks_clear() {
      calls.push("clear-wasm");
    },
    async kernel_install_commit() {
      calls.push("commit");
      return { blocked: null } as const;
    },
  };

  await expect(
    inspectPendingInstallRecovery(deploymentId, actor as never),
  ).resolves.toEqual({
    deploymentId,
    runningTarget: false,
    blockers: [],
  });
  expect(calls).toEqual(["status", "runtime"]);
  expect(useAppsStore.getState().pendingInstallRecovery).toEqual({
    deploymentId,
    runningTarget: false,
    blockers: [],
  });
});

test("running-target recovery releases only the selected blocker and retries safely", async () => {
  const blocker = {
    id: 7n,
    appId: "mail",
    installationUid: 4n,
    scope: "Method app_mail__mail_v1_update",
    reason: "scope_conflict" as const,
  };
  useAppsStore.getState().setPendingInstallRecovery({
    deploymentId,
    runningTarget: true,
    blockers: [blocker],
  });
  const calls: string[] = [];
  const appInstance = (activeDeploymentId: string, uid: bigint) => ({
    scope: { app_id: "kernel", installation_uid: uid },
    version: 100n,
    deployment_id: activeDeploymentId,
    capability_plan_fingerprint: "a".repeat(64),
    browser_origin_nonce: uid.toString(16).padStart(32, "0"),
    browser_origin_authority_epoch: uid,
    resident_frame_security: { credentialless_opaque_v1: null },
  });
  const targetInstance = appInstance(deploymentId, 2n);
  const status = {
    deployment_id: deploymentId,
    copy_count: 0n,
    clear_count: 0n,
    removed_apps: [],
    committed_app_instances: [
      appInstance("old00000000000000000000000000000", 1n),
    ],
    target_app_instances: [targetInstance],
  };
  const actor = {
    async kernel_install_pending_reservation_release(input: {
      deployment_id: string;
      reservation_id: bigint;
    }) {
      calls.push(`release:${input.deployment_id}:${input.reservation_id}`);
      return true;
    },
    async kernel_install_status() {
      calls.push("status");
      return [status];
    },
    async kernel_runtime_info() {
      calls.push("runtime");
      return {
        deployment_id: deploymentId,
        assembler_id: ASSEMBLER_ID,
        compiler_id: "fixture",
        apps: [targetInstance],
        memories: [],
      };
    },
    async kernel_install_wasm_chunks_clear() {
      calls.push("clear-wasm");
    },
    async kernel_install_commit() {
      calls.push("commit");
      return { blocked: null } as const;
    },
    async kernel_install_pending_reservation_blockers() {
      calls.push("blockers");
      return [
        {
          reason: { scope_conflict: null },
          reservation: {
            id: blocker.id,
            app_id: blocker.appId,
            installation_uid: blocker.installationUid,
            scope_kind: "method",
            principal: [],
            method: ["app_mail__mail_v1_update"],
            created_at: 12n,
            created_by: { toText: () => "aaaaa-aa" },
          },
        },
      ];
    },
  };

  const result = await releasePendingInstallReservation(
    deploymentId,
    blocker.id,
    actor as never,
  );
  expect(result).toBe(false);

  expect(calls[0]).toBe(`release:${deploymentId}:${blocker.id}`);
  expect(calls).toContain("clear-wasm");
  expect(calls).toContain("commit");
  expect(useAppsStore.getState().pendingInstallRecovery).toEqual({
    deploymentId,
    runningTarget: true,
    blockers: [blocker],
  });
});

test("running targets never enter the impossible discard path", async () => {
  useAppsStore.getState().setPendingInstallRecovery({
    deploymentId,
    runningTarget: true,
    blockers: [],
  });

  await expect(abortPendingInstallRecovery(deploymentId)).rejects.toThrow(
    /cannot be discarded/,
  );
});

test.each([null, { deployment_id: deploymentId }])(
  "discard rejects predecessor install status shape %#",
  async (status) => {
    useAppsStore.getState().setPendingInstallRecovery({
      deploymentId,
      runningTarget: false,
      blockers: [],
    });
    let aborted = false;
    const actor = {
      async kernel_install_status() {
        return status;
      },
      async kernel_install_abort() {
        aborted = true;
      },
    };

    await expect(
      abortPendingInstallRecovery(deploymentId, actor as never),
    ).rejects.toThrow("Install journal status is invalid");
    expect(aborted).toBe(false);
  },
);
