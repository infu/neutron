import type {
  JsonObject,
  MsgBusToolContext,
  SelfCallObject,
} from "neutron-tools/app";
import {
  parseEvmSendTransactionRequest,
  parseEvmSignMessageRequest,
  parseEvmSignTypedDataRequest,
  parseEvmOperationResult,
  requireEvmWalletCaller,
  parseEvmReplaceTransactionRequest,
  type EvmReplaceTransactionRequest,
  type EvmEffectKind,
  type EvmEffectRequest,
  type EvmReceipt,
} from "neutron-tools/evm_wallet";
import {
  METHODS,
  identityArgs,
  parseOperation,
  hex,
  decodeKnownCall,
  errorMessage,
  maxFee,
  type Operation,
} from "./data.ts";
import { prepareBrowserOperation, executeBrowserOperation, reconcileBrowserOperation, refreshBrowserEvidence } from "./browser_operations.ts";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentOperation } from "./presentation.ts";

export type ProviderKind = EvmEffectKind | "replacement";
export type ProviderRequest = EvmEffectRequest | EvmReplaceTransactionRequest;
export const PRESENT_TOOLS = {
  replacement: "evm_replacement_present_v1",
  transaction: "evm_transaction_present_v1",
  message: "evm_message_present_v1",
  typed_data: "evm_typed_data_present_v1",
} as const;
// Same-app calls intentionally have no Kernel provider presentation capability.
// These ordinary private tools return to the exact Wallet tile that requested
// review; the external provider tools retain their foreground attestation.
export const OWNER_REVIEW_TOOLS = {
  replacement: "evm_replacement_owner_review_v1",
  transaction: "evm_transaction_owner_review_v1",
  message: "evm_message_owner_review_v1",
  typed_data: "evm_typed_data_owner_review_v1",
} as const;
export type Prepared = {
  request: ProviderRequest;
  kind: ProviderKind;
  identity: SelfCallObject;
  operation: Operation;
};
export function parseEffect(
  kind: ProviderKind,
  args: unknown,
): ProviderRequest {
  return kind === "replacement"
    ? parseEvmReplaceTransactionRequest(args)
    : kind === "transaction"
      ? parseEvmSendTransactionRequest(args)
      : kind === "message"
        ? parseEvmSignMessageRequest(args)
        : parseEvmSignTypedDataRequest(args);
}
export function effectIntent(
  kind: ProviderKind,
  request: ProviderRequest,
): SelfCallObject {
  let operation: SelfCallObject;
  if (kind === "replacement") {
    const r = parseEvmReplaceTransactionRequest(request);
    operation = {
      replacement: {
        operation_id: r.operationId,
        cancel: r.cancel,
        max_fee_per_gas: r.maxFeePerGasWei,
        max_priority_fee_per_gas: r.maxPriorityFeePerGasWei,
      },
    };
  } else if (kind === "transaction") {
    const t = parseEvmSendTransactionRequest(request);
    operation = {
      transaction: {
        ...(t.transactionType === undefined
          ? {}
          : { transaction_type: t.transactionType }),
        to: t.to,
        value: t.valueWei,
        data: t.data,
        access_list: (t.accessList ?? []).map((x) => ({
          address: x.address,
          storageKeys: x.storageKeys,
        })),
        ...(t.gasLimit === undefined ? {} : { gas_limit: t.gasLimit }),
        ...(t.maxFeePerGasWei === undefined
          ? {}
          : { max_fee_per_gas: t.maxFeePerGasWei }),
        ...(t.maxPriorityFeePerGasWei === undefined
          ? {}
          : { max_priority_fee_per_gas: t.maxPriorityFeePerGasWei }),
        ...(t.gasPriceWei === undefined ? {} : { gas_price: t.gasPriceWei }),
      },
    };
  } else if (kind === "message")
    operation = {
      personal_message: {
        message: parseEvmSignMessageRequest(request).messageHex,
      },
    };
  else
    operation = {
      typed_data: { json: parseEvmSignTypedDataRequest(request).typedDataJson },
    };
  return {
    account_id: request.accountId,
    chain_id: request.chainId,
    operation,
  };
}
export function invocationIdentity(
  context: MsgBusToolContext,
  id: string,
  root = false,
): SelfCallObject {
  const caller = requireEvmWalletCaller(context, root);
  if (!context.caller?.endpoint)
    throw new Error("EVM Wallet requires an authenticated caller endpoint");
  return identityArgs({ ...caller, endpoint: context.caller.endpoint }, id);
}
export function assertOperationMatches(
  prepared: Prepared,
  operation: Operation,
): void {
  const { request, kind } = prepared;
  const caller = prepared.identity.caller as SelfCallObject;
  if (
    operation.requestId !== request.requestId ||
    operation.accountId !== request.accountId ||
    operation.chainId !== request.chainId ||
    operation.kind !== (kind === "replacement" ? "transaction" : kind) ||
    operation.caller.appId !== caller.app_id ||
    operation.caller.installationUid !== caller.installation_uid
  )
    throw new Error(
      "EVM Wallet returned an operation for another intent or caller",
    );
  if (
    operation.status === "prepared" &&
    (kind === "transaction" || kind === "replacement")
  ) {
    const tx = operation.preparedTransaction,
      review = operation.review;
    if (
      !tx ||
      !review ||
      tx.chainId !== request.chainId ||
      tx.nonce !== review.nonce ||
      tx.gasLimit !== review.gasLimit ||
      tx.maxFeePerGas !== review.maxFeePerGas ||
      tx.maxPriorityFeePerGas !== review.maxPriorityFeePerGas ||
      tx.gasPrice !== review.gasPrice
    ) {
      throw new Error(
        "EVM Wallet review is missing consistent exact prepared transaction fields",
      );
    }
    if (kind === "transaction") {
      const requested = parseEvmSendTransactionRequest(request);
      if (
        tx.to.toLowerCase() !== requested.to.toLowerCase() ||
        tx.value !== requested.valueWei ||
        tx.data.toLowerCase() !== requested.data.toLowerCase() ||
        JSON.stringify(tx.accessList).toLowerCase() !==
          JSON.stringify(requested.accessList ?? []).toLowerCase()
      ) {
        throw new Error(
          "EVM Wallet prepared transaction does not match the requested effect",
        );
      }
      if (
        (requested.transactionType !== undefined &&
          tx.transactionType !== requested.transactionType) ||
        (requested.gasLimit !== undefined &&
          tx.gasLimit !== requested.gasLimit) ||
        (requested.maxFeePerGasWei !== undefined &&
          tx.maxFeePerGas !== requested.maxFeePerGasWei) ||
        (requested.maxPriorityFeePerGasWei !== undefined &&
          tx.maxPriorityFeePerGas !== requested.maxPriorityFeePerGasWei) ||
        (requested.gasPriceWei !== undefined &&
          tx.gasPrice !== requested.gasPriceWei)
      ) {
        throw new Error(
          "EVM Wallet prepared fees or gas do not match the explicit request",
        );
      }
    } else {
      const replacement = parseEvmReplaceTransactionRequest(request);
      if (
        tx.maxFeePerGas !== replacement.maxFeePerGasWei ||
        tx.maxPriorityFeePerGas !== replacement.maxPriorityFeePerGasWei
      )
        throw new Error(
          "EVM Wallet prepared replacement fees do not match the request",
        );
    }
  }
  if (kind === "replacement") {
    const r = parseEvmReplaceTransactionRequest(request),
      a = operation.intent.replacement;
    if (
      !a ||
      a.operationId !== r.operationId ||
      a.cancel !== r.cancel ||
      a.maxFeePerGas !== r.maxFeePerGasWei ||
      a.maxPriorityFeePerGas !== r.maxPriorityFeePerGasWei
    )
      throw new Error("EVM replacement review does not match the request");
    if (operation.status === "prepared" && !operation.preparedTransaction)
      throw new Error(
        "EVM replacement review is missing exact resolved transaction fields",
      );
  } else if (kind === "transaction") {
    const t = parseEvmSendTransactionRequest(request),
      actual = operation.intent.transaction;
    if (
      !actual ||
      actual.to.toLowerCase() !== t.to.toLowerCase() ||
      actual.value !== t.valueWei ||
      actual.transactionType !== (t.transactionType ?? null) ||
      actual.gasLimit !== (t.gasLimit ?? null) ||
      actual.maxFeePerGas !== (t.maxFeePerGasWei ?? null) ||
      actual.maxPriorityFeePerGas !== (t.maxPriorityFeePerGasWei ?? null) ||
      actual.gasPrice !== (t.gasPriceWei ?? null) ||
      actual.data.toLowerCase() !== t.data.toLowerCase() ||
      JSON.stringify(actual.accessList).toLowerCase() !==
        JSON.stringify(t.accessList ?? []).toLowerCase()
    )
      throw new Error(
        "EVM Wallet transaction review does not match the requested fields",
      );
  } else if (kind === "message") {
    if (
      operation.intent.messageHex?.toLowerCase() !==
      parseEvmSignMessageRequest(request).messageHex.toLowerCase()
    )
      throw new Error("EVM Wallet message review does not match the request");
  } else if (
    operation.intent.typedDataJson !==
    parseEvmSignTypedDataRequest(request).typedDataJson
  )
    throw new Error(
      "EVM Wallet typed data review does not match the exact requested JSON",
    );
}
export async function prepareEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
  root = false,
): Promise<Prepared> {
  context.signal?.throwIfAborted();
  const request = parseEffect(kind, args),
    identity = invocationIdentity(context, request.requestId, root);
  const operation = await prepareBrowserOperation(context.kernel, identity, effectIntent(kind, request), { signal: context.signal });
  const prepared = { request, kind, identity, operation };
  assertOperationMatches(prepared, operation);
  context.signal?.throwIfAborted();
  return prepared;
}
export async function executeEffect(
  prepared: Prepared,
  context: MsgBusToolContext,
): Promise<Operation> {
  context.signal?.throwIfAborted();
  const operation = await executeBrowserOperation(context.kernel, prepared.operation, { signal: context.signal });
  assertOperationMatches(prepared, operation);
  return operation;
}
export async function rejectEffect(
  prepared: Prepared,
  context: MsgBusToolContext,
): Promise<Operation> {
  const operation = parseOperation(
    await context.kernel.updateSelf(
      METHODS.reject,
      [{ identity: prepared.identity }],
      60,
    ),
  );
  assertOperationMatches(prepared, operation);
  return operation;
}
export async function statusEffect(
  prepared: Prepared,
  context: MsgBusToolContext,
): Promise<Operation> {
  const operation = await reconcileBrowserOperation(context.kernel, prepared.operation, { signal: context.signal });
  assertOperationMatches(prepared, operation);
  return operation;
}
export async function refreshReviewEvidence(
  prepared: Prepared,
  context: MsgBusToolContext,
  refresh = true,
): Promise<Operation> {
  const operation = await refreshBrowserEvidence(context.kernel, prepared.operation, refresh, { signal: context.signal });
  assertOperationMatches(prepared, operation);
  return operation;
}
export async function handleHumanEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  const caller = requireEvmWalletCaller(context);
  if (caller.appId === "evm_wallet") {
    if (context.agentMode)
      throw new Error("EVM Wallet owner review is unavailable to Agent invocations");
    const endpoint = context.caller!.endpoint;
    if (
      context.caller!.role !== "tile" ||
      !/^app:evm_wallet:tile:evm_wallet:instance:[^:]+$/.test(endpoint)
    )
      throw new Error("EVM Wallet owner review requires an authenticated Wallet tile instance");
    return context.kernel.callTool<JsonObject>({
      target: endpoint as `app:evm_wallet:tile:evm_wallet:instance:${string}`,
      name: OWNER_REVIEW_TOOLS[kind],
      arguments: parseEffect(kind, args) as JsonObject,
    });
  }
  if (context.agentMode) return handleAgentProviderEffect(kind, args, context);
  if (typeof context.presentUserInterface !== "function")
    throw new Error("EVM Wallet requires Kernel provider presentation support");
  return context.presentUserInterface({
    tileId: "evm_wallet",
    tool: PRESENT_TOOLS[kind],
    arguments: parseEffect(kind, args) as JsonObject,
  });
}

