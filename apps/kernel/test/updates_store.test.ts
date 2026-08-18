import { beforeEach, expect, test } from "bun:test";
import {
  updateCheckState,
  useUpdateCheckStore,
} from "../src/updates/store.ts";
import type { UpdateReview } from "../src/updates/model.ts";

const source = "rrkah-fqaaa-aaaaa-aaaaq-cai";

beforeEach(() => updateCheckState.clear());

test("queued results settle in place and cancellation keeps completed rows", () => {
  updateCheckState.checking();
  updateCheckState.queue([
    {
      appId: "mail",
      name: "Mail",
      version: 100,
      updateSource: source,
    },
    {
      appId: "contacts",
      name: "Contacts",
      version: 101,
      updateSource: source,
    },
  ]);
  expect(
    useUpdateCheckStore.getState().results.map(({ appId, kind }) => [
      appId,
      kind,
    ]),
  ).toEqual([
    ["contacts", "queued"],
    ["mail", "queued"],
  ]);

  updateCheckState.result({
    kind: "not_published",
    appId: "mail",
    name: "Mail",
    installed: 100,
    source,
  });
  expect(
    useUpdateCheckStore.getState().results.map(({ appId, kind }) => [
      appId,
      kind,
    ]),
  ).toEqual([
    ["contacts", "queued"],
    ["mail", "not_published"],
  ]);

  updateCheckState.cancelled();
  expect(useUpdateCheckStore.getState()).toMatchObject({
    phase: "ready",
    error: null,
    errorStage: null,
    selectedAppIds: ["contacts"],
  });
  expect(useUpdateCheckStore.getState().results).toEqual([
    expect.objectContaining({ appId: "contacts", kind: "cancelled" }),
    expect.objectContaining({ appId: "mail", kind: "not_published" }),
  ]);
});

test("failure stages remain explicit and success retires candidates", () => {
  updateCheckState.error("bad package", "prepare");
  expect(useUpdateCheckStore.getState()).toMatchObject({
    phase: "error",
    error: "bad package",
    errorStage: "prepare",
  });

  updateCheckState.ready(
    [
      {
        kind: "available",
        appId: "mail",
        name: "Mail",
        installed: 100,
        source,
        releaseDigest: "a".repeat(64),
        release: {
          protocol: "neutron-repo-v1",
          id: "mail",
          version: 101,
          sha256: "b".repeat(64),
          size: 10,
        },
      },
    ],
    1,
  );
  expect(useUpdateCheckStore.getState().selectedAppIds).toEqual(["mail"]);

  const retainedArchiveBytes = Uint8Array.of(1, 2, 3);
  updateCheckState.review({
    apps: [],
    compiledSizeKiB: 1,
    migrationPlan: {
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    },
    diagnostics: [],
    compatibilityDiagnostics: [],
    deploymentBuild: {
      record: {} as UpdateReview["deploymentBuild"]["record"],
      suppliedPackages: [
        { archiveBytes: retainedArchiveBytes },
      ] as unknown as UpdateReview["deploymentBuild"]["suppliedPackages"],
    },
  });
  expect(
    useUpdateCheckStore.getState().review?.deploymentBuild.suppliedPackages[0]
      ?.archiveBytes,
  ).toBe(retainedArchiveBytes);
  updateCheckState.error("deployment failed", "apply");
  expect(useUpdateCheckStore.getState()).toMatchObject({
    phase: "error",
    compiledSizeKiB: null,
    review: null,
    errorStage: "apply",
  });

  updateCheckState.ready(useUpdateCheckStore.getState().results, 1);
  updateCheckState.success(1);
  expect(useUpdateCheckStore.getState()).toMatchObject({
    phase: "success",
    checkedAt: null,
    results: [],
    selectedAppIds: [],
    updatedAppCount: 1,
    error: null,
    errorStage: null,
  });
});
