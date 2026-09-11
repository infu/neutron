import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import {
  account, deferredRelayCall, installFixture, ok, relayCall, session, until, wire,
  type IntegrationCase,
} from "./helpers.ts";

function domainOk<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected domain ok, received ${wire(result)}`);
  return result.ok;
}

function some<T = any>(value: T[]): T {
  assert.equal(value.length, 1, "Expected one retained row");
  return value[0];
}

function state(record: any, expected: string) {
  assert.deepEqual(Object.keys(record.state), [expected], wire(record));
}

async function setup() {
  const env = await session();
  try {
    const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "TUSDC", decimals: 6, fee: 10n }]);
    const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const config = {
      admins: [neutron.canisterId], auditors: [],
      tokens: [{ ledger: ledger.canisterId, symbol: "TUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: ledger.canisterId,
      fees: { version: 1n, updateBase: 0n, updateByte: 0n, storageByteYear: 0n, purchase: 0n, withdraw: 0n, grant: 0n, xrc: 0n },
      referralTerms: { version: 1n, discountBps: 1_000n, affiliateBps: 3_000n, developerBps: 3_000n },
    };
    const protocol = await installFixture(env.pic, "payment_harness", "test/fixtures/PaymentHarness.mo", [config]);
    await ledger.actor.credit(account(neutron.canisterId), 10_000n);
    const now = BigInt(await env.pic.getTime()) * 1_000_000n;
    return { ...env, ledger, neutron, publisher, protocol, config, now };
  } catch (error) {
    await env.shutdown();
    throw error;
  }
}

type Environment = Awaited<ReturnType<typeof setup>>;

function proposedPurchase(env: Environment, requestId = "purchase-1", appId = "sample_app") {
  return {
    owner: env.neutron.canisterId, requestId,
    intentHash: new TextEncoder().encode(`intent:${requestId}:${appId}`),
    quoteCommitment: new TextEncoder().encode(`quote:${requestId}:${appId}`),
    ledger: env.ledger.canisterId, amount: 100n, fee: 10n, affiliate: [], rateId: 0n,
    items: [{ appId, listingRevision: 1n, publisher: env.publisher.canisterId,
      priceUsdMicros: 1_000_000n, paidAtoms: 100n, developerAtoms: 30n, affiliateAtoms: 0n,
      burnAtoms: 70n, releaseDigest: Uint8Array.of(1, 2, 3) }],
    state: { prepared: null }, currentAttempt: [], createdAtNs: env.now, updatedAtNs: env.now,
    finalizedAtNs: [], lastError: [],
  };
}

async function preparePurchase(env: Environment, requestId?: string, appId?: string) {
  const proposed = proposedPurchase(env, requestId, appId);
  const order = domainOk(await relayCall(env.neutron, env.protocol, "preparePurchase", [proposed]));
  const subaccount = await env.protocol.actor.spenderSubaccount(proposed);
  ok(await relayCall(env.neutron, env.ledger, "icrc2_approve", [{
    from_subaccount: [], spender: { owner: env.protocol.canisterId, subaccount: [subaccount] },
    amount: proposed.amount + proposed.fee, expected_allowance: [0n], expires_at: [], fee: [10n],
    memo: [new TextEncoder().encode(`approve:${proposed.requestId}`)], created_at_time: [env.now],
  }]));
  return { proposed, order };
}

async function assertCompletedPurchase(env: Environment, order: any, appId = "sample_app") {
  state(order, "complete");
  const attempt = some<any>(await env.protocol.actor.attempt(some<bigint>(order.currentAttempt)));
  state(attempt, "succeeded");
  assert.equal(some<any>(await env.protocol.actor.entitlement(env.neutron.canisterId, appId)).orderId, order.id);
  const acquisition = some<any>(await env.protocol.actor.acquisition(env.neutron.canisterId, appId));
  assert.equal(acquisition.orderId, order.id);
  assert.deepEqual(acquisition.block, attempt.block);
  assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false)).available, 30n);
  assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true)).available, 70n);
  assert.deepEqual(await env.protocol.actor.claim(env.neutron.canisterId, appId), []);
  assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
}

async function runPurchase(env: Environment, id: bigint) {
  return domainOk(await relayCall(env.neutron, env.protocol, "runPurchase", [id]));
}

function proposedWithdrawal(env: Environment, requestId: string, totalDebit = 80n) {
  return {
    owner: env.publisher.canisterId, requestId, intentHash: new TextEncoder().encode(`withdraw:${requestId}`),
    ledger: env.ledger.canisterId, to: account(env.publisher.canisterId), totalDebit, fee: 10n, isBurn: false,
    state: { prepared: null }, currentAttempt: [], createdAtNs: env.now, updatedAtNs: env.now,
    finalizedAtNs: [], lastError: [],
  };
}

export const cases: IntegrationCase[] = [
  {
    name: "Payment engine: lost collection reply retries exact saved request and finalizes once",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const { order } = await preparePurchase(env);
        await env.ledger.actor.setScript([{ commitThenReject: "reply lost after collection" }]);
        const unknown = await runPurchase(env, order.id);
        state(unknown, "outcome_unknown");
        const original = some<any>(await env.protocol.actor.attempt(some<bigint>(unknown.currentAttempt)));
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
        assert.deepEqual(await env.protocol.actor.entitlement(env.neutron.canisterId, "sample_app"), []);
        assert.deepEqual(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false), []);
        assert.equal(some<any>(await env.protocol.actor.claim(env.neutron.canisterId, "sample_app")).orderId, order.id);

        const complete = await runPurchase(env, order.id);
        await assertCompletedPurchase(env, complete);
        const confirmed = some<any>(await env.protocol.actor.attempt(some<bigint>(complete.currentAttempt)));
        assert.deepEqual(confirmed.request, original.request);
        assert.equal(confirmed.duplicate, true);
        assert.equal(confirmed.hadUnknown, true);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 2n);
        await assertCompletedPurchase(env, await runPurchase(env, order.id));
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 2n, "Completed retry does not call the ledger");
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n, "One approval and one collection");
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: same-ID and overlapping-cart calls cannot double collect",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const first = await preparePurchase(env, "first");
        const second = await preparePurchase(env, "second");
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.ledger.actor.setScript([{ hold: gate.canisterId }]);
        const receive = await deferredRelayCall(env.pic, env.neutron, env.protocol, "runPurchase", [first.order.id]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "purchase waiting on the ledger");
        const same = await runPurchase(env, first.order.id);
        state(same, "dispatched");
        const competing: any = await relayCall(env.neutron, env.protocol, "runPurchase", [second.order.id]);
        assert.match(competing.err, /Another purchase is already acquiring/);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 1n);
        await gate.actor.releaseGate();
        await assertCompletedPurchase(env, domainOk(await receive()));
        const after: any = await relayCall(env.neutron, env.protocol, "runPurchase", [second.order.id]);
        assert.match(after.err, /Ownership changed/);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 3n, "Two approvals, only one collection");
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: overlapping withdrawals cannot spend reserved earnings",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        await env.protocol.actor.seedCredit(env.ledger.canisterId, env.publisher.canisterId, 100n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 100n);
        const first = domainOk(await relayCall(env.publisher, env.protocol, "prepareWithdrawal", [proposedWithdrawal(env, "first")]));
        const second = domainOk(await relayCall(env.publisher, env.protocol, "prepareWithdrawal", [proposedWithdrawal(env, "second")]));
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.ledger.actor.setScript([{ hold: gate.canisterId }]);
        const receive = await deferredRelayCall(env.pic, env.publisher, env.protocol, "runWithdrawal", [first.id]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "withdrawal waiting on the ledger");
        const reserved = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(reserved.available, 20n);
        assert.equal(reserved.reserved, 80n);
        const same = domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [first.id]));
        state(same, "dispatched");
        const competing: any = await relayCall(env.publisher, env.protocol, "runWithdrawal", [second.id]);
        assert.match(competing.err, /available/i);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        await gate.actor.releaseGate();
        state(domainOk(await receive()), "complete");
        const credit = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(credit.available, 20n);
        assert.equal(credit.reserved, 0n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.publisher.canisterId)), 70n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 20n);
        state(domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [first.id])), "complete");
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: unknown withdrawal retains its reservation after TooOld and settles exact duplicate",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        await env.protocol.actor.seedCredit(env.ledger.canisterId, env.publisher.canisterId, 100n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 100n);
        const prepared = domainOk(await relayCall(env.publisher, env.protocol, "prepareWithdrawal", [proposedWithdrawal(env, "lost-payout")]));
        await env.ledger.actor.setScript([{ commitThenReject: "payout committed but reply lost" }]);
        const unknown = domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [prepared.id]));
        state(unknown, "outcome_unknown");
        const original = some<any>(await env.protocol.actor.attempt(some<bigint>(unknown.currentAttempt)));
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.publisher.canisterId)), 70n);
        await env.ledger.actor.setTimeRules(1_000_000_000n, 60_000_000_000n);
        await env.pic.advanceTime(2_000);
        await env.pic.tick();
        const tooOld = domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [prepared.id]));
        state(tooOld, "outcome_unknown");
        const retained = some<any>(await env.protocol.actor.attempt(original.id));
        state(retained, "outcome_unknown");
        assert.equal(retained.hadUnknown, true);
        assert.deepEqual(retained.request, original.request);
        const stillReserved = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(stillReserved.available, 20n);
        assert.equal(stillReserved.reserved, 80n);
        const competing = domainOk(await relayCall(env.publisher, env.protocol, "prepareWithdrawal", [proposedWithdrawal(env, "second-payout")]));
        const denied: any = await relayCall(env.publisher, env.protocol, "runWithdrawal", [competing.id]);
        assert.match(denied.err, /available/i);
        // Restore the fixture's deduplication window, without changing the saved
        // request. This now lets the ledger prove its original committed block.
        await env.ledger.actor.setTimeRules(86_400_000_000_000n, 60_000_000_000n);
        state(domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [prepared.id])), "complete");
        const completed = some<any>(await env.protocol.actor.attempt(original.id));
        assert.equal(completed.duplicate, true);
        assert.deepEqual(completed.request, original.request);
        const credit = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(credit.available, 20n);
        assert.equal(credit.reserved, 0n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.publisher.canisterId)), 70n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: real upgrade preserves unknown payment and exact same-ID recovery",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const { order, proposed } = await preparePurchase(env);
        await env.ledger.actor.setScript([{ commitThenReject: "collection committed before upgrade" }]);
        const unknown = await runPurchase(env, order.id);
        state(unknown, "outcome_unknown");
        const attempt = some<any>(await env.protocol.actor.attempt(some<bigint>(unknown.currentAttempt)));
        const subaccount = await env.protocol.actor.spenderSubaccount(proposed);
        await env.pic.upgradeCanister({
          canisterId: env.protocol.canisterId, wasm: env.protocol.wasmPath,
          arg: IDL.encode(env.protocol.init({ IDL }), [env.config]),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        const restored = some<any>(await env.protocol.actor.purchase(env.neutron.canisterId, proposed.requestId));
        assert.deepEqual(restored, unknown);
        assert.deepEqual(some(await env.protocol.actor.attempt(attempt.id)), attempt);
        assert.deepEqual(await env.protocol.actor.spenderSubaccount(proposed), subaccount);
        assert.equal(some<any>(await env.protocol.actor.claim(env.neutron.canisterId, "sample_app")).orderId, order.id);
        await assertCompletedPurchase(env, await runPurchase(env, order.id));
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
        const recovered = some<any>(await env.protocol.actor.attempt(attempt.id));
        assert.equal(recovered.duplicate, true);
        assert.deepEqual(recovered.request, attempt.request);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: daily forwarding spends only burn credits and does not repeat the day's payout",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const burner = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await env.protocol.actor.setBurnAccount(env.ledger.canisterId, [account(burner.canisterId)]);
        await env.protocol.actor.seedCredit(env.ledger.canisterId, env.publisher.canisterId, 300n);
        await env.protocol.actor.seedCredit(env.ledger.canisterId, env.neutron.canisterId, 200n);
        await env.protocol.actor.seedBurnCredit(env.ledger.canisterId, 100n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 600n);
        await env.protocol.actor.tickJobs();
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(burner.canisterId)), 90n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 500n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false)).available, 300n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.neutron.canisterId, false)).available, 200n);
        const burn = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true));
        assert.equal(burn.available, 0n);
        assert.equal(burn.reserved, 0n);
        const first: any[] = await env.protocol.actor.withdrawalsSnapshot();
        assert.equal(first.length, 1);
        state(first[0], "complete");
        assert.equal(first[0].isBurn, true);
        await env.protocol.actor.tickJobs();
        await env.protocol.actor.seedBurnCredit(env.ledger.canisterId, 50n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 50n);
        await env.protocol.actor.tickJobs();
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n, "New same-day credits wait for the next daily payout");
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true)).available, 50n);
        await env.pic.advanceTime(86_400_000);
        await env.pic.tick();
        await env.protocol.actor.tickJobs();
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(burner.canisterId)), 130n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 500n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false)).available, 300n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.neutron.canisterId, false)).available, 200n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: daily forwarding retains dust and balances without a configured destination",
    scope: "protocol",
    async run() {
      for (const scenario of ["missing_destination", "dust"] as const) {
        const env = await setup();
        try {
          const amount = scenario === "dust" ? 10n : 100n;
          if (scenario === "dust") {
            await env.protocol.actor.setBurnAccount(env.ledger.canisterId, [account(env.publisher.canisterId)]);
          }
          await env.protocol.actor.seedBurnCredit(env.ledger.canisterId, amount);
          await env.ledger.actor.credit(account(env.protocol.canisterId), amount);
          await env.protocol.actor.tickJobs();
          await env.protocol.actor.tickJobs();
          assert.equal((await env.ledger.actor.stats()).transferCalls, 0n, scenario);
          assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), amount);
          const retained = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true));
          assert.equal(retained.available, amount);
          assert.equal(retained.reserved, 0n);
          assert.deepEqual(await env.protocol.actor.withdrawalsSnapshot(), []);
        } finally { await env.shutdown(); }
      }
    },
  },
  {
    name: "Payment engine: daily forwarding resumes unknown payout across upgrade and day boundary before new credits",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const burner = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await env.protocol.actor.setBurnAccount(env.ledger.canisterId, [account(burner.canisterId)]);
        await env.protocol.actor.seedBurnCredit(env.ledger.canisterId, 100n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 100n);
        await env.ledger.actor.setTimeRules(604_800_000_000_000n, 60_000_000_000n);
        await env.ledger.actor.setScript([{ commitThenReject: "burn forwarding committed before reply loss" }]);
        await env.protocol.actor.tickJobs();
        const originalRows: any[] = await env.protocol.actor.withdrawalsSnapshot();
        assert.equal(originalRows.length, 1);
        const original = originalRows[0];
        state(original, "outcome_unknown");
        const originalAttempt = some<any>(await env.protocol.actor.attempt(some<bigint>(original.currentAttempt)));
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(burner.canisterId)), 90n);
        await env.protocol.actor.seedBurnCredit(env.ledger.canisterId, 50n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 50n);
        await env.pic.upgradeCanister({
          canisterId: env.protocol.canisterId, wasm: env.protocol.wasmPath,
          arg: IDL.encode(env.protocol.init({ IDL }), [env.config]),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        await env.pic.advanceTime(86_400_000);
        await env.pic.tick();
        await env.ledger.actor.setScript([{ temporary: null }]);
        await env.protocol.actor.tickJobs();
        const unresolvedRows: any[] = await env.protocol.actor.withdrawalsSnapshot();
        assert.equal(unresolvedRows.length, 1, "A later day must not create a payout while the original outcome is unknown");
        state(unresolvedRows[0], "outcome_unknown");
        const retained = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true));
        assert.equal(retained.available, 50n);
        assert.equal(retained.reserved, 100n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
        await env.protocol.actor.tickJobs();
        const recovered = some<any>(await env.protocol.actor.withdrawal(env.protocol.canisterId, original.requestId));
        state(recovered, "complete");
        const recoveredAttempt = some<any>(await env.protocol.actor.attempt(originalAttempt.id));
        assert.equal(recoveredAttempt.duplicate, true);
        assert.deepEqual(recoveredAttempt.request, originalAttempt.request);
        // Any later forwarding has a distinct daily record and spends only the
        // newly accrued 50, never the already-delivered original 100 again.
        await env.protocol.actor.tickJobs();
        const finalRows: any[] = await env.protocol.actor.withdrawalsSnapshot();
        assert.ok(finalRows.length <= 2);
        const transfers = (await env.ledger.actor.transactions()).filter((row: any) => "transfer" in row.kind);
        assert.equal(transfers.filter((row: any) => row.amount === 90n).length, 1);
        assert.ok(transfers.every((row: any) => row.amount === 90n || row.amount === 40n));
        assert.equal(some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.protocol.canisterId, true)).reserved, 0n);
        assert.ok(await env.ledger.actor.icrc1_balance_of(account(burner.canisterId)) <= 130n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: withdrawal finalization trap and upgrade retain successful payout without another transfer",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        await env.protocol.actor.seedCredit(env.ledger.canisterId, env.publisher.canisterId, 100n);
        await env.ledger.actor.credit(account(env.protocol.canisterId), 100n);
        const order = domainOk(await relayCall(env.publisher, env.protocol, "prepareWithdrawal", [proposedWithdrawal(env, "finalize-payout")]));
        await env.protocol.actor.setWithdrawalFinalizationFailure(true);
        const failed: any = await relayCall(env.publisher, env.protocol, "runWithdrawal", [order.id]);
        assert.match(failed.err, /interrupted/);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.publisher.canisterId)), 70n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 20n);
        const saved = some<any>(await env.protocol.actor.withdrawal(env.publisher.canisterId, "finalize-payout"));
        state(saved, "dispatched");
        const attempt = some<any>(await env.protocol.actor.attempt(some<bigint>(saved.currentAttempt)));
        state(attempt, "succeeded");
        assert.deepEqual(attempt.block, [0n], "The payout's successful block survives the subsequent accounting trap");
        assert.equal(attempt.duplicate, false);
        assert.equal(attempt.hadUnknown, false);
        const held = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(held.available, 20n);
        assert.equal(held.reserved, 80n);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);

        await env.pic.upgradeCanister({
          canisterId: env.protocol.canisterId, wasm: env.protocol.wasmPath,
          arg: IDL.encode(env.protocol.init({ IDL }), [env.config]),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        assert.deepEqual(some(await env.protocol.actor.withdrawal(env.publisher.canisterId, "finalize-payout")), saved);
        assert.deepEqual(some(await env.protocol.actor.attempt(attempt.id)), attempt);
        assert.deepEqual(some(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false)), held);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);

        const failedAgain: any = await relayCall(env.publisher, env.protocol, "runWithdrawal", [order.id]);
        assert.match(failedAgain.err, /interrupted/);
        assert.deepEqual(some(await env.protocol.actor.attempt(attempt.id)), attempt);
        assert.deepEqual(some(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false)), held);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);

        await env.protocol.actor.setWithdrawalFinalizationFailure(false);
        state(domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [order.id])), "complete");
        const recovered = some<any>(await env.protocol.actor.attempt(attempt.id));
        assert.deepEqual(recovered, attempt, "Local finalization uses the retained success without changing the ledger evidence");
        const credit = some<any>(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false));
        assert.equal(credit.available, 20n);
        assert.equal(credit.reserved, 0n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.publisher.canisterId)), 70n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 20n);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n, "A known successful payout is never submitted again");
        state(domainOk(await relayCall(env.publisher, env.protocol, "runWithdrawal", [order.id])), "complete");
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Payment engine: finalization trap and upgrade retain successful receipt without another ledger call",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const { order } = await preparePurchase(env);
        await env.protocol.actor.setFinalizationFailure(true);
        const failed: any = await relayCall(env.neutron, env.protocol, "runPurchase", [order.id]);
        assert.match(failed.err, /interrupted/);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 100n);
        assert.deepEqual(await env.protocol.actor.entitlement(env.neutron.canisterId, "sample_app"), []);
        assert.deepEqual(await env.protocol.actor.credit(env.ledger.canisterId, env.publisher.canisterId, false), []);
        const saved = some<any>(await env.protocol.actor.purchase(env.neutron.canisterId, "purchase-1"));
        state(saved, "dispatched");
        const attempt = some<any>(await env.protocol.actor.attempt(some<bigint>(saved.currentAttempt)));
        state(attempt, "succeeded");
        assert.deepEqual(attempt.block, [1n], "The received success block survives the later local finalization trap");
        assert.equal(attempt.duplicate, false);
        assert.equal(attempt.hadUnknown, false);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 1n);
        assert.equal(some<any>(await env.protocol.actor.claim(env.neutron.canisterId, "sample_app")).orderId, order.id);

        await env.pic.upgradeCanister({
          canisterId: env.protocol.canisterId, wasm: env.protocol.wasmPath,
          arg: IDL.encode(env.protocol.init({ IDL }), [env.config]),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        assert.deepEqual(some(await env.protocol.actor.purchase(env.neutron.canisterId, "purchase-1")), saved);
        assert.deepEqual(some(await env.protocol.actor.attempt(attempt.id)), attempt);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 1n);

        // The failure may persist across repeated resumes. Known success must
        // keep finalizing locally rather than sending even a deduplicated call.
        const failedAgain: any = await relayCall(env.neutron, env.protocol, "runPurchase", [order.id]);
        assert.match(failedAgain.err, /interrupted/);
        assert.deepEqual(some(await env.protocol.actor.attempt(attempt.id)), attempt);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 1n);
        await env.protocol.actor.setFinalizationFailure(false);
        await assertCompletedPurchase(env, await runPurchase(env, order.id));
        const recovered = some<any>(await env.protocol.actor.attempt(attempt.id));
        assert.equal(recovered.duplicate, false);
        assert.deepEqual(recovered.block, [1n]);
        assert.deepEqual(recovered.request, attempt.request);
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 1n, "Recovery must not call the ledger again after a known successful reply");
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
      } finally { await env.shutdown(); }
    },
  },
];
