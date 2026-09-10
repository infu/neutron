// All rights reserved. See ../../LICENSE.
import assert from "node:assert/strict";
import { prepareAsh } from "../../scripts/test-ash-runtime.ts";
import { installFixture, type IntegrationCase } from "./helpers.ts";

const APP_COUNT = 5_000;
const ACQUISITION_COUNT = 25_000;
const WEEK_NS = 604_800_000_000_000n;
const MONTH_NS = 2_592_000_000_000_000n;
const NOW = 10_000_000_000_000_000n;
// Production IC update/timer limit, not PocketIC's relaxed benchmarking mode.
const UPDATE_INSTRUCTIONS = 40_000_000_000n;
const PAGE_SIZE = 1_000n;

export const cases: IntegrationCase[] = [{
  name: "ranking maintenance scale uses production instruction limits with 5000 apps and 25000 acquisitions",
  scope: "protocol",
  async run() {
    const { pic, shutdown } = await (await prepareAsh()).createSession({
      application: [{ state: { type: "new" }, enableDeterministicTimeSlicing: true, enableBenchmarkingInstructionLimits: false }],
    });
    try {
      const { actor, canisterId } = await installFixture(pic, "rankings_scale_fixture", "test/fixtures/RankingsScale.mo");
      for (let index = 0; index < APP_COUNT; index += 100) await actor.seedApps(100n);
      for (let index = 0; index < ACQUISITION_COUNT; index += 500) await actor.seedAcquisitions(500n, NOW, []);
      assert.deepEqual(await actor.counts(), { apps: 5_000n, acquisitions: 25_000n, rankings: 5_000n });

      const samples: Array<Record<string, string>> = [];
      async function advance(label: string, now: bigint) {
        const cyclesBefore = BigInt(await pic.getCyclesBalance(canisterId));
        const sample = await actor.advance(now, 500n);
        const cycleDebit = cyclesBefore - BigInt(await pic.getCyclesBalance(canisterId));
        assert.ok(sample.rankingInstructions > 0n);
        assert.ok(sample.messageInstructions < UPDATE_INSTRUCTIONS, `${label} exceeded the production message instruction budget`);
        assert.ok(cycleDebit > 0n, `${label} must include actual update execution charging`);
        samples.push({ label, rankingInstructions: String(sample.rankingInstructions), messageInstructions: String(sample.messageInstructions), cycleDebit: String(cycleDebit), processed: String(sample.result.processed), published: String(sample.result.published) });
        return sample.result;
      }

      const initial = await advance("initial publication", NOW + 1n);
      assert.equal(initial.published, true);
      assert.equal(initial.processed, 0n);
      const first = (await actor.chart({ free: null }, { week: null }, [], 2n, NOW + 1n)).ok;
      assert.deepEqual(first.entries, [{ appId: "app-04998", score: 5n }, { appId: "app-04996", score: 5n }]);
      assert.equal(first.next.length, 1);
      const second = (await actor.chart({ free: null }, { week: null }, first.next, 2n, NOW + 1n)).ok;
      assert.deepEqual(second.entries, [{ appId: "app-04994", score: 5n }, { appId: "app-04992", score: 5n }]);

      const idle = await advance("unchanged maintenance", NOW + 60_000_000_000n);
      assert.equal(idle.processed, 0n);
      assert.equal(idle.published, true);
      assert.ok(idle.generation > initial.generation);
      assert.ok("err" in await actor.chart({ free: null }, { week: null }, first.next, 2n, NOW + 60_000_000_000n), "A replaced snapshot must explicitly reject its previous cursor");

      await actor.seedAcquisitions(20n, NOW + 60_000_000_001n, [0n]);
      const changed = await advance("changed publication", NOW + 60_000_000_002n);
      assert.equal(changed.published, true);
      const expected = (kind: "free" | "paid", recent: boolean) => Array.from({ length: APP_COUNT }, (_, index) => index)
        .filter((index) => index % 2 === (kind === "free" ? 0 : 1))
        .map((index) => ({ appId: `app-${String(index).padStart(5, "0")}`, score: (recent ? 0n : 5n) + (index === 0 ? 20n : 0n) }))
        .sort((a, b) => a.score === b.score ? (a.appId < b.appId ? 1 : -1) : (a.score < b.score ? 1 : -1));
      async function chart(kind: "free" | "paid", window: "week" | "month" | "all", now: bigint, desired: Array<{ appId: string; score: bigint }>) {
        const entries: typeof desired = [];
        let cursor: unknown[] = [];
        let generation: bigint | undefined;
        do {
          const response = await actor.chart({ [kind]: null }, { [window]: null }, cursor, PAGE_SIZE, now);
          assert.ok("ok" in response);
          const page = response.ok;
          generation ??= page.generation;
          assert.equal(page.generation, generation);
          assert.equal(page.refreshing, false);
          entries.push(...page.entries);
          cursor = page.next;
        } while (cursor.length);
        assert.deepEqual(entries, desired, `${kind}/${window} includes every eligible app exactly once in score order`);
      }
      for (const kind of ["free", "paid"] as const) {
        for (const window of ["week", "month", "all"] as const) await chart(kind, window, NOW + 60_000_000_002n, expected(kind, false));
      }

      // Expire only the original 25k events; the later 20 remain current.
      const expiryAt = NOW + WEEK_NS;
      const backlog = await advance("weekly expiry full work budget", expiryAt);
      assert.equal(backlog.processed, 500n);
      assert.equal(backlog.published, false);
      const stale = (await actor.chart({ free: null }, { week: null }, [], 1n, expiryAt)).ok;
      assert.equal(stale.generation, changed.generation);
      assert.equal(stale.refreshing, true);
      assert.deepEqual(stale.entries, [{ appId: "app-00000", score: 25n }]);
      let remaining = backlog;
      let processed = backlog.processed;
      let ticks = 1;
      while (!remaining.published) {
        assert.ok(ticks < 60, "The fixed 500-event maintenance budget must drain this known backlog");
        remaining = await advance("weekly expiry continuation", expiryAt);
        processed += remaining.processed;
        ticks += 1;
      }
      assert.equal(processed, 25_000n);
      assert.equal(ticks, 50);
      for (const kind of ["free", "paid"] as const) {
        await chart(kind, "week", expiryAt, expected(kind, true));
        await chart(kind, "month", expiryAt, expected(kind, false));
        await chart(kind, "all", expiryAt, expected(kind, false));
      }
      const afterExpiry = await advance("unchanged after expiry", expiryAt + 1n);
      assert.equal(afterExpiry.processed, 0n);
      // No hidden monthly expiry work was introduced by the weekly scan.
      assert.ok(expiryAt < NOW + MONTH_NS);
      const largestInstructions = samples.reduce((largest, sample) => BigInt(sample.messageInstructions) > BigInt(largest.messageInstructions) ? sample : largest);
      const largestCycleDebit = samples.reduce((largest, sample) => BigInt(sample.cycleDebit) > BigInt(largest.cycleDebit) ? sample : largest);
      console.log(`Ranking scale measurements (production limits; IC counters exclude deferred GC, observed cycle debits include complete message execution): ${JSON.stringify({
        apps: APP_COUNT, acquisitions: ACQUISITION_COUNT + 20, expiryTicks: ticks,
        samples: samples.filter((sample) => sample.label !== "weekly expiry continuation"),
        largestInstructions, largestCycleDebit,
      })}`);
    } finally { await shutdown(); }
  },
}];
