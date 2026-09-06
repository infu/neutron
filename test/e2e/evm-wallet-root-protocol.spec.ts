import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { Interface, Transaction } from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import type { EvmAccount, EvmOperationResult, EvmSendTransactionRequest } from "neutron-tools/evm_wallet";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import type { SwapRecord, SavedIntent } from "../../apps/uniswap/src/controller.ts";
import { createLocalEvmChain, type LocalEvmTransactionEvidence } from "./fixtures/evm-wallet-chain.ts";
import { createLocalUniswapFixture } from "./fixtures/evm-wallet-uniswap.ts";
import { expectNoEvmKernelDialogs, startEvmKernelDialogAudit } from "./fixtures/evm-wallet-browser.ts";
import type { EvmRpcBroadcastReplyLoss } from "./fixtures/evm-wallet-rpc-routing.ts";

const KITCHEN = 'iframe[data-app-id="kitchensink"][data-tile-id="main"]';
const WALLET = "app:evm_wallet:background";
const UNISWAP = "app:uniswap:background";
type ToolCall = { target: string; name: string; arguments: Record<string, unknown> };
type Prepared = { swapId: string; phase: string; recordJson: string; approvalRequestJson: string | null; swapRequestJson: string };

// Only the caller fixture replaces Kitchen Sink JS. Installed Kernel supplies
// Agent authority, installed Uniswap prepares/verifies durable requests, and
// installed EVM Wallet signs real transactions against official local contracts.
// This qualifies the Agent protocol, not model reasoning or Kitchen Sink JS.
test.describe.configure({ retries: 0 });
test.skip(!process.env.NEUTRON_NDEPLOY_CONFIG?.endsWith("evm-wallet-local.ndeploy.json") ||
  process.env.NEUTRON_EVM_ROOT_CHAIN_WINDOW !== "1",
"Requires the isolated EVM runtime and an exclusive local Ethereum financial window");

