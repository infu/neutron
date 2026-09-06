import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { encodeFunctionResult, type Hex } from "viem";
import { encodeSelfCallValues, type JsonObject, type JsonValue, type MsgBusToolCall, type MsgBusToolContext, type SelfCallValue } from "neutron-tools/app";
import {
  extractPublicTypeAliases, generateAppMethodSchemaArtifact, motokoTypeToIdl, validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import { materializeSelfCallArguments, normalizeSelfCallResult } from "../../kernel/src/self_calls.ts";
import {
  createEvmWalletClient, EVM_WALLET_TARGET, EVM_WALLET_TOOLS,
  type EvmOperationResult, type EvmOperationStatusResult, type EvmReceipt, type EvmTransactionResult,
} from "neutron-tools/evm_wallet";
import {
  bridgeEvmRequestId, bridgeTransaction, createBridgeClient, executeBridgeDeposit,
  type BridgeIntent, type BridgeQuote,
} from "../src/bridge.ts";
import { handleBridgeRootAttach, handleBridgeRootAttachReplacement, handleBridgeRootNext, handleBridgeRootPrepare } from "../src/bridge_tools.ts";
import { connectEvmBridge } from "../src/evm_bridge.ts";

const account = `0x${"11".repeat(20)}` as Hex;
const helper = `0x${"22".repeat(20)}` as Hex;
const minter = `0x${"33".repeat(20)}` as Hex;
const other = `0x${"44".repeat(20)}` as Hex;
const hash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const fingerprint = `0x${"ef".repeat(32)}` as Hex;
const root = { appId: "agent", installationUid: "51" };
const helperAbi = [{ type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;

function intent(): BridgeIntent {
  return {
    id: "01".repeat(16), source: root, account, amount: "12", revision: "0",
    createdAt: "1", updatedAt: "1", eventCursor: "42", acceptedDeposit: null, mint: null, error: null,
    quote: {
      chainId: "1", ledger: "ss2fx-dyaaa-aaaar-qacoq-cai", minter: "sv3dd-oaaaa-aaaar-qacoa-cai",
      helperAddress: helper, helperMode: "subaccount", minterAddress: minter, tokenAddress: null,
      recipient: "aaaaa-aa", principalWord: `0x${"00".repeat(32)}`, subaccountWord: `0x${"00".repeat(32)}`,
    },
    steps: (["reset_approval", "approval", "deposit"] as const).map((kind) => ({
      kind, state: "ready", operationId: null, transactionHash: null, error: null,
    })),
  };
}

function claimed(transactionHash: Hex | null = null): BridgeIntent {
  const saved = intent();
  Object.assign(saved.steps[2]!, {
    state: transactionHash ? "submitted" : "unknown",
    operationId: bridgeEvmRequestId(saved.id, "deposit"), transactionHash,
  });
  return saved;
}

// Kernel SelfCall projection unwraps #ok and omits absent option fields. It
// does not preserve Result or Candid [] / [value] wrappers. Exercise the actual
// bridge parser against that wire shape.
function wireQuote(quote: BridgeQuote) {
  return {
    chain_id: quote.chainId, ledger: quote.ledger, minter: quote.minter,
    helper_address: quote.helperAddress, helper_mode: { [quote.helperMode]: null },
    minter_address: quote.minterAddress, ...(quote.tokenAddress === null ? {} : { token_address: quote.tokenAddress }),
    recipient: quote.recipient, principal_word: quote.principalWord, subaccount_word: quote.subaccountWord,
  };
}

function wireIntent(saved: BridgeIntent) {
  return {
    id: Uint8Array.from(saved.id.match(/../g)!, (byte) => Number.parseInt(byte, 16)),
    quote: wireQuote(saved.quote), account: saved.account, amount: saved.amount,
    source: typeof saved.source === "string" ? { [saved.source]: null } : {
      evm_agent: { app_id: saved.source.appId, installation_uid: saved.source.installationUid },
    },
    steps: saved.steps.map((step) => ({
      kind: { [step.kind]: null }, state: { [step.state]: null },
      ...(step.operationId === null ? {} : { operation_id: step.operationId }),
      ...(step.transactionHash === null ? {} : { transaction_hash: step.transactionHash }),
      ...(step.error === null ? {} : { error: step.error }),
    })),
    revision: saved.revision, created_at: saved.createdAt, updated_at: saved.updatedAt, event_cursor: saved.eventCursor,
    ...(saved.acceptedDeposit === null ? {} : { accepted_deposit: {
      log_index: saved.acceptedDeposit.logIndex, block_number: saved.acceptedDeposit.blockNumber, event_index: saved.acceptedDeposit.eventIndex,
    } }),
    ...(saved.mint === null ? {} : { mint: {
      ledger_block_index: saved.mint.ledgerBlockIndex, event_index: saved.mint.eventIndex, verified_ledger: saved.mint.verifiedLedger,
    } }),
    ...(saved.error === null ? {} : { error: saved.error }),
  };
}

function receipt(status: EvmReceipt["status"] = "success"): EvmReceipt {
  return {
    blockNumber: "100", blockHash, status, gasUsed: "21000", effectiveGasPriceWei: "30000000000",
    logs: [], finality: "included", observedAtNs: "1000000000",
  };
}

function operation(patch: Partial<EvmOperationResult> = {}): EvmOperationResult {
  return {
    accountId: "main", chainId: "1", requestId: bridgeEvmRequestId(intent().id, "deposit"),
    operationId: "7", kind: "transaction", status: "submitted", address: account,
    transactionHash: hash, signature: null, message: null, reviewRevision: "1", receipt: null, ...patch,
  };
}

function evidence(saved = claimed()): EvmTransactionResult {
  const transaction = bridgeTransaction(saved, "deposit");
  return {
    chainId: "1", transactionHash: hash, walletRequestMatches: true,
    transaction: {
      from: transaction.from, to: transaction.to, data: transaction.data,
      valueWei: BigInt(transaction.value ?? "0x0").toString(), nonce: "10", blockNumber: "100", blockHash,
    },
    receipt: receipt(), observedAtNs: "1000000000", source: "evm_rpc",
  };
}

function fixture(initial = intent()) {
  let saved = structuredClone(initial);
  const calls: MsgBusToolCall[] = [];
  let effectiveHash: string | null = null;
  const selfCalls: Array<{ method: string; args: SelfCallValue[] }> = [];
  const state = {
    liveQuote: structuredClone(initial.quote), evidence: evidence(initial),
    status: operation() as EvmOperationStatusResult, sendResult: operation(),
    helperCode: "0x6001", actualMinter: minter,
    evidenceByHash: {} as Record<string, EvmTransactionResult>, replacementMatches: true,
  };
  const accounts = {
    accounts: [{ accountId: "main", address: account, publicKey: `0x02${"78".repeat(32)}`, keyFingerprint: fingerprint, namespaceVersion: "1" }],
  };
  const query = async (method: string, args: SelfCallValue[] = []) => {
    selfCalls.push({ method, args: structuredClone(args) });
    if (method === "wallet_bridge_status_v1") return wireIntent(saved);
    if (method === "wallet_bridge_list_v1") return { records: [wireIntent(saved)] };
    throw new Error(`Unexpected Wallet query ${method}`);
  };
  const update = async (method: string, args: SelfCallValue[] = []) => {
    selfCalls.push({ method, args: structuredClone(args) });
    if (method === "wallet_bridge_quote_v1") return wireQuote(state.liveQuote);
    if (method === "wallet_bridge_refresh_v1") return wireIntent(saved);
    let input = args[0] as Record<string, unknown>;
    if (method === "wallet_bridge_prepare_v1") {
      const caller = (input.source as { evm_agent: { app_id: string; installation_uid: string } }).evm_agent;
      saved.source = { appId: caller.app_id, installationUid: caller.installation_uid };
      saved.account = input.account as string;
      saved.amount = input.amount as string;
      return wireIntent(saved);
    }
    if (method === "wallet_bridge_replacement_v1") {
      if (input.lookup) return { hash: effectiveHash };
      input = input.record as Record<string, unknown>;
      if (input.revision !== saved.revision) throw new Error("revision conflict");
      const kind = Object.keys(input.step as object)[0];
      const step = saved.steps.find((entry) => entry.kind === kind)!;
      if (input.original_transaction_hash !== step.transactionHash || input.previous_transaction_hash !== (effectiveHash ?? step.transactionHash)) throw new Error("replacement identity conflict");
      effectiveHash = String(input.transaction_hash);
      step.state = Object.keys(input.state as object)[0] as typeof step.state;
      saved.revision = String(BigInt(saved.revision) + 1n);
      return { intent: wireIntent(saved) };
    }
    if (method === "wallet_bridge_claim_v1" || method === "wallet_bridge_record_step_v1") {
      if (input.revision !== saved.revision) throw new Error("revision conflict");
      const kind = Object.keys(input.step as object)[0];
      const step = saved.steps.find((candidate) => candidate.kind === kind)!;
      if (method === "wallet_bridge_claim_v1") {
        if (step.state !== "ready") throw new Error("already claimed");
        step.state = "unknown";
        step.operationId = input.operation_id as string ?? null;
      } else {
        if (step.transactionHash && input.transaction_hash && step.transactionHash !== input.transaction_hash) throw new Error("A saved transaction hash cannot change");
        step.state = Object.keys(input.state as object)[0] as typeof step.state;
        step.transactionHash = input.transaction_hash as Hex ?? null;
        step.error = input.error as string ?? null;
      }
      saved.revision = (BigInt(saved.revision) + 1n).toString();
      return wireIntent(saved);
    }
    throw new Error(`Unexpected Wallet update ${method}`);
  };
  // Only the transport is substituted. The production SDK parses every
  // request/result and binds returned chain and request identities.
  const kernel = {
    querySelf: query, updateSelf: update,
    async callTool(call: MsgBusToolCall) {
      calls.push(structuredClone(call));
      expect(call.target).toBe(EVM_WALLET_TARGET);
      if (call.name === EVM_WALLET_TOOLS.accounts) return structuredClone(accounts);
      if (call.name === EVM_WALLET_TOOLS.transaction) {
        const selected = state.evidenceByHash[String(call.arguments?.transactionHash)];
        return structuredClone(selected ? { ...selected, walletRequestMatches: call.arguments?.walletRequest ? selected.walletRequestMatches : null } : state.evidence);
      }
      if (call.name === EVM_WALLET_TOOLS.replacementTransaction) return { ...call.arguments, walletReplacementMatches: state.replacementMatches, observedAtNs: "1", source: "evm_wallet_journal" };
      if (call.name === EVM_WALLET_TOOLS.operationStatus) return structuredClone(state.status);
      if (call.name === EVM_WALLET_TOOLS.sendTransaction) return structuredClone(state.sendResult);
      if (call.name === EVM_WALLET_TOOLS.readContract) return {
        ...call.arguments, address: account, code: state.helperCode,
        result: encodeFunctionResult({ abi: helperAbi, functionName: "getMinterAddress", result: state.actualMinter }),
        blockNumber: "100", observedAtNs: "1000000000",
      };
      throw new Error(`Unexpected EVM tool ${call.name}; bridge handlers must not forward root signing authority`);
    },
  } as unknown as MsgBusToolContext["kernel"];
  const context: MsgBusToolContext = {
    kernel, caller: { ...root, endpoint: "app:agent:tile:root" }, audience: "agent_root", reportProgress: () => undefined,
  };
  return {
    context, calls, selfCalls, state, saved: () => structuredClone(saved),
    bridge: createBridgeClient({ query, update }), evm: createEvmWalletClient(kernel),
  };
}

test("root bridge preparation binds the authenticated installation and returns the direct-root request without nested signing", async () => {
  const f = fixture();
  const prepared = await handleBridgeRootPrepare({ id: intent().id, ledger: intent().quote.ledger, amountAtoms: "12" }, f.context);
  expect(prepared.source).toEqual(root);
  const prepare = f.selfCalls.find((call) => call.method === "wallet_bridge_prepare_v1")!;
  expect(prepare.args[0]).toMatchObject({ source: { evm_agent: { app_id: "agent", installation_uid: "51" } }, account });

  const first = await handleBridgeRootNext({ id: intent().id }, f.context);
  const second = await handleBridgeRootNext({ id: intent().id }, f.context);
  expect(first.request).toEqual({
    accountId: "main", chainId: "1", requestId: bridgeEvmRequestId(intent().id, "deposit"),
    to: helper, valueWei: "12", data: bridgeTransaction(intent(), "deposit").data,
  });
  expect(second.request).toEqual(first.request);
  expect(f.saved().steps[2]!.state).toBe("unknown");
  expect(f.selfCalls.filter((call) => call.method === "wallet_bridge_claim_v1")).toHaveLength(1);
  const allowedReads = new Set<string>([EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.readContract]);
  expect(f.calls.every((call) => allowedReads.has(call.name))).toBe(true);
});

test("a different app or reinstalled root cannot resume or attach the original root bridge", async () => {
  for (const caller of [{ ...root, installationUid: "52" }, { appId: "kitchensink", installationUid: "51" }]) {
    const f = fixture(claimed());
    const context = { ...f.context, caller: { ...caller, endpoint: "app:agent:tile:root" } };
    await expect(handleBridgeRootNext({ id: intent().id }, context)).rejects.toThrow("original root Agent installation");
    await expect(handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, context)).rejects.toThrow("original root Agent installation");
    expect(f.calls).toHaveLength(0);
    expect(f.saved().steps[2]!.transactionHash).toBeNull();
  }
});

test("root bridge tools reject a nested or foreground caller before touching either wallet", async () => {
  for (const audience of ["foreground_tile", null] as const) {
    const f = fixture(claimed());
    const context = { ...f.context, agentMode: true };
    if (audience === null) delete context.audience;
    else context.audience = audience;
    await expect(handleBridgeRootPrepare({ id: intent().id, ledger: intent().quote.ledger, amountAtoms: "12" }, context)).rejects.toThrow("root-agent attestation");
    await expect(handleBridgeRootNext({ id: intent().id }, context)).rejects.toThrow("root-agent attestation");
    await expect(handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, context)).rejects.toThrow("root-agent attestation");
    expect(f.calls).toHaveLength(0);
    expect(f.selfCalls).toHaveLength(0);
  }
});

for (const field of ["from", "to", "data", "valueWei", "chainId", "transactionHash"] as const) {
  test(`root bridge attach rejects public transaction evidence with the wrong ${field}`, async () => {
    const f = fixture(claimed());
    if (field === "chainId") f.state.evidence.chainId = "42161";
    else if (field === "transactionHash") f.state.evidence.transactionHash = blockHash;
    else f.state.evidence.transaction![field] = field === "data" ? "0xdeadbeef" : field === "valueWei" ? "13" : other;
    await expect(handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, f.context)).rejects.toThrow(
      field === "chainId" || field === "transactionHash" ? "transaction evidence does not match the request" : "transaction does not match this saved bridge step",
    );
    expect(f.saved().steps[2]).toMatchObject({ state: "unknown", transactionHash: null });
    expect(f.selfCalls.some((call) => call.method === "wallet_bridge_record_step_v1")).toBe(false);
  });
}

