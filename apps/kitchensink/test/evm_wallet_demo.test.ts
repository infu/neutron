import { expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { JsonValue, MsgBusClient, MsgBusToolCall } from "neutron-tools/app";
import {
  createEvmWalletClient,
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  type EvmAccount,
  type EvmEffectKind,
  type EvmEffectRequest,
  type EvmNetwork,
  type EvmOperationResult,
  type EvmOperationStatusRequest,
  type EvmSendTransactionRequest,
  type EvmSignMessageRequest,
  type EvmSignTypedDataRequest,
} from "neutron-tools/evm_wallet";
import {
  advanceEvmWalletDemo,
  createEvmDemoIntent,
  evmDemoRecordTerminal,
  readEvmWalletSelection,
  type EvmDemoDraft,
  type EvmDemoIntent,
  type EvmDemoRecord,
} from "../src/evm_wallet_demo.ts";
import {
  createEvmDemoJournal,
  EVM_DEMO_INTENT_TOOL,
  EVM_DEMO_STORAGE_KEY,
  runEvmDemoIntentAction,
} from "../src/evm_wallet_intent_storage.ts";
import { createWalletFundingDemoRequest } from "../src/wallet_funding_demo.ts";
import {
  runWalletFundingIntentAction,
  WALLET_FUNDING_INTENT_STORAGE_KEY,
} from "../src/wallet_funding_intent_storage.ts";

// Public fixture keys: no real wallet or network is used by these tests.
const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const otherSigner = privateKeyToAccount(`0x${"0".repeat(63)}2`);
const account: EvmAccount = {
  accountId: "main",
  address: signer.address.toLowerCase(),
  publicKey: signer.publicKey,
  keyFingerprint: `0x${"ab".repeat(32)}`,
  namespaceVersion: "1",
};
const recipient = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
const networks: EvmNetwork[] = [
  { chainId: "1", name: "Ethereum", nativeSymbol: "ETH", nativeDecimals: "18", explorerUrl: "https://etherscan.io", feeModel: "eip1559", finalityKind: "ethereum" },
  { chainId: "42161", name: "Arbitrum", nativeSymbol: "ETH", nativeDecimals: "18", explorerUrl: "https://arbiscan.io", feeModel: "eip1559", finalityKind: "arbitrum" },
];

test("first-use selection waits for account consent before requesting network consent", async () => {
  const fixture = new DemoFixture();
  const accountOpened = deferred();
  const accountConsent = deferred();
  fixture.beforeAccounts = async () => {
    accountOpened.resolve();
    await accountConsent.promise;
  };
  const selection = readEvmWalletSelection(fixture.wallet);
  await accountOpened.promise;
  expect(fixture.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  expect(fixture.storage.writes).toBe(0);
  accountConsent.resolve();
  const result = await selection;
  expect(result.accountResult.accounts[0]!.address).toBe(account.address);
  expect(result.networkResult.networks).toEqual(networks);
  expect(fixture.calls.map((call) => call.name))
    .toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.networks]);
  expect(fixture.effects).toEqual([]);
});

test("declined account consent never starts network discovery or writes an intent", async () => {
  const fixture = new DemoFixture();
  const accountOpened = deferred();
  const accountConsent = deferred();
  fixture.beforeAccounts = async () => {
    accountOpened.resolve();
    await accountConsent.promise;
  };
  const selection = readEvmWalletSelection(fixture.wallet);
  // Attach rejection handling before the gate opens, then assert after the
  // rejection; Bun's pending .rejects matcher must not hold the gate itself.
  void selection.catch(() => undefined);
  await accountOpened.promise;
  accountConsent.reject(new Error("Owner declined account read"));
  await expect(selection).rejects.toThrow("Owner declined account read");
  expect(fixture.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  expect(fixture.storage.writes).toBe(0);
  expect(fixture.effects).toEqual([]);
});

test("saved-intent advancement completes each read consent before status or effects", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  const preparedWrites = fixture.storage.writes;
  const accountOpened = deferred();
  const accountConsent = deferred();
  const networkOpened = deferred();
  const networkConsent = deferred();
  fixture.beforeAccounts = async () => {
    accountOpened.resolve();
    await accountConsent.promise;
  };
  fixture.beforeNetworks = async () => {
    networkOpened.resolve();
    await networkConsent.promise;
  };
  const advancing = advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  await accountOpened.promise;
  expect(fixture.calls.filter((call) => call.target === EVM_WALLET_TARGET).map((call) => call.name))
    .toEqual([EVM_WALLET_TOOLS.accounts]);
  expect(fixture.storage.writes).toBe(preparedWrites);
  accountConsent.resolve();
  await networkOpened.promise;
  expect(fixture.calls.filter((call) => call.target === EVM_WALLET_TARGET).map((call) => call.name))
    .toEqual([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.networks]);
  expect(fixture.storage.writes).toBe(preparedWrites);
  expect(fixture.storage.records()[0]!.progress[0]!.attempted).toBe(false);
  expect(fixture.statusReads).toEqual([]);
  expect(fixture.effects).toEqual([]);
  networkConsent.resolve();
  const result = await advancing;
  expect(evmDemoRecordTerminal(result)).toBe(true);
  expect(fixture.calls.filter((call) => call.target === EVM_WALLET_TARGET).map((call) => call.name))
    .toEqual([
      EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.networks,
      EVM_WALLET_TOOLS.operationStatus, EVM_WALLET_TOOLS.sendTransaction,
    ]);
  expect(fixture.effects).toHaveLength(1);
});

