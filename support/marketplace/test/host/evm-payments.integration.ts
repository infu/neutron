import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { CKUSDC, HELPER, receiptFor } from "./evm-fixture-helpers.ts";
import {
  account, deferredRelayCall, installFixture, relayCall, session, until, wire,
  type IntegrationCase,
} from "./helpers.ts";

const payer = "0x3333333333333333333333333333333333333333";
const hash = `0x${"42".repeat(32)}`;
const canonicalLedger = Principal.fromText(CKUSDC);

function accepted<T = any>(result: any): T {
  assert.ok(result && "ok" in result, `Expected ok, received ${wire(result)}`);
  return result.ok;
}

function some<T = any>(values: T[]): T {
  assert.equal(values.length, 1, "Expected a retained row");
  return values[0];
}

async function setup() {
  const env = await session();
  try {
    const ledger = await installFixture(env.pic, "fake_ledger", "test/fixtures/FakeLedger.mo", [{ symbol: "ckUSDC", decimals: 6, fee: 10n }]);
    const minter = await installFixture(env.pic, "fake_evm_minter", "test/fixtures/FakeEvmMinter.mo");
    const rpc = await installFixture(env.pic, "fake_evm_rpc", "test/fixtures/FakeEvmRpc.mo");
    const buyer = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const publisher = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
    const config = {
      admins: [buyer.canisterId], auditors: [],
      tokens: [{ ledger: canonicalLedger, symbol: "ckUSDC", decimals: 6, fee: 10n, rateSymbol: "USDC", burnAccount: [] }],
      xrc: minter.canisterId,
      fees: { version: 1n, updateBase: 0n, updateByte: 0n, storageByteYear: 0n, purchase: 0n, withdraw: 0n, grant: 0n, xrc: 0n },
      referralTerms: { version: 1n, discountBps: 1_000n, affiliateBps: 3_000n, developerBps: 3_000n },
    };
    const initArgs = [config, ledger.canisterId, minter.canisterId, rpc.canisterId];
    const protocol = await installFixture(env.pic, "evm_payment_harness", "test/fixtures/EvmPaymentHarness.mo", initArgs);
    await protocol.actor.seedApp("evm_sample", publisher.canisterId, 1_000_000n);
    return { ...env, ledger, minter, rpc, buyer, publisher, protocol, initArgs };
  } catch (error) {
    await env.shutdown();
    throw error;
  }
}

type Environment = Awaited<ReturnType<typeof setup>>;

function request(requestId = "evm-1", appIds = ["evm_sample"]) {
  return { requestId, appIds, ledger: canonicalLedger, referralCode: [] };
}

async function invoice(env: Environment, requestId = "evm-1") {
  const rows: any[] = await env.protocol.actor.invoices();
  return some(rows.filter((row) => row.requestId === requestId));
}

async function prepare(env: Environment, requestId = "evm-1", appIds?: string[]) {
  const quote = accepted(await relayCall(env.buyer, env.protocol, "quote", [request(requestId, appIds)]));
  accepted(await relayCall(env.buyer, env.protocol, "prepare", [quote, payer]));
  const saved = await invoice(env, requestId);
  assert.equal(saved.saleAtoms, 1_000_000n);
  assert.equal(saved.grossAtoms, 1_000_010n);
  assert.equal(saved.subaccount.length, 32);
  assert.equal(saved.route.helper, HELPER);
  return { quote, invoice: saved };
}

async function configureProof(env: Environment, saved: any, transactionHash = hash) {
  const evidence = receiptFor({
    helper: saved.route.helper, payer: saved.payer, recipient: env.protocol.canisterId,
    subaccount: Uint8Array.from(saved.subaccount), amount: saved.grossAtoms, hash: transactionHash,
  });
  await env.rpc.actor.setReceiptFor(transactionHash, { Consistent: { Ok: [evidence.receipt] } });
  await env.rpc.actor.setBlockFor(evidence.block.number, { Consistent: { Ok: evidence.block } });
  return evidence;
}

