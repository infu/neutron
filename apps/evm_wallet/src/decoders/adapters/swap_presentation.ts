import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { amount, type Asset, type Operation } from "../../data.ts";
import type { OperationPresentation } from "../../presentation.ts";

// Decode the supported Router02 transaction itself; an app-supplied title or
// claimed output must never stand in for the bytes the owner is signing.
const ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
// Router02 resolves these flags in V3SwapRouter.exactInputInternal.
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const WRAPPED: Record<string, string> = {
  "1": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "42161": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
};
const ABI = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);

function exactCall(data: Hex) {
  const call = decodeFunctionData({ abi: ABI, data });
  if (encodeFunctionData({ abi: ABI, ...call }).toLowerCase() !== data.toLowerCase()) throw new Error("Noncanonical router call");
  return call;
}

export function presentUniswapSwap(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const wrapped = WRAPPED[operation.chainId];
  if (!tx || !wrapped || tx.to.toLowerCase() !== ROUTER) return null;
  try {
    const outer = exactCall(tx.data as Hex);
    if (outer.functionName !== "multicall") return null;
    const calls = outer.args[1].map(exactCall);
    const first = calls[0];
    if (first?.functionName !== "exactInputSingle") return null;
    const swap = first.args[0];
    // Only the exact single-pool flow is summarized. Other router calls remain
    // available as ordinary contract interactions with their exact calldata.
    if (swap.amountIn === 0n || swap.sqrtPriceLimitX96 !== 0n) return null;
    let recipient = swap.recipient.toLowerCase() === MSG_SENDER ? getAddress(operation.address)
      : swap.recipient.toLowerCase() === ADDRESS_THIS ? getAddress(ROUTER) : swap.recipient;
    let outputNative = false;
    let cursor = 1;
    const unwrap = calls[cursor];
    if (unwrap?.functionName === "unwrapWETH9") {
      if (swap.tokenOut.toLowerCase() !== wrapped || recipient.toLowerCase() !== ROUTER || unwrap.args[0] !== swap.amountOutMinimum) return null;
      recipient = unwrap.args[1];
      outputNative = true;
      cursor++;
    } else if (recipient.toLowerCase() === ROUTER) return null;
    const inputNative = BigInt(tx.value) !== 0n;
    if (inputNative) {
      if (swap.tokenIn.toLowerCase() !== wrapped || BigInt(tx.value) !== swap.amountIn || calls[cursor]?.functionName !== "refundETH") return null;
      cursor++;
    }
    if (cursor !== calls.length) return null;
    const token = (address: string) => assets.find(asset => asset.chainId === operation.chainId && asset.address.toLowerCase() === address.toLowerCase());
    const input = token(swap.tokenIn), output = token(swap.tokenOut);
    const display = (value: bigint, asset: Asset | undefined, native: boolean, address: string) => native
      ? `${amount(value.toString())} ETH`
      : asset ? `${amount(value.toString(), asset.decimals)} ${asset.symbol}` : `${value} atomic units · ${getAddress(address)}`;
    return {
      title: "Swap tokens",
      amount: display(swap.amountIn, input, inputNative, swap.tokenIn),
      amountLabel: "You pay",
      description: "Swap through Uniswap. The minimum received is enforced by this transaction.",
      parties: [
        { label: "Minimum received", value: display(swap.amountOutMinimum, output, outputNative, swap.tokenOut) },
        { label: "Recipient", value: getAddress(recipient) },
      ],
      contract: tx.to,
      nativeValue: null,
      unlimitedApproval: false,
      tokenSymbol: inputNative ? "ETH" : input?.symbol ?? null,
      tokenAddress: inputNative ? null : swap.tokenIn,
      swap: {
        tokenIn: getAddress(swap.tokenIn),
        tokenOut: getAddress(swap.tokenOut),
        amountIn: swap.amountIn.toString(),
        amountOutMinimum: swap.amountOutMinimum.toString(),
        recipient: getAddress(recipient),
        deadline: outer.args[0].toString(),
        poolFee: swap.fee.toString(),
        inputNative,
        outputNative,
      },
    };
  } catch { return null; }
}
