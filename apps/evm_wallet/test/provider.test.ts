import { expect, test } from "bun:test";
import type { MsgBusToolContext } from "neutron-tools/app";
import {
  effectIntent,
  handleHumanEffect,
  handleRootEffect,
  operationReceipt,
  OWNER_REVIEW_TOOLS,
  prepareEffect,
} from "../src/provider.ts";
import {
  acceptPrompt,
  checkPrompt,
  declinePrompt,
  getPrompts,
  presentEffect,
  presentOwnEffect,
  refreshPromptEvidence,
} from "../src/prompts.ts";
import { atomicAmount, parseBalance, parseOperation } from "../src/data.ts";
import { assertLocalAccount } from "../src/local_intent.ts";
const caller = {
  appId: "kitchensink",
  installationUid: "9",
  endpoint: "app:kitchensink:tile:main",
};
const request = {
  requestId: "ab".repeat(16),
  accountId: "main" as const,
  chainId: "1",
  to: `0x${"11".repeat(20)}`,
  valueWei: "7",
  data: "0x",
};
function wire(overrides: Record<string, unknown> = {}) {
  return {
    ok: {
      caller: {
        app_id: caller.appId,
        installation_uid: caller.installationUid,
        endpoint: caller.endpoint,
      },
      operation_id: "1",
      request_id: request.requestId,
      account_id: "main",
      chain_id: "1",
      kind: "transaction",
      status: "prepared",
      address: `0x${"22".repeat(20)}`,
      transaction_hash: null,
      signature: null,
      message: null,
      review_revision: "1",
      review: {
        nonce: "0",
        gas_limit: "21000",
        max_fee_per_gas: "2",
        max_priority_fee_per_gas: "1",
        gas_price: null,
        balance: "999999",
        simulation: "0x",
        observed_at: "1000000",
      },
      receipt_json: null,
      finality: null,
      created_at: "1000000",
      updated_at: "1000000",
      intent: effectIntent("transaction", request),
      prepared_transaction: {
        to: request.to,
        value: request.valueWei,
        data: request.data,
        access_list: [],
        chain_id: request.chainId,
        nonce:
          (overrides.review as { nonce: string } | undefined)?.nonce ?? "0",
        gas_limit: "21000",
        transaction_type: "eip1559",
        max_fee_per_gas: "2",
        max_priority_fee_per_gas: "1",
        gas_price: null,
      },
      ...overrides,
    },
  };
}
function context(
  update: (method: string, args: unknown[]) => Promise<unknown>,
  extra: Partial<MsgBusToolContext> = {},
): MsgBusToolContext {
  return {
    caller,
    audience: "foreground_tile",
    kernel: { updateSelf: update },
    ...extra,
  } as unknown as MsgBusToolContext;
}
async function promptReady() {
  for (let i = 0; i < 30; i++) {
    if (getPrompts().length) return getPrompts()[0]!;
    await Promise.resolve();
  }
  throw new Error("No prompt");
}
test("exact typed JSON and explicit transaction fields reach backend unchanged", () => {
  const typedDataJson =
    '{"types":{"EIP712Domain":[],"Permit":[{"name":"amount","type":"uint256"}]},"primaryType":"Permit","domain":{},"message":{"amount":9007199254740993}}';
  expect(
    effectIntent("typed_data", {
      requestId: request.requestId,
      accountId: "main",
      chainId: "1",
      typedDataJson,
    }),
  ).toEqual({
    account_id: "main",
    chain_id: "1",
    operation: { typed_data: { json: typedDataJson } },
  });
  expect(
    effectIntent("transaction", {
      ...request,
      transactionType: "legacy",
      gasPriceWei: "5",
      gasLimit: "40000",
    }),
  ).toMatchObject({
    operation: {
      transaction: {
        transaction_type: "legacy",
        gas_price: "5",
        gas_limit: "40000",
        access_list: [],
      },
    },
  });
});
test("missing installation provenance and nested root callers fail before backend work", async () => {
  let calls = 0;
  const ctx = context(async () => {
    calls++;
    return wire();
  });
  await expect(
    prepareEffect("transaction", request, {
      ...ctx,
      caller: { appId: caller.appId, endpoint: caller.endpoint },
    }),
  ).rejects.toThrow("installation identity");
  await expect(handleRootEffect("transaction", request, ctx)).rejects.toThrow(
    "root-agent",
  );
  expect(calls).toBe(0);
});
test("public provider delegates privately without preparing or signing", async () => {
  let calls = 0;
  const presentations: unknown[] = [];
  const ctx = context(
    async () => {
      calls++;
      return wire();
    },
    {
      presentUserInterface: async (request: unknown) => {
        presentations.push(request);
        return { ok: true };
      },
    } as unknown as Partial<MsgBusToolContext>,
  );
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual({
    ok: true,
  });
  expect(calls).toBe(0);
  expect(presentations).toEqual([
    {
      tileId: "evm_wallet",
      tool: "evm_transaction_present_v1",
      arguments: request,
    },
  ]);
});
const ownerTile = {
  appId: "evm_wallet",
  installationUid: "12",
  role: "tile",
  endpoint: "app:evm_wallet:tile:evm_wallet:instance:owner-7",
};
const ownerResident = { ...ownerTile, role: "background", endpoint: "app:evm_wallet:background" };
function humanOwnerContext(
  update: (method: string, args: unknown[]) => Promise<unknown>,
  extra: Partial<MsgBusToolContext> = {},
): MsgBusToolContext {
  const ctx = context(update, extra);
  delete ctx.audience;
  return ctx;
}
test("own requests route to their exact tile without provider presentation or backend effects", async () => {
  const forwarded: unknown[] = [];
  const ctx = humanOwnerContext(async () => { throw new Error("Resident must not prepare or sign"); }, {
    caller: ownerTile,
    kernel: {
      callTool: async (call: unknown) => { forwarded.push(call); return { routed: true }; },
    } as unknown as MsgBusToolContext["kernel"],
  });
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual({ routed: true });
  expect(forwarded).toEqual([{ target: ownerTile.endpoint, name: OWNER_REVIEW_TOOLS.transaction, arguments: request }]);
  expect(ctx.presentUserInterface).toBeUndefined();
});
test("own route rejects missing provenance, non-tile endpoints and Agent invocation before dispatch", async () => {
  let forwarded = 0;
  const ctx = humanOwnerContext(async () => { throw new Error("Unexpected backend work"); }, {
    caller: ownerTile,
    kernel: { callTool: async () => { forwarded++; } } as unknown as MsgBusToolContext["kernel"],
  });
  for (const changed of [
    { caller: { appId: ownerTile.appId, role: ownerTile.role, endpoint: ownerTile.endpoint } },
    { caller: ownerResident },
    { caller: { ...ownerTile, role: "background" } },
    { caller: { ...ownerTile, endpoint: "app:evm_wallet:tile:evm_wallet" } },
    { caller: { ...ownerTile, endpoint: "app:kitchensink:tile:main:instance:owner-7" } },
    { agentMode: true },
  ]) await expect(handleHumanEffect("transaction", request, { ...ctx, ...changed })).rejects.toThrow();
  await expect(handleHumanEffect("transaction", request, { ...ctx, caller })).rejects.toThrow("provider presentation");
  expect(forwarded).toBe(0);
});
test("owner review only accepts the authenticated resident without Agent invocation", async () => {
  let prepares = 0;
  const ctx = humanOwnerContext(async () => { prepares++; return wire(); }, { caller: ownerResident });
  for (const changed of [
    { caller },
    { caller: ownerTile },
    { caller: { appId: ownerResident.appId, role: ownerResident.role, endpoint: ownerResident.endpoint } },
    { caller: { ...ownerResident, role: "tile" } },
    { caller: { ...ownerResident, endpoint: "app:evm_wallet:background:other" } },
    { agentMode: true },
  ]) await expect(presentOwnEffect("transaction", request, { ...ctx, ...changed })).rejects.toThrow();
  // Existing external private tools still require Kernel foreground attestation.
  await expect(presentEffect("transaction", request, ctx)).rejects.toThrow("foreground-tile attestation");
  expect(prepares).toBe(0);
  expect(getPrompts()).toHaveLength(0);
});
test("own two-leg review preserves request identity, explicit approval and saved-result replay", async () => {
  const calls: string[] = [];
  let submitted = false;
  const ownerContext = humanOwnerContext(async (method, args) => {
    calls.push(method);
    expect((args[0] as Record<string, unknown>).identity).toEqual({
      caller: { app_id: ownerResident.appId, installation_uid: ownerResident.installationUid, endpoint: ownerResident.endpoint },
      request_id: request.requestId,
    });
    if (method.endsWith("execute_v1")) submitted = true;
    return wire({
      caller: { app_id: ownerResident.appId, installation_uid: ownerResident.installationUid, endpoint: ownerResident.endpoint },
      ...(submitted ? { status: "submitted", transaction_hash: `0x${"aa".repeat(32)}` } : {}),
    });
  }, { caller: ownerResident });
  const ctx = humanOwnerContext(async () => { throw new Error("Unexpected resident backend call"); }, {
    caller: ownerTile,
    kernel: { callTool: async (call: { target: string; name: string; arguments: typeof request }) => {
      expect(call.target).toBe(ownerTile.endpoint);
      expect(call.name).toBe(OWNER_REVIEW_TOOLS.transaction);
      return presentOwnEffect("transaction", call.arguments, ownerContext);
    } } as unknown as MsgBusToolContext["kernel"],
  });
  const pending = handleHumanEffect("transaction", request, ctx);
  const prompt = await promptReady();
  expect(calls).toEqual(["evm_wallet_prepare_v1"]);
  expect(prompt.context.audience).toBeUndefined();
  expect(prompt.prepared.request.requestId).toBe(request.requestId);
  await acceptPrompt(prompt);
  const result = await pending;
  expect(result.status).toBe("submitted");
  expect(await handleHumanEffect("transaction", request, ctx)).toEqual(result);
  expect(calls).toEqual(["evm_wallet_prepare_v1", "evm_wallet_execute_v1", "evm_wallet_prepare_v1"]);
  expect(getPrompts()).toHaveLength(0);
});
test("decline durably rejects without executing", async () => {
  const calls: string[] = [];
  const ctx = context(async (method) => {
    calls.push(method);
    return wire(method.endsWith("reject_v1") ? { status: "rejected" } : {});
  });
  const pending = presentEffect("transaction", request, ctx);
  await declinePrompt(await promptReady());
  expect((await pending).status).toBe("rejected");
  expect(calls).toEqual(["evm_wallet_prepare_v1", "evm_wallet_reject_v1"]);
});
test("concurrent nonce allocation requires approving the changed review", async () => {
  let executes = 0;
  const ctx = context(async (method, args) => {
    if (method.endsWith("execute_v1")) {
      executes++;
      expect((args[0] as Record<string, unknown>).review_revision).toBe(
        String(executes),
      );
      return executes === 1
        ? wire({
            review_revision: "2",
            review: { ...wire().ok.review, nonce: "1" },
            message: "Review changed",
          })
        : wire({
            review_revision: "2",
            status: "submitted",
            transaction_hash: `0x${"aa".repeat(32)}`,
          });
    }
    return wire();
  });
  const pending = presentEffect("transaction", request, ctx),
    prompt = await promptReady();
  await acceptPrompt(prompt);
  expect(executes).toBe(1);
  expect(prompt.phase).toBe("review");
  expect(prompt.prepared.operation.review?.nonce).toBe("1");
  await acceptPrompt(prompt);
  expect((await pending).status).toBe("submitted");
  expect(executes).toBe(2);
});
test("lost response checks status without automatically executing again", async () => {
  const calls: string[] = [];
  const ctx = context(async (method) => {
    calls.push(method);
    if (method.endsWith("execute_v1")) throw new Error("response lost");
    return wire(
      method.endsWith("status_v1")
        ? { status: "submitted", transaction_hash: `0x${"aa".repeat(32)}` }
        : {},
    );
  });
  const pending = presentEffect("transaction", request, ctx),
    prompt = await promptReady();
  await acceptPrompt(prompt);
  expect(prompt.phase).toBe("uncertain");
  await checkPrompt(prompt);
  expect((await pending).status).toBe("submitted");
  expect(calls).toEqual([
    "evm_wallet_prepare_v1",
    "evm_wallet_execute_v1",
    "evm_wallet_status_v1",
  ]);
});
test("cancellation removes review and prevents a late click signing", async () => {
  const controller = new AbortController();
  let executes = 0;
  const pending = presentEffect(
    "transaction",
    request,
    context(
      async (method) => {
        if (method.endsWith("execute_v1")) executes++;
        return wire();
      },
      { signal: controller.signal },
    ),
  );
  const caught = pending.catch((e) => e);
  const prompt = await promptReady();
  controller.abort(new Error("Caller cancelled"));
  await acceptPrompt(prompt);
  expect((await caught).message).toBe("Caller cancelled");
  expect(executes).toBe(0);
  expect(getPrompts()).toHaveLength(0);
});
test("changed recipient or explicit gas limits fail review matching", async () => {
  await expect(
    prepareEffect(
      "transaction",
      request,
      context(async () =>
        wire({
          intent: effectIntent("transaction", {
            ...request,
            to: `0x${"33".repeat(20)}`,
          }),
        }),
      ),
    ),
  ).rejects.toThrow("does not match");
  await expect(
    prepareEffect(
      "transaction",
      { ...request, gasLimit: "21000" },
      context(async () =>
        wire({
          intent: effectIntent("transaction", {
            ...request,
            gasLimit: "90000",
          }),
        }),
      ),
    ),
  ).rejects.toThrow("does not match");
});
test("block quantities remain exact and missing balances stay unavailable", () => {
  const r = parseBalance({
    ok: {
      account_id: "main",
      chain_id: "1",
      address: `0x${"22".repeat(20)}`,
      native_balance: "90071992547409931234",
      tokens: [
        {
          address: request.to,
          balance: null,
          decimals: null,
          symbol: null,
          error: "provider disagreement",
        },
      ],
      block_number: "0x20000000000001",
      observed_at: "123456789",
      completeness: "requested_only",
    },
  });
  expect(r.blockNumber).toBe("9007199254740993");
  expect(r.nativeBalance).toBe("90071992547409931234");
  expect(r.tokens[0]!.balance).toBeNull();
  expect(() => atomicAmount("0.0000001", 6)).toThrow();
  expect(atomicAmount("1.000001", 6)).toBe("1000001");
});
test("missing receipt remains pending and finality is not invented", () => {
  const operation = parseOperation(wire({ receipt_json: "null" }));
  expect(operationReceipt(operation)).toBeNull();
  const raw = {
    blockNumber: "0x1",
    blockHash: `0x${"11".repeat(32)}`,
    status: "0x1",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x2",
    logs: [],
  };
  expect(
    operationReceipt({
      ...operation,
      receiptJson: JSON.stringify(raw),
      finality: "included",
    }),
  ).toMatchObject({
    gasUsed: "21000",
    effectiveGasPriceWei: "2",
    finality: "included",
  });
});
test("live request account checking needs no browser storage", () => {
  const intent = { request, expectedAddress: `0x${"22".repeat(20)}` };
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Opaque origin", "SecurityError");
    },
  });
  try {
    expect(() =>
      assertLocalAccount(intent, intent.expectedAddress),
    ).not.toThrow();
    expect(() => assertLocalAccount(intent, `0x${"33".repeat(20)}`)).toThrow(
      "account changed",
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a stale network token never falls back to a native transfer", async () => {
  const { localTransferRequest } = await import("../src/local_intent.ts");
  const token = {
    chainId: "1",
    address: `0x${"33".repeat(20)}`,
    symbol: "USDC",
    decimals: 6,
  };
  expect(() =>
    localTransferRequest({
      requestId: request.requestId,
      chainId: "42161",
      token: token.address,
      assets: [token],
      to: request.to,
      amount: "2",
    }),
  ).toThrow("not on this network");
  const transfer = localTransferRequest({
    requestId: request.requestId,
    chainId: "1",
    token: token.address,
    assets: [token],
    to: request.to,
    amount: "2.000001",
  });
  expect(transfer.to).toBe(token.address);
  expect(transfer.valueWei).toBe("0");
  expect(transfer.data).toEndWith(2000001n.toString(16).padStart(64, "0"));
});
test("replacement review requires the exact resolved transaction and preserves backend warnings", async () => {
  const replacement = {
    requestId: request.requestId,
    accountId: "main" as const,
    chainId: "1",
    operationId: "7",
    cancel: true,
    maxFeePerGasWei: "2",
    maxPriorityFeePerGasWei: "1",
  };
  const replacementIntent = effectIntent("replacement", replacement);
  await expect(
    prepareEffect(
      "replacement",
      replacement,
      context(async () =>
        wire({ intent: replacementIntent, prepared_transaction: null }),
      ),
    ),
  ).rejects.toThrow("prepared transaction fields");
  const message = "Replacement is a same-nonce zero-value self transfer.";
  const operation = await prepareEffect(
    "replacement",
    replacement,
    context(async () =>
      wire({
        intent: replacementIntent,
        message,
        prepared_transaction: {
          ...wire().ok.prepared_transaction,
          to: wire().ok.address,
          value: "0",
        },
      }),
    ),
  );
  expect(operation.operation.preparedTransaction?.to).toBe(wire().ok.address);
  expect(operation.operation.preparedTransaction?.value).toBe("0");
  expect(operation.operation.message).toBe(message);
});

