import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { amount, type Asset, type Operation } from "./data.ts";
import type { OperationPresentation } from "./presentation.ts";

// Universal Router 2.1.1 uses the V4 swap tuple with minHopPriceX36. Older
// deployments have a different tuple and must not be decoded with this ABI.
const ROUTERS: Record<string, string> = {
  "1": "0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca",
  "42161": "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
};
const ZERO = "0x0000000000000000000000000000000000000000";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const ACTIONS = parseAbiParameters("bytes actions, bytes[] params");
const SINGLE = parseAbiParameters("((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData) params");
const SETTLE = parseAbiParameters("address currency, uint256 amount");
const TAKE = parseAbiParameters("address currency, address recipient, uint256 amount");

/** Summarize only the complete supported transaction, using signed calldata. */
export function presentUniswapV4Swap(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const router = ROUTERS[operation.chainId];
  if (!tx || !router || tx.to.toLowerCase() !== router) return null;
  try {
    const call = decodeFunctionData({ abi: EXECUTE, data: tx.data as Hex });
    const [commands, inputs, deadline] = call.args;
    // No optional/reverting commands, opaque additional actions or hidden
    // Permit2 permissions are summarized as a swap.
    if (commands !== "0x10" && commands !== "0x1004") return null;
    if (inputs.length !== (commands === "0x10" ? 1 : 2)) return null;
    const [actions, params] = decodeAbiParameters(ACTIONS, inputs[0]!);
    if (actions !== "0x060c0e" || params.length !== 3) return null;
    const [swap] = decodeAbiParameters(SINGLE, params[0]!);
    const [settleCurrency, settleAmount] = decodeAbiParameters(SETTLE, params[1]!);
    const [takeCurrency, takeRecipient, takeAmount] = decodeAbiParameters(TAKE, params[2]!);
    const interpretedInputs: Hex[] = [encodeAbiParameters(ACTIONS, [actions, [
      encodeAbiParameters(SINGLE, [swap]),
      encodeAbiParameters(SETTLE, [settleCurrency, settleAmount]),
      encodeAbiParameters(TAKE, [takeCurrency, takeRecipient, takeAmount]),
    ]])];
    const pool = swap.poolKey;
    if (swap.amountIn === 0n || BigInt(pool.currency0) >= BigInt(pool.currency1)) return null;
    const tokenIn = swap.zeroForOne ? pool.currency0 : pool.currency1;
    const tokenOut = swap.zeroForOne ? pool.currency1 : pool.currency0;
    if (settleCurrency.toLowerCase() !== tokenIn.toLowerCase() || settleAmount !== swap.amountIn ||
        takeCurrency.toLowerCase() !== tokenOut.toLowerCase() || takeAmount !== 0n) return null;
    const inputNative = tokenIn.toLowerCase() === ZERO;
    const outputNative = tokenOut.toLowerCase() === ZERO;
    if (BigInt(tx.value) !== (inputNative ? swap.amountIn : 0n)) return null;
    const resolveRecipient = (value: string) => value.toLowerCase() === MSG_SENDER
      ? getAddress(operation.address)
      : value.toLowerCase() === ADDRESS_THIS ? getAddress(router) : getAddress(value);
    const recipient = resolveRecipient(takeRecipient);
    // Output retained in the router is not a completed delivery to a recipient.
    if (recipient.toLowerCase() === router) return null;
    let refundRecipient: string | undefined;
    if (inputNative) {
      if (commands !== "0x1004") return null;
      const [currency, recipient, minimum] = decodeAbiParameters(TAKE, inputs[1]!);
      refundRecipient = resolveRecipient(recipient);
      if (currency.toLowerCase() !== ZERO || minimum !== 0n || refundRecipient.toLowerCase() !== operation.address.toLowerCase()) return null;
      interpretedInputs.push(encodeAbiParameters(TAKE, [currency, recipient, minimum]));
    } else if (commands !== "0x10") return null;
    // A specialized summary covers every byte. Noncanonical or unconsumed ABI
    // data remains available through the generic contract-interaction review.
    if (encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [commands, interpretedInputs, deadline] }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const asset = (address: string) => assets.find(token => token.chainId === operation.chainId && token.address.toLowerCase() === address.toLowerCase());
    const input = asset(tokenIn), output = asset(tokenOut);
    const display = (value: bigint, token: Asset | undefined, native: boolean, address: string) => native
      ? `${amount(value.toString())} ETH`
      : token ? `${amount(value.toString(), token.decimals)} ${token.symbol}` : `${value} atomic units · ${getAddress(address)}`;
    return {
      title: "Swap tokens",
      amount: display(swap.amountIn, input, inputNative, tokenIn),
      amountLabel: "You pay",
      description: "Swap through Uniswap V4. The minimum received is enforced by this transaction.",
      parties: [
        { label: "Minimum received", value: display(swap.amountOutMinimum, output, outputNative, tokenOut) },
        { label: "Recipient", value: recipient },
        ...(pool.hooks.toLowerCase() === ZERO ? [] : [{ label: "Pool hook", value: getAddress(pool.hooks) }]),
      ],
      advancedDetails: [
        { label: "Protocol", value: "Uniswap V4 · Universal Router 2.1.1" },
        { label: "Pool currency 0", value: getAddress(pool.currency0) },
        { label: "Pool currency 1", value: getAddress(pool.currency1) },
        { label: "Pool fee (raw)", value: pool.fee.toString() },
        { label: "Tick spacing", value: pool.tickSpacing.toString() },
        { label: "Hook contract", value: getAddress(pool.hooks) },
        { label: "Hook data", value: swap.hookData },
        { label: "Minimum hop price × 10³⁶", value: swap.minHopPriceX36.toString() },
        { label: "Deadline (Unix seconds)", value: deadline.toString() },
        ...(refundRecipient ? [{ label: "Native refund recipient", value: refundRecipient }] : []),
      ],
      contract: tx.to,
      nativeValue: null,
      unlimitedApproval: false,
      tokenSymbol: inputNative ? "ETH" : input?.symbol ?? null,
      tokenAddress: inputNative ? null : getAddress(tokenIn),
      swap: {
        protocol: "v4",
        tokenIn: getAddress(tokenIn),
        tokenOut: getAddress(tokenOut),
        amountIn: swap.amountIn.toString(),
        amountOutMinimum: swap.amountOutMinimum.toString(),
        recipient,
        deadline: deadline.toString(),
        poolFee: pool.fee.toString(),
        inputNative,
        outputNative,
        poolKey: { currency0: getAddress(pool.currency0), currency1: getAddress(pool.currency1), fee: pool.fee.toString(), tickSpacing: pool.tickSpacing.toString(), hooks: getAddress(pool.hooks) },
        hookData: swap.hookData,
        minHopPriceX36: swap.minHopPriceX36.toString(),
        ...(refundRecipient ? { refundRecipient } : {}),
      },
    };
  } catch { return null; }
}