for (const outcome of ["success", "reverted", "pending"] as const) {
  test(`root bridge attaches exact public transaction evidence as ${outcome} without signing`, async () => {
    const f = fixture(claimed());
    f.state.evidence.receipt = outcome === "pending" ? null : receipt(outcome);
    const attached = await handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, f.context);
    expect((attached.steps as JsonObject[])[2]).toMatchObject({
      state: outcome === "pending" ? "submitted" : outcome === "success" ? "confirmed" : "failed", transactionHash: hash,
    });
    expect(f.calls).toEqual([{
      target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.transaction, arguments: {
        chainId: "1", transactionHash: hash, walletRequest: {
          callerAppId: "agent", callerInstallationUid: "51", requestId: bridgeEvmRequestId(intent().id, "deposit"),
        },
      },
    }]);
  });
}

test("root bridge attach rejects an otherwise identical transaction belonging to a different EVM Wallet request", async () => {
  const f = fixture(claimed());
  f.state.evidence.walletRequestMatches = false;
  await expect(handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, f.context)).rejects.toThrow("not bound to this exact root caller installation");
  expect(f.saved().steps[2]).toMatchObject({ state: "unknown", transactionHash: null });
  expect(f.selfCalls.filter((call) => call.method === "wallet_bridge_record_step_v1").some((call) => (call.args[0] as Record<string, unknown>).transaction_hash === replacementHash)).toBe(false);
});

