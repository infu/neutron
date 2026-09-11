import assert from "node:assert/strict";
import { CKUSDC, HELPER, MINTER, installAt, receiptFor } from "./evm-fixture-helpers.ts";
import { installFixture, session, type IntegrationCase } from "./helpers.ts";

const OPTIONS = {
  providers: [{ PublicNode: null }, { Llama: null }, { Ankr: null }],
  receiptResponseBytes: 2_048n, blockResponseBytes: 2_048n,
  receiptCycles: 100n, blockCycles: 200n,
};
const HASH = `0x${"12".repeat(32)}`;

export const cases: IntegrationCase[] = [
  {
    name: "EVM fixtures: production RPC client uses exact Candid and attaches native cycles",
    scope: "fixture",
    async run() {
      const env = await session();
      try {
        const rpc = await installFixture(env.pic, "fake_evm_rpc", "test/fixtures/FakeEvmRpc.mo");
        const client = await installFixture(env.pic, "evm_client_harness", "test/fixtures/EvmClientHarness.mo", [rpc.canisterId]);
        const observation = receiptFor({ helper: HELPER, payer: "0x3333333333333333333333333333333333333333", recipient: client.canisterId, subaccount: new Uint8Array(32).fill(1), amount: 1_000_000n, hash: HASH });
        await rpc.actor.setReceipt({ Consistent: { Ok: [observation.receipt] } });
        await rpc.actor.setBlock({ Consistent: { Ok: observation.block } });
        await rpc.actor.setCosts({ receipt: { Ok: 3n }, block: { Ok: 5n } });
        const result = await client.actor.observe(HASH, OPTIONS);
        assert.equal(result.ok.receipt.transactionHash, HASH);
        assert.equal(result.ok.block.hash, observation.block.hash);
        const stats = await rpc.actor.stats();
        assert.equal(stats.receiptCalls, 1n);
        assert.equal(stats.blockCalls, 1n);
        assert.deepEqual(stats.observations.map((entry: any) => entry.attachedCycles), [100n, 200n]);
        assert.deepEqual(stats.observations.map((entry: any) => entry.acceptedCycles), [3n, 5n]);
        assert.ok(stats.observations.every((entry: any) => entry.caller.toText() === client.canisterId.toText()));
        assert.deepEqual(stats.observations[1].method, { block: { Number: observation.block.number } });
        assert.deepEqual(stats.observations[0].config[0].responseConsensus, [{ Equality: null }]);
        await rpc.actor.setCosts({ receipt: { Ok: 101n }, block: { Ok: 5n } });
        const budget = await client.actor.observe(HASH, OPTIONS);
        assert.equal(budget.err.budget.required, 101n);
        assert.equal((await rpc.actor.stats()).receiptCalls, 1n, "Cost rejection must precede the paid call");
        await rpc.actor.setCostErrors({ receipt: ["fixture cost unavailable"], block: [] });
        const costError = await client.actor.observe(HASH, OPTIONS);
        assert.match(costError.err.transport.message, /fixture cost unavailable/);
        await rpc.actor.setCostErrors({ receipt: [], block: [] });
        await rpc.actor.setCosts({ receipt: { Ok: 1n }, block: { Ok: 1n } });
        await rpc.actor.setBehavior({ receipt: { reject: "fixture RPC reject" }, block: { normal: null } });
        const rejected = await client.actor.observe(HASH, OPTIONS);
        assert.match(rejected.err.transport.message, /fixture RPC reject/);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM fixtures: production minter and ckUSDC clients reach canonical local canister IDs",
    scope: "fixture",
    async run() {
      const env = await session();
      try {
        const minter = await installAt(env.pic, "fake_evm_minter", "test/fixtures/FakeEvmMinter.mo", [], MINTER);
        const ledger = await installAt(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10_000n }], CKUSDC);
        const rpc = await installFixture(env.pic, "fake_evm_rpc", "test/fixtures/FakeEvmRpc.mo");
        const client = await installFixture(env.pic, "evm_client_harness", "test/fixtures/EvmClientHarness.mo", [rpc.canisterId]);
        const discovered = await client.actor.discover();
        assert.equal(discovered.ok.helper, HELPER);
        assert.equal(discovered.ok.ledger.toText(), CKUSDC);
        assert.equal(discovered.ok.minter.toText(), MINTER);
        const payer = "0x3333333333333333333333333333333333333333";
        assert.equal((await client.actor.verifyPayer(discovered.ok, payer)).ok, payer);
        await minter.actor.setBlocked([payer]);
        assert.match((await client.actor.verifyPayer(discovered.ok, payer)).err, /does not accept deposits/);
        await minter.actor.setErrors({ info: ["fixture minter query rejected"], blocked: [] });
        assert.match((await client.actor.discover()).err, /fixture minter query rejected/);
        const subaccount = new Uint8Array(32).fill(7);
        await ledger.actor.credit({ owner: client.canisterId, subaccount: [subaccount] }, 1_010_000n);
        assert.equal((await client.actor.balance(client.canisterId, subaccount)).ok, 1_010_000n);
      } finally { await env.shutdown(); }
    },
  },
];
