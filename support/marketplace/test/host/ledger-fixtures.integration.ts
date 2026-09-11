import assert from "node:assert/strict";
import { account, deferredRelayCall, installFixture, ok, relayCall, session, until, type IntegrationCase } from "./helpers.ts";

async function setup() {
  const env = await session();
  try {
    const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
    const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const protocol = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    await ledger.actor.credit(account(neutron.canisterId), 10_000n);
    const now = BigInt(await env.pic.getTime()) * 1_000_000n;
    ok(await relayCall(neutron, ledger, "icrc2_approve", [{
      from_subaccount: [], spender: account(protocol.canisterId), amount: 9_000n,
      expected_allowance: [0n], expires_at: [], fee: [10n], memo: [Uint8Array.of(1)], created_at_time: [now],
    }]));
    const transfer = {
      spender_subaccount: [], from: account(neutron.canisterId), to: account(protocol.canisterId),
      amount: 100n, fee: [10n], memo: [Uint8Array.of(2)], created_at_time: [now],
    };
    return { ...env, ledger, neutron, protocol, transfer };
  } catch (error) {
    await env.shutdown();
    throw error;
  }
}

export const cases: IntegrationCase[] = [
  {
    name: "ICRC fixture: real relay collection and exact duplicate apply once",
    scope: "fixture",
    async run() {
      const env = await setup();
      try {
        const block = ok<bigint>(await relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]));
        const duplicate: any = await relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]);
        assert.equal(duplicate.Err.Duplicate.duplicate_of, block);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.neutron.canisterId)), 9_880n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "ICRC fixture: committed collection survives lost reply and retry proves Duplicate",
    scope: "fixture",
    async run() {
      const env = await setup();
      try {
        await env.ledger.actor.setScript([{ commitThenReject: "test: reply lost after ledger commit" }]);
        await assert.rejects(relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]), /reply lost after ledger commit/);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
        const duplicate: any = await relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]);
        assert.equal(duplicate.Err.Duplicate.duplicate_of, 1n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "ICRC fixture: held intercanister call overlaps an exact competing request",
    scope: "fixture",
    async run() {
      const env = await setup();
      try {
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.ledger.actor.setScript([{ hold: gate.canisterId }]);
        const first = await deferredRelayCall(env.pic, env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "ledger waiting on the controlled gate");
        const second = await deferredRelayCall(env.pic, env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]);
        const block = ok<bigint>(await second());
        await gate.actor.releaseGate();
        const duplicate: any = await first();
        assert.equal(duplicate.Err.Duplicate.duplicate_of, block);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "ICRC fixture: elapsed dedup window is distinct from a missing prior effect",
    scope: "fixture",
    async run() {
      const env = await setup();
      try {
        ok(await relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]));
        await env.ledger.actor.setTimeRules(1_000_000_000n, 60_000_000_000n);
        await env.pic.advanceTime(2_000);
        await env.pic.tick();
        const tooOld: any = await relayCall(env.protocol, env.ledger, "icrc2_transfer_from", [env.transfer]);
        assert.ok("TooOld" in tooOld.Err);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "XRC fixture: ingress cannot pay native cycles; Neutron relay attaches and receives surplus",
    scope: "fixture",
    async run() {
      const env = await session();
      try {
        const oracle = await installFixture(env.pic, "oracle", "test/fixtures/Oracle.mo");
        const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const request = { base_asset: { symbol: "USDC", class: { Cryptocurrency: null } }, quote_asset: { symbol: "USD", class: { FiatCurrency: null } }, timestamp: [] };
        assert.ok("NotEnoughCycles" in (await oracle.actor.get_exchange_rate(request)).Err);
        const balanceBefore = await env.pic.getCyclesBalance(neutron.canisterId);
        const result: any = await relayCall(neutron, oracle, "get_exchange_rate", [request], 1_000_000_000n);
        const balanceAfter = await env.pic.getCyclesBalance(neutron.canisterId);
        assert.equal(ok<any>(result).rate, 100_000_000n);
        const stats = await oracle.actor.stats();
        assert.equal(stats.cyclesReceived, 20_000_000n);
        assert.equal(stats.calls, 2n);
        // The balance also pays execution costs, so it is not an exact fee
        // receipt. It nevertheless proves the full attachment was not retained.
        assert.ok(balanceBefore - balanceAfter < 1_000_000_000);
      } finally { await env.shutdown(); }
    },
  },
];
