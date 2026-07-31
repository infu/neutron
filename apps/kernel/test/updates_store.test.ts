import { beforeEach, expect, test } from "bun:test";
import {
  updateCheckState,
  useUpdateCheckStore,
} from "../src/updates/store.ts";

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
