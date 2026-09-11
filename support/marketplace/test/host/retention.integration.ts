// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "latest release retirement frees bytes, preserves shared and pending artifacts, and survives upgrade",
  scope: "upgrade",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor, canisterId, wasmPath } = await installFixture(pic, "retention_fixture", "test/fixtures/Retention.mo");
      async function verifyUpgrade() {
        const snapshot = Uint8Array.from(await actor.snapshot());
        await pic.tick(100);
        await pic.upgradeCanister({
          canisterId, wasm: wasmPath, arg: new Uint8Array(),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        assert.deepEqual(Uint8Array.from(await actor.snapshot()), snapshot);
        assert.equal(await actor.verify(), true);
      }
      let before = await actor.seed();
      assert.equal(await actor.verify(), true);
      // Approving alpha 101 retires only its old package: beta's current
      // release and alpha's pending 102 both still share the original source.
      for (const phase of [1n, 2n, 3n]) {
        const after = await actor.approveNext();
        assert.equal(after.phase, phase);
        assert.equal(after.retiredCount, 1n);
        assert.equal(after.liveBytes, before.liveBytes - after.retiredBytes);
        assert.equal(after.liveFiles, before.liveFiles - 1n);
        assert.ok(after.freeBlocks > before.freeBlocks, "Retirement must return the actual blob allocation to its pool");
        assert.equal(await actor.verify(), true);
        if (phase === 1n) await verifyUpgrade();
        before = after;
      }
      // The final successor introduces new uploads and removes both the old
      // package and source, since neither is now current or awaiting audit.
      const final = await actor.approveNext();
      assert.equal(final.phase, 4n);
      assert.equal(final.retiredCount, 2n);
      assert.equal(await actor.verify(), true);
      await verifyUpgrade();
      assert.equal(await actor.reuseFreedBlocks(), true);
      assert.equal(await actor.verify(), true);
    } finally { await shutdown(); }
  },
}, {
  name: "audit rejection retires abandoned pending bytes while revocation preserves the current release",
  scope: "fixture",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor } = await installFixture(pic, "retention_fixture", "test/fixtures/Retention.mo");
      await actor.seed();
      assert.deepEqual(await actor.dispositionChecks(), { firstRejected: 1n, lastRejected: 2n, revoked: 0n, valid: true });
    } finally { await shutdown(); }
  },
}, {
  name: "a fresh deduplicated upload stays available through approval, retry, and upgrade until its own publication retires",
  scope: "upgrade",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor, canisterId, wasmPath } = await installFixture(pic, "retention_fixture", "test/fixtures/Retention.mo");
      await actor.seed();
      assert.equal(await actor.prepareFreshDedup(), true);
      assert.equal(await actor.freshUploadIsUnbound(), true);
      const before = Uint8Array.from(await actor.snapshot());
      await pic.tick(100);
      await pic.upgradeCanister({
        canisterId, wasm: wasmPath, arg: new Uint8Array(),
        upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
      });
      assert.deepEqual(Uint8Array.from(await actor.snapshot()), before);
      assert.equal(await actor.freshUploadIsUnbound(), true);
      assert.equal(await actor.completeFreshDedup(), true);
    } finally { await shutdown(); }
  },
}];
