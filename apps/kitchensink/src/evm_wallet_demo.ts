import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import {
  createEvmRequestId,
  parseEvmEffectRequest,
  parseEvmOperationResult,
  type EvmAccount,
  type EvmAccountsResult,
  type EvmEffectKind,
  type EvmEffectRequest,
  type EvmOperationResult,
  type EvmNetworksResult,
  type EvmSendTransactionRequest,
  type EvmWalletClient,
} from "neutron-tools/evm_wallet";
import {
  kitchenSinkPersonalMessageHex,
  kitchenSinkTypedData,
  verifyKitchenSinkPersonal,
  verifyKitchenSinkTyped,
} from "./evm_wallet_signatures.ts";

export const EVM_DEMO_KINDS = ["native", "token", "approval_call", "message", "typed_data"] as const;
export type EvmDemoKind = typeof EVM_DEMO_KINDS[number];
export type EvmDemoStep = { title: string; kind: EvmEffectKind; request: EvmEffectRequest };
export type EvmDemoIntent = {
  id: string;
  kind: EvmDemoKind;
  chainId: string;
  account: EvmAccount;
  createdAtNs: string;
  steps: EvmDemoStep[];
};
export type EvmDemoProgress = { attempted: boolean; operation: EvmOperationResult | null; error: string | null; signatureVerified: boolean };
export type EvmDemoRecord = { intent: EvmDemoIntent; revision: number; progress: EvmDemoProgress[] };
export type EvmDemoDraft = {
  kind: EvmDemoKind;
  chainId: string;
  account: EvmAccount;
  destination?: string;
  amountAtoms?: string;
  token?: string;
  calldata?: string;
};
export interface EvmDemoJournal {
  prepare(intent: EvmDemoIntent): Promise<EvmDemoRecord>;
  get(id: string): Promise<EvmDemoRecord>;
  list(): Promise<EvmDemoRecord[]>;
  attempting(record: EvmDemoRecord, step: number): Promise<EvmDemoRecord>;
  observed(record: EvmDemoRecord, step: number, operation: EvmOperationResult, signatureVerified: boolean): Promise<EvmDemoRecord>;
  failed(record: EvmDemoRecord, step: number, error: string): Promise<EvmDemoRecord>;
}

/** Each first-use read can need its own owner decision. Await it before
 * requesting the next tool so their consent presentations cannot overlap. */
export async function readEvmWalletSelection(
  wallet: Pick<EvmWalletClient, "accounts" | "networks">,
): Promise<{ accountResult: EvmAccountsResult; networkResult: EvmNetworksResult }> {
  const accountResult = await wallet.accounts();
  const networkResult = await wallet.networks();
  return { accountResult, networkResult };
}

/** Freeze every transaction in a sequence before the first wallet effect. */
export function createEvmDemoIntent(draft: EvmDemoDraft, requestId = createEvmRequestId): EvmDemoIntent {
  const scope = { accountId: draft.account.accountId, chainId: draft.chainId };
  const transaction = (title: string, to: string, valueWei: string, data: string): EvmDemoStep => ({
    title, kind: "transaction", request: parseEvmEffectRequest("transaction", { ...scope, requestId: requestId(), to: getAddress(to), valueWei, data }),
  });
  let steps: EvmDemoStep[];
  if (draft.kind === "message") {
    steps = [{ title: "Sign a harmless Kitchen Sink message", kind: "message", request: parseEvmEffectRequest("message", {
      ...scope, requestId: requestId(), messageHex: kitchenSinkPersonalMessageHex(),
    }) }];
  } else if (draft.kind === "typed_data") {
    steps = [{ title: "Sign harmless KitchenSinkMessage typed data", kind: "typed_data", request: parseEvmEffectRequest("typed_data", {
      ...scope, requestId: requestId(), typedDataJson: JSON.stringify(kitchenSinkTypedData(Number(draft.chainId))),
    }) }];
  } else {
    const destination = getAddress(draft.destination ?? "");
    const amount = draft.amountAtoms ?? "";
    if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("Enter a positive amount in atomic units; no decimal points.");
    if (draft.kind === "native") steps = [transaction("Transfer native currency", destination, amount, "0x")];
    else {
      const token = getAddress(draft.token ?? "");
      if (draft.kind === "token") {
        steps = [transaction("Transfer ERC20 tokens", token, "0", encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [destination, BigInt(amount)] }))];
      } else {
        const data = draft.calldata ?? "";
        if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) throw new Error("Enter ABI-encoded contract calldata including its four-byte function selector.");
        steps = [
          transaction("Approve the exact ERC20 amount", token, "0", encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [destination, BigInt(amount)] })),
          transaction("Call the approved contract", destination, "0", data),
        ];
      }
    }
  }
  return { id: steps[0]!.request.requestId, kind: draft.kind, chainId: draft.chainId, account: draft.account, createdAtNs: (BigInt(Date.now()) * 1_000_000n).toString(), steps };
}

export function evmDemoStepSucceeded(progress: EvmDemoProgress): boolean {
  const op = progress.operation;
  if (!op) return false;
  return op.kind === "transaction"
    ? op.status === "confirmed" && op.receipt?.status === "success"
    : op.status === "signed" && progress.signatureVerified;
}