test("complete approval and call intent is durable before the first wallet effect", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  const prepared = await fixture.journal.prepare(intent);
  expect(fixture.effects).toEqual([]);
  expect(fixture.storage.records()).toEqual([prepared]);
  fixture.beforeEffect = (kind, request) => {
    const stored = fixture.storage.records()[0]!;
    expect(stored.intent).toEqual(intent);
    expect(stored.progress[0]!.attempted).toBe(true);
    expect(stored.progress[1]!.attempted).toBe(false);
    expect(kind).toBe("transaction");
    expect(request).toEqual(intent.steps[0]!.request);
  };
  const result = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const approval = intent.steps[0]!.request as EvmSendTransactionRequest;
  expect(decodeFunctionData({ abi: erc20Abi, data: approval.data as Hex })).toEqual({
    functionName: "approve", args: [recipient, 1000000n],
  });
  expect(intent.steps[1]!.request).toMatchObject({ to: recipient, valueWei: "0", data: "0x12345678" });
  expect(result.progress[0]!.operation?.status).toBe("confirmed");
  expect(result.progress[1]!.attempted).toBe(false);
  expect(fixture.effects).toHaveLength(1);
  expect(fixture.calls.every((call) => !call.name.includes("_root_"))).toBe(true);
});

test("preparation is idempotent and rejects changed effects without replacing evidence", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent();
  const first = await fixture.journal.prepare(intent);
  const storageWrites = fixture.storage.writes;
  expect(await fixture.journal.prepare(clone(intent))).toEqual(first);
  expect(await fixture.journal.prepare(fixture.intent())).toEqual(first);
  expect(fixture.storage.writes).toBe(storageWrites);
  const changed = clone(intent);
  (changed.steps[0]!.request as EvmSendTransactionRequest).valueWei = "2";
  await expect(fixture.journal.prepare(changed)).rejects.toThrow("conflicts");
  await expect(fixture.journal.prepare(fixture.intent({ amountAtoms: "2" })))
    .rejects.toThrow("unresolved EVM intent");
  expect(await fixture.journal.list()).toEqual([first]);
  expect(fixture.effects).toEqual([]);
});

test("missing wallet or unsupported saved chain cannot invoke an effect", async () => {
  for (const mode of ["missing", "unsupported"] as const) {
    const fixture = new DemoFixture();
    const intent = fixture.intent();
    await fixture.journal.prepare(intent);
    if (mode === "missing") fixture.accountsError = new Error("No installed EVM Wallet provider");
    else fixture.networkList = networks.filter((network) => network.chainId !== intent.chainId);
    await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
      .rejects.toThrow(mode === "missing" ? "No installed" : "does not support saved chain 1");
    const saved = await fixture.journal.get(intent.id);
    expect(saved.intent).toEqual(intent);
    expect(saved.progress[0]!.attempted).toBe(false);
    expect(saved.progress[0]!.error).not.toBeNull();
    expect(fixture.effects).toEqual([]);
    expect(fixture.statusReads).toEqual([]);
  }
});

test("a wallet decline is terminal and cannot reopen its review on resume", async () => {
  const fixture = new DemoFixture();
  fixture.effectStatus = "rejected";
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  const declined = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(declined.progress[0]!.operation?.status).toBe("rejected");
  expect(evmDemoRecordTerminal(declined)).toBe(true);
  const calls = fixture.calls.length;
  expect(await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id)).toEqual(declined);
  expect(fixture.effects).toHaveLength(1);
  expect(fixture.calls.slice(calls).every((call) => call.name === EVM_DEMO_INTENT_TOOL)).toBe(true);
  const next = await fixture.journal.prepare(fixture.intent());
  expect(next.intent.id).not.toBe(intent.id);
  expect(await fixture.journal.list()).toHaveLength(2);
});

