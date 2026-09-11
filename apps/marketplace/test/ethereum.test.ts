import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from "viem";
import type { EthereumProviderConnection } from "neutron-tools/app";
import type { EvmOperationStatusResult, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { buildEthereumFundingPlan, principalToEthereumWord, executeBrowserFundingStep, executeEvmFundingStep, ERC20_ABI, DEPOSIT_HELPER_ABI, type EthereumFundingJournal, type EthereumFundingKind, type EthereumFundingRecord, type EthereumFundingPlan } from "../src/ethereum.ts";

// Canonical mainnet route observed from the ckETH minter on 2026-09-10.
// This is a deterministic encoding fixture; tests make no network requests.
const route = {
  chainId: "1",
  tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  helperAddress: "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68",
  minterAddress: "0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80",
  recipientPrincipal: "233tv-xiaaa-aaaay-aacta-cai",
} as const;
const payer = "0xe70ab51ef2d86e70d834b4ac809d75e362ca23f2";
const principalWord = "0x0a00000000030000a60101000000000000000000000000000000000000000000" as Hex;
const subaccountWord = `0x${"19".repeat(32)}` as Hex;
const ids = { approval: "ab".repeat(16), deposit: "cd".repeat(16) };
const invoice = () => ({ operationId: "ef".repeat(16), amountAtoms: "1234567", payerAddress: payer, principalWord, subaccountWord, route: { ...route } });
const officialApproval = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const officialDeposit = parseAbi(["function depositErc20(address erc20Address, uint256 amount, bytes32 principal, bytes32 subaccount)"]);

test("principal words use the ckETH length-prefixed principal bytes and zero padding", () => {
  expect(principalToEthereumWord(route.recipientPrincipal)).toBe(principalWord);
  expect(principalToEthereumWord("3rurp-vyaaa-aaaay-aacua-cai")).toBe("0x0a00000000030000a80101000000000000000000000000000000000000000000");
  expect(() => principalToEthereumWord("not-a-principal")).toThrow();
});

test("approval and deposit preserve exact invoice identities, atoms and mainnet recipients", () => {
  const original = invoice();
  const plan = buildEthereumFundingPlan(original, route, ids);
  expect(plan.invoice.operationId).toBe(original.operationId);
  expect(plan.invoice.amountAtoms).toBe("1234567");
  expect(plan.invoice.route.minterAddress.toLowerCase()).toBe(route.minterAddress.toLowerCase());
  const approval = plan.steps.approval;
  const deposit = plan.steps.deposit;
  expect(approval.kind).toBe("approval"); expect(approval.requestId).toBe(ids.approval);
  expect(deposit.kind).toBe("deposit"); expect(deposit.requestId).toBe(ids.deposit);
  expect(approval.transaction.from.toLowerCase()).toBe(payer);
  expect(deposit.transaction.from.toLowerCase()).toBe(payer);
  expect(approval.transaction.to.toLowerCase()).toBe(route.tokenAddress.toLowerCase());
  expect(deposit.transaction.to.toLowerCase()).toBe(route.helperAddress.toLowerCase());
  expect(approval.transaction.value).toBe("0x0");
  expect(deposit.transaction.value).toBe("0x0");
  const allowance = decodeFunctionData({ abi: officialApproval, data: approval.transaction.data });
  expect(allowance.functionName).toBe("approve");
  expect(allowance.args).toEqual([getAddress(route.helperAddress), 1234567n]);
  expect(allowance.args[1]).not.toBe((1n << 256n) - 1n);
  expect(decodeFunctionData({ abi: ERC20_ABI, data: approval.transaction.data }).functionName).toBe("approve");
  const decoded = decodeFunctionData({ abi: officialDeposit, data: deposit.transaction.data });
  expect(decoded.functionName).toBe("depositErc20");
  expect(decoded.args).toEqual([getAddress(route.tokenAddress), 1234567n, principalWord, subaccountWord]);
  expect(decodeFunctionData({ abi: DEPOSIT_HELPER_ABI, data: deposit.transaction.data }).functionName).toBe("depositErc20");
  expect(original).toEqual(invoice());
});

describe("invoice route validation", () => {
  for (const [field, value] of [
    ["chainId", "42161"],
    ["tokenAddress", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
    ["helperAddress", route.minterAddress],
    ["minterAddress", route.helperAddress],
    ["recipientPrincipal", "3rurp-vyaaa-aaaay-aacua-cai"],
  ] as const) test(`rejects a mismatched ${field}`, () => {
    const changed = { ...invoice(), route: { ...route, [field]: value } };
    expect(() => buildEthereumFundingPlan(changed as Parameters<typeof buildEthereumFundingPlan>[0], route, ids)).toThrow();
  });

  test("a matching non-Ethereum route is still rejected", () => {
    const wrongChain = { ...route, chainId: "42161" };
    expect(() => buildEthereumFundingPlan(
      { ...invoice(), route: wrongChain } as Parameters<typeof buildEthereumFundingPlan>[0],
      wrongChain as Parameters<typeof buildEthereumFundingPlan>[1], ids,
    )).toThrow();
  });

  test("the recipient principal word must match the retained marketplace principal", () => {
    expect(() => buildEthereumFundingPlan({ ...invoice(), principalWord: principalToEthereumWord("3rurp-vyaaa-aaaay-aacua-cai") }, route, ids)).toThrow();
  });

  for (const field of ["principalWord", "subaccountWord"] as const) test(`rejects a malformed ${field}`, () => {
    expect(() => buildEthereumFundingPlan({ ...invoice(), [field]: "0x12" }, route, ids)).toThrow();
  });
});

for (const amountAtoms of ["0", "-1", "1.5", "", "not-a-number", (1n << 256n).toString()]) test(`rejects invalid token amount ${JSON.stringify(amountAtoms)}`, () => {
  expect(() => buildEthereumFundingPlan({ ...invoice(), amountAtoms }, route, ids)).toThrow();
});

test("approval and deposit cannot share a Wallet request identity", () => {
  expect(() => buildEthereumFundingPlan(invoice(), route, { approval: ids.approval, deposit: ids.approval })).toThrow();
});

for (const field of ["approval", "deposit"] as const) test(`rejects a malformed ${field} request ID`, () => {
  expect(() => buildEthereumFundingPlan(invoice(), route, { ...ids, [field]: "short" })).toThrow();
});

test("rejects a malformed purchase operation ID", () => {
  expect(() => buildEthereumFundingPlan({ ...invoice(), operationId: "short" }, route, ids)).toThrow();
});

const approvalHash = `0x${"31".repeat(32)}` as Hex;
const depositHash = `0x${"42".repeat(32)}` as Hex;
const fingerprint = `0x${"53".repeat(32)}` as Hex;
const blockHash = `0x${"64".repeat(32)}` as Hex;
const freshPlan = () => buildEthereumFundingPlan(invoice(), route, ids);
const stable = (value: unknown) => JSON.stringify(value);

/** An atomic ownership claim followed by exact compare-and-set updates. Reads
 * return copies, so drivers cannot mutate durable evidence by retaining a ref. */
function journalFixture(events: string[] = []) {
  const rows = new Map<EthereumFundingKind, EthereumFundingRecord>();
  let claims = 0;
  const journal: EthereumFundingJournal = {
    async read(kind) { const row = rows.get(kind); return row ? structuredClone(row) : null; },
    async claim(candidate) {
      const retained = rows.get(candidate.step.kind);
      if (retained) { events.push("claim-lost"); return { claimed: false, record: structuredClone(retained) }; }
      rows.set(candidate.step.kind, structuredClone(candidate)); claims++; events.push("claim");
      return { claimed: true, record: structuredClone(candidate) };
    },
    async record(previous, next) {
      if (stable(rows.get(previous.step.kind)) !== stable(previous) || next.step.kind !== previous.step.kind) throw new Error("Concurrent funding journal change");
      rows.set(previous.step.kind, structuredClone(next)); events.push("record");
      return structuredClone(next);
    },
  };
  return { journal, rows, claims: () => claims };
}

function chainReads(plan: EthereumFundingPlan, options: { allowance?: bigint; balance?: bigint; minter?: string } = {}) {
  const amount = BigInt(plan.invoice.amountAtoms);
  return (to: string, data: Hex): Hex => {
    if (to.toLowerCase() === route.helperAddress.toLowerCase()) {
      expect(decodeFunctionData({ abi: DEPOSIT_HELPER_ABI, data }).functionName).toBe("getMinterAddress");
      return encodeFunctionResult({ abi: DEPOSIT_HELPER_ABI, functionName: "getMinterAddress", result: getAddress(options.minter ?? route.minterAddress) });
    }
    expect(to.toLowerCase()).toBe(route.tokenAddress.toLowerCase());
    const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
    if (decoded.functionName === "allowance") {
      expect(decoded.args).toEqual([getAddress(payer), getAddress(route.helperAddress)]);
      return encodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", result: options.allowance ?? 0n });
    }
    expect(decoded.functionName).toBe("balanceOf");
    expect(decoded.args).toEqual([getAddress(payer)]);
    return encodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", result: options.balance ?? amount });
  };
}

function browserFixture(plan: EthereumFundingPlan, options: { allowance?: bigint; balance?: bigint; minter?: string; payer?: string; events?: string[] } = {}) {
  const reads = chainReads(plan, options), events = options.events ?? [];
  const fixture = { sends: 0, receiptReads: 0, sendError: null as Error | null, receipt: null as Record<string, unknown> | null, onSend: () => {} };
  const provider = { async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    if (method === "eth_requestAccounts") return [options.payer ?? payer];
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") { expect(params?.[1]).toBe("latest"); return "0x6001600155"; }
    if (method === "eth_call") {
      expect(params?.[1]).toBe("latest");
      const tx = params![0] as { to: string; data: Hex };
      return reads(tx.to, tx.data);
    }
    if (method === "eth_sendTransaction") {
      fixture.sends++; events.push("send"); fixture.onSend();
      const tx = params![0] as { to: string };
      if (fixture.sendError) throw fixture.sendError;
      return tx.to.toLowerCase() === route.helperAddress.toLowerCase() ? depositHash : approvalHash;
    }
    if (method === "eth_getTransactionReceipt") {
      fixture.receiptReads++; events.push("receipt");
      expect([approvalHash, depositHash]).toContain(params![0] as Hex);
      return fixture.receipt;
    }
    throw new Error(`Unexpected RPC method ${method}`);
  } };
  return { ...fixture, get sends() { return fixture.sends; }, get receiptReads() { return fixture.receiptReads; },
    set sendError(value: Error | null) { fixture.sendError = value; }, set receipt(value: Record<string, unknown> | null) { fixture.receipt = value; }, set onSend(value: () => void) { fixture.onSend = value; },
    connection: { provider, close: async () => {} } as unknown as EthereumProviderConnection };
}

function browserReceipt(plan: EthereumFundingPlan, kind: EthereumFundingKind) {
  return { transactionHash: kind === "approval" ? approvalHash : depositHash, from: plan.steps[kind].transaction.from, to: plan.steps[kind].transaction.to, status: "0x1", blockNumber: "0x18bf764" };
}

function evmFixture(plan: EthereumFundingPlan, kind: EthereumFundingKind, options: { allowance?: bigint; balance?: bigint; minter?: string; payer?: string; events?: string[] } = {}) {
  const reads = chainReads(plan, options), events = options.events ?? [], step = plan.steps[kind];
  const hash = kind === "approval" ? approvalHash : depositHash;
  const identity = { accountId: "main" as const, chainId: "1", requestId: step.requestId };
  const submitted: EvmOperationStatusResult = { ...identity, operationId: "17", kind: "transaction", status: "submitted", address: payer, transactionHash: hash, signature: null, message: null, reviewRevision: "1", receipt: null };
  const fixture = { sends: 0, rootSends: 0, statusReads: 0, sendError: null as Error | null, onSend: () => {},
    status: { ...identity, status: "not_found" } as EvmOperationStatusResult,
    evidence: { chainId: "1", transactionHash: hash, walletRequestMatches: null, transaction: null, receipt: null, observedAtNs: "1", source: "evm_rpc" } as EvmTransactionResult,
  };
  const client = {
    async accounts() { return { accounts: [{ accountId: "main", address: options.payer ?? payer, keyFingerprint: fingerprint }] }; },
    async callContract(request: { to: string; data: Hex }) { return { result: reads(request.to, request.data) }; },
    async readContract() { return { code: "0x6001600155" }; },
    async operationStatus(request: typeof identity) { expect(request).toEqual(identity); fixture.statusReads++; events.push("wallet-status"); return fixture.status; },
    async sendTransaction(request: { requestId: string; to: string; data: Hex; valueWei: string }) {
      expect(request).toMatchObject({ ...identity, to: step.transaction.to.toLowerCase(), data: step.transaction.data.toLowerCase(), valueWei: "0" });
      fixture.sends++; events.push("wallet-send"); fixture.onSend();
      if (fixture.sendError) throw fixture.sendError;
      fixture.status = submitted;
      return submitted;
    },
    async sendTransactionRoot() { fixture.rootSends++; throw new Error("A nested marketplace call cannot use root-only signing"); },
    async transaction(request: { chainId: string; transactionHash: string }) { expect(request).toEqual({ chainId: "1", transactionHash: hash }); return fixture.evidence; },
  } as unknown as EvmWalletClient;
  function confirm() {
    fixture.status = submitted;
    fixture.evidence = { chainId: "1", transactionHash: hash, walletRequestMatches: null,
      transaction: { from: payer, to: step.transaction.to, data: step.transaction.data, valueWei: "0", nonce: "3", blockNumber: "25950052", blockHash },
      receipt: { status: "success", blockNumber: "25950052", blockHash, gasUsed: "52000", effectiveGasPriceWei: "1000000000", logs: [], finality: "included", observedAtNs: "1" }, observedAtNs: "1", source: "evm_rpc" };
  }
  return { fixture, client, confirm, submitted };
}

describe("browser funding execution", () => {
  test("claims durably before dispatch and reconciles approval without calling it a payment", async () => {
    const plan = freshPlan(), events: string[] = [], store = journalFixture(events), browser = browserFixture(plan, { events });
    browser.onSend = () => expect(store.rows.get("approval")?.state).toBe("unknown");
    const sent = await executeBrowserFundingStep(plan, "approval", browser.connection, store.journal);
    expect(sent.state).toBe("submitted"); expect(sent.transactionHash).toBe(approvalHash);
    expect(sent.message).toContain("not a payment");
    expect(events.indexOf("claim")).toBeLessThan(events.indexOf("send"));
    browser.receipt = browserReceipt(plan, "approval");
    const confirmed = await executeBrowserFundingStep(plan, "approval", browser.connection, store.journal);
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.receipt?.status).toBe("success");
    expect(confirmed.message).toContain("No payment has been made");
    expect(browser.sends).toBe(1);
  });

  test("an unknown browser send without a hash is never sent again", async () => {
    const plan = freshPlan(), store = journalFixture(), browser = browserFixture(plan);
    browser.sendError = new Error("Browser reply lost after submit");
    const unknown = await executeBrowserFundingStep(plan, "approval", browser.connection, store.journal);
    expect(unknown.state).toBe("unknown"); expect(unknown.transactionHash).toBeNull();
    browser.sendError = null;
    const resumed = await executeBrowserFundingStep(plan, "approval", browser.connection, store.journal);
    expect(resumed.state).toBe("unknown"); expect(resumed.message).toContain("do not send it again");
    expect(browser.sends).toBe(1); expect(browser.receiptReads).toBe(0); expect(store.claims()).toBe(1);
  });

  for (const field of ["transactionHash", "from", "to"] as const) test(`rejects a receipt with mismatched ${field}`, async () => {
    const plan = freshPlan(), store = journalFixture(), browser = browserFixture(plan);
    const retained = await executeBrowserFundingStep(plan, "approval", browser.connection, store.journal);
    browser.receipt = { ...browserReceipt(plan, "approval"), [field]: field === "transactionHash" ? depositHash : route.minterAddress };
    await expect(executeBrowserFundingStep(plan, "approval", browser.connection, store.journal)).rejects.toThrow("receipt does not match");
    expect(store.rows.get("approval")).toEqual(retained); expect(browser.sends).toBe(1);
  });

  test("only one concurrent browser caller acquires the right to send", async () => {
    const plan = freshPlan(), store = journalFixture(), browser = browserFixture(plan);
    const results = await Promise.all([
      executeBrowserFundingStep(plan, "approval", browser.connection, store.journal),
      executeBrowserFundingStep(plan, "approval", browser.connection, store.journal),
    ]);
    expect(store.claims()).toBe(1); expect(browser.sends).toBe(1);
    expect(results.some(value => value.transactionHash === approvalHash)).toBe(true);
    expect(store.rows.get("approval")?.transactionHash).toBe(approvalHash);
  });
});

