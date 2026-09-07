import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Abi, type Hex } from "viem";
import { amount, type Asset, type Operation } from "./data.ts";
import type { OperationPresentation, PresentationField } from "./presentation.ts";

// Official Curve Router deployments. Recognition is bound to both network and
// destination, independently of any title supplied by a requesting app.
const ROUTERS: Record<string, string> = {
  "1": "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e",
  "42161": "0x2191718cd32d02b8e60badffea33e4b5dd9a0a0d",
};
const ZERO = "0x" + "00".repeat(20), NATIVE = "0x" + "ee".repeat(20);
const ROUTER = parseAbi(["function exchange(address[11] route,uint256[5][5] params,uint256 amount,uint256 minimum,address[5] pools,address receiver) payable returns (uint256)"]);

export function presentCurve(operation: Operation, assets: readonly Asset[]): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  if (!tx || !ROUTERS[operation.chainId]) return null;
  const base: OperationPresentation = { title: "Pool interaction", amount: null, amountLabel: "Amount", description: "", parties: [], contract: tx.to, nativeValue: tx.value === "0" ? null : `${amount(tx.value)} ETH`, unlimitedApproval: false, tokenSymbol: null };
  if (tx.to.toLowerCase() === ROUTERS[operation.chainId]) {
    try {
      const decoded = decodeFunctionData({ abi: ROUTER, data: tx.data as Hex });
      if (encodeFunctionData({ abi: ROUTER, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
      const [route, params, inputAmount, minimum, pools, recipient] = decoded.args;
      let hops = 0;
      while (hops < 5 && route[2 * hops + 1]!.toLowerCase() !== ZERO) hops++;
      if (!hops || inputAmount === 0n || route[2 * hops]!.toLowerCase() === ZERO) return null;
      const tokenIn = route[0]!, tokenOut = route[2 * hops]!;
      const nativeIn = tokenIn.toLowerCase() === NATIVE;
      if (BigInt(tx.value) !== (nativeIn ? inputAmount : 0n)) return null;
      const show = (value: bigint, address: string) => {
        if (address.toLowerCase() === NATIVE) return `${amount(value.toString())} ETH`;
        const token = assets.find((asset) => asset.chainId === operation.chainId && asset.address.toLowerCase() === address.toLowerCase());
        return token ? `${amount(value.toString(), token.decimals)} ${token.symbol}` : `${value} atomic units · ${getAddress(address)}`;
      };
      const inputToken = assets.find((asset) => asset.chainId === operation.chainId && asset.address.toLowerCase() === tokenIn.toLowerCase());
      return { ...base, title: "Swap through Curve", amountLabel: "You pay", amount: show(inputAmount, tokenIn), nativeValue: null,
        description: "Exchange through Curve Router. The minimum received is enforced onchain. This transaction has no onchain expiry.",
        tokenSymbol: nativeIn ? "ETH" : inputToken?.symbol ?? null, tokenAddress: nativeIn ? null : tokenIn,
        parties: [{ label: "Minimum received", value: show(minimum, tokenOut) }, { label: "Recipient", value: getAddress(recipient) }],
        advancedDetails: [
          { label: "Input asset", value: tokenIn }, { label: "Output asset", value: tokenOut },
          { label: "Input (atomic units)", value: inputAmount.toString() }, { label: "Minimum output (atomic units)", value: minimum.toString() },
          { label: "Route", value: route.join(" → ") }, { label: "Route parameters", value: params.map((row) => row.join(", ")).join("; ") },
          { label: "Additional pools", value: pools.join(", ") }, { label: "Onchain expiry", value: "None" },
        ],
      };
    } catch { return null; }
  }
  // Pool deployments are permissionless. Decoding an interface never claims
  // factory membership, token metadata or safety from the caller's description.
  // All indexed atomic values and the exact contract remain visible to both
  // human and Agent review, with the full calldata retained by the wallet.
  for (const array of ["uint256[]", "uint256[2]", "uint256[3]"]) for (const tail of ["", ",address receiver", ",bool useEth,address receiver"]) {
    const signatures = [
      `function add_liquidity(${array} amounts,uint256 minimum${tail}) payable`,
      `function remove_liquidity(uint256 amount,${array} minima${tail})`,
      ...["int128", "uint256"].map((index) => `function remove_liquidity_one_coin(uint256 amount,${index} coin,uint256 minimum${tail})`),
    ];
    try {
      const abi = parseAbi(signatures as string[]) as Abi, decoded = decodeFunctionData({ abi, data: tx.data as Hex });
      if (encodeFunctionData({ abi, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) continue;
      const args = decoded.args as unknown[], deposit = decoded.functionName === "add_liquidity", one = decoded.functionName === "remove_liquidity_one_coin";
      const recipient = tail ? String(args.at(-1)) : operation.address;
      const fields: PresentationField[] = [];
      if (deposit) {
        (args[0] as bigint[]).forEach((value, index) => fields.push({ label: `Pool coin ${index} budget (atomic units)`, value: value.toString() }));
        fields.push({ label: "Minimum LP tokens (atomic units)", value: String(args[1]) });
      } else {
        fields.push({ label: "LP tokens to burn (atomic units)", value: String(args[0]) });
        if (one) fields.push({ label: "Receive pool coin index", value: String(args[1]) }, { label: "Minimum received (atomic units)", value: String(args[2]) });
        else (args[1] as bigint[]).forEach((value, index) => fields.push({ label: `Minimum pool coin ${index} (atomic units)`, value: value.toString() }));
      }
      if (tail.includes("bool")) fields.push({ label: "Use native ETH", value: args.at(-2) ? "Yes" : "No" });
      return { ...base, title: deposit ? "Add pool liquidity" : "Remove pool liquidity", amountLabel: deposit ? "Token budgets" : "LP tokens to burn",
        amount: deposit ? null : `${args[0]} atomic LP units`,
        description: `Call the pool's ${decoded.functionName} interface. Verify the pool contract and its indexed assets. Decoding this interface does not verify Curve factory membership.`,
        parties: [...fields, { label: "Recipient", value: getAddress(recipient) }],
        advancedDetails: [{ label: "Pool interface", value: decoded.functionName }, { label: "Onchain expiry", value: "None" }],
      };
    } catch { /* Other interfaces retain the ordinary contract review. */ }
  }
  return null;
}