test("a lost effect reply retains the attempted ID and reload reconciles without another effect", async () => {
  const fixture = new DemoFixture();
  fixture.loseNextEffectReply = true;
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("reply lost after wallet saved operation");
  const unknown = await fixture.journal.get(intent.id);
  expect(unknown.intent).toEqual(intent);
  expect(unknown.progress[0]).toMatchObject({ attempted: true, operation: null, signatureVerified: false });
  expect(unknown.progress[0]!.error).toContain("reply lost");
  const reloadedJournal = createEvmDemoJournal(fixture.bus);
  const reloadedWallet = createEvmWalletClient(fixture.bus);
  expect(await reloadedJournal.prepare(fixture.intent())).toEqual(unknown);
  const reconciled = await advanceEvmWalletDemo(reloadedWallet, reloadedJournal, intent.id);
  expect(reconciled.progress[0]!.operation?.status).toBe("confirmed");
  expect(reconciled.progress[0]!.error).toBeNull();
  expect(fixture.effects).toHaveLength(1);
  expect(fixture.statusReads.map((request) => request.requestId)).toEqual([intent.id, intent.id]);
  expect(reconciled.progress[0]!.operation?.requestId).toBe(intent.id);
});

test("concurrent tiles reuse a saved intent while independent chains keep separate progress", async () => {
  const fixture = new DemoFixture();
  const secondJournal = createEvmDemoJournal(fixture.bus);
  const ethereum = fixture.intent();
  const duplicate = fixture.intent();
  const arbitrum = fixture.intent({ chainId: "42161" });
  const [first, same, other] = await Promise.all([
    fixture.journal.prepare(ethereum), secondJournal.prepare(duplicate), secondJournal.prepare(arbitrum),
  ]);
  expect(same.intent.id).toBe(first.intent.id);
  expect(other.intent.id).toBe(arbitrum.id);
  expect(await fixture.journal.list()).toHaveLength(2);
  const results = await Promise.all([
    advanceEvmWalletDemo(fixture.wallet, fixture.journal, first.intent.id),
    advanceEvmWalletDemo(createEvmWalletClient(fixture.bus), secondJournal, other.intent.id),
  ]);
  expect(results.every(evmDemoRecordTerminal)).toBe(true);
  expect(fixture.effects.map(({ request }) => [request.chainId, request.requestId]).sort())
    .toEqual([["1", ethereum.id], ["42161", arbitrum.id]]);
  const saved = await fixture.journal.list();
  expect(saved).toHaveLength(2);
  expect(saved.every(evmDemoRecordTerminal)).toBe(true);
  expect(new Set(saved.map((record) => record.progress[0]!.operation?.operationId)).size).toBe(2);
});

test("a confirmed approval survives a failed contract call and neither is automatically repeated", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approval = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(approval.progress[0]!.operation?.status).toBe("confirmed");
  expect(approval.progress[1]!.attempted).toBe(false);
  fixture.effectStatus = "reverted";
  const result = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(result.progress[0]).toEqual(approval.progress[0]);
  expect(result.progress[1]!.operation?.status).toBe("reverted");
  expect(evmDemoRecordTerminal(result)).toBe(true);
  expect(await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id)).toEqual(result);
  expect(fixture.effects.map(({ request }) => request.requestId)).toEqual(intent.steps.map(({ request }) => request.requestId));
  expect(fixture.storage.records()[0]!.progress[0]!.operation?.transactionHash)
    .toBe(approval.progress[0]!.operation?.transactionHash);
});

test("a provider RPC failure on the next call retains approval and retries only its saved call ID", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approved = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const approval = approved.progress[0]!.operation;
  fixture.effectError = new Error("RPC providers unavailable during preparation");
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("RPC providers unavailable");
  const pending = await fixture.journal.get(intent.id);
  expect(pending.intent).toEqual(intent);
  expect(pending.progress[0]!.operation).toEqual(approval);
  expect(pending.progress[1]).toMatchObject({ attempted: true, operation: null, error: "RPC providers unavailable during preparation" });
  expect(evmDemoRecordTerminal(pending)).toBe(false);
  expect(fixture.operations.has(operationKey(intent.steps[1]!.request))).toBe(false);
  fixture.effectError = null;
  const recovered = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(recovered.progress[0]!.operation).toEqual(approval);
  expect(recovered.progress[1]!.operation?.status).toBe("confirmed");
  expect(evmDemoRecordTerminal(recovered)).toBe(true);
  expect(fixture.effects.map(({ request }) => request.requestId)).toEqual([
    intent.steps[0]!.request.requestId,
    intent.steps[1]!.request.requestId,
    intent.steps[1]!.request.requestId,
  ]);
});

