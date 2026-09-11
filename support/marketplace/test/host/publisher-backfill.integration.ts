// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "publisher backfill interleaves live ratings and acquisitions across an upgrade without double counting",
  scope: "upgrade",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor, canisterId, wasmPath } = await installFixture(pic, "publisher_backfill_fixture", "test/fixtures/Publishers.mo");
      await actor.seed();
      const initial = await actor.snapshot();
      assert.equal(initial.alpha[0].statsComplete, false);
      assert.equal(initial.alpha[0].ratingCount, 0n);
      assert.equal(initial.alpha[0].totalUsers, 0n);
      assert.equal(initial.acquisitions, 4n);

      assert.equal(await actor.advance(1n), 1n);
      let state = await actor.snapshot();
      assert.equal(state.appBaselines, 1n);
      assert.equal(state.alpha[0].ratingCount, 2n);
      assert.equal(state.alpha[0].ratingTotal, 8n);

      // This app has not reached the historical cursor yet. Its live rating
      // edit must establish the complete app baseline, not only the delta.
      await actor.rate("alpha-two", 0n, 5n);
      state = await actor.snapshot();
      assert.equal(state.alpha[0].ratingCount, 3n);
      assert.equal(state.alpha[0].ratingTotal, 13n);
      assert.equal(await actor.advance(1n), 1n);
      assert.equal((await actor.snapshot()).alpha[0].ratingTotal, 13n);

      // Also edit an app already traversed. New and historical buyers arrive
      // before acquisition backfill; later history must not count either twice.
      await actor.rate("alpha-one", 1n, 1n);
      const newBuyerAcquisition = await actor.acquire("alpha-two", 2n);
      const historicalBuyerAcquisition = await actor.acquire("alpha-two", 1n);
      assert.equal(await actor.acquire("alpha-two", 2n), newBuyerAcquisition);
      assert.equal(await actor.acquire("alpha-two", 1n), historicalBuyerAcquisition);
      state = await actor.snapshot();
      assert.equal(state.alpha[0].ratingCount, 3n);
      assert.equal(state.alpha[0].ratingTotal, 11n);
      assert.equal(state.alpha[0].totalUsers, 2n);
      assert.equal(state.acquisitions, 6n);
      assert.equal(state.entitlements, 6n);

      assert.equal(await actor.advance(1n), 1n); // Other publisher's app.
      assert.equal(await actor.advance(1n), 1n); // First historical acquisition.
      const beforeUpgrade = await actor.snapshot();
      assert.equal(beforeUpgrade.maintenance.appsComplete, true);
      assert.equal(beforeUpgrade.maintenance.acquisitionsComplete, false);
      assert.equal(beforeUpgrade.alpha[0].statsComplete, false);
      assert.equal(beforeUpgrade.alpha[0].totalUsers, 3n);
      assert.equal(beforeUpgrade.beta[0].ratingCount, 1n);
      assert.equal(beforeUpgrade.beta[0].ratingTotal, 4n);

      await pic.tick(100);
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.snapshot(), beforeUpgrade);

      let processed = 0n;
      let calls = 0;
      while (!(await actor.snapshot()).alpha[0].statsComplete) {
        assert.ok(calls++ < 8, "A one-row work budget must finish the five remaining acquisitions");
        const count = await actor.advance(1n);
        assert.ok(count <= 1n, "Maintenance must respect its explicit work budget");
        processed += count;
      }
      assert.equal(processed, 5n);
      const complete = await actor.snapshot();
      assert.equal(complete.alpha[0].ratingCount, 3n);
      assert.equal(complete.alpha[0].ratingTotal, 11n);
      assert.equal(complete.alpha[0].totalUsers, 3n);
      assert.equal(complete.beta[0].ratingCount, 1n);
      assert.equal(complete.beta[0].ratingTotal, 4n);
      assert.equal(complete.beta[0].totalUsers, 1n);
      assert.equal(complete.appBaselines, 3n);
      assert.equal(complete.memberships, 4n);
      assert.equal(await actor.advance(1n), 0n);
      assert.deepEqual(await actor.snapshot(), complete);

      // New ratings and edits after backfill remain incremental, and neither
      // edits nor repeat acquisition calls increase the distinct user total.
      await actor.rate("alpha-two", 0n, 4n);
      await actor.rate("alpha-two", 2n, 4n);
      await actor.rate("alpha-two", 2n, 4n);
      assert.equal(await actor.acquire("alpha-two", 2n), newBuyerAcquisition);
      const final = await actor.snapshot();
      assert.equal(final.alpha[0].ratingCount, 4n);
      assert.equal(final.alpha[0].ratingTotal, 14n);
      assert.equal(final.alpha[0].totalUsers, 3n);
      assert.equal(final.acquisitions, 6n);
      assert.equal(final.ratings, 5n);
    } finally { await shutdown(); }
  },
}];
