import assert from "node:assert/strict";
import path from "node:path";
import { IDL } from "@dfinity/candid";
import {
  encodeLocalLedgerInitArgs,
  LEDGER_WASM_ARTIFACT,
  LOCAL_LEDGER_FIXTURES,
  resolveLocalFixtureArtifacts,
  type PreparedLocalFixtureWasm,
} from "../../../../packages/neutron-provision/src/local_fixtures.ts";
import { repositoryRoot } from "../../scripts/test-ash-runtime.ts";
import {
  account, deferredRelayCall, installFixture, ok, relayCall, session,
  type IntegrationCase,
} from "./helpers.ts";

// Genuine, release-pinned DFINITY ICRC ledger, not the scripted error fixture.
// This exercises its ICRC-1/2 behavior with two token configurations; it does
// not claim coverage of the separate legacy ICP ledger or production canisters.
let artifact: Promise<PreparedLocalFixtureWasm> | undefined;
function officialLedger() {
  return artifact ??= resolveLocalFixtureArtifacts({
    cacheDirectory: path.join(repositoryRoot, ".neutron/cache/fixtures"),
  }).then(({ ledger }) => {
    // The shared fixture resolver verifies the compressed artifact SHA-256
    // against the repository catalog before decompressing or installing it.
    assert.match(ledger.moduleHashHex, /^[0-9a-f]{64}$/);
    console.log(`Official ICRC fixture ${LEDGER_WASM_ARTIFACT.release}; archive sha256=${LEDGER_WASM_ARTIFACT.archiveSha256}; module sha256=${ledger.moduleHashHex}`);
    return ledger;
  }).catch((cause) => {
    throw new Error(`Required official ledger fixture ${LEDGER_WASM_ARTIFACT.release}/${LEDGER_WASM_ARTIFACT.name} could not be verified. Populate the repository's pinned fixture cache or allow its official release download. This case cannot be skipped.`, { cause });
  });
}

// Standard ICRC wire types. Init encoding is reused from neutron-provision,
// rather than maintaining a second release-specific ledger initialization DID.
export const ledgerIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const blob = IDL.Vec(IDL.Nat8);
  const accountType = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(blob) });
  const common = {
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
    TooOld: IDL.Null,
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
  };
  const timestamped = { fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(blob), created_at_time: IDL.Opt(IDL.Nat64) };
  const result = (errors: Record<string, IDL.Type>) => IDL.Variant({ Ok: IDL.Nat, Err: IDL.Variant(errors) });
  const transferErrors = { ...common, BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }) };
  return IDL.Service({
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
    icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_balance_of: IDL.Func([accountType], [IDL.Nat], ["query"]),
    icrc1_transfer: IDL.Func([IDL.Record({ from_subaccount: IDL.Opt(blob), to: accountType, amount: IDL.Nat, ...timestamped })], [result(transferErrors)], []),
    icrc2_allowance: IDL.Func([IDL.Record({ account: accountType, spender: accountType })], [IDL.Record({ allowance: IDL.Nat, expires_at: IDL.Opt(IDL.Nat64) })], ["query"]),
    icrc2_approve: IDL.Func([IDL.Record({
      from_subaccount: IDL.Opt(blob), spender: accountType, amount: IDL.Nat,
      expected_allowance: IDL.Opt(IDL.Nat), expires_at: IDL.Opt(IDL.Nat64), ...timestamped,
    })], [result({ ...common, AllowanceChanged: IDL.Record({ current_allowance: IDL.Nat }), Expired: IDL.Record({ ledger_time: IDL.Nat64 }) })], []),
    icrc2_transfer_from: IDL.Func([IDL.Record({
      spender_subaccount: IDL.Opt(blob), from: accountType, to: accountType, amount: IDL.Nat, ...timestamped,
    })], [result({ ...transferErrors, InsufficientAllowance: IDL.Record({ allowance: IDL.Nat }) })], []),
  });
};