test("direct Kernel root Agent completes Uniswap and descendants cannot sign", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const checkpoints: Array<Record<string, unknown>> = [];
  const checkpointPath = testInfo.outputPath("root-protocol-checkpoints.json");
  testInfo.attachments.push({ name: "root-protocol-checkpoints", path: checkpointPath, contentType: "application/json" });
  async function checkpoint(stage: string, data: Record<string, unknown> = {}): Promise<void> {
    checkpoints.push({ at: new Date().toISOString(), stage, ...data });
    await writeFile(checkpointPath, `${JSON.stringify(checkpoints, null, 2)}\n`);
    console.log(`Root protocol: ${stage}`);
  }
  await checkpoint("started");
  await installCaller(page);
  let kitchen = await openRootCaller(page);
  await startEvmKernelDialogAudit(page);
  const chain = await createLocalEvmChain();
  async function prepareFreshProtocol() {
    const contracts = await createLocalUniswapFixture();
    const accounts = await rootCall<{ accounts: EvmAccount[] }>(kitchen, walletCall("evm_accounts_v1", {}));
    const account = accounts.accounts.find((item) => item.accountId === "main");
    expect(account).toBeTruthy();
    const address = account!.address;
    await checkpoint("account discovered", { account });
    await contracts.fund(address);
    const before = {
      nonce: await chain.nonce(address), native: await chain.balance(address),
      input: await contracts.balance(contracts.tokenA, address), output: await contracts.balance(contracts.tokenB, address),
      allowance: await contracts.allowance(contracts.tokenA, address),
    };
    expect(before.allowance).toBe(0n);
    const quote = await rootCall<{ quoteJson: string }>(kitchen, uniCall("uniswap_quote_v1", {
      chainId: "1", accountId: "main", tokenIn: contracts.tokenA, tokenOut: contracts.tokenB,
      amountIn: contracts.recommendedAmountAtoms, slippageBps: 50, recipient: address,
      deadline: String(Math.floor(Date.now() / 1_000) + 1_200),
    }));
    await checkpoint("Uniswap quote completed", { quote });
    const swapId = await page.evaluate(() => crypto.randomUUID().replaceAll("-", ""));
    const prepareCall = uniCall("uniswap_prepare_v1", { swapId, quoteJson: quote.quoteJson });
    const prepared = await rootCall<Prepared>(kitchen, prepareCall);
    expect(prepared.phase).toBe("queued");
    expect(await rootCall<Prepared>(kitchen, prepareCall)).toEqual(prepared);
    const initial = JSON.parse(prepared.recordJson) as SwapRecord;
    const intent = JSON.parse(initial.quote_json) as SavedIntent;
    expect(intent.executionMode).toBe("agent");
    expect(intent.walletCaller).toMatchObject({ appId: "kitchensink" });
    expect(intent.walletCaller?.installationUid).toMatch(/^[1-9][0-9]*$/u);
    expect(prepared.approvalRequestJson).not.toBeNull();
    const approvalRequest = JSON.parse(prepared.approvalRequestJson!) as EvmSendTransactionRequest;
    const swapRequest = JSON.parse(prepared.swapRequestJson) as EvmSendTransactionRequest;
    await checkpoint("Uniswap exact requests persisted before effects", { prepared: initial, approvalRequest, swapRequest });
    const approvalCall = walletCall("evm_send_transaction_root_v1", approvalRequest);

    const denied: Record<string, string> = {};
    for (const mode of ["human", "descendant"] as const) {
      const result = await invoke(kitchen, mode, approvalCall);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("evm_send_transaction_root_v1");
      denied[mode] = result.error!;
      expect(await chain.nonce(address)).toBe(before.nonce);
      expect(await chain.balance(address)).toBe(before.native);
      expect(await contracts.allowance(contracts.tokenA, address)).toBe(before.allowance);
      expect(await contracts.balance(contracts.tokenA, address)).toBe(before.input);
      expect(await contracts.balance(contracts.tokenB, address)).toBe(before.output);
    }
    const missing = await rootCall<{ status: string }>(kitchen, walletCall("evm_operation_status_v1", identity(approvalRequest)));
    expect(missing.status).toBe("not_found");
    await checkpoint("human and descendant root calls denied without an operation", { denied, missing });
    await expect(page.locator('iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]')).toHaveCount(0);

    const approval = await sendAndConfirm(kitchen, approvalRequest);
    await checkpoint("root approval confirmed", { approval });
    const approvalEvidence = await chain.evidence(approval.transactionHash!);
    expect(approvalEvidence.from.toLowerCase()).toBe(address.toLowerCase());
    expect(approvalEvidence.to.toLowerCase()).toBe(contracts.tokenA.toLowerCase());
    expect(Transaction.from(approvalEvidence.raw).data).toBe(approvalRequest.data);
    expect(await contracts.allowance(contracts.tokenA, address)).toBe(BigInt(contracts.recommendedAmountAtoms));
    expect(await contracts.balance(contracts.tokenA, address)).toBe(before.input);
    expect(await contracts.balance(contracts.tokenB, address)).toBe(before.output);
    const recordedApproval = await rootCall<Prepared>(kitchen, uniCall("uniswap_record_result_v1", {
      swapId, stage: "approval", operationJson: JSON.stringify(approval),
    }));
    expect(recordedApproval.phase).toBe("approval_confirmed");
    await checkpoint("Uniswap independently recorded approval", { recordedApproval });
    expect(recordedApproval.approvalRequestJson).toBe(prepared.approvalRequestJson);
    expect(recordedApproval.swapRequestJson).toBe(prepared.swapRequestJson);

    // An actual successful approval is not evidence for a different saved swap
    // request, even when a root caller relabels the result's request ID.
    const relabeled = await invoke(kitchen, "direct", uniCall("uniswap_record_result_v1", {
      swapId, stage: "swap", operationJson: JSON.stringify({ ...approval, requestId: swapRequest.requestId }),
    }));
    expect(relabeled.ok).toBe(false);
    expect(relabeled.error).toContain("bind this transaction hash");
    const afterRelabel = await rootCall<{ recordJson: string }>(kitchen, uniCall("uniswap_status_v1", { swapId }));
    expect(afterRelabel.recordJson).toBe(recordedApproval.recordJson);
    expect((JSON.parse(afterRelabel.recordJson) as SwapRecord).swap_operation_json).toBeNull();
    expect(await chain.nonce(address)).toBe(before.nonce + 1n);
    await checkpoint("relabeled approval rejected", { error: relabeled.error });
    return { contracts, account, address, before, prepared, initial, intent, approvalRequest, swapRequest, swapId, approvalCall, denied, approval, approvalEvidence, recordedApproval, relabeled };
  }
  const preparedProtocol = process.env.NEUTRON_EVM_ROOT_RESUME_CHECKPOINT
    ? await resumeProtocol(kitchen, chain, process.env.NEUTRON_EVM_ROOT_RESUME_CHECKPOINT)
    : await prepareFreshProtocol();
  const { contracts, account, address, before, prepared, initial, intent, approvalRequest, swapRequest, swapId, approvalCall, denied, approval, approvalEvidence, recordedApproval, relabeled } = preparedProtocol;

  await expectNoEvmKernelDialogs(page);
  kitchen = await openRootCaller(page);
  await startEvmKernelDialogAudit(page);
  const afterReload = await rootCall<{ recordJson: string }>(kitchen, uniCall("uniswap_status_v1", { swapId }));
  expect(afterReload.recordJson).toBe(recordedApproval.recordJson);
  expect((JSON.parse(afterReload.recordJson) as SwapRecord).swap_request_json).toBe(prepared.swapRequestJson);
  expect(await chain.nonce(address)).toBe(before.nonce + 1n);
  await checkpoint("same saved requests recovered after reload", { afterReload });

  // The loopback proxy forwards these real signed bytes to Anvil and validates
  // its accepted hash before suppressing every provider's broadcast response.
  // The root must retain its unknown operation and reconcile its saved identity.
  let ambiguousSwap!: EvmOperationResult;
  let lostReply!: EvmRpcBroadcastReplyLoss;
  let swapEvidence!: LocalEvmTransactionEvidence;
  const priorFault = (await broadcastReplyControl("state")).broadcastReplyLoss;
  expect(priorFault === null || priorFault.releasedAt !== null,
    "The exclusive test window must not borrow an already active fault").toBe(true);
  try {
    // Include arm in cleanup: the proxy may arm even if its reply is lost.
    await broadcastReplyControl("arm", { chainId: "1" });
    ambiguousSwap = await rootCall<EvmOperationResult>(kitchen, walletCall("evm_send_transaction_root_v1", swapRequest));
    expect(ambiguousSwap.status).toBe("unknown");
    expect(ambiguousSwap.requestId).toBe(swapRequest.requestId);
    expect(ambiguousSwap.receipt).toBeNull();
    expect(ambiguousSwap.message).toContain("Broadcast outcome requires reconciliation");
    const control = await broadcastReplyControl("state");
    expect(control.broadcastReplyLoss).not.toBeNull();
    lostReply = control.broadcastReplyLoss!;
    await checkpoint("actual swap broadcast response lost", { ambiguousSwap, lostReply });
    expect(lostReply.chainId).toBe("1");
    expect(lostReply.acceptedAt).not.toBeNull();
    expect(lostReply.releasedAt).toBeNull();
    expect(lostReply.transactionHash).toBe(ambiguousSwap.transactionHash);
    expect(lostReply.suppressedResponses).toBeGreaterThan(0);
    expect(lostReply.deliveredResponses).toBe(0);
    expect(lostReply.observedRawTransactions).toEqual([lostReply.raw]);
    swapEvidence = await chain.evidence(lostReply.transactionHash!);
    expect(swapEvidence.raw).toBe(lostReply.raw);
    expect(await chain.nonce(address)).toBe(before.nonce + 2n);
    // Uniswap still has only its independently verified approval. An unknown
    // broadcast reply never creates a fictitious confirmed swap in its journal.
    expect(await rootCall(kitchen, uniCall("uniswap_status_v1", { swapId })))
      .toEqual({ recordJson: recordedApproval.recordJson });
  } finally {
    await broadcastReplyControl("release");
  }
  const swap = await confirmSavedOperation(kitchen, swapRequest);
  await checkpoint("same swap operation recovered to confirmed", { swap });
  expect(swap).toMatchObject({ operationId: ambiguousSwap.operationId, requestId: swapRequest.requestId, transactionHash: ambiguousSwap.transactionHash });
  expect(swapEvidence.hash).toBe(swap.transactionHash);
  expect(swapEvidence.from.toLowerCase()).toBe(address.toLowerCase());
  expect(swapEvidence.to.toLowerCase()).toBe(contracts.router.toLowerCase());
  expect(Transaction.from(swapEvidence.raw).data).toBe(swapRequest.data);
  const recordedSwap = await rootCall<Prepared>(kitchen, uniCall("uniswap_record_result_v1", {
    swapId, stage: "swap", operationJson: JSON.stringify(swap),
  }));
  expect(recordedSwap.phase).toBe("swap_confirmed");
  await checkpoint("Uniswap independently recorded swap", { recordedSwap });
  const final = JSON.parse(recordedSwap.recordJson) as SwapRecord;
  expect(final.quote_json).toBe(initial.quote_json);
  expect(final.approval_request_id).toBe(approvalRequest.requestId);
  expect(final.swap_request_id).toBe(swapRequest.requestId);
  for (const operationJson of [final.approval_operation_json, final.swap_operation_json]) {
    const operation = JSON.parse(operationJson!) as EvmOperationResult;
    expect(operation.status).toBe("confirmed");
    expect(operation.receipt?.status).toBe("success");
    expect(operation.message).toContain("exact caller/request binding");
  }
  const statusCall = uniCall("uniswap_status_v1", { swapId });
  expect(await rootCall(kitchen, statusCall)).toEqual({ recordJson: recordedSwap.recordJson });
  expect(await rootCall(kitchen, statusCall)).toEqual({ recordJson: recordedSwap.recordJson });
  expect(await rootCall<EvmOperationResult>(kitchen, approvalCall)).toMatchObject({ operationId: approval.operationId, transactionHash: approval.transactionHash });
  expect(await rootCall<EvmOperationResult>(kitchen, walletCall("evm_send_transaction_root_v1", swapRequest))).toMatchObject({ operationId: swap.operationId, transactionHash: swap.transactionHash });
  const actualInput = before.input - await contracts.balance(contracts.tokenA, address);
  const actualOutput = await contracts.balance(contracts.tokenB, address) - before.output;
  expect(actualInput).toBe(BigInt(contracts.recommendedAmountAtoms));
  expect(actualOutput).toBeGreaterThanOrEqual(BigInt(intent.quote.minimumOut));
  expect(await contracts.allowance(contracts.tokenA, address)).toBe(0n);
  expect(await chain.nonce(address)).toBe(before.nonce + 2n);
  const recoveredReply = (await broadcastReplyControl("state")).broadcastReplyLoss!;
  expect(recoveredReply.releasedAt).not.toBeNull();
  expect(recoveredReply.raw).toBe(lostReply.raw);
  expect(recoveredReply.transactionHash).toBe(lostReply.transactionHash);
  expect(recoveredReply.observedRawTransactions).toEqual([lostReply.raw]);
  // The receipt was already mined: status and identical root retries should
  // require neither another broadcast nor another transaction nonce.
  expect(recoveredReply.matchingRequests).toBe(lostReply.matchingRequests);
  expect(recoveredReply.deliveredResponses).toBe(0);
  await expectNoEvmKernelDialogs(page);
  await expect(page.locator('iframe[data-app-id="evm_wallet"][data-tile-id="evm_wallet"]')).toHaveCount(0);
  await checkpoint("completed without duplicate transaction", { nonceBefore: String(before.nonce), nonceAfter: String(await chain.nonce(address)) });
  await testInfo.attach("root-uniswap-real-chain-protocol", {
    body: JSON.stringify({ proof: "Deterministic Kitchen caller, real Kernel Agent grants and scope, installed Uniswap and EVM Wallet, official local contracts; approval checkpoint survives reload; actual accepted swap broadcast response suppressed and saved operation recovered", account, denied, relabeledApprovalError: relabeled.error, prepared: initial, afterReload, final, approvalEvidence, ambiguousSwap, lostReply, recoveredReply, swapEvidence, actualInput: String(actualInput), actualOutput: String(actualOutput), nonceBefore: String(before.nonce), nonceAfter: String(await chain.nonce(address)) }, null, 2),
    contentType: "application/json",
  });
});