test("an unavailable RPC status response cannot trigger resubmission of a pending transaction", async () => {
  const fixture = new DemoFixture();
  fixture.effectStatus = "submitted";
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  const submitted = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const original = submitted.progress[0]!.operation;
  fixture.statusError = new Error("RPC providers disagree about the canonical receipt");
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("RPC providers disagree");
  const retained = await fixture.journal.get(intent.id);
  expect(retained.intent).toEqual(intent);
  expect(retained.progress[0]!.operation).toEqual(original);
  expect(retained.progress[0]!.error).toContain("RPC providers disagree");
  expect(evmDemoRecordTerminal(retained)).toBe(false);
  expect(fixture.effects).toHaveLength(1);
  expect(fixture.statusReads.at(-1)).toEqual({ accountId: "main", chainId: "1", requestId: intent.id });
  fixture.statusError = null;
  expect((await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id)).progress[0]!.operation).toEqual(original);
  expect(fixture.effects).toHaveLength(1);
});

test("an approval receipt removed by a reorganization blocks the call until reconfirmed", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approved = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const confirmedApproval = approved.progress[0]!.operation!;
  const approvalKey = operationKey(intent.steps[0]!.request);
  fixture.operations.set(approvalKey, { ...confirmedApproval, status: "submitted", receipt: null });
  const previousReads = fixture.statusReads.length;
  const pending = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(pending.progress[0]!.operation).toEqual({ ...confirmedApproval, status: "submitted", receipt: null });
  expect(pending.progress[1]).toEqual(approved.progress[1]);
  expect(fixture.statusReads.slice(previousReads).map((request) => request.requestId))
    .toEqual([intent.steps[0]!.request.requestId]);
  expect(fixture.effects).toHaveLength(1);
  expect((await fixture.journal.get(intent.id)).progress[0]).toEqual(pending.progress[0]);

  fixture.operations.set(approvalKey, confirmedApproval);
  // This click reconciles the pending prerequisite; the next explicit click
  // requests the later transaction, preserving one step per user action.
  const reconfirmed = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(reconfirmed.progress[0]!.operation).toEqual(confirmedApproval);
  expect(reconfirmed.progress[1]!.attempted).toBe(false);
  expect(fixture.effects).toHaveLength(1);
  const complete = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(evmDemoRecordTerminal(complete)).toBe(true);
  expect(fixture.effects.map(({ request }) => request.requestId))
    .toEqual(intent.steps.map(({ request }) => request.requestId));
  await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(fixture.effects).toHaveLength(2);
});

test("a missing completed prerequisite stops before requesting the contract call", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approved = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  fixture.operations.delete(operationKey(intent.steps[0]!.request));
  const previousReads = fixture.statusReads.length;
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("no longer has the completed prerequisite operation");
  const retained = await fixture.journal.get(intent.id);
  expect(retained.progress[0]).toEqual(approved.progress[0]);
  expect(retained.progress[1]!.operation).toBeNull();
  expect(retained.progress[1]!.attempted).toBe(false);
  expect(retained.progress[1]!.error).toContain("next step was not submitted");
  expect(fixture.statusReads.slice(previousReads).map((request) => request.requestId))
    .toEqual([intent.steps[0]!.request.requestId]);
  expect(fixture.effects).toHaveLength(1);
});

test("wallet address or fingerprint replacement blocks both submission and reconciliation", async () => {
  for (const replacement of [
    { ...account, address: otherSigner.address },
    { ...account, keyFingerprint: `0x${"cd".repeat(32)}` },
  ]) {
    for (const attempted of [false, true]) {
      const fixture = new DemoFixture();
      const intent = fixture.intent();
      await fixture.journal.prepare(intent);
      if (attempted) {
        fixture.loseNextEffectReply = true;
        await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
          .rejects.toThrow("reply lost");
      }
      const effectCount = fixture.effects.length;
      const statusCount = fixture.statusReads.length;
      fixture.accountList = [replacement];
      await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
        .rejects.toThrow("account changed");
      expect(fixture.effects).toHaveLength(effectCount);
      expect(fixture.statusReads).toHaveLength(statusCount);
      expect((await fixture.journal.get(intent.id)).intent).toEqual(intent);
    }
  }
});