test("a known root transaction hash remains reconcilable after its helper retires and never yields another executable request", async () => {
  const f = fixture(claimed(hash));
  f.state.liveQuote.helperAddress = other;
  f.state.helperCode = "0x";
  const next = await handleBridgeRootNext({ id: intent().id }, f.context);
  expect(next.request).toBeNull();
  expect(next.message).toContain(hash);
  expect(f.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  expect(f.selfCalls.some((call) => call.method === "wallet_bridge_quote_v1")).toBe(false);
  await handleBridgeRootAttach({ id: intent().id, step: "deposit", transactionHash: hash }, f.context);
  expect(f.saved().steps[2]!.state).toBe("confirmed");
});

test("an unknown root claim without a hash cannot yield a fresh request for a retired route", async () => {
  const f = fixture(claimed());
  f.state.liveQuote.helperAddress = other;
  await expect(handleBridgeRootNext({ id: intent().id }, f.context)).rejects.toThrow("retired helper");
  expect(f.saved().steps[2]).toMatchObject({ state: "unknown", transactionHash: null });
  expect(f.calls.map((call) => call.name)).toEqual([EVM_WALLET_TOOLS.accounts]);
  expect(f.selfCalls.filter((call) => call.method === "wallet_bridge_quote_v1")).toHaveLength(1);
});

test("an unknown root claim rechecks the saved helper's contract identity before yielding a fresh request", async () => {
  for (const change of ["code", "minter"] as const) {
    const f = fixture(claimed());
    if (change === "code") f.state.helperCode = "0x";
    else f.state.actualMinter = other;
    await expect(handleBridgeRootNext({ id: intent().id }, f.context)).rejects.toThrow("does not match the official minter");
    expect(f.saved().steps[2]!.transactionHash).toBeNull();
  }
});

for (const status of ["not_found", "prepared", "preparing"] as const) {
  test(`EVM bridge validates a fresh send after ${status}, then uses the same saved request`, async () => {
    const f = fixture(claimed());
    const identity = { accountId: "main" as const, chainId: "1", requestId: bridgeEvmRequestId(intent().id, "deposit") };
    f.state.status = status === "not_found" ? { ...identity, status } : operation({ status, transactionHash: null });
    const connected = await connectEvmBridge(f.evm, helper, null, account);
    let validated = 0;
    const result = await connected.evm.send(identity.requestId, bridgeTransaction(intent(), "deposit"), async () => {
      validated++;
      expect(f.calls.at(-1)?.name).toBe(EVM_WALLET_TOOLS.operationStatus);
      expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
    });
    expect(result).toBe(hash);
    expect(validated).toBe(1);
    expect(f.calls.find((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)?.arguments).toEqual({
      ...identity, to: helper, valueWei: "12", data: bridgeTransaction(intent(), "deposit").data,
    });
  });
}

for (const status of ["signed", "submitted", "confirmed", "unknown"] as const) {
  test(`EVM bridge recovers the existing ${status} hash without requiring its retired helper to pass fresh-send validation`, async () => {
    const f = fixture(claimed());
    f.state.status = operation({ status, receipt: status === "confirmed" ? receipt() : null });
    const connected = await connectEvmBridge(f.evm, helper, null, account);
    let validated = 0;
    const result = await connected.evm.send(bridgeEvmRequestId(intent().id, "deposit"), bridgeTransaction(intent(), "deposit"), async () => {
      validated++;
      throw new Error("retired helper");
    });
    expect(result).toBe(hash);
    expect(validated).toBe(0);
    expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
  });
}

test("EVM bridge cannot submit after fresh-send validation rejects a retired helper", async () => {
  const f = fixture(claimed());
  f.state.status = operation({ status: "prepared", transactionHash: null });
  const connected = await connectEvmBridge(f.evm, helper, null, account);
  await expect(connected.evm.send(bridgeEvmRequestId(intent().id, "deposit"), bridgeTransaction(intent(), "deposit"), async () => {
    throw new Error("retired helper");
  })).rejects.toThrow("retired helper");
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});

test("an unresolved EVM signing operation without a hash is reconciled without validating or starting a replacement", async () => {
  const f = fixture(claimed());
  f.state.status = operation({ status: "signing", transactionHash: null });
  const connected = await connectEvmBridge(f.evm, helper, null, account);
  let validated = 0;
  await expect(connected.evm.send(bridgeEvmRequestId(intent().id, "deposit"), bridgeTransaction(intent(), "deposit"), async () => {
    validated++;
  })).rejects.toThrow("saved request must be reconciled");
  expect(validated).toBe(0);
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});

for (const status of ["rejected", "reverted", "failed"] as const) {
  test(`an EVM ${status} operation cannot invoke fresh-send validation or submit a replacement`, async () => {
    const f = fixture(claimed());
    f.state.status = operation({
      status, transactionHash: status === "reverted" ? hash : null,
      receipt: status === "reverted" ? receipt("reverted") : null,
    });
    const connected = await connectEvmBridge(f.evm, helper, null, account);
    let validated = 0;
    await expect(connected.evm.send(bridgeEvmRequestId(intent().id, "deposit"), bridgeTransaction(intent(), "deposit"), async () => {
      validated++;
    })).rejects.toThrow();
    expect(validated).toBe(0);
    expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
  });
}

test("durable bridge execution recovers a lost EVM reply from the same operation after the helper retires", async () => {
  const saved = claimed();
  saved.source = "evm";
  const f = fixture(saved);
  f.state.liveQuote.helperAddress = other;
  f.state.helperCode = "0x";
  f.state.status = operation({ status: "confirmed", receipt: receipt() });
  const connected = await connectEvmBridge(f.evm, helper, null, account);
  const completed = await executeBridgeDeposit({ intent: saved, client: f.bridge, provider: connected.provider, evm: connected.evm });
  expect(completed.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash, operationId: bridgeEvmRequestId(saved.id, "deposit") });
  expect(f.calls.filter((call) => call.name === EVM_WALLET_TOOLS.operationStatus)).toHaveLength(2);
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.readContract || call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
  expect(f.selfCalls.some((call) => call.method === "wallet_bridge_quote_v1")).toBe(false);
});

test("durable bridge execution cannot resume an undispatched EVM claim through a retired helper", async () => {
  const saved = claimed();
  saved.source = "evm";
  const f = fixture(saved);
  f.state.liveQuote.helperAddress = other;
  f.state.status = { accountId: "main", chainId: "1", requestId: bridgeEvmRequestId(saved.id, "deposit"), status: "not_found" };
  const connected = await connectEvmBridge(f.evm, helper, null, account);
  await expect(executeBridgeDeposit({ intent: saved, client: f.bridge, provider: connected.provider, evm: connected.evm })).rejects.toThrow("retired helper");
  expect(f.saved().steps[2]).toMatchObject({ state: "unknown", transactionHash: null });
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});

async function bridgeIdl() {
  const [source, manifestText] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as Parameters<typeof generateAppMethodSchemaArtifact>[0];
  const aliases = extractPublicTypeAliases(source);
  // Use the actual declarations and installed function configuration, while
  // keeping this bridge contract test independent of unrelated wallet APIs.
  const func = Object.fromEntries(Object.entries(manifest.func ?? {}).filter(([name]) => name.startsWith("wallet_bridge_")));
  return {
    artifact: generateAppMethodSchemaArtifact({ ...manifest, func }, source),
    type: (alias: string) => {
      const declaration = aliases[alias];
      if (declaration === undefined) throw new Error(`Missing bridge declaration ${alias}`);
      return motokoTypeToIdl(declaration, IDL, aliases);
    },
  };
}

// Build native Candid values from the JSON-facing values, based on the actual
// generated IDL. Encoding then checks every field and optional/variant shape.
function nativeCandid(value: unknown, type: IDL.Type): unknown {
  if (type instanceof IDL.OptClass) return value == null ? [] : [nativeCandid(value, type._type)];
  if (type instanceof IDL.PrincipalClass) return Principal.fromText(value as string);
  if (["nat", "int", "nat64", "int64"].includes(type.name)) return BigInt(value as string);
  if (type instanceof IDL.VecClass) {
    if (type._type.name === "nat8") return value;
    return (value as unknown[]).map((entry) => nativeCandid(entry, type._type));
  }
  if (type instanceof IDL.TupleClass) return type._fields.map(([, child], index) => nativeCandid((value as unknown[])[index], child));
  if (type instanceof IDL.RecordClass) return Object.fromEntries(type._fields.map(([key, child]) => [key, nativeCandid((value as Record<string, unknown>)[key], child)]));
  if (type instanceof IDL.VariantClass) {
    const selected = type._fields.find(([key]) => Object.hasOwn(value as object, key));
    if (!selected) throw new Error("Unknown native Candid variant");
    return { [selected[0]]: nativeCandid((value as Record<string, unknown>)[selected[0]], selected[1]) };
  }
  return value;
}

function publicSchemaValue(value: SelfCallValue): JsonValue {
  // Public method schemas support byte arrays; the actual private SelfCall
  // below separately requires native bytes in the binary sidecar.
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(publicSchemaValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publicSchemaValue(child as SelfCallValue)]));
  return value as JsonValue;
}