export function evmDemoRecordTerminal(record: EvmDemoRecord): boolean {
  return record.progress.every(evmDemoStepSucceeded) || record.progress.some(({ operation }) =>
    operation && ["reverted", "rejected", "failed", "replaced"].includes(operation.status));
}

export function assertEvmDemoOperation(intent: EvmDemoIntent, step: number, value: unknown): EvmOperationResult {
  const operation = parseEvmOperationResult(value);
  const expected = intent.steps[step];
  if (!expected || operation.requestId !== expected.request.requestId || operation.chainId !== intent.chainId ||
      operation.accountId !== intent.account.accountId || operation.kind !== expected.kind ||
      operation.address.toLowerCase() !== intent.account.address.toLowerCase()) {
    throw new Error("EVM Wallet result does not match the saved request, chain, kind, and account.");
  }
  return operation;
}

/** One explicit click advances at most one step; reads never imply authority. */
export async function advanceEvmWalletDemo(
  wallet: Pick<EvmWalletClient, "accounts" | "networks" | "operationStatus" | "sendTransaction" | "signMessage" | "signTypedData">,
  journal: EvmDemoJournal,
  id: string,
): Promise<EvmDemoRecord> {
  let record = await journal.get(id);
  if (evmDemoRecordTerminal(record)) return record;
  const index = record.progress.findIndex((progress) => !evmDemoStepSucceeded(progress));
  const step = record.intent.steps[index]!;
  try {
    const { accountResult: accounts, networkResult: networks } = await readEvmWalletSelection(wallet);
    const account = accounts.accounts.find((entry) => entry.accountId === record.intent.account.accountId);
    if (!account || account.address.toLowerCase() !== record.intent.account.address.toLowerCase() ||
        account.keyFingerprint.toLowerCase() !== record.intent.account.keyFingerprint.toLowerCase()) {
      throw new Error("EVM Wallet account changed since this intent was saved. The original request is retained; no replacement transfer was sent.");
    }
    if (!networks.networks.some((network) => network.chainId === record.intent.chainId)) {
      throw new Error(`EVM Wallet does not support saved chain ${record.intent.chainId}.`);
    }
    // A previously included approval can be reorganized out before the next
    // click. Refresh prerequisite receipts before asking for the later effect.
    for (let previous = 0; previous < index; previous++) {
      const prerequisite = record.intent.steps[previous]!;
      const latest = await wallet.operationStatus({ accountId: prerequisite.request.accountId, chainId: prerequisite.request.chainId, requestId: prerequisite.request.requestId });
      if (latest.status === "not_found") throw new Error("The wallet no longer has the completed prerequisite operation. The next step was not submitted.");
      const operation = assertEvmDemoOperation(record.intent, previous, latest);
      record = await journal.observed(record, previous, operation, record.progress[previous]!.signatureVerified);
      if (!evmDemoStepSucceeded(record.progress[previous]!)) return record;
    }
    const status = await wallet.operationStatus({ accountId: step.request.accountId, chainId: step.request.chainId, requestId: step.request.requestId });
    let result: EvmOperationResult;
    if (status.status === "not_found") {
      if (record.progress[index]!.operation !== null) throw new Error("The wallet no longer has a previously observed operation. Keep this record for reconciliation; a new effect was not submitted.");
      record = await journal.attempting(record, index);
      result = await requestEffect(wallet, step);
    } else {
      result = assertEvmDemoOperation(record.intent, index, status);
      // A prepared request can reopen its original wallet-owned decision.
      // Signing/submission/unknown outcomes are reconciled by status only.
      if (result.status === "prepared" || result.status === "preparing") {
        record = await journal.observed(record, index, result, false);
        record = await journal.attempting(record, index);
        result = await requestEffect(wallet, step);
      }
    }
    result = assertEvmDemoOperation(record.intent, index, result);
    // Preserve returned signature/transaction evidence even if independent
    // verification fails. The wallet may already have released a signature.
    record = await journal.observed(record, index, result, false);
    let verified = false;
    if (result.kind !== "transaction" && result.status === "signed") {
      if (!result.signature) throw new Error("EVM Wallet marked the message signed without returning its signature.");
      verified = result.kind === "message"
        ? await verifyKitchenSinkPersonal(record.intent.account.address, result.signature)
        : await verifyKitchenSinkTyped(Number(record.intent.chainId), record.intent.account.address, result.signature);
      if (!verified) throw new Error("Returned signature does not verify against the saved Kitchen Sink message and account.");
    }
    return verified ? await journal.observed(record, index, result, true) : record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await journal.failed(record, index, message);
    throw error;
  }
}

function requestEffect(wallet: Pick<EvmWalletClient, "sendTransaction" | "signMessage" | "signTypedData">, step: EvmDemoStep): Promise<EvmOperationResult> {
  if (step.kind === "transaction") return wallet.sendTransaction(step.request as EvmSendTransactionRequest);
  if (step.kind === "message") return wallet.signMessage(parseEvmEffectRequest("message", step.request) as Parameters<EvmWalletClient["signMessage"]>[0]);
  return wallet.signTypedData(parseEvmEffectRequest("typed_data", step.request) as Parameters<EvmWalletClient["signTypedData"]>[0]);
}