/** The Agent sees the same exact candidate and observations as an owner review.
 * Calldata labels are explanatory only; the bytes remain part of the decision. */
export function agentProviderReview(
  prepared: Prepared,
  evidenceError: string | null = null,
): JsonObject {
  const operation = prepared.operation;
  assertOperationMatches(prepared, operation);
  const tx = operation.preparedTransaction;
  const decoded = tx ? decodeKnownCall(tx.data) : null;
  const summary = presentOperation(operation, mergeEvmAssets([]));
  return {
    provider: "EVM Wallet",
    kind: prepared.kind,
    summary: {
      title: summary.title,
      amount: summary.amount,
      amountLabel: summary.amountLabel,
      description: summary.description,
      parties: summary.parties,
      contract: summary.contract,
      nativeValue: summary.nativeValue,
      unlimitedApproval: summary.unlimitedApproval,
      tokenAddress: summary.tokenAddress ?? null,
      tokenSymbol: summary.tokenSymbol,
      swap: summary.swap ?? null,
      recognition: "Transaction labels are inferred from exact calldata and the Wallet token catalog; they do not verify contract behavior",
    },
    caller: { ...operation.caller },
    operationId: operation.operationId,
    requestId: operation.requestId,
    reviewRevision: operation.reviewRevision,
    accountId: operation.accountId,
    chainId: operation.chainId,
    signingAddress: operation.address,
    transaction: tx ? {
      transactionType: tx.transactionType,
      to: tx.to,
      valueWei: tx.value,
      data: tx.data,
      accessList: tx.accessList,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      maxFeePerGasWei: tx.maxFeePerGas,
      maxPriorityFeePerGasWei: tx.maxPriorityFeePerGas,
      gasPriceWei: tx.gasPrice,
    } : null,
    personalMessageHex: operation.intent.messageHex ?? null,
    typedDataJson: operation.intent.typedDataJson ?? null,
    replacement: operation.intent.replacement ?? null,
    observations: operation.review ? {
      nativeBalanceWei: operation.review.balance,
      maximumNetworkFeeWei: maxFee(operation.review),
      simulation: operation.review.simulation,
      observedAtNs: operation.review.observedAtNs,
    } : null,
    decodedTokenCall: decoded ? {
      name: decoded.name,
      details: decoded.details.map(([label, value]) => ({ label, value })),
      recognition: "Inferred from calldata; this does not verify contract behavior",
    } : null,
    tokenEvidence: operation.tokenEvidence,
    tokenEvidenceError: evidenceError,
    notice: operation.message,
  };
}

