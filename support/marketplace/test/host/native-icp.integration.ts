import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { account, deferredRelayCall, installFixture, ok, relayCall, wire, type IntegrationCase } from "./helpers.ts";
import { prepareAsh } from "../../scripts/test-ash-runtime.ts";
import { ICP_FEE, installNativeIcp } from "./native-icp-fixture.ts";

const memo = (byte: number) => new Uint8Array(32).fill(byte);
const some = <T = any>(value: T[]): T => { assert.equal(value.length, 1); return value[0]; };
const domainOk = (result: any): any => { assert.ok("ok" in result, wire(result)); return result.ok; };
const state = (value: any, expected: string) => assert.deepEqual(Object.keys(value.state), [expected], wire(value));
// ryjl3 belongs to the NNS routing range; keep the marketplace/Neutron relays
// on an application subnet while installing the genuine ledger on NNS.
const session = async () => (await prepareAsh()).createSession({ nns: { state: { type: "new" } } });

async function mint(ledger: any, minter: any, to: any, amount: bigint) {
  return ok(await relayCall(minter, ledger, "icrc1_transfer", [{
    from_subaccount: [], to: account(to), amount, fee: [], memo: [], created_at_time: [],
  }]));
}

export const cases: IntegrationCase[] = [
  {
    name: "Native ICP ledger: 32-byte memo, exact spender subaccount, duplicate and competing transfers",
    scope: "fixture",
    async run() {
      const env = await session();
      try {
        const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const protocol = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const minter = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const ledger = await installNativeIcp(env.pic, minter.canisterId);
        const opening = 1_000_000_000n;
        const price = 100_000_000n;
        await mint(ledger, minter, neutron.canisterId, opening);
        const now = BigInt(await env.pic.getTime()) * 1_000_000n;
        const spender = { owner: protocol.canisterId, subaccount: [memo(9)] };
        const approve = {
          from_subaccount: [], spender, amount: price + ICP_FEE, expected_allowance: [0n],
          expires_at: [], fee: [ICP_FEE], memo: [memo(1)], created_at_time: [now],
        };
        const approval = ok<bigint>(await relayCall(neutron, ledger, "icrc2_approve", [approve]));
        const repeatedApproval: any = await relayCall(neutron, ledger, "icrc2_approve", [approve]);
        assert.equal(repeatedApproval.Err.Duplicate.duplicate_of, approval);
        const transfer = {
          spender_subaccount: spender.subaccount, from: account(neutron.canisterId),
          to: account(protocol.canisterId), amount: price, fee: [ICP_FEE],
          memo: [memo(2)], created_at_time: [now],
        };
        const wrongAccount: any = await relayCall(protocol, ledger, "icrc2_transfer_from", [{ ...transfer, spender_subaccount: [] }]);
        assert.equal(wrongAccount.Err.InsufficientAllowance.allowance, 0n);
        const block = ok<bigint>(await relayCall(protocol, ledger, "icrc2_transfer_from", [transfer]));
        const repeatedTransfer: any = await relayCall(protocol, ledger, "icrc2_transfer_from", [transfer]);
        assert.equal(repeatedTransfer.Err.Duplicate.duplicate_of, block);
        assert.equal((await ledger.actor.icrc2_allowance({ account: account(neutron.canisterId), spender })).allowance, 0n);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), opening - price - 2n * ICP_FEE);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), price);

        const withdrawal = {
          from_subaccount: [], to: account(neutron.canisterId), amount: price - ICP_FEE,
          fee: [ICP_FEE], memo: [memo(3)], created_at_time: [now],
        };
        const competing = { ...withdrawal, memo: [memo(4)] };
        const first = await deferredRelayCall(env.pic, protocol, ledger, "icrc1_transfer", [withdrawal]);
        const second = await deferredRelayCall(env.pic, protocol, ledger, "icrc1_transfer", [competing]);
        const results: any[] = await Promise.all([first(), second()]);
        const winner = results.findIndex((value) => "Ok" in value);
        assert.notEqual(winner, -1);
        assert.equal(results[1 - winner].Err.InsufficientFunds.balance, 0n);
        const duplicate: any = await relayCall(protocol, ledger, "icrc1_transfer", [winner === 0 ? withdrawal : competing]);
        assert.equal(duplicate.Err.Duplicate.duplicate_of, results[winner].Ok);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), 0n);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), opening - 3n * ICP_FEE);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "Native ICP ledger: marketplace purchase and withdrawal recover retained success across upgrade",
    scope: "upgrade",
    async run() {
      const env = await session();
      try {
        const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const minter = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const ledger = await installNativeIcp(env.pic, minter.canisterId);
        const config = {
          admins: [neutron.canisterId], auditors: [],
          tokens: [{ ledger: ledger.canisterId, symbol: "ICP", decimals: 8, fee: ICP_FEE, rateSymbol: "ICP", burnAccount: [] }],
          xrc: ledger.canisterId,
          fees: { version: 1n, updateBase: 0n, updateByte: 0n, storageByteYear: 0n, purchase: 0n, withdraw: 0n, grant: 0n, xrc: 0n },
          referralTerms: { version: 1n, discountBps: 1_000n, affiliateBps: 3_000n, developerBps: 3_000n },
        };
        const protocol = await installFixture(env.pic, "payment_harness", "test/fixtures/PaymentHarness.mo", [config]);
        const opening = 1_000_000_000n;
        const price = 100_000_000n;
        const royalty = 30_000_000n;
        await mint(ledger, minter, neutron.canisterId, opening);
        const now = BigInt(await env.pic.getTime()) * 1_000_000n;
        const proposed = {
          owner: neutron.canisterId, requestId: "native-icp-purchase", intentHash: memo(10), quoteCommitment: memo(11),
          ledger: ledger.canisterId, amount: price, fee: ICP_FEE, affiliate: [], rateId: 0n,
          items: [{ appId: "native_icp_app", listingRevision: 1n, publisher: publisher.canisterId,
            priceUsdMicros: 1_000_000n, paidAtoms: price, developerAtoms: royalty, affiliateAtoms: 0n,
            burnAtoms: price - royalty, releaseDigest: memo(12) }],
          state: { prepared: null }, currentAttempt: [], createdAtNs: now, updatedAtNs: now, finalizedAtNs: [], lastError: [],
        };
        const order = domainOk(await relayCall(neutron, protocol, "preparePurchase", [proposed]));
        const subaccount = await protocol.actor.spenderSubaccount(proposed);
        assert.equal(subaccount.length, 32);
        assert.notDeepEqual(subaccount, await protocol.actor.spenderSubaccount({ ...proposed, requestId: "another-order" }));
        const spender = { owner: protocol.canisterId, subaccount: [subaccount] };
        ok(await relayCall(neutron, ledger, "icrc2_approve", [{
          from_subaccount: [], spender, amount: price + ICP_FEE, expected_allowance: [0n],
          expires_at: [], fee: [ICP_FEE], memo: [memo(13)], created_at_time: [now],
        }]));
        await protocol.actor.setFinalizationFailure(true);
        const failed: any = await relayCall(neutron, protocol, "runPurchase", [order.id]);
        assert.match(failed.err, /interrupted/);
        const saved = some<any>(await protocol.actor.purchase(neutron.canisterId, proposed.requestId));
        const proof = some<any>(await protocol.actor.attempt(some<bigint>(saved.currentAttempt)));
        state(saved, "dispatched");
        state(proof, "succeeded");
        assert.equal(proof.request.memo.length, 32, "The actual production purchase engine uses the native ledger's maximum memo length");
        assert.deepEqual(proof.request.spenderSubaccount, [subaccount]);
        assert.equal(proof.duplicate, false);
        assert.equal(proof.hadUnknown, false);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), price);
        assert.deepEqual(await protocol.actor.entitlement(neutron.canisterId, "native_icp_app"), []);

        const upgrade = () => env.pic.upgradeCanister({
          canisterId: protocol.canisterId, wasm: protocol.wasmPath,
          arg: IDL.encode(protocol.init({ IDL }), [config]),
          upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
        });
        await upgrade();
        assert.deepEqual(some(await protocol.actor.attempt(proof.id)), proof);
        await protocol.actor.setFinalizationFailure(false);
        state(domainOk(await relayCall(neutron, protocol, "runPurchase", [order.id])), "complete");
        state(domainOk(await relayCall(neutron, protocol, "runPurchase", [order.id])), "complete");
        assert.deepEqual(some(await protocol.actor.attempt(proof.id)), proof, "Recovery retains the first successful receipt, rather than a Duplicate response");
        assert.equal(some<any>(await protocol.actor.entitlement(neutron.canisterId, "native_icp_app")).orderId, order.id);
        assert.equal(some<any>(await protocol.actor.credit(ledger.canisterId, publisher.canisterId, false)).available, royalty);
        assert.equal(some<any>(await protocol.actor.credit(ledger.canisterId, protocol.canisterId, true)).available, price - royalty);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), opening - price - 2n * ICP_FEE);

        const withdrawal = domainOk(await relayCall(publisher, protocol, "prepareWithdrawal", [{
          owner: publisher.canisterId, requestId: "native-icp-royalty", intentHash: memo(14), ledger: ledger.canisterId,
          to: account(publisher.canisterId), totalDebit: royalty, fee: ICP_FEE, isBurn: false,
          state: { prepared: null }, currentAttempt: [], createdAtNs: now, updatedAtNs: now, finalizedAtNs: [], lastError: [],
        }]));
        await protocol.actor.setWithdrawalFinalizationFailure(true);
        const stopped: any = await relayCall(publisher, protocol, "runWithdrawal", [withdrawal.id]);
        assert.match(stopped.err, /interrupted/);
        const savedWithdrawal = some<any>(await protocol.actor.withdrawal(publisher.canisterId, "native-icp-royalty"));
        const withdrawalProof = some<any>(await protocol.actor.attempt(some<bigint>(savedWithdrawal.currentAttempt)));
        state(withdrawalProof, "succeeded");
        assert.equal(withdrawalProof.request.memo.length, 32);
        assert.equal(await ledger.actor.icrc1_balance_of(account(publisher.canisterId)), royalty - ICP_FEE);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), price - royalty);
        assert.equal(some<any>(await protocol.actor.credit(ledger.canisterId, publisher.canisterId, false)).reserved, royalty);
        await upgrade();
        assert.deepEqual(some(await protocol.actor.attempt(withdrawalProof.id)), withdrawalProof);
        await protocol.actor.setWithdrawalFinalizationFailure(false);
        state(domainOk(await relayCall(publisher, protocol, "runWithdrawal", [withdrawal.id])), "complete");
        state(domainOk(await relayCall(publisher, protocol, "runWithdrawal", [withdrawal.id])), "complete");
        assert.deepEqual(some(await protocol.actor.attempt(withdrawalProof.id)), withdrawalProof);
        const credit = some<any>(await protocol.actor.credit(ledger.canisterId, publisher.canisterId, false));
        assert.equal(credit.available, 0n);
        assert.equal(credit.reserved, 0n);
        assert.equal(await ledger.actor.icrc1_balance_of(account(publisher.canisterId)), royalty - ICP_FEE);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), price - royalty);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), opening - price - 2n * ICP_FEE);
      } finally { await env.shutdown(); }
    },
  },
];