test("a lost contract-call reply preserves its confirmed approval across resume", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approval = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  fixture.loseNextEffectReply = true;
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("reply lost");
  const unknown = await fixture.journal.get(intent.id);
  expect(unknown.progress[0]).toEqual(approval.progress[0]);
  expect(unknown.progress[1]).toMatchObject({ attempted: true, operation: null });
  const resumed = await advanceEvmWalletDemo(fixture.wallet, createEvmDemoJournal(fixture.bus), intent.id);
  expect(resumed.progress[0]).toEqual(approval.progress[0]);
  expect(resumed.progress[1]!.operation?.status).toBe("confirmed");
  expect(fixture.effects.map(({ request }) => request.requestId))
    .toEqual(intent.steps.map(({ request }) => request.requestId));
});

test("failed intent or attempted-marker persistence prevents any wallet effect", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent();
  fixture.storage.failNextSet();
  await expect(fixture.journal.prepare(intent)).rejects.toThrow("storage write failed");
  expect(fixture.storage.records()).toEqual([]);
  expect(fixture.effects).toEqual([]);
  await fixture.journal.prepare(intent);
  fixture.storage.failNextSet();
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("storage write failed");
  const saved = await fixture.journal.get(intent.id);
  expect(saved.intent).toEqual(intent);
  expect(saved.progress[0]!.attempted).toBe(false);
  expect(fixture.effects).toEqual([]);
});

test("a previously observed operation disappearing blocks a replacement effect", async () => {
  const fixture = new DemoFixture();
  fixture.effectStatus = "submitted";
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  const submitted = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  fixture.operations.clear();
  await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
    .rejects.toThrow("no longer has a previously observed operation");
  expect(fixture.effects).toHaveLength(1);
  expect((await fixture.journal.get(intent.id)).progress[0]!.operation)
    .toEqual(submitted.progress[0]!.operation);
});

test("a replaced native transfer ends while explicit fresh preparation only saves a new intent", async () => {
  // Test identical and changed fresh requests separately, since preparing one
  // creates a new unresolved intent that subsequent form edits cannot replace.
  for (const amountAtoms of ["1000000", "2"]) {
    const fixture = new DemoFixture();
    fixture.effectStatus = "submitted";
    const intent = fixture.intent();
    await fixture.journal.prepare(intent);
    const submitted = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
    const original = submitted.progress[0]!.operation!;
    const replacementTransactionHash = `0x${"12".repeat(32)}`;
    expect(replacementTransactionHash).not.toBe(original.transactionHash);
    fixture.operations.set(operationKey(intent.steps[0]!.request), {
      ...original, status: "replaced", replacementTransactionHash, receipt: null,
    });

    const statusReads = fixture.statusReads.length;
    const replaced = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
    expect(replaced.progress[0]!.operation).toMatchObject({
      requestId: intent.id, operationId: original.operationId,
      status: "replaced", transactionHash: original.transactionHash,
      replacementTransactionHash, receipt: null,
    });
    expect(evmDemoRecordTerminal(replaced)).toBe(true);
    const resumed = await advanceEvmWalletDemo(fixture.wallet, createEvmDemoJournal(fixture.bus), intent.id);
    expect(resumed).toEqual(replaced);
    expect(fixture.effects).toHaveLength(1);
    expect(fixture.statusReads.slice(statusReads).map((request) => request.requestId))
      .toEqual([intent.id]);

    const changedOriginal = clone(intent);
    (changedOriginal.steps[0]!.request as EvmSendTransactionRequest).valueWei = "3";
    await expect(fixture.journal.prepare(changedOriginal)).rejects.toThrow("conflicts");
    const freshIntent = fixture.intent({ amountAtoms });
    const fresh = await fixture.journal.prepare(freshIntent);
    expect(fresh.intent).toEqual(freshIntent);
    expect(fresh.intent.id).not.toBe(intent.id);
    expect(fresh.progress[0]).toMatchObject({ attempted: false, operation: null });
    expect(await fixture.journal.list()).toHaveLength(2);
    expect((await fixture.journal.get(intent.id)).progress).toEqual(replaced.progress);
    expect(fixture.storage.records()[0]!.progress[0]!.operation?.replacementTransactionHash)
      .toBe(replacementTransactionHash);
    expect(fixture.effects).toHaveLength(1);
  }
});