/** Continue an interrupted qualification from its actual recorded approval.
 * Never deploy/fund, re-quote, prepare new IDs, or submit another approval here.
 */
async function resumeProtocol(kitchen: FrameLocator, chain: Awaited<ReturnType<typeof createLocalEvmChain>>, path: string) {
  const events = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
  const event = (stage: string) => {
    const result = events.find((entry) => entry.stage === stage);
    if (!result) throw new Error(`Continuation has no completed ${stage} checkpoint`);
    return result;
  };
  const account = event("account discovered").account as EvmAccount;
  const current = await rootCall<{ accounts: EvmAccount[] }>(kitchen, walletCall("evm_accounts_v1", {}));
  expect(current.accounts.find((entry) => entry.accountId === account.accountId)).toEqual(account);
  const address = account.address;
  const saved = event("Uniswap exact requests persisted before effects");
  const initial = saved.prepared as SwapRecord;
  const intent = JSON.parse(initial.quote_json) as SavedIntent;
  const approvalRequest = saved.approvalRequest as EvmSendTransactionRequest;
  const swapRequest = saved.swapRequest as EvmSendTransactionRequest;
  expect(JSON.parse(initial.approval_request_json!)).toEqual(approvalRequest);
  expect(JSON.parse(initial.swap_request_json)).toEqual(swapRequest);
  const swapId = initial.id;
  const recordedApproval = event("Uniswap independently recorded approval").recordedApproval as Prepared;
  const status = await rootCall<{ recordJson: string }>(kitchen, uniCall("uniswap_status_v1", { swapId }));
  expect(status.recordJson).toBe(recordedApproval.recordJson);
  expect((JSON.parse(status.recordJson) as SwapRecord).swap_operation_json).toBeNull();
  const approval = event("root approval confirmed").approval as EvmOperationResult;
  const actualApproval = await confirmSavedOperation(kitchen, approvalRequest);
  expect(actualApproval).toMatchObject({ operationId: approval.operationId, requestId: approvalRequest.requestId, transactionHash: approval.transactionHash });
  const approvalEvidence = await chain.evidence(approval.transactionHash!);
  expect(Transaction.from(approvalEvidence.raw).data).toBe(approvalRequest.data);
  expect(approvalEvidence.from.toLowerCase()).toBe(address.toLowerCase());
  const abi = new Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
  const contracts = {
    tokenA: intent.quote.tokenIn.address!, tokenB: intent.quote.tokenOut.address!, router: intent.quote.router,
    recommendedAmountAtoms: intent.quote.amountIn,
    async balance(token: string, owner: string): Promise<bigint> {
      const raw = await chain.rpc<string>("eth_call", [{ to: token, data: abi.encodeFunctionData("balanceOf", [owner]) }, "latest"]);
      return BigInt(abi.decodeFunctionResult("balanceOf", raw)[0]);
    },
    async allowance(token: string, owner: string): Promise<bigint> {
      const raw = await chain.rpc<string>("eth_call", [{ to: token, data: abi.encodeFunctionData("allowance", [owner, intent.quote.router]) }, "latest"]);
      return BigInt(abi.decodeFunctionResult("allowance", raw)[0]);
    },
  };
  expect(contracts.tokenA).not.toBeNull(); expect(contracts.tokenB).not.toBeNull();
  expect(await contracts.allowance(contracts.tokenA, address)).toBe(BigInt(contracts.recommendedAmountAtoms));
  expect(await chain.nonce(address)).toBe(BigInt(approvalEvidence.nonce) + 1n);
  const missingSwap = await rootCall<{ status: string }>(kitchen, walletCall("evm_operation_status_v1", identity(swapRequest)));
  expect(missingSwap.status).toBe("not_found");
  const before = { nonce: BigInt(approvalEvidence.nonce), input: await contracts.balance(contracts.tokenA, address), output: await contracts.balance(contracts.tokenB, address) };
  const prepared: Prepared = { swapId, phase: initial.phase, recordJson: JSON.stringify(initial), approvalRequestJson: initial.approval_request_json, swapRequestJson: initial.swap_request_json };
  const denied = event("human and descendant root calls denied without an operation").denied as Record<string, string>;
  const relabeled = { error: event("relabeled approval rejected").error as string };
  return { contracts, account, address, before, prepared, initial, intent, approvalRequest, swapRequest, swapId, approvalCall: walletCall("evm_send_transaction_root_v1", approvalRequest), denied, approval, approvalEvidence, recordedApproval, relabeled };
}

