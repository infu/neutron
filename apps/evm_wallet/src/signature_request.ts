import { stringToHex } from "viem";
import {
  createEvmRequestId,
  parseEvmAccountsResult,
  parseEvmOperationResult,
  parseEvmOperationStatusResult,
  parseEvmSignMessageRequest,
  parseEvmSignTypedDataRequest,
  type EvmOperationResult,
  type EvmOperationStatusResult,
  type EvmSignMessageRequest,
  type EvmSignTypedDataRequest,
  type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import { address } from "./data.ts";

type SignatureWallet = Pick<
  EvmWalletClient,
  "accounts" | "operationStatus" | "signMessage" | "signTypedData"
>;
export type SignatureKind = "message" | "typed_data";
/** Live UI request only. Durable operation records belong to the Wallet backend. */
export type SignatureRequest =
  | { kind: "message"; request: EvmSignMessageRequest; expectedAddress: string }
  | {
      kind: "typed_data";
      request: EvmSignTypedDataRequest;
      expectedAddress: string;
    };

export function parseSignatureRequest(value: unknown): SignatureRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid signature request");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, "kind") ||
    !Object.hasOwn(record, "request") ||
    !Object.hasOwn(record, "expectedAddress")
  ) {
    throw new Error("Invalid signature request fields");
  }
  const expectedAddress = address(record.expectedAddress);
  if (record.kind === "message")
    return {
      kind: "message",
      request: parseEvmSignMessageRequest(record.request),
      expectedAddress,
    };
  if (record.kind === "typed_data")
    return {
      kind: "typed_data",
      request: parseEvmSignTypedDataRequest(record.request),
      expectedAddress,
    };
  throw new Error("Invalid signature kind");
}

export function createSignatureRequest(
  kind: SignatureKind,
  content: string,
  chainId: string,
  expectedAddress: string,
  requestId = createEvmRequestId(),
): SignatureRequest {
  return parseSignatureRequest({
    kind,
    expectedAddress,
    request: {
      accountId: "main",
      chainId,
      requestId,
      ...(kind === "message"
        ? { messageHex: stringToHex(content) }
        : { typedDataJson: content }),
    },
  });
}

export function assertSignatureAccount(
  intent: SignatureRequest,
  currentAddress: string,
): void {
  if (
    address(currentAddress).toLowerCase() !==
    intent.expectedAddress.toLowerCase()
  ) {
    throw new Error(
      "The wallet account changed. Reconcile this signature request with its original address before creating another signature.",
    );
  }
}

function checkedOperation(
  intent: SignatureRequest,
  value: unknown,
): EvmOperationResult {
  const result = parseEvmOperationResult(value, intent.request, intent.kind);
  assertSignatureAccount(intent, result.address);
  return result;
}

/** A status check cannot open the confirmation UI or request a signature. */
export async function checkSignatureRequest(
  wallet: SignatureWallet,
  value: SignatureRequest,
  currentAddress: string,
): Promise<EvmOperationStatusResult> {
  const intent = parseSignatureRequest(value);
  assertSignatureAccount(intent, currentAddress);
  const { accounts } = parseEvmAccountsResult(await wallet.accounts());
  const account = accounts.find(
    (entry) => entry.accountId === intent.request.accountId,
  );
  if (!account) throw new Error("The signing account is unavailable");
  assertSignatureAccount(intent, account.address);
  const { accountId, chainId, requestId } = intent.request;
  const result = parseEvmOperationStatusResult(
    await wallet.operationStatus({ accountId, chainId, requestId }),
    intent.request,
  );
  return result.status === "not_found"
    ? result
    : checkedOperation(intent, result);
}

/**
 * Called only by an explicit review action. The public provider durably prepares
 * the request before asking for approval in the Wallet UI. Pending signatures
 * are never replayed, and this live request keeps the same ID for retries.
 */
export async function reviewSignatureRequest(
  wallet: SignatureWallet,
  value: SignatureRequest,
  currentAddress: string,
): Promise<EvmOperationResult> {
  const intent = parseSignatureRequest(value);
  const status = await checkSignatureRequest(wallet, intent, currentAddress);
  if (status.status !== "not_found" && status.status !== "prepared")
    return status;
  const result =
    intent.kind === "message"
      ? await wallet.signMessage(intent.request)
      : await wallet.signTypedData(intent.request);
  return checkedOperation(intent, result);
}