test("a replaced approval never authorizes the later contract call", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  const approved = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const originalApproval = approved.progress[0]!.operation!;
  const replacementTransactionHash = `0x${"34".repeat(32)}`;
  fixture.operations.set(operationKey(intent.steps[0]!.request), {
    ...originalApproval, status: "replaced", replacementTransactionHash, receipt: null,
  });
  const statusReads = fixture.statusReads.length;
  const blocked = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(blocked.progress[0]!.operation).toMatchObject({
    status: "replaced", transactionHash: originalApproval.transactionHash,
    replacementTransactionHash, receipt: null,
  });
  expect(blocked.progress[1]).toEqual(approved.progress[1]);
  expect(evmDemoRecordTerminal(blocked)).toBe(true);
  const resumed = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(resumed).toEqual(blocked);
  expect(resumed.progress[1]!.attempted).toBe(false);
  expect(fixture.statusReads.slice(statusReads).map((request) => request.requestId))
    .toEqual([intent.steps[0]!.request.requestId]);
  const fresh = await fixture.journal.prepare(fixture.intent({ kind: "approval_call" }));
  expect(fresh.intent.id).not.toBe(intent.id);
  expect(fresh.progress.every((progress) => !progress.attempted && progress.operation === null)).toBe(true);
  expect(await fixture.journal.list()).toHaveLength(2);
  expect(fixture.effects.map(({ request }) => request.requestId))
    .toEqual([intent.steps[0]!.request.requestId]);
});

test("message and typed-data demos independently verify signatures before recording success", async () => {
  for (const kind of ["message", "typed_data"] as const) {
    const fixture = new DemoFixture();
    const intent = fixture.intent({ kind, chainId: "42161" });
    await fixture.journal.prepare(intent);
    const result = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
    expect(result.progress[0]!.signatureVerified).toBe(true);
    expect(result.progress[0]!.operation?.status).toBe("signed");
    expect(evmDemoRecordTerminal(result)).toBe(true);
    expect(fixture.effects[0]!.request).toEqual(intent.steps[0]!.request);
  }
});

test("a wallet claiming another account's signature is not accepted as success", async () => {
  for (const kind of ["message", "typed_data"] as const) {
    const fixture = new DemoFixture();
    fixture.useWrongSigner = true;
    const intent = fixture.intent({ kind });
    await fixture.journal.prepare(intent);
    await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
      .rejects.toThrow("does not verify");
    const saved = await fixture.journal.get(intent.id);
    expect(saved.progress[0]!.signatureVerified).toBe(false);
    expect(saved.progress[0]!.operation?.status).toBe("signed");
    expect(saved.progress[0]!.operation?.signature)
      .toBe(fixture.operations.get(operationKey(intent.steps[0]!.request))!.signature);
    expect(evmDemoRecordTerminal(saved)).toBe(false);
    expect(saved.progress[0]!.error).toContain("does not verify");
    await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
      .rejects.toThrow("does not verify");
    expect(fixture.effects).toHaveLength(1);
  }
});

test("operation replies for another chain, account or request cannot be accepted", async () => {
  for (const patch of [
    { chainId: "42161" },
    { address: otherSigner.address },
    { accountId: "another-account" },
    { requestId: "ff".repeat(16) },
  ]) {
    const fixture = new DemoFixture();
    fixture.operationReplyPatch = patch;
    const intent = fixture.intent();
    await fixture.journal.prepare(intent);
    await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id))
      .rejects.toThrow();
    const saved = await fixture.journal.get(intent.id);
    expect(saved.intent).toEqual(intent);
    expect(saved.progress[0]!.operation).toBeNull();
    expect(saved.progress[0]!.signatureVerified).toBe(false);
    expect(saved.progress[0]!.error).not.toBeNull();
    expect(evmDemoRecordTerminal(saved)).toBe(false);
    expect(fixture.effects).toHaveLength(1);
  }
});

test("stale journal revisions cannot overwrite newer confirmed progress", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent();
  const stale = await fixture.journal.prepare(intent);
  const confirmed = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(confirmed.revision).toBeGreaterThan(stale.revision);
  const writes = fixture.storage.writes;
  const encoded = fixture.storage.getItem(EVM_DEMO_STORAGE_KEY);
  expect(await fixture.journal.failed(stale, 0, "Late failed reply")).toEqual(confirmed);
  expect(await fixture.journal.attempting(stale, 0)).toEqual(confirmed);
  expect(await fixture.journal.observed(stale, 0, {
    ...confirmed.progress[0]!.operation!, status: "submitted", receipt: null,
  }, false)).toEqual(confirmed);
  expect(fixture.storage.writes).toBe(writes);
  expect(fixture.storage.getItem(EVM_DEMO_STORAGE_KEY)).toBe(encoded);
  expect(await fixture.journal.get(intent.id)).toEqual(confirmed);
});