async function handleAgentProviderEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  // agentMode alone grants nothing. The Kernel callback is bound to this exact
  // provider invocation and obtains a fresh decision from the active root Agent.
  if (typeof context.requestApproval !== "function")
    throw new Error("EVM Wallet requires Kernel provider approval support for Agent requests");
  let prepared = await prepareEffect(kind, args, context);
  if (prepared.operation.status !== "prepared")
    return operationJson(prepared.operation);
  let evidenceError: string | null = null;
  if (prepared.operation.preparedTransaction && decodeKnownCall(prepared.operation.preparedTransaction.data)) {
    try {
      prepared = { ...prepared, operation: await refreshReviewEvidence(prepared, context, false) };
    } catch (error) {
      context.signal?.throwIfAborted();
      // The owner dialog also shows unavailable observations without replacing
      // the exact candidate. Let the Agent judge assess the same information.
      evidenceError = errorMessage(error);
    }
    if (prepared.operation.status !== "prepared")
      return operationJson(prepared.operation);
  }
  context.signal?.throwIfAborted();
  await context.requestApproval(agentProviderReview(prepared, evidenceError));
  context.signal?.throwIfAborted();
  // executeBrowserOperation binds execution to this review revision. If another
  // transaction changed its nonce, return the new unsigned review; a later call
  // must obtain its own fresh approval before executing it.
  return operationJson(await executeEffect(prepared, context));
}
export async function handleRootEffect(
  kind: ProviderKind,
  args: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const prepared = await prepareEffect(kind, args, context, true);
  const operation =
    prepared.operation.status === "prepared"
      ? await executeEffect(prepared, context)
      : prepared.operation;
  return operationJson(operation);
}
export function quantity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !(/^(0|[1-9][0-9]*)$/.test(value) || /^0x[0-9a-f]+$/i.test(value))
  )
    throw new Error(`Invalid receipt ${label}`);
  return BigInt(value).toString();
}
export function operationReceipt(operation: Operation): EvmReceipt | null {
  return receiptJson(
    operation.receiptJson,
    operation.finality,
    operation.updatedAtNs,
  );
}
export function receiptJson(
  value: string | null,
  finality: string | null,
  observedAtNs: string,
): EvmReceipt | null {
  if (value === null) return null;
  const r = JSON.parse(value);
  if (r === null) return null;
  if (!r || typeof r !== "object" || !Array.isArray(r.logs))
    throw new Error("Invalid stored transaction receipt");
  const status = quantity(r.status, "status");
  if (status !== "0" && status !== "1")
    throw new Error("Invalid receipt status");
  return {
    blockNumber: quantity(r.blockNumber, "block number"),
    blockHash: hex(r.blockHash),
    status: status === "1" ? "success" : "reverted",
    gasUsed: quantity(r.gasUsed, "gas used"),
    effectiveGasPriceWei: quantity(r.effectiveGasPrice, "gas price"),
    logs: r.logs.map((l: Record<string, unknown>) => ({
      address: String(l.address),
      data: hex(l.data),
      topics: (l.topics as unknown[]).map((x) => hex(x)),
      logIndex: quantity(l.logIndex, "log index"),
    })),
    finality:
      finality === "finalized"
        ? "finalized"
        : finality === "safe"
          ? "safe"
          : "included",
    observedAtNs,
  };
}
export function operationJson(operation: Operation): JsonObject {
  return parseEvmOperationResult({
    operationId: operation.operationId,
    requestId: operation.requestId,
    accountId: operation.accountId,
    chainId: operation.chainId,
    kind: operation.kind,
    status: operation.status,
    address: operation.address,
    transactionHash: operation.transactionHash,
    replacementTransactionHash: operation.replacementTransactionHash,
    signature: operation.signature,
    message: operation.message,
    reviewRevision: operation.reviewRevision,
    receipt: operationReceipt(operation),
  }) as unknown as JsonObject;
}
