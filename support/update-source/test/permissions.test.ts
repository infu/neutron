import { describe, expect, test } from "bun:test";
import {
  configurePublisher,
  publisherStatus,
  revokePublisher,
  rotatePublisher,
} from "../src/permissions.ts";
import { MemoryAssetState } from "./memory_asset.ts";

const admin =
  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const publisher =
  "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
const replacement =
  "7bd4t-ulhpg-panwd-7xt77-e6ebg-irkog-cr2z2-f5io2-safj6-4kfnw-3ae";
const anonymous = "2vxsx-fae";

function managedState(): MemoryAssetState {
  const state = new MemoryAssetState();
  state.permissions.get("ManagePermissions")!.add(admin);
  state.permissions.get("Commit")!.add(admin);
  state.controllers.add(admin);
  return state;
}

describe("publisher permissions", () => {
  test("grants one non-controller Commit publisher", async () => {
    const state = managedState();
    const status = await configurePublisher(state.actor(admin), publisher);
    expect(status.commit).toEqual([publisher]);
    expect(status.controllers).toEqual([admin]);
    expect(status.controller_publishers).toEqual([]);
    expect(status.single_commit_publisher).toBe(true);
  });

  test("refuses to turn a controller into the publisher", async () => {
    const state = managedState();
    await expect(
      configurePublisher(state.actor(admin), admin),
    ).rejects.toThrow("is a controller");
  });

  test("rotation revokes the old publisher before granting the new one", async () => {
    const state = managedState();
    await configurePublisher(state.actor(admin), publisher);
    state.calls.length = 0;
    const status = await rotatePublisher(
      state.actor(admin),
      publisher,
      replacement,
    );
    expect(status.commit).toEqual([replacement]);
    const revoke = state.calls.indexOf(`revoke:Commit:${publisher}`);
    const grant = state.calls.indexOf(`grant:Commit:${replacement}`);
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
  });

  test("revoke is idempotent and status exposes all roles", async () => {
    const state = managedState();
    state.permissions.get("Prepare")!.add(replacement);
    await configurePublisher(state.actor(admin), publisher);
    await revokePublisher(state.actor(admin), publisher);
    await revokePublisher(state.actor(admin), publisher);
    const status = await publisherStatus(state.actor(admin));
    expect(status.prepare).toEqual([replacement]);
    expect(status.commit).toEqual([]);
    expect(status.manage_permissions).toEqual([admin]);
  });

  test("an existing non-controller publisher requires explicit replacement", async () => {
    const state = managedState();
    state.permissions.get("Commit")!.add(replacement);
    await expect(
      configurePublisher(state.actor(admin), publisher),
    ).rejects.toThrow("use --replace");
    const status = await configurePublisher(state.actor(admin), publisher, {
      replace: true,
    });
    expect(status.commit).toEqual([publisher]);
  });

  test("anonymous, Prepare-only, and unrelated callers cannot commit", async () => {
    const state = managedState();
    state.permissions.get("Prepare")!.add(publisher);
    const batch = await state.actor(publisher).createBatch();
    await expect(
      state.actor(publisher).commitBatch(batch, []),
    ).rejects.toThrow("no Commit permission");
    await expect(
      state.actor(anonymous).commitBatch(batch, []),
    ).rejects.toThrow("no Commit permission");
    await expect(
      state.actor(replacement).commitBatch(batch, []),
    ).rejects.toThrow("no Commit permission");
    await expect(state.actor(replacement).createBatch()).rejects.toThrow(
      "no Prepare permission",
    );
    expect(state.commits).toBe(0);

    state.permissions.get("Commit")!.add(publisher);
    await state.actor(publisher).commitBatch(batch, []);
    expect(state.commits).toBe(1);
  });
});