test("actual Wallet Candid Result projection restores bridge records and quote options without a second ok wrapper", async () => {
  const idl = await bridgeIdl();
  for (const populated of [false, true]) {
    const saved = populated ? claimed(hash) : intent();
    if (populated) {
      saved.quote.tokenAddress = other;
      saved.acceptedDeposit = { logIndex: "9", blockNumber: "100", eventIndex: "12345678901234567890" };
      saved.mint = { ledgerBlockIndex: "23456789012345678901", eventIndex: "12345678901234567891", verifiedLedger: true };
      saved.steps[0]!.error = "An earlier approval was declined";
      saved.error = "Saved diagnostic";
    }
    const intentType = idl.type("wallet_bridge_status_v1_Output");
    const quoteType = idl.type("wallet_bridge_quote_v1_Output");
    const projectedIntent = normalizeSelfCallResult(
      IDL.decode([intentType], IDL.encode([intentType], [nativeCandid({ ok: wireIntent(saved) }, intentType)]))[0], intentType,
    );
    const projectedQuote = normalizeSelfCallResult(
      IDL.decode([quoteType], IDL.encode([quoteType], [nativeCandid({ ok: wireQuote(saved.quote) }, quoteType)]))[0], quoteType,
    );
    expect(projectedIntent).not.toHaveProperty("ok");
    expect(projectedIntent).toEqual(wireIntent(saved));
    expect(projectedQuote).toEqual(wireQuote(saved.quote));
    const client = createBridgeClient({ query: async () => projectedIntent, update: async () => projectedQuote });
    expect(await client.status(saved.id)).toEqual(saved);
    expect(await client.quote(saved.quote.ledger)).toEqual(saved.quote);
    const wrapped = createBridgeClient({ query: async () => ({ ok: projectedIntent }), update: async () => ({ ok: projectedQuote }) });
    await expect(wrapped.status(saved.id)).rejects.toThrow();
    await expect(wrapped.quote(saved.quote.ledger)).rejects.toThrow();
  }
});