function invoiceAccount(env: Environment, saved: any) {
  return { owner: env.protocol.canisterId, subaccount: [saved.subaccount] };
}

async function fund(env: Environment, saved: any, amount = saved.grossAtoms) {
  await env.ledger.actor.credit(invoiceAccount(env, saved), amount);
}

async function verify(env: Environment, requestId = "evm-1", transactionHash = hash) {
  return accepted(await relayCall(env.buyer, env.protocol, "verify", [requestId, transactionHash]));
}

async function settle(env: Environment, requestId = "evm-1") {
  return accepted(await relayCall(env.buyer, env.protocol, "settle", [requestId]));
}

async function assertNoRevenue(env: Environment) {
  assert.deepEqual(await env.protocol.actor.credit(env.publisher.canisterId, false), []);
  assert.deepEqual(await env.protocol.actor.credit(env.protocol.canisterId, true), []);
}

async function assertRevenueOnce(env: Environment) {
  const saved = await invoice(env);
  assert.equal(saved.revenueFinalizedAtNs.length, 1);
  assert.equal(some<any>(await env.protocol.actor.credit(env.publisher.canisterId, false)).available, 300_000n);
  assert.equal(some<any>(await env.protocol.actor.credit(env.protocol.canisterId, true)).available, 700_000n);
  assert.equal(some<any>(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample")).orderId, saved.orderId);
  assert.equal(some<any>(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample")).orderId, saved.orderId);
  assert.equal((await env.protocol.actor.sweeps()).filter((row: any) => "sale" in row.purpose && row.finalizedAtNs.length === 1).length, 1);
}

async function upgrade(env: Environment) {
  await env.pic.upgradeCanister({
    canisterId: env.protocol.canisterId, wasm: env.protocol.wasmPath,
    arg: IDL.encode(env.protocol.init({ IDL }), env.initArgs),
    upgradeModeOptions: { skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] },
  });
}

export const cases: IntegrationCase[] = [
  {
    name: "EVM payment engine: exact mined deposit grants before wrapping and royalties wait for one confirmed sweep",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        const granted = await invoice(env);
        assert.equal(granted.acceptedReceiptId.length, 1);
        assert.equal(granted.entitlementGrantedAtNs.length, 1);
        assert.deepEqual(granted.revenueFinalizedAtNs, []);
        const acquisition = some<any>(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"));
        assert.deepEqual(acquisition.block, [], "Ethereum proof is not a ckUSDC sweep block");
        assert.equal((await env.ledger.actor.stats()).transferCalls, 0n);
        await assertNoRevenue(env);
        await settle(env);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 0n);

        await fund(env, prepared.invoice);
        await settle(env);
        await assertRevenueOnce(env);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 1_000_000n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(invoiceAccount(env, prepared.invoice)), 0n);
        const attempt = some<any>(await env.protocol.actor.attempts());
        assert.deepEqual(attempt.state, { succeeded: null });
        assert.deepEqual(attempt.block, [0n]);
        await settle(env);
        await verify(env);
        await assertRevenueOnce(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.equal((await env.protocol.actor.receipts()).length, 1);
        assert.deepEqual(some(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample")), acquisition);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: same invoice retries and overlapping verification do not duplicate receipt or entitlement",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        accepted(await relayCall(env.buyer, env.protocol, "prepare", [prepared.quote, payer]));
        assert.equal((await env.protocol.actor.invoices()).length, 1);
        assert.deepEqual((await invoice(env)).subaccount, prepared.invoice.subaccount);
        await configureProof(env, prepared.invoice);
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.rpc.actor.setBehavior({ receipt: { hold: gate.canisterId }, block: { normal: null } });
        const first = await deferredRelayCall(env.pic, env.buyer, env.protocol, "verify", ["evm-1", hash]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "verification waiting at the RPC fixture");
        await relayCall(env.buyer, env.protocol, "verify", ["evm-1", hash]);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        await gate.actor.releaseGate();
        accepted(await first());
        assert.equal((await env.protocol.actor.receipts()).length, 1);
        some(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"));
        await assertNoRevenue(env);
        await verify(env);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n, "A retained proof does not require another paid RPC call");

        await env.protocol.actor.seedApp("evm_other", env.publisher.canisterId, 1_000_000n);
        await prepare(env, "evm-other", ["evm_other"]);
        const reused: any = await relayCall(env.buyer, env.protocol, "verify", ["evm-other", hash]);
        assert.ok("err" in reused, wire(reused));
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_other"), []);
        assert.equal((await env.protocol.actor.receipts()).length, 1, "One event cannot pay a second invoice's different subaccount");
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: overlapping settlement calls cannot dispatch two invoice sweeps",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        await fund(env, prepared.invoice);
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.ledger.actor.setScript([{ hold: gate.canisterId }]);
        const first = await deferredRelayCall(env.pic, env.buyer, env.protocol, "settle", ["evm-1"]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "invoice sweep waiting at the ledger fixture");
        await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.equal((await env.protocol.actor.sweeps()).length, 1);
        await gate.actor.releaseGate();
        accepted(await first());
        await assertRevenueOnce(env);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: shared acquisition claims block IC collection and same-ID rail switching",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        const held = some<any>(await env.protocol.actor.claim(env.buyer.canisterId, "evm_sample"));
        assert.equal(held.orderId, prepared.invoice.orderId);
        const competing = accepted(await relayCall(env.buyer, env.protocol, "prepareIc", [request("ic-competitor")]));
        const denied: any = await relayCall(env.buyer, env.protocol, "runIc", [competing.id]);
        assert.ok("err" in denied, wire(denied));
        const switched: any = await relayCall(env.buyer, env.protocol, "runIc", [prepared.invoice.orderId]);
        assert.ok("err" in switched, wire(switched));
        assert.equal((await env.ledger.actor.stats()).transferFromCalls, 0n);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        accepted(await relayCall(env.buyer, env.protocol, "cancel", ["evm-1"]));
        assert.deepEqual(await env.protocol.actor.claim(env.buyer.canisterId, "evm_sample"), []);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: cancellation during proof verification converts late ckUSDC into buyer credit",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        const gate = await installFixture(env.pic, "relay", "test/fixtures/Relay.mo");
        await gate.actor.resetGate();
        await env.rpc.actor.setBehavior({ receipt: { hold: gate.canisterId }, block: { normal: null } });
        const verification = await deferredRelayCall(env.pic, env.buyer, env.protocol, "verify", ["evm-1", hash]);
        await until(env.pic, async () => (await gate.actor.gateStatus()).waiting === 1n, "proof request in flight before cancellation");
        accepted(await relayCall(env.buyer, env.protocol, "cancel", ["evm-1"]));
        assert.equal((await invoice(env)).canceledAtNs.length, 1);
        // A receipt arriving after cancellation cannot silently re-open the cart.
        await gate.actor.releaseGate();
        accepted(await verification());
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        await fund(env, prepared.invoice);
        await settle(env);
        await assertNoRevenue(env);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        assert.deepEqual(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"), []);
        assert.equal(some<any>(await env.protocol.actor.credit(env.buyer.canisterId, false)).available, 1_000_000n);
        assert.equal((await invoice(env)).creditedBuyerAtoms, 1_000_000n);
        const sweep = some<any>(await env.protocol.actor.sweeps());
        assert.deepEqual(sweep.purpose, { buyer_credit: null });
        await settle(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.buyer.canisterId, false)).available, 1_000_000n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: payer blocked after invoice preparation cannot obtain an early grant",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await env.minter.actor.setBlocked([payer]);
        const denied: any = await relayCall(env.buyer, env.protocol, "verify", ["evm-1", hash]);
        assert.ok("err" in denied, wire(denied));
        assert.match(denied.err.message, /minter.*accept|block/i);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 0n);
        assert.equal((await env.protocol.actor.receipts()).length, 0);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 0n);
        await env.minter.actor.setBlocked([]);
        await verify(env);
        some(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"));
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n);
        assert.equal((await env.protocol.actor.invoices()).length, 1);
        await assertNoRevenue(env);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: hashless funding waits for wrapping and then grants from one ledger sweep",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await settle(env);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 0n);
        await fund(env, prepared.invoice);
        await settle(env);
        await assertRevenueOnce(env);
        const saved = await invoice(env);
        assert.deepEqual(saved.acceptedReceiptId, []);
        assert.deepEqual(some<any>(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample")).block, [0n]);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 0n);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: completed invoice extra deposits are buyer credits and never extra royalties",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        await fund(env, prepared.invoice);
        await settle(env);
        await assertRevenueOnce(env);
        await fund(env, prepared.invoice, 110n);
        await settle(env);
        await assertRevenueOnce(env);
        assert.equal(some<any>(await env.protocol.actor.credit(env.buyer.canisterId, false)).available, 100n);
        assert.equal((await invoice(env)).creditedBuyerAtoms, 100n);
        assert.equal((await env.protocol.actor.sweeps()).filter((row: any) => "buyer_credit" in row.purpose).length, 1);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 2n);
        await settle(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 2n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: sweep fee increase holds the shortfall rather than reducing the sale",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        await fund(env, prepared.invoice);
        await env.ledger.actor.setFee(20n);
        await settle(env);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 0n);
        assert.equal(await env.ledger.actor.icrc1_balance_of(invoiceAccount(env, prepared.invoice)), 1_000_010n);
        await settle(env);
        await assertNoRevenue(env);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 0n);
        await fund(env, prepared.invoice, 10n);
        await settle(env);
        await assertRevenueOnce(env);
        assert.equal(await env.ledger.actor.icrc1_balance_of(account(env.protocol.canisterId)), 1_000_000n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: lost sweep reply uses exact Duplicate recovery and finalizes royalties once",
    scope: "protocol",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        await fund(env, prepared.invoice);
        await env.ledger.actor.setScript([{ commitThenReject: "sweep committed but reply lost" }]);
        await settle(env);
        await assertNoRevenue(env);
        const original = some<any>(await env.protocol.actor.attempts());
        assert.deepEqual(original.state, { outcome_unknown: null });
        assert.equal(await env.ledger.actor.icrc1_balance_of(invoiceAccount(env, prepared.invoice)), 0n);
        await settle(env);
        await assertRevenueOnce(env);
        const recovered = some<any>(await env.protocol.actor.attempts());
        assert.equal(recovered.id, original.id);
        assert.deepEqual(recovered.request, original.request);
        assert.equal(recovered.duplicate, true);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 2n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: verified Ethereum receipt survives grant trap and upgrade without another RPC read",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await env.protocol.actor.setGrantFailure(true);
        const failed: any = await relayCall(env.buyer, env.protocol, "verify", ["evm-1", hash]);
        assert.ok("err" in failed, wire(failed));
        const saved = await invoice(env);
        assert.equal(saved.acceptedReceiptId.length, 1);
        assert.deepEqual(saved.entitlementGrantedAtNs, []);
        assert.deepEqual(some<any>(await env.protocol.actor.status(env.buyer.canisterId, "evm-1")).nextAction, { settle: null });
        const receipt = some<any>(await env.protocol.actor.receipts());
        assert.equal(receipt.transactionHash, hash);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        assert.deepEqual(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"), []);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n);
        await upgrade(env);
        assert.deepEqual(some(await env.protocol.actor.receipts()), receipt);
        const failedAgain: any = await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        assert.ok("err" in failedAgain, wire(failedAgain));
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n);
        await env.protocol.actor.setGrantFailure(false);
        await settle(env);
        const granted = await invoice(env);
        assert.equal(granted.entitlementGrantedAtNs.length, 1);
        some(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"));
        some(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"));
        await assertNoRevenue(env);
        assert.equal((await env.rpc.actor.stats()).receiptCalls, 1n);
        assert.equal((await env.rpc.actor.stats()).blockCalls, 1n);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 0n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: buyer-credit trap and upgrade retain sweep success without another transfer",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        accepted(await relayCall(env.buyer, env.protocol, "cancel", ["evm-1"]));
        await fund(env, prepared.invoice);
        await env.protocol.actor.setRevenueFinalizationFailure(true);
        const failed: any = await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        assert.ok("err" in failed, wire(failed));
        await assertNoRevenue(env);
        assert.deepEqual(await env.protocol.actor.credit(env.buyer.canisterId, false), []);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        const original = some<any>(await env.protocol.actor.attempts());
        assert.deepEqual(original.state, { succeeded: null });
        assert.deepEqual(original.block, [0n]);
        assert.equal(original.duplicate, false);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.deepEqual(some<any>(await env.protocol.actor.sweeps()).purpose, { buyer_credit: null });
        await upgrade(env);
        assert.deepEqual(some(await env.protocol.actor.attempts()), original);
        const failedAgain: any = await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        assert.ok("err" in failedAgain, wire(failedAgain));
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        await env.protocol.actor.setRevenueFinalizationFailure(false);
        await settle(env);
        await assertNoRevenue(env);
        assert.equal(some<any>(await env.protocol.actor.credit(env.buyer.canisterId, false)).available, 1_000_000n);
        assert.equal((await invoice(env)).creditedBuyerAtoms, 1_000_000n);
        assert.deepEqual((await invoice(env)).revenueFinalizedAtNs, []);
        assert.deepEqual(await env.protocol.actor.entitlement(env.buyer.canisterId, "evm_sample"), []);
        assert.deepEqual(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"), []);
        assert.deepEqual(some(await env.protocol.actor.attempts()), original);
        await settle(env);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.equal((await env.ledger.actor.stats()).appliedTransactions, 1n);
        assert.equal(some<any>(await env.protocol.actor.credit(env.buyer.canisterId, false)).available, 1_000_000n);
      } finally { await env.shutdown(); }
    },
  },
  {
    name: "EVM payment engine: local royalty trap and upgrade retain sweep success without another ledger call",
    scope: "upgrade",
    async run() {
      const env = await setup();
      try {
        const prepared = await prepare(env);
        await configureProof(env, prepared.invoice);
        await verify(env);
        const acquisition = some<any>(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample"));
        await fund(env, prepared.invoice);
        await env.protocol.actor.setRevenueFinalizationFailure(true);
        const failed: any = await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        assert.ok("err" in failed, wire(failed));
        await assertNoRevenue(env);
        const original = some<any>(await env.protocol.actor.attempts());
        assert.deepEqual(original.state, { succeeded: null });
        assert.deepEqual(original.block, [0n]);
        assert.equal(original.duplicate, false);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        await upgrade(env);
        assert.deepEqual(some(await env.protocol.actor.attempts()), original);
        assert.deepEqual(some(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample")), acquisition);
        const failedAgain: any = await relayCall(env.buyer, env.protocol, "settle", ["evm-1"]);
        assert.ok("err" in failedAgain, wire(failedAgain));
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        await env.protocol.actor.setRevenueFinalizationFailure(false);
        await settle(env);
        await assertRevenueOnce(env);
        assert.deepEqual(some(await env.protocol.actor.attempts()), original);
        assert.equal((await env.ledger.actor.stats()).transferCalls, 1n);
        assert.deepEqual(some(await env.protocol.actor.acquisition(env.buyer.canisterId, "evm_sample")), acquisition);
      } finally { await env.shutdown(); }
    },
  },
];
