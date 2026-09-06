import { callTool } from "neutron-tools/app";
import { createEvmWalletClient, EVM_WALLET_TARGET, EVM_WALLET_TOOLS, type EvmOperationResult, type EvmSendTransactionRequest } from "neutron-tools/evm_wallet";
import { encodeFunctionData, type Hex } from "viem";
import { EthereumReceiptRevertedError, type EthereumProvider, type EthereumTransaction } from "./ethereum.ts";

export type EvmBridgeClient = ReturnType<typeof createEvmWalletClient>;
const allowanceAbi = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const minterAbi = [{ type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;

/** Connect the foreground deposit flow once. Tracking can reconcile only saved
 * signed bytes; every fresh transaction keeps its separate Wallet review.
 */
export async function connectEvmBridgeReads(kernel: { callTool: typeof callTool } = { callTool }): Promise<void> {
  await kernel.callTool({
    target: "kernel", name: "permissions.request", arguments: {
      target: EVM_WALLET_TARGET,
      tools: [EVM_WALLET_TOOLS.accounts, EVM_WALLET_TOOLS.callContract, EVM_WALLET_TOOLS.readContract, EVM_WALLET_TOOLS.operationStatus, EVM_WALLET_TOOLS.transaction],
    },
  });
}

export async function connectEvmBridge(client: EvmBridgeClient, helper: string, token: string | null, expectedAddress?: string) {
  const accounts = await client.accounts();
  const account = accounts.accounts.find((entry) => entry.accountId === "main");
  if (!account) throw new Error("EVM Wallet has no available signing account");
  if (expectedAddress && account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("EVM Wallet's account changed. This saved deposit belongs to its original address and will not be replayed with another key.");
  const scope = { accountId: "main" as const, chainId: "1" };
  const assertAccount = async () => {
    const fresh = (await client.accounts()).accounts.find((entry) => entry.accountId === "main");
    if (!fresh || fresh.address.toLowerCase() !== account.address.toLowerCase() || fresh.keyFingerprint !== account.keyFingerprint) throw new Error("EVM Wallet's signing account changed during this deposit");
  };
  const provider: EthereumProvider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") { await assertAccount(); return [account.address]; }
      if (method === "eth_chainId") return "0x1";
      if (!Array.isArray(params)) throw new Error("Invalid EVM bridge read parameters");
      if (method === "eth_call") {
        const tx = params[0] as { to: string; data: string };
        return (await client.callContract({ ...scope, to: tx.to, data: tx.data })).result;
      }
      if (method === "eth_getCode") {
        const to = String(params[0]);
        if (to.toLowerCase() !== helper.toLowerCase() && to.toLowerCase() !== token?.toLowerCase()) throw new Error("Unexpected bridge contract");
        const data = to.toLowerCase() === helper.toLowerCase()
          ? encodeFunctionData({ abi: minterAbi, functionName: "getMinterAddress" })
          : encodeFunctionData({ abi: allowanceAbi, functionName: "allowance", args: [account.address as Hex, helper as Hex] });
        const result = await client.readContract({ ...scope, to, data });
        return result.code;
      }
      throw new Error(`Unsupported EVM bridge read: ${method}`);
    },
  };
  const request = (requestId: string, tx: EthereumTransaction): EvmSendTransactionRequest => ({
    ...scope, requestId, to: tx.to, valueWei: tx.value ? BigInt(tx.value).toString() : "0", data: tx.data,
  });
  const check = (result: EvmOperationResult, expectedHash?: Hex): Hex => {
    if (result.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("EVM operation address does not match the saved deposit");
    if (result.status === "reverted" || result.receipt?.status === "reverted") throw new EthereumReceiptRevertedError("The deposit transaction reverted on Ethereum", result.transactionHash as Hex | undefined);
    if (result.status === "rejected") throw Object.assign(new Error(result.message ?? "EVM Wallet declined the transaction"), { code: 4001 });
    if (!result.transactionHash) throw new Error(result.message ?? `EVM Wallet transaction is ${result.status}; its saved request must be reconciled`);
    if (expectedHash && result.transactionHash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error("EVM Wallet returned a different transaction hash for this saved bridge step");
    return result.transactionHash as Hex;
  };
  return {
    account,
    provider,
    evm: {
      async send(requestId: string, tx: EthereumTransaction, beforeFreshSend?: () => Promise<void>): Promise<Hex> {
        await assertAccount();
        // Status first avoids presenting another review after a lost UI reply.
        // The same request remains authoritative even when its reply was lost.
        const existing = await client.operationStatus({ ...scope, requestId });
        if (existing.status !== "not_found" && existing.status !== "prepared" && existing.status !== "preparing") return check(existing);
        await beforeFreshSend?.();
        await assertAccount();
        return check(await client.sendTransaction(request(requestId, tx)));
      },
      async confirm(requestId: string, hash: Hex, expected?: EthereumTransaction, onReplacement?: (hash: Hex, state: "submitted" | "confirmed" | "failed") => Promise<void>): Promise<void> {
        let recordedReplacement: string | null = null;
        const deadline = Date.now() + 300_000;
        do {
          const result = await client.operationStatus({ ...scope, requestId });
          if (result.status === "not_found") throw new Error("The saved EVM Wallet operation is unavailable; no replacement transaction was submitted");
          check(result, hash);
          if (result.replacementTransactionHash && !result.receipt) {
            // operationStatus is scoped by the actual Kernel caller: this hash
            // is the Wallet journal's replacement of this exact saved request.
            // Its real effect must still match; a cancellation cannot deposit.
            if (!expected || !onReplacement) throw new Error("Replacement recovery requires the saved bridge transaction and durable evidence journal");
            const replacement = result.replacementTransactionHash as Hex;
            const evidence = await client.transaction({ chainId: "1", transactionHash: replacement });
            if (!evidence.transaction) throw new Error("The replacement transaction is not yet visible on Ethereum; keep the saved deposit and reconcile again");
            assertBridgeTransactionMatches(expected, evidence.transaction);
            const state = evidence.receipt?.status === "success" ? "confirmed" : evidence.receipt?.status === "reverted" ? "failed" : "submitted";
            const marker = `${replacement}:${state}`;
            if (marker !== recordedReplacement) { await onReplacement(replacement, state); recordedReplacement = marker; }
            if (state === "failed") throw new EthereumReceiptRevertedError("The replacement deposit transaction reverted on Ethereum", replacement);
            if (state === "confirmed") return;
          } else if (result.receipt?.status === "success") return;
          await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
        } while (Date.now() < deadline);
        throw new Error("This saved EVM transaction is still pending. Resume to check the same operation.");
      },
    },
  };
}

/** Owner-supplied browser hash is accepted only after independent chain reads. */
export async function attachExternalBridgeTransaction(
  client: EvmBridgeClient,
  bridge: import("./bridge.ts").BridgeClient,
  intent: import("./bridge.ts").BridgeIntent,
  kind: import("./ethereum.ts").EthereumDepositStep,
  transactionHash: string,
): Promise<import("./bridge.ts").BridgeIntent> {
  if (intent.source !== "external") throw new Error("Only a saved external browser request can use manual transaction recovery");
  const { bridgeTransaction } = await import("./bridge.ts");
  const expected = bridgeTransaction(intent, kind);
  const evidence = await client.transaction({ chainId: "1", transactionHash });
  const actual = evidence.transaction;
  if (!actual) throw new Error("Ethereum has not returned this transaction yet. Keep the saved request and check again.");
  if (actual.from.toLowerCase() !== expected.from.toLowerCase() || actual.to?.toLowerCase() !== expected.to.toLowerCase() || actual.data.toLowerCase() !== expected.data.toLowerCase() || actual.valueWei !== BigInt(expected.value ?? "0x0").toString()) throw new Error("The transaction does not match this saved browser deposit step");
  const current = await bridge.status(intent.id);
  if (current.source !== "external") throw new Error("The saved deposit source changed");
  const state = evidence.receipt?.status === "success" ? "confirmed" : evidence.receipt?.status === "reverted" ? "failed" : "submitted";
  return bridge.record(current, kind, state, transactionHash as Hex, state === "failed" ? "The Ethereum transaction reverted" : null);
}

/** Exact signed effect, independently read from the selected chain. */
export function assertBridgeTransactionMatches(expected: EthereumTransaction, actual: NonNullable<import("neutron-tools/evm_wallet").EvmTransactionResult["transaction"]>): void {
  if (actual.from.toLowerCase() !== expected.from.toLowerCase() || actual.to?.toLowerCase() !== expected.to.toLowerCase() || actual.data.toLowerCase() !== expected.data.toLowerCase() || actual.valueWei !== BigInt(expected.value ?? "0x0").toString()) {
    throw new Error("The Ethereum transaction does not match this saved bridge step; a cancellation or changed replacement cannot complete it");
  }
}