test("every actual bridge client input matches generated method schemas and Kernel's live Candid binary binding", async () => {
  const idl = await bridgeIdl();
  const f = fixture();
  await f.bridge.quote(intent().quote.ledger);
  let saved = await f.bridge.prepare({ id: intent().id, ledger: intent().quote.ledger, source: root, account, amount: "12" });
  saved = await f.bridge.status(saved.id);
  saved = await f.bridge.claim(saved, "deposit", bridgeEvmRequestId(saved.id, "deposit"));
  saved = await f.bridge.record(saved, "deposit", "unknown", null);
  saved = await f.bridge.record(saved, "deposit", "submitted", hash);
  await f.bridge.effectiveHash(saved.id, "deposit");
  saved = await f.bridge.recordReplacement(saved, "deposit", hash, hash, `0x${"99".repeat(32)}` as Hex, "submitted");
  await f.bridge.refresh(saved.id);
  expect(await f.bridge.list(null)).toEqual([saved]);
  expect(await f.bridge.list(saved.quote.ledger)).toEqual([saved]);
  const exercised = new Set(f.selfCalls.map(({ method }) => method));
  expect([...exercised].sort()).toEqual(Object.keys(idl.artifact.methods).sort());

  for (const { method, args } of f.selfCalls) {
    const inputType = idl.type(`${method}_Input`);
    const encoded = encodeSelfCallValues(args);
    const bound = materializeSelfCallArguments(encoded.value, encoded.blobs, [inputType]);
    const bytes = IDL.encode([inputType], [nativeCandid(bound.args[0], inputType)]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const decoded = IDL.decode([inputType], bytes);
    expect(decoded).toHaveLength(1);
    expect(normalizeSelfCallResult(decoded[0], inputType)).toEqual(args[0]);
    expect(validateAppMethodArgs(idl.artifact, method, args.map(publicSchemaValue))).toEqual({ valid: true, errors: [] });
  }
});

const replacementHash = `0x${"98".repeat(32)}` as Hex;
function replacementFixture(initial = claimed(hash)) {
  const f = fixture(initial);
  f.state.status = operation({ status: "replaced", replacementTransactionHash: replacementHash });
  f.state.evidenceByHash[hash] = { ...evidence(initial), receipt: null };
  f.state.evidenceByHash[replacementHash] = { ...evidence(initial), transactionHash: replacementHash, walletRequestMatches: false };
  return f;
}
test("human speed-up preserves original durable identity while confirming exact replacement effect", async () => {
  const saved = claimed(hash); saved.source = "evm";
  const f = replacementFixture(saved);
  const connection = await connectEvmBridge(f.evm, helper, null, account);
  const result = await executeBridgeDeposit({ intent: saved, client: f.bridge, ...connection });
  expect(result.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash, operationId: saved.steps[2]!.operationId });
  expect(await f.bridge.effectiveHash(saved.id, "deposit")).toBe(replacementHash);
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
  const calls = f.calls.length;
  await executeBridgeDeposit({ intent: result, client: f.bridge, ...connection });
  expect(f.calls.slice(calls).some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});
for (const changed of ["to", "from", "data", "valueWei"] as const) test(`human replacement with changed ${changed} cannot advance the bridge`, async () => {
  const saved = claimed(hash); saved.source = "evm";
  const f = replacementFixture(saved);
  const tx = f.state.evidenceByHash[replacementHash]!.transaction!;
  tx[changed] = changed === "data" ? "0x" : changed === "valueWei" ? "0" : other;
  const connection = await connectEvmBridge(f.evm, helper, null, account);
  await expect(executeBridgeDeposit({ intent: saved, client: f.bridge, ...connection })).rejects.toThrow("cancellation or changed replacement");
  expect(f.saved().steps[2]!.state).toBe("submitted");
  expect(await f.bridge.effectiveHash(saved.id, "deposit")).toBeNull();
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});
test("root replacement requires exact journal ancestry and retains original hash after reload", async () => {
  const f = replacementFixture();
  const args = { id: intent().id, step: "deposit", transactionHash: replacementHash };
  f.state.replacementMatches = false;
  await expect(handleBridgeRootAttach(args, f.context)).rejects.toThrow("did not prove");
  expect(await f.bridge.effectiveHash(intent().id, "deposit")).toBeNull();
  f.state.replacementMatches = true;
  const result = await handleBridgeRootAttach(args, f.context) as unknown as BridgeIntent;
  expect(result.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash });
  expect(await f.bridge.effectiveHash(result.id, "deposit")).toBe(replacementHash);
  expect(f.calls.filter((call) => call.name === EVM_WALLET_TOOLS.replacementTransaction).at(-1)?.arguments?.originalWalletRequest).toEqual({ callerAppId: root.appId, callerInstallationUid: root.installationUid, requestId: result.steps[2]!.operationId });
});
test("root can recover replacement after original attach was lost and original RPC transaction evicted", async () => {
  const f = replacementFixture(claimed());
  f.state.evidenceByHash[hash]!.transaction = null;
  const result = await handleBridgeRootAttachReplacement({ id: intent().id, step: "deposit", originalTransactionHash: hash, transactionHash: replacementHash }, f.context) as unknown as BridgeIntent;
  expect(result.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash });
  expect(await f.bridge.effectiveHash(result.id, "deposit")).toBe(replacementHash);
});
test("root cancellation and different-nonce evidence remain unresolved", async () => {
  for (const mutation of ["cancel", "nonce"] as const) {
    const f = replacementFixture();
    const tx = f.state.evidenceByHash[replacementHash]!.transaction!;
    if (mutation === "cancel") { tx.to = account; tx.data = "0x"; tx.valueWei = "0"; }
    else tx.nonce = "11";
    await expect(handleBridgeRootAttachReplacement({ id: intent().id, step: "deposit", originalTransactionHash: hash, transactionHash: replacementHash }, f.context)).rejects.toThrow(mutation === "cancel" ? "does not match" : "different nonce");
    expect(await f.bridge.effectiveHash(intent().id, "deposit")).toBeNull();
    expect(f.saved().steps[2]!.state).toBe("submitted");
  }
});

