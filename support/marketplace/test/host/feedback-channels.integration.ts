// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

function ok(result: any): any {
  assert.ok("ok" in result, `Expected feedback success: ${JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  return result.ok;
}
function error(result: any, code: string): void { assert.equal(result.err?.code, code); }

export const cases: IntegrationCase[] = [{
  name: "feedback channels preserve rating backfill and version text lifecycle across keep upgrade",
  scope: "upgrade",
  async run() {
    const { pic, shutdown } = await session();
    try {
      const fixture = await installFixture(pic, "feedback_channels_fixture", "test/fixtures/FeedbackChannels.mo");
      const { actor, canisterId, wasmPath } = fixture;
      const [stable, beta, next] = await actor.seed();
      let state = await actor.snapshot();
      assert.equal(ok(state.histogram).complete, false);
      assert.equal(ok(state.histogram).count, 3n);
      assert.equal(ok(state.histogram).total, 11n);
      assert.equal(await actor.advance(1n), 1n);
      assert.equal(ok((await actor.snapshot()).histogram).five, 1n);

      // Row three is ahead of the cursor. An edit and retry count it once;
      // row one is behind the cursor and replaces its saved contribution.
      const edited = ok(await actor.legacyRate(2n, 3n, "Legacy client still works", 20n));
      assert.deepEqual(ok(await actor.legacyRate(2n, 3n, "Legacy client still works", 21n)), edited);
      ok(await actor.rate(0n, 1n, 22n));
      state = await actor.snapshot();
      assert.equal(state.contributions, 2n);
      assert.equal(state.ratings[0].review, "Unversioned historical text");
      assert.equal(ok(state.histogram).total, 8n);

      const stableComment = ok(await actor.comment(0n, stable, "Stable comment", 30n));
      const betaComment = ok(await actor.comment(0n, beta, "Beta comment", 31n));
      const otherBetaComment = ok(await actor.comment(1n, beta, "Another beta comment", 32n));
      assert.deepEqual(ok(await actor.comment(0n, beta, "Beta comment", 33n)), betaComment);
      error(await actor.comment(3n, beta, "No acquisition", 34n), "feedback_acquisition_required");
      error(await actor.comment(0n, { ...beta, version: 99n }, "Stale editor", 34n), "feedback_release_mismatch");
      error(await actor.comment(0n, { ...beta, digest: new Uint8Array([1, 2, 3]) }, "Wrong digest", 34n), "feedback_release_mismatch");
      error(await actor.comment(0n, { ...beta, appId: "other-app" }, "Wrong app", 34n), "feedback_release_mismatch");
      const page = ok(await actor.comments([1n], beta, [], 1n));
      assert.deepEqual(page.comments, [betaComment]);
      assert.deepEqual(page.ownComment, [otherBetaComment]);
      assert.deepEqual(ok(await actor.comments([], beta, page.nextCursor, 1n)).comments, [otherBetaComment]);

      const beforeUpgrade = await actor.snapshot();
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.snapshot(), beforeUpgrade);

      // Finish historical backfill with one-row messages, interleaved with
      // cleanup scans. The permanent aggregate is unchanged by either task.
      for (let calls = 0; !(await actor.snapshot()).maintenance.ratingsComplete; calls++) {
        assert.ok(calls < 20);
        assert.ok(await actor.advance(1n) <= 1n);
      }
      state = await actor.snapshot();
      assert.deepEqual(ok(state.histogram), { five: 0n, four: 1n, three: 1n, two: 0n, one: 1n, count: 3n, total: 8n, complete: true });
      assert.equal(state.publisher[0].ratingCount, 3n);
      assert.equal(state.publisher[0].ratingTotal, 8n);

      // Replace beta first. Its text is instantly unavailable, before the
      // eventual deletion. An older stable thread remains readable.
      await actor.heads([stable.candidateId], [next.candidateId]);
      error(await actor.comments([], beta, [], 10n), "feedback_release_retired");
      error(await actor.comment(0n, beta, "Cannot recreate retired text", 40n), "feedback_release_retired");
      assert.deepEqual(ok(await actor.comments([], stable, [], 10n)).comments, [stableComment]);
      for (let calls = 0; (await actor.snapshot()).comments.length !== 1; calls++) {
        assert.ok(calls < 30);
        assert.ok(await actor.advance(1n) <= 1n);
      }
      const nextComment = ok(await actor.comment(0n, next, "Promote these exact bytes", 41n));
      await actor.heads([next.candidateId], [next.candidateId]);
      assert.deepEqual(ok(await actor.comments([], next, [], 10n)).comments, [nextComment]);
      error(await actor.comments([], stable, [], 10n), "feedback_release_retired");
      for (let calls = 0; (await actor.snapshot()).comments.length !== 1; calls++) {
        assert.ok(calls < 30);
        await actor.advance(1n);
      }
      assert.deepEqual((await actor.snapshot()).comments, [nextComment]);

      // Cutover is explicit and restartable. Rejected old-client text cannot
      // reappear; cleanup preserves all rating metadata and publisher totals.
      const beforeCutover = await actor.snapshot();
      await actor.cutover();
      error(await actor.legacyRate(0n, 5n, "Old client must upgrade", 50n), "feedback_update_required");
      assert.deepEqual((await actor.snapshot()).ratings, beforeCutover.ratings);
      await actor.advance(1n);
      const duringCleanup = await actor.snapshot();
      await pic.upgradeCanister({ canisterId, wasm: wasmPath, arg: new Uint8Array(), upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] } });
      assert.deepEqual(await actor.snapshot(), duringCleanup);
      await actor.cutover(); // Retry must retain the cleanup cursor.
      assert.deepEqual((await actor.snapshot()).maintenance, duringCleanup.maintenance);
      for (let calls = 0; !(await actor.snapshot()).maintenance.legacyTextComplete; calls++) {
        assert.ok(calls < 25);
        assert.ok(await actor.advance(1n) <= 1n);
      }
      state = await actor.snapshot();
      assert.deepEqual(state.ratings, beforeCutover.ratings.map((rating: any) => ({ ...rating, review: "" })));
      assert.deepEqual(state.publisher, beforeCutover.publisher);
      assert.deepEqual(state.histogram, beforeCutover.histogram);
      assert.equal(state.entitlements, 3n);
      assert.equal(state.ownerIndexes, 1n);
      ok(await actor.legacyRate(0n, 5n, "", 60n));
      ok(await actor.rate(0n, 4n, 61n));
      state = await actor.snapshot();
      assert.deepEqual(ok(state.histogram), { five: 0n, four: 2n, three: 1n, two: 0n, one: 0n, count: 3n, total: 11n, complete: true });
      ok(await actor.removeComment(0n, next));
      ok(await actor.removeComment(0n, next));
      assert.equal((await actor.snapshot()).ownerIndexes, 0n);
    } finally { await shutdown(); }
  },
}];