describe("EVM Wallet funding execution", () => {
  test("uses the public provider only after the durable claim and verifies the exact approval receipt", async () => {
    const plan = freshPlan(), events: string[] = [], store = journalFixture(events), wallet = evmFixture(plan, "approval", { events });
    wallet.confirm(); wallet.fixture.status = { accountId: "main", chainId: "1", requestId: ids.approval, status: "not_found" };
    wallet.fixture.onSend = () => expect(store.rows.get("approval")?.walletIntent?.request.requestId).toBe(ids.approval);
    const result = await executeEvmFundingStep(plan, "approval", wallet.client, store.journal);
    expect(result.state).toBe("confirmed"); expect(result.transactionHash).toBe(approvalHash);
    expect(result.message).toContain("No payment has been made");
    expect(events.indexOf("claim")).toBeLessThan(events.indexOf("wallet-send"));
    expect(wallet.fixture.sends).toBe(1); expect(wallet.fixture.rootSends).toBe(0);
  });

  test("Wallet not_found after an unknown send cannot start another transaction", async () => {
    const plan = freshPlan(), store = journalFixture(), wallet = evmFixture(plan, "approval");
    wallet.fixture.sendError = new Error("Wallet reply interrupted");
    expect((await executeEvmFundingStep(plan, "approval", wallet.client, store.journal)).state).toBe("unknown");
    wallet.fixture.sendError = null;
    const resumed = await executeEvmFundingStep(plan, "approval", wallet.client, store.journal);
    expect(resumed.state).toBe("unknown"); expect(resumed.transactionHash).toBeNull();
    expect(resumed.message).toContain("Do not reconstruct or send another payment");
    expect(wallet.fixture.sends).toBe(1); expect(wallet.fixture.rootSends).toBe(0); expect(store.claims()).toBe(1);
  });

  test("a later exact deposit receipt recovers the original Wallet request without another send", async () => {
    const plan = freshPlan(), store = journalFixture(), wallet = evmFixture(plan, "deposit", { allowance: 1234567n });
    wallet.fixture.sendError = new Error("Wallet reply lost after dispatch");
    const unknown = await executeEvmFundingStep(plan, "deposit", wallet.client, store.journal);
    expect(unknown.state).toBe("unknown");
    wallet.fixture.sendError = null; wallet.confirm();
    const confirmed = await executeEvmFundingStep(plan, "deposit", wallet.client, store.journal);
    expect(confirmed.state).toBe("confirmed"); expect(confirmed.transactionHash).toBe(depositHash);
    expect(confirmed.message).toContain("protocol must independently verify");
    expect(confirmed.walletIntent).toEqual(unknown.walletIntent);
    expect(wallet.fixture.sends).toBe(1); expect(wallet.fixture.rootSends).toBe(0);
  });

  test("wrong transaction calldata cannot confirm an existing Wallet deposit", async () => {
    const plan = freshPlan(), store = journalFixture(), wallet = evmFixture(plan, "deposit", { allowance: 1234567n });
    const submitted = await executeEvmFundingStep(plan, "deposit", wallet.client, store.journal);
    expect(submitted.state).toBe("submitted");
    wallet.confirm(); wallet.fixture.evidence.transaction!.data = plan.steps.approval.transaction.data;
    await expect(executeEvmFundingStep(plan, "deposit", wallet.client, store.journal)).rejects.toThrow("does not match");
    expect(store.rows.get("deposit")).toEqual(submitted); expect(wallet.fixture.sends).toBe(1);
  });

  test("only one concurrent Wallet caller acquires the right to send", async () => {
    const plan = freshPlan(), store = journalFixture(), wallet = evmFixture(plan, "approval");
    const results = await Promise.all([
      executeEvmFundingStep(plan, "approval", wallet.client, store.journal),
      executeEvmFundingStep(plan, "approval", wallet.client, store.journal),
    ]);
    expect(store.claims()).toBe(1); expect(wallet.fixture.sends).toBe(1); expect(wallet.fixture.rootSends).toBe(0);
    expect(results.some(value => value.transactionHash === approvalHash)).toBe(true);
  });
});