function walletCall(name: string, args: object): ToolCall { return { target: WALLET, name, arguments: args as Record<string, unknown> }; }
function uniCall(name: string, args: object): ToolCall { return { target: UNISWAP, name, arguments: args as Record<string, unknown> }; }
function identity(request: EvmSendTransactionRequest) { return { accountId: request.accountId, chainId: request.chainId, requestId: request.requestId }; }
async function invoke(kitchen: FrameLocator, mode: "direct" | "human" | "descendant", call: ToolCall): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return kitchen.locator("body").evaluate(async (_body, input) => {
    const run = (window as typeof window & { __NEUTRON_EVM_ROOT_CALL__?: (mode: string, call: unknown) => Promise<unknown> }).__NEUTRON_EVM_ROOT_CALL__;
    if (!run) throw new Error("Root caller fixture is unavailable");
    try { return { ok: true, result: await run(input.mode, input.call) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }, { mode, call });
}
async function rootCall<T = unknown>(kitchen: FrameLocator, call: ToolCall): Promise<T> {
  const result = await invoke(kitchen, "direct", call);
  expect(result.ok, `${call.name}: ${result.error ?? ""}`).toBe(true);
  return result.result as T;
}
async function sendAndConfirm(kitchen: FrameLocator, request: EvmSendTransactionRequest): Promise<EvmOperationResult> {
  const operation = await rootCall<EvmOperationResult>(kitchen, walletCall("evm_send_transaction_root_v1", request));
  expect(operation.transactionHash).toMatch(/^0x[0-9a-f]{64}$/iu);
  return confirmSavedOperation(kitchen, request);
}
async function confirmSavedOperation(kitchen: FrameLocator, request: EvmSendTransactionRequest): Promise<EvmOperationResult> {
  let operation!: EvmOperationResult;
  await expect.poll(async () => {
    operation = await rootCall<EvmOperationResult>(kitchen, walletCall("evm_operation_status_v1", identity(request)));
    return operation.status;
  }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe("confirmed");
  return operation;
}
async function broadcastReplyControl(action: "arm" | "state" | "release", args?: { chainId: "1" }): Promise<{ broadcastReplyLoss: EvmRpcBroadcastReplyLoss | null }> {
  const response = await fetch(`http://127.0.0.1:18549/__fixture_control/${action}`, {
    method: action === "state" ? "GET" : "POST",
    ...(args ? { headers: { "content-type": "application/json" }, body: JSON.stringify(args) } : {}),
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Explicit local broadcast reply-loss control ${action} failed: HTTP ${response.status}`);
  return response.json() as Promise<{ broadcastReplyLoss: EvmRpcBroadcastReplyLoss | null }>;
}
async function installCaller(page: Page): Promise<void> {
  const build = await esbuild.build({ absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)), bundle: true,
    entryPoints: [fileURLToPath(new URL("./fixtures/evm-wallet-root-harness.ts", import.meta.url))],
    format: "esm", minify: true, platform: "browser", target: "es2022", write: false });
  const source = build.outputFiles?.[0]?.text;
  if (!source) throw new Error("Root caller fixture did not build");
  await page.route(/\/app\/kitchensink\/(?:main|service)\.js(?:\?.*)?$/u,
    (route) => route.fulfill({ body: source, contentType: "text/javascript; charset=utf-8", status: 200 }));
}
async function openRootCaller(page: Page): Promise<FrameLocator> {
  const runtime = resolveLocalNeutronRuntime();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  expect(await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Kernel login hook unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed)).toBe(runtime.developerIdentityPrincipal);
  for (const app of ["evm_wallet", "uniswap", "kitchensink"]) {
    await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${app}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }
  if (await page.locator(KITCHEN).count() === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
  }
  const kitchen = page.frameLocator(KITCHEN);
  await expect(kitchen.locator('[data-tid="evm-root-harness"]')).toBeVisible();
  await page.locator(KITCHEN).focus();
  await kitchen.locator('[data-tid="evm-root-enable"]').click();
  const grant = page.locator('[data-tid="agent-grant-dialog"]');
  await expect(grant).toContainText("capability_agent_demo");
  await grant.locator('[data-tid="agent-grant-approve"]').click();
  await expect(page.locator('[data-tid="agent-mode-indicator"]')).toBeVisible();
  await expect(kitchen.locator('[data-tid="evm-root-grant"]')).toHaveText("enabled");
  await page.locator('[data-tid="launcher-open"]').focus();
  await expect(page.locator(KITCHEN)).not.toBeFocused();
  return kitchen;
}