test("corrupted saved records remain untouched and cannot trigger wallet calls", async () => {
  const fixture = new DemoFixture();
  const intent = fixture.intent();
  await fixture.journal.prepare(intent);
  const confirmed = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const operation = confirmed.progress[0]!.operation!;
  const corruptValues = [
    "{",
    JSON.stringify({ records: [{ ...confirmed, unexpected: true }] }),
    JSON.stringify({ records: [{ ...confirmed, progress: [{
      ...confirmed.progress[0], operation: { ...operation, receipt: {
        ...operation.receipt,
        logs: [{ address: recipient, data: "0x", topics: [], logIndex: "0", unexpected: true }],
      } },
    }] }] }),
  ];
  for (const encoded of corruptValues) {
    fixture.storage.setItem(EVM_DEMO_STORAGE_KEY, encoded);
    const writes = fixture.storage.writes;
    const walletCalls = fixture.calls.filter((call) => call.target === EVM_WALLET_TARGET).length;
    await expect(fixture.journal.list()).rejects.toThrow("Unreadable saved EVM Wallet intents");
    await expect(fixture.journal.prepare(fixture.intent())).rejects
      .toThrow("Unreadable saved EVM Wallet intents");
    await expect(advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id)).rejects
      .toThrow("Unreadable saved EVM Wallet intents");
    expect(fixture.storage.writes).toBe(writes);
    expect(fixture.storage.getItem(EVM_DEMO_STORAGE_KEY)).toBe(encoded);
    expect(fixture.calls.filter((call) => call.target === EVM_WALLET_TARGET))
      .toHaveLength(walletCalls);
    expect(fixture.effects).toHaveLength(1);
  }
});

test("EVM journal updates preserve existing IC Wallet funding intents byte for byte", async () => {
  const fixture = new DemoFixture();
  const existing = ["direct", "allowance"].map((kind) => {
    const request = runWalletFundingIntentAction(fixture.storage, {
      action: "prepare", kind: kind as "direct" | "allowance",
    }, (requestKind) => createWalletFundingDemoRequest(requestKind, {
      nowMs: 1_700_000_000_000,
      fillRandomValues(bytes) { bytes.fill(requestKind === "direct" ? 1 : 2); },
    }));
    const key = `${WALLET_FUNDING_INTENT_STORAGE_KEY}.${kind}`;
    return { key, request, encoded: fixture.storage.getItem(key) };
  });
  const intent = fixture.intent({ kind: "approval_call" });
  await fixture.journal.prepare(intent);
  await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  const terminal = await advanceEvmWalletDemo(fixture.wallet, fixture.journal, intent.id);
  expect(evmDemoRecordTerminal(terminal)).toBe(true);
  for (const { key, request, encoded } of existing) {
    expect(fixture.storage.getItem(key)).toBe(encoded);
    expect(JSON.parse(fixture.storage.getItem(key)!)).toEqual(request);
  }
  expect(fixture.storage.records()).toEqual([terminal]);
});

class MemoryStorage {
  private readonly values = new Map<string, string>();
  private rejectNextSet = false;
  writes = 0;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.rejectNextSet) {
      this.rejectNextSet = false;
      throw new Error("storage write failed");
    }
    this.values.set(key, value);
    this.writes += 1;
  }
  failNextSet(): void { this.rejectNextSet = true; }
  records(): EvmDemoRecord[] {
    return JSON.parse(this.getItem(EVM_DEMO_STORAGE_KEY) ?? '{"records":[]}').records;
  }
}