export const cases: IntegrationCase[] = ["ckusdc", "ckbtc"].map((key) => {
  const spec = LOCAL_LEDGER_FIXTURES.find((fixture) => fixture.key === key)!;
  return {
    name: `Official ICRC ledger (${spec.decimals} decimals): subaccount collection, duplicates and concurrent withdrawal accounting`,
    scope: "fixture",
    async run() {
      const artifact = await officialLedger();
      const env = await session();
      try {
        const neutron = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const protocol = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const minter = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        const canisterId = await env.pic.createCanister({ cycles: 100_000_000_000_000n });
        await env.pic.installCode({ canisterId, wasm: artifact.wasm, arg: encodeLocalLedgerInitArgs(spec, minter.canisterId) });
        const ledger = { canisterId, idlFactory: ledgerIdl, actor: env.pic.createActor(ledgerIdl, canisterId) };
        assert.equal(await ledger.actor.icrc1_decimals(), spec.decimals);
        assert.equal(await ledger.actor.icrc1_fee(), spec.fee);

        const unit = 10n ** BigInt(spec.decimals);
        const openingBalance = 10n * unit;
        const purchaseAmount = unit;
        // Only fixture setup mints; the buyer and protocol below are ordinary
        // accounts and therefore pay fees on every actual ledger operation.
        ok(await relayCall(minter, ledger, "icrc1_transfer", [{
          from_subaccount: [], to: account(neutron.canisterId), amount: openingBalance,
          fee: [], memo: [], created_at_time: [],
        }]));
        const now = BigInt(await env.pic.getTime()) * 1_000_000n;
        const spenderSubaccount = new Uint8Array(32).fill(7);
        const spender = { owner: protocol.canisterId, subaccount: [spenderSubaccount] };
        const approval = {
          from_subaccount: [], spender, amount: purchaseAmount + spec.fee,
          expected_allowance: [0n], expires_at: [], fee: [spec.fee],
          memo: [Uint8Array.of(1)], created_at_time: [now],
        };
        const approveBlock = ok<bigint>(await relayCall(neutron, ledger, "icrc2_approve", [approval]));
        const duplicateApproval: any = await relayCall(neutron, ledger, "icrc2_approve", [approval]);
        assert.equal(duplicateApproval.Err.Duplicate.duplicate_of, approveBlock);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), openingBalance - spec.fee);

        const collection = {
          spender_subaccount: [spenderSubaccount], from: account(neutron.canisterId),
          to: account(protocol.canisterId), amount: purchaseAmount, fee: [spec.fee],
          memo: [Uint8Array.of(2)], created_at_time: [now],
        };
        const wrongSpender: any = await relayCall(protocol, ledger, "icrc2_transfer_from", [{ ...collection, spender_subaccount: [] }]);
        assert.equal(wrongSpender.Err.InsufficientAllowance.allowance, 0n);
        const collectionBlock = ok<bigint>(await relayCall(protocol, ledger, "icrc2_transfer_from", [collection]));
        const duplicateCollection: any = await relayCall(protocol, ledger, "icrc2_transfer_from", [collection]);
        assert.equal(duplicateCollection.Err.Duplicate.duplicate_of, collectionBlock);
        assert.equal((await ledger.actor.icrc2_allowance({ account: account(neutron.canisterId), spender })).allowance, 0n);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), openingBalance - purchaseAmount - 2n * spec.fee);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), purchaseAmount);

        // Two distinct concurrent payouts each require the entire available
        // balance. The genuine ledger must apply exactly one, never overdraw.
        const withdrawal = {
          from_subaccount: [], to: account(neutron.canisterId), amount: purchaseAmount - spec.fee,
          fee: [spec.fee], memo: [Uint8Array.of(3)], created_at_time: [now],
        };
        const competing = { ...withdrawal, memo: [Uint8Array.of(4)] };
        const receiveFirst = await deferredRelayCall(env.pic, protocol, ledger, "icrc1_transfer", [withdrawal]);
        const receiveSecond = await deferredRelayCall(env.pic, protocol, ledger, "icrc1_transfer", [competing]);
        const results: any[] = await Promise.all([receiveFirst(), receiveSecond()]);
        const succeeded = results.findIndex((result) => "Ok" in result);
        assert.notEqual(succeeded, -1, "One withdrawal must succeed");
        assert.equal(results[1 - succeeded].Err.InsufficientFunds.balance, 0n);
        const duplicateWithdrawal: any = await relayCall(protocol, ledger, "icrc1_transfer", [succeeded === 0 ? withdrawal : competing]);
        assert.equal(duplicateWithdrawal.Err.Duplicate.duplicate_of, results[succeeded].Ok);
        assert.equal(await ledger.actor.icrc1_balance_of(account(protocol.canisterId)), 0n);
        assert.equal(await ledger.actor.icrc1_balance_of(account(neutron.canisterId)), openingBalance - 3n * spec.fee);
      } finally { await env.shutdown(); }
    },
  };
});