for (const source of ["browser", "evm_wallet"] as const) describe(`${source} funding preflight`, () => {
  async function run(options: { allowance?: bigint; balance?: bigint; minter?: string; payer?: string }, kind: EthereumFundingKind = "deposit") {
    const plan = freshPlan(), store = journalFixture();
    const browser = browserFixture(plan, options), wallet = evmFixture(plan, kind, options);
    try {
      return source === "browser"
        ? await executeBrowserFundingStep(plan, kind, browser.connection, store.journal)
        : await executeEvmFundingStep(plan, kind, wallet.client, store.journal);
    } finally {
      expect(store.claims()).toBe(0); expect(browser.sends).toBe(0); expect(wallet.fixture.sends).toBe(0);
    }
  }
  test("another payer cannot dispatch the invoice", async () => {
    await expect(run({ payer: route.minterAddress, allowance: 1234567n }, "approval")).rejects.toThrow(/payer/i);
  });
  test("a helper reporting a different minter cannot dispatch", async () => {
    await expect(run({ minter: route.helperAddress, allowance: 1234567n }, "approval")).rejects.toThrow("another minter");
  });
  test("insufficient token balance cannot dispatch", async () => {
    await expect(run({ balance: 1234566n, allowance: 1234567n })).rejects.toThrow("insufficient USDC");
  });
  for (const allowance of [0n, 1234566n, 1234568n, (1n << 256n) - 1n]) test(`deposit requires exact approval rather than ${allowance} atoms`, async () => {
    await expect(run({ allowance })).rejects.toThrow("exact USDC approval");
  });
});

test("the browser deposits with an exact live allowance and retained invoice calldata", async () => {
  const plan = freshPlan(), store = journalFixture(), browser = browserFixture(plan, { allowance: 1234567n });
  const submitted = await executeBrowserFundingStep(plan, "deposit", browser.connection, store.journal);
  expect(submitted.state).toBe("submitted"); expect(submitted.transactionHash).toBe(depositHash);
  browser.receipt = browserReceipt(plan, "deposit");
  const confirmed = await executeBrowserFundingStep(plan, "deposit", browser.connection, store.journal);
  expect(confirmed.state).toBe("confirmed"); expect(confirmed.step.transaction.data).toBe(plan.steps.deposit.transaction.data);
  expect(confirmed.message).toContain("protocol must verify this payment"); expect(browser.sends).toBe(1);
});