test("refreshing token observations uses the revised review without signing or changing the request", async () => {
  let finishRead!: () => void;
  const waitForRead = new Promise<void>((resolve) => { finishRead = resolve; });
  let executions = 0;
  const ctx = context(async (method, args) => {
    if (method === "evm_wallet_prepare_v1") return wire();
    if (method === "evm_wallet_review_evidence_v1") {
      expect(args).toEqual([{
        identity: { caller: { app_id: caller.appId, installation_uid: caller.installationUid, endpoint: caller.endpoint }, request_id: request.requestId },
        review_revision: "1",
        refresh: true,
      }]);
      await waitForRead;
      return { operation: wire({ review_revision: "2" }).ok, token_evidence: null };
    }
    if (method === "evm_wallet_execute_v1") {
      executions++;
      expect((args[0] as { review_revision: string }).review_revision).toBe("2");
      return wire({ status: "submitted", review_revision: "2", transaction_hash: `0x${"33".repeat(32)}` });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const completion = presentEffect("transaction", request, ctx);
  const prompt = await promptReady();
  const refreshing = refreshPromptEvidence(prompt);
  await acceptPrompt(prompt);
  expect(executions).toBe(0);
  expect(prompt.phase).toBe("checking");
  finishRead();
  await refreshing;
  expect(prompt.prepared.operation.reviewRevision).toBe("2");
  expect(prompt.prepared.request).toEqual(request);
  await acceptPrompt(prompt);
  expect(executions).toBe(1);
  expect((await completion).status).toBe("submitted");
});

test("failed token refresh keeps the saved review available and never executes an effect", async () => {
  let executions = 0;
  const ctx = context(async (method) => {
    if (method === "evm_wallet_prepare_v1") return wire();
    if (method === "evm_wallet_review_evidence_v1") throw new Error("Transport reply lost");
    if (method === "evm_wallet_reject_v1") return wire({ status: "rejected" });
    if (method === "evm_wallet_execute_v1") executions++;
    throw new Error(`Unexpected method ${method}`);
  });
  const completion = presentEffect("transaction", request, ctx);
  const prompt = await promptReady();
  await refreshPromptEvidence(prompt);
  expect(prompt.phase).toBe("review");
  expect(prompt.error).toContain("could not be refreshed");
  expect(prompt.prepared.operation.reviewRevision).toBe("1");
  expect(executions).toBe(0);
  await declinePrompt(prompt);
  expect((await completion).status).toBe("rejected");
});
