import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseSignature, type Address, type Hex } from "viem";

/** Circle's mainnet CCTP v2 deployments, verified against its deployment reference.
 * https://developers.circle.com/cctp/references/contract-addresses
 * https://developers.circle.com/cctp/references/hypercore-contract-addresses */
export const CCTP = {
  tokenMessenger: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
  messageTransmitter: "0x81d40f21f12a8f0e3252bccb954d722d4c464b64",
  forwarder: "0xb21d281dedb17ae5b501f6aa8256fe38c4e45757",
  coreDepositWallet: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
  hyperEvmUsdc: "0xb88339cb7199b77e23db6e890353e22632ba630f",
  coreUserExists: "0x0000000000000000000000000000000000000810",
  hyperEvmDomain: 19,
  hyperEvmRpc: "https://rpc.hyperliquid.xyz/evm",
  circleApi: "https://iris-api.circle.com",
  hyperliquidApi: "https://api.hyperliquid.xyz",
} as const;
export const FUNDING_CHAINS = {
  "1": { name: "Ethereum", domain: 0, usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io/tx/" },
  "42161": { name: "Arbitrum", domain: 3, usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io/tx/" },
} as const;
export type FundingChainId = keyof typeof FUNDING_CHAINS;
export type FundingInput = { environment: "mainnet"; direction: "deposit" | "withdraw"; chainId: FundingChainId; amount: string; speed?: "fast" | "standard"; sourceBalance?: "perps" | "unified" };
export type NormalizedFundingInput = Omit<Required<FundingInput>, "sourceBalance"> & Pick<FundingInput, "sourceBalance">;
export const TOKEN_MESSENGER_ABI = parseAbi(["function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)"]);
export const CCTP_RECOVERY_ABI = parseAbi([
  "function mintAndForward(bytes message,bytes attestation)",
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);
export const USDC_ABI = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function allowance(address owner,address spender) view returns (uint256)"]);
export const CORE_DEPOSIT_ABI = parseAbi([
  "function calculateCrossChainWithdrawalFee(bool shouldForward,uint32 destinationChainId) view returns (uint256)",
  "function cctpMaxFee() view returns (uint256)",
  "function newCoreAccountFee() view returns (uint64)",
  "function enabledDestinationDexes(uint32 dex) view returns (bool)",
  "function isDexForwardingDisabled() view returns (bool)",
]);

export function usdcAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw new Error("USDC amount must be a decimal string with at most 6 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n) throw new Error("USDC amount must be positive.");
  // This is the deployed CoreDepositWallet's uint64 Core-unit conversion,
  // not an application spending limit.
  if (amount > ((1n << 64n) - 1n) / 100n) throw new Error("Amount exceeds HyperCore's supported token amount representation.");
  return amount;
}
export function formatUsdc(amount: bigint): string {
  if (amount < 0n) return `-${formatUsdc(-amount)}`;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function parseFundingInput(value: unknown): NormalizedFundingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A funding input is required.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["environment", "direction", "chainId", "amount", "speed", "sourceBalance"].includes(k))) throw new Error("Unknown funding parameter.");
  if (v.environment !== "mainnet") throw new Error("CCTP funding currently connects mainnet Ethereum or Arbitrum to mainnet Hyperliquid.");
  if (v.direction !== "deposit" && v.direction !== "withdraw") throw new Error("Choose deposit or withdraw.");
  if (v.chainId !== "1" && v.chainId !== "42161") throw new Error("Choose Ethereum (1) or Arbitrum (42161) native USDC.");
  if (v.speed !== undefined && v.speed !== "fast" && v.speed !== "standard") throw new Error("Choose fast or standard CCTP finality.");
  if (v.direction === "withdraw" && v.speed === "standard") throw new Error("HyperCore controls withdrawal finality; choose fast for a forwarded withdrawal.");
  if (v.sourceBalance !== undefined && v.sourceBalance !== "perps" && v.sourceBalance !== "unified") throw new Error("Choose the perps or unified USDC withdrawal balance.");
  if (v.direction === "deposit" && v.sourceBalance !== undefined) throw new Error("A deposit always credits the default perps account; sourceBalance applies to withdrawals.");
  return { environment: "mainnet", direction: v.direction, chainId: v.chainId, amount: formatUsdc(usdcAtoms(v.amount)), speed: v.speed ?? "fast", ...(v.sourceBalance === undefined ? {} : { sourceBalance: v.sourceBalance }) };
}
export function addressWord(address: string): Hex { return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`; }
export function forwardHook(recipient: string): Hex {
  // bytes24("cctp-forward"), uint32(0), uint32(24), address, uint32(0).
  // The recipient and default-perps DEX are in the authenticated CCTP message.
  return `0x636374702d666f7277617264${"0".repeat(24)}0000000000000018${getAddress(recipient).slice(2).toLowerCase()}00000000`;
}
export function depositCalldata(input: FundingInput, recipient: string, maxFeeAtoms: string): Hex {
  const v = parseFundingInput(input), amount = usdcAtoms(v.amount), fee = unsignedAtoms(maxFeeAtoms);
  if (v.direction !== "deposit" || fee >= amount) throw new Error("Deposit amount must exceed the maximum CCTP fee.");
  return encodeFunctionData({ abi: TOKEN_MESSENGER_ABI, functionName: "depositForBurnWithHook", args: [amount, CCTP.hyperEvmDomain, addressWord(CCTP.forwarder), FUNDING_CHAINS[v.chainId].usdc, addressWord(CCTP.forwarder), fee, v.speed === "fast" ? 1000 : 2000, forwardHook(recipient)] });
}
export function unsignedAtoms(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Expected an unsigned atomic amount.");
  return BigInt(value);
}
function decimalFraction(value: unknown): [bigint, bigint] {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(text)) throw new Error("Circle returned an invalid protocol fee.");
  const [a, b = ""] = text.split(".");
  return [BigInt(a! + b), 10n ** BigInt(b.length)];
}
export function depositFees(raw: unknown, amount: bigint, speed: "fast" | "standard") {
  if (!Array.isArray(raw)) throw new Error("Circle returned an invalid fee response.");
  const finality = speed === "fast" ? 1000 : 2000;
  const entry = raw.find(row => row && typeof row === "object" && row.finalityThreshold === finality);
  if (!entry?.forwardFee) throw new Error("Circle does not currently quote forwarding for this route.");
  const [numerator, denominator] = decimalFraction(entry.minimumFee);
  const divisor = 10_000n * denominator;
  const protocolFee = (amount * numerator + divisor - 1n) / divisor;
  const atomic = (value: unknown) => {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Circle returned an invalid forwarding fee.");
    return unsignedAtoms(String(value));
  };
  // The live endpoint and Circle's how-to use `med`; its API schema also
  // documents `medium`. Both identify the same recommended forwarding tier.
  const medium = atomic(entry.forwardFee.med ?? entry.forwardFee.medium), high = atomic(entry.forwardFee.high), low = atomic(entry.forwardFee.low);
  if (high < medium || medium < low) throw new Error("Circle forwarding fee tiers are inconsistent.");
  return { protocolFeeAtoms: protocolFee.toString(), forwardingFeeAtoms: medium.toString(), estimatedFeeAtoms: (protocolFee + medium).toString(), maxFeeAtoms: (protocolFee + high).toString(), finalityThreshold: finality };
}
export type WithdrawalAction = {
  type: "sendToEvmWithData"; hyperliquidChain: "Mainnet"; signatureChainId: "0xa4b1";
  token: "USDC"; amount: string; sourceDex: "" | "spot"; destinationRecipient: string;
  addressEncoding: "hex"; destinationChainId: number; gasLimit: number; data: "0x"; nonce: number;
};
export function withdrawalAction(input: FundingInput, recipient: string, sourceDex: "" | "spot", nonce: number): WithdrawalAction {
  const v = parseFundingInput(input);
  if (v.direction !== "withdraw" || !Number.isSafeInteger(nonce) || nonce <= 0) throw new Error("Invalid withdrawal action identity.");
  return { type: "sendToEvmWithData", hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", token: "USDC", amount: v.amount, sourceDex, destinationRecipient: getAddress(recipient).toLowerCase(), addressEncoding: "hex", destinationChainId: FUNDING_CHAINS[v.chainId].domain, gasLimit: 200_000, data: "0x", nonce };
}
export function withdrawalTypedData(action: WithdrawalAction): string {
  // Stable field order survives the journal's canonical JSON serialization;
  // the exact Wallet request string must be identical after a reload.
  const message = { hyperliquidChain: action.hyperliquidChain, token: action.token, amount: action.amount, sourceDex: action.sourceDex, destinationRecipient: action.destinationRecipient, addressEncoding: action.addressEncoding, destinationChainId: action.destinationChainId, gasLimit: action.gasLimit, data: action.data, nonce: action.nonce };
  return JSON.stringify({ domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" }, primaryType: "HyperliquidTransaction:SendToEvmWithData", types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    "HyperliquidTransaction:SendToEvmWithData": [{ name: "hyperliquidChain", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "sourceDex", type: "string" }, { name: "destinationRecipient", type: "string" }, { name: "addressEncoding", type: "string" }, { name: "destinationChainId", type: "uint32" }, { name: "gasLimit", type: "uint64" }, { name: "data", type: "bytes" }, { name: "nonce", type: "uint64" }],
  }, message });
}
export function withdrawalEnvelope(action: WithdrawalAction, signatureHex: string) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) throw new Error("Wallet returned an invalid withdrawal signature.");
  const signature = parseSignature(signatureHex as Hex);
  return { action, nonce: action.nonce, signature: { r: signature.r, s: signature.s, v: Number(signature.v ?? (signature.yParity + 27)) } };
}
export function coreUserExistsCalldata(address: string): Hex { return encodeAbiParameters([{ type: "address" }], [getAddress(address) as Address]); }