test("a lost replacement journal reply resumes its existing edge without another signature", async () => {
  const saved = claimed(hash); saved.source = "evm";
  const f = replacementFixture(saved);
  f.state.evidenceByHash[replacementHash]!.receipt = null;
  const persist = f.bridge.recordReplacement;
  f.bridge.recordReplacement = async (...args) => { await persist(...args); throw new Error("replacement record reply lost"); };
  const connection = await connectEvmBridge(f.evm, helper, null, account);
  await expect(executeBridgeDeposit({ intent: saved, client: f.bridge, ...connection })).rejects.toThrow("record reply lost");
  expect(await f.bridge.effectiveHash(saved.id, "deposit")).toBe(replacementHash);
  expect(f.saved().steps[2]).toMatchObject({ state: "submitted", transactionHash: hash });
  f.state.evidenceByHash[replacementHash]!.receipt = receipt();
  const result = await executeBridgeDeposit({ intent: f.saved(), client: f.bridge, ...connection });
  expect(result.steps[2]).toMatchObject({ state: "confirmed", transactionHash: hash });
  expect(f.selfCalls.filter((call) => call.method === "wallet_bridge_replacement_v1" && (call.args[0] as Record<string, unknown>).record)).toHaveLength(1);
  expect(f.calls.some((call) => call.name === EVM_WALLET_TOOLS.sendTransaction)).toBe(false);
});
for (const original of [null, hash]) test(`a reverted exact replacement preserves original identity after ${original ? "saved hash" : "lost first reply"}`, async () => {
  const saved = claimed(original); saved.source = "evm";
  const f = replacementFixture(saved);
  f.state.evidenceByHash[replacementHash]!.receipt = receipt("reverted");
  const connection = await connectEvmBridge(f.evm, helper, null, account);
  await expect(executeBridgeDeposit({ intent: saved, client: f.bridge, ...connection })).rejects.toThrow("replacement deposit transaction reverted");
  expect(f.saved().steps[2]).toMatchObject({ state: "failed", transactionHash: hash });
  expect(await f.bridge.effectiveHash(saved.id, "deposit")).toBe(replacementHash);
  expect(f.selfCalls.filter((call) => call.method === "wallet_bridge_record_step_v1").some((call) => (call.args[0] as Record<string, unknown>).transaction_hash === replacementHash)).toBe(false);
});