class DemoFixture {
  readonly storage = new MemoryStorage();
  readonly calls: MsgBusToolCall[] = [];
  readonly effects: Array<{ kind: EvmEffectKind; request: EvmEffectRequest }> = [];
  readonly statusReads: EvmOperationStatusRequest[] = [];
  readonly operations = new Map<string, EvmOperationResult>();
  accountList = clone([account]);
  networkList = clone(networks);
  accountsError: Error | null = null;
  effectError: Error | null = null;
  statusError: Error | null = null;
  beforeAccounts: (() => Promise<void>) | null = null;
  beforeNetworks: (() => Promise<void>) | null = null;
  effectStatus: EvmOperationResult["status"] = "confirmed";
  loseNextEffectReply = false;
  useWrongSigner = false;
  operationReplyPatch: Record<string, string> = {};
  beforeEffect: ((kind: EvmEffectKind, request: EvmEffectRequest) => void) | null = null;
  private nextRequest = 1;
  readonly bus: Pick<MsgBusClient, "callTool"> = {
    callTool: async (value: MsgBusToolCall) => {
      const call = clone(value);
      this.calls.push(call);
      if (call.target === "app:kitchensink:background") {
        expect(call.name).toBe(EVM_DEMO_INTENT_TOOL);
        // A real resident handles mutations synchronously under its origin lock.
        return clone(runEvmDemoIntentAction(this.storage, call.arguments)) as unknown as JsonValue;
      }
      expect(call.target).toBe(EVM_WALLET_TARGET);
      if (call.name === EVM_WALLET_TOOLS.accounts) {
        await this.beforeAccounts?.();
        if (this.accountsError) throw this.accountsError;
        return clone({ accounts: this.accountList });
      }
      if (call.name === EVM_WALLET_TOOLS.networks) {
        await this.beforeNetworks?.();
        return clone({ networks: this.networkList });
      }
      if (call.name === EVM_WALLET_TOOLS.operationStatus) {
        const request = call.arguments as EvmOperationStatusRequest;
        this.statusReads.push(clone(request));
        if (this.statusError) throw this.statusError;
        return clone(this.operations.get(operationKey(request)) ?? { ...request, status: "not_found" });
      }
      const kind = call.name === EVM_WALLET_TOOLS.sendTransaction ? "transaction"
        : call.name === EVM_WALLET_TOOLS.signMessage ? "message"
          : call.name === EVM_WALLET_TOOLS.signTypedData ? "typed_data" : null;
      if (!kind) throw new Error(`Unexpected wallet tool ${call.name}`);
      const request = call.arguments as EvmEffectRequest;
      this.beforeEffect?.(kind, request);
      this.effects.push({ kind, request: clone(request) });
      if (this.effectError) throw this.effectError;
      const key = operationKey(request);
      let operation = this.operations.get(key);
      if (!operation) {
        operation = await this.makeOperation(kind, request);
        this.operations.set(key, operation);
      }
      if (this.loseNextEffectReply) {
        this.loseNextEffectReply = false;
        throw new Error("reply lost after wallet saved operation");
      }
      return clone({ ...operation, ...this.operationReplyPatch }) as unknown as JsonValue;
    },
  };
  readonly journal = createEvmDemoJournal(this.bus);
  readonly wallet = createEvmWalletClient(this.bus);

  intent(overrides: Partial<EvmDemoDraft> = {}): EvmDemoIntent {
    return createEvmDemoIntent({
      kind: "native", chainId: "1", account: clone(account), destination: recipient,
      amountAtoms: "1000000", token, calldata: "0x12345678", ...overrides,
    }, () => (this.nextRequest++).toString(16).padStart(32, "0"));
  }

  private async makeOperation(kind: EvmEffectKind, request: EvmEffectRequest): Promise<EvmOperationResult> {
    const operationId = this.effects.length.toString();
    const status = kind === "transaction" ? this.effectStatus : "signed";
    const hasHash = kind === "transaction" && ["signed", "submitted", "confirmed", "reverted"].includes(status);
    let signature: string | null = null;
    const signingAccount = this.useWrongSigner ? otherSigner : signer;
    if (kind === "message") signature = await signingAccount.signMessage({
      message: { raw: (request as EvmSignMessageRequest).messageHex as Hex },
    });
    if (kind === "typed_data") signature = await signingAccount.signTypedData(
      JSON.parse((request as EvmSignTypedDataRequest).typedDataJson),
    );
    return {
      accountId: request.accountId, chainId: request.chainId, requestId: request.requestId,
      operationId, kind, status, address: account.address,
      transactionHash: hasHash ? `0x${operationId.padStart(64, "0")}` : null,
      signature, message: status === "rejected" ? "Owner declined" : null, reviewRevision: "1",
      receipt: status === "confirmed" || status === "reverted" ? {
        blockNumber: "123", blockHash: `0x${"ef".repeat(32)}`,
        status: status === "confirmed" ? "success" : "reverted",
        gasUsed: "21000", effectiveGasPriceWei: "1000000000", logs: [],
        finality: "finalized", observedAtNs: "1800000000000000000",
      } : null,
    };
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function operationKey(request: EvmOperationStatusRequest): string {
  return `${request.accountId}:${request.chainId}:${request.requestId}`;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
