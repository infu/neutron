import {
  parseEvmSendTransactionRequest,
  type EvmSendTransactionRequest,
} from "neutron-tools/evm_wallet";
import { address, atomicAmount, hex, type Asset } from "./data.ts";
import { encodeFunctionData, erc20Abi } from "viem";
/** Live form context only. The authoritative intent is journaled by prepare before approval. */
export type LocalIntent = {
  request: EvmSendTransactionRequest;
  expectedAddress: string;
};
export function localTransferRequest(input: {
  requestId: string;
  chainId: string;
  token: string;
  assets: Asset[];
  to: string;
  amount: string;
  data?: string;
}): EvmSendTransactionRequest {
  const destination = address(input.to),
    asset = input.assets.find(
      (entry) =>
        entry.chainId === input.chainId && entry.address === input.token,
    );
  if (input.token !== "native" && !asset)
    throw new Error(
      "The selected token is not on this network. Select an asset on the current network before continuing.",
    );
  return parseEvmSendTransactionRequest({
    requestId: input.requestId,
    accountId: "main",
    chainId: input.chainId,
    to: asset ? asset.address : destination,
    valueWei: asset ? "0" : atomicAmount(input.amount),
    data: asset
      ? encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [
            destination as `0x${string}`,
            BigInt(atomicAmount(input.amount, asset.decimals)),
          ],
        })
      : hex(input.data ?? "0x"),
  });
}
export function assertLocalAccount(
  intent: LocalIntent,
  currentAddress: string,
): void {
  if (
    intent.expectedAddress.toLowerCase() !==
    address(currentAddress).toLowerCase()
  )
    throw new Error(
      "The wallet account changed. Reconcile the original request in Wallet activity before continuing.",
    );
}
