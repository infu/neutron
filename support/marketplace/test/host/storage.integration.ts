// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

export const cases: IntegrationCase[] = [{
  name: "storage upgrade preserves every retained root and unfinished uploads beyond year one",
  scope: "upgrade",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor, canisterId, wasmPath } = await installFixture(pic, "storage_fixture", "test/fixtures/Storage.mo");
      await actor.seed();
      const before = Uint8Array.from(await actor.snapshot());
      assert.equal(await actor.validateIndexesAndBytes(), true);
      // Paid upload bytes remain available beyond its prepaid first year and an actual same-principal upgrade, with no replacement upload.
      await pic.advanceTime(367 * 24 * 60 * 60 * 1_000);
      // Advancing PocketIC's clock does not execute subnet rounds. Allow rounds
      // to repay the fixture's prior install-code instruction debit before the
      // real upgrade, as a running subnet would over the elapsed year.
      await pic.tick(100);
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(Uint8Array.from(await actor.snapshot()), before);
      assert.equal(await actor.validateIndexesAndBytes(), true);
      assert.equal(new TextDecoder().decode(Uint8Array.from(await actor.finishPending())), "abcdefgh");
      assert.equal(await actor.nextReferralCode(), 2n);
    } finally {
      await shutdown();
    }
  },
}, {
  name: "publisher ownership pagination retains sparse IDs and reused storage slots",
  scope: "fixture",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const { actor } = await installFixture(pic, "storage_fixture", "test/fixtures/Storage.mo");
      await actor.seed();
      assert.equal(await actor.checkPublisherPagination(), true);
    } finally { await shutdown(); }
  },
}, {
  name: "storage allocation failure rolls back accepted cycles and partial state",
  scope: "fixture",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const target = await installFixture(pic, "upload_billing_fixture", "test/fixtures/UploadBilling.mo");
      const payer = await installFixture(pic, "upload_billing_fixture", "test/fixtures/UploadBilling.mo");
      await target.actor.seed();
      const targetBefore = await target.actor.cycleBalance();
      const payerBefore = await payer.actor.cycleBalance();
      const { message, refunded, ...result } = await payer.actor.probe(target.canisterId);
      assert.match(message, /Upload allocation failed/);
      assert.deepEqual(result, { trapped: true, effects: 0n, uploads: 0n, charges: 0n });
      // Inspect economic balances as well as the journal: the accepted storage
      // charge is deliberately much larger than fixture execution costs.
      assert.ok(await target.actor.cycleBalance() <= targetBefore, "The allocator must not retain the 800B storage charge");
      assert.ok(await payer.actor.cycleBalance() > payerBefore - 800_000_000_000n, "The payer must recover its storage payment");
      assert.deepEqual(await target.actor.counts(), { effects: 0n, uploads: 0n, charges: 0n });
    } finally { await shutdown(); }
  },
}];
