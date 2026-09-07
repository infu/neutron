import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { amount, atomicAmount, type Operation } from "../../data.ts";
import type { OperationPresentation, PresentationField } from "../../presentation.ts";

// Reviewed 2026-09-07 against the official signing implementation and Circle:
// https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/utils/signing.py
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
// https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm
// https://developers.circle.com/cctp/howtos/transfer-usdc-from-ethereum-to-hypercore
// https://developers.circle.com/cctp/references/contract-addresses
// https://developers.circle.com/cctp/references/hypercore-contract-addresses
// These are presentation matches, not additional signing restrictions.
const ZERO = "0x0000000000000000000000000000000000000000";
const MESSENGER = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d";
const SOURCES: Record<string, { name: string; usdc: string }> = {
  "1": { name: "Ethereum mainnet", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  "42161": { name: "Arbitrum mainnet", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
};
const FORWARDER = "0xb21d281dedb17ae5b501f6aa8256fe38c4e45757";
const FORWARDER_BYTES32 = `0x${"0".repeat(24)}${FORWARDER.slice(2)}`;
const HOOK_HEADER = "636374702d666f7277617264".padEnd(48, "0") + "0000000000000018";
const DEPOSIT_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)",
]);
type Struct = readonly (readonly [string, string])[];
const DOMAIN: Struct = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"]];
const APPROVE: Struct = [["hyperliquidChain", "string"], ["agentAddress", "address"], ["agentName", "string"], ["nonce", "uint64"]];
const WITHDRAW: Struct = [
  ["hyperliquidChain", "string"], ["token", "string"], ["amount", "string"], ["sourceDex", "string"],
  ["destinationRecipient", "string"], ["addressEncoding", "string"], ["destinationChainId", "uint32"],
  ["gasLimit", "uint64"], ["data", "bytes"], ["nonce", "uint64"],
];
const field = (label: string, value: string | bigint | number): PresentationField => ({ label, value: String(value) });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
function uint(value: unknown, bits: number): bigint | null {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value))) return null;
  const result = BigInt(value);
  return result < 2n ** BigInt(bits) ? result : null;
}
function schema(value: unknown, expected: Struct): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => {
    const member = record(entry);
    return member !== null && keys(member, ["name", "type"]) && member.name === expected[index]![0] && member.type === expected[index]![1];
  });
}
const base = (): OperationPresentation => ({ title: "", amount: null, amountLabel: "Amount", description: "", parties: [], contract: null, nativeValue: null, unlimitedApproval: false, tokenSymbol: null });

/** Interpret only the exact master-action domain and signed field definitions.
 * The message contains signed fields only, matching Wallet's EIP-712 parser. */
export function presentHyperliquidAuthorization(operation: Operation): OperationPresentation | null {
  if (operation.kind !== "typed_data" || !operation.intent.typedDataJson || operation.chainId !== "42161") return null;
  try {
    const parsed = record(JSON.parse(operation.intent.typedDataJson));
    const domain = record(parsed?.domain), types = record(parsed?.types), message = record(parsed?.message);
    if (!parsed || !domain || !types || !message || !keys(parsed, ["domain", "types", "primaryType", "message"]) ||
      !keys(domain, DOMAIN.map(([name]) => name)) || domain.name !== "HyperliquidSignTransaction" || domain.version !== "1" ||
      uint(domain.chainId, 256) !== 42161n || domain.verifyingContract !== ZERO || !schema(types.EIP712Domain, DOMAIN)) return null;
    const approval = parsed.primaryType === "HyperliquidTransaction:ApproveAgent";
    if (!approval && parsed.primaryType !== "HyperliquidTransaction:SendToEvmWithData") return null;
    const primaryType = parsed.primaryType as string, expected = approval ? APPROVE : WITHDRAW;
    if (!keys(types, ["EIP712Domain", primaryType]) || !schema(types[primaryType], expected)) return null;
    const messageFields = expected.map(([name]) => name);
    const nonce = uint(message.nonce, 64);
    if (!keys(message, messageFields) || nonce === null || !["Mainnet", "Testnet"].includes(String(message.hyperliquidChain)) || !address(operation.address)) return null;
    const environment = `Hyperliquid ${message.hyperliquidChain}`;
    const advanced = [field("Signing domain", "HyperliquidSignTransaction v1"), field("Signature type", primaryType), field("Signing chain", "Arbitrum (42161)"), field("Nonce (milliseconds)", nonce)];
    if (approval) {
      if (!address(message.agentAddress) || typeof message.agentName !== "string") return null;
      const revoke = message.agentAddress === ZERO;
      return { ...base(), title: revoke ? "Revoke Hyperliquid trading key" : "Authorize Hyperliquid trading key",
        description: revoke
          ? "Replace the registered key for this name with the zero address, removing the previous key's authorization when Hyperliquid accepts the action. Existing orders and positions remain open."
          : "Allow this API key to trade and manage positions for your Hyperliquid account. It cannot withdraw to an external address, but its trading can lose your collateral. Registering the same name replaces the previous key for that name.",
        parties: [field("Account", getAddress(operation.address)), field("Trading key", getAddress(message.agentAddress)), field("Key name", message.agentName || "Unnamed"), field("Network", environment)],
        advancedDetails: advanced,
      };
    }
    const destination = uint(message.destinationChainId, 32);
    if (message.token !== "USDC" || typeof message.amount !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(message.amount) ||
      typeof message.sourceDex !== "string" || !["", "spot"].includes(message.sourceDex) || !address(message.destinationRecipient) || message.addressEncoding !== "hex" ||
      (destination !== 0n && destination !== 3n) || uint(message.gasLimit, 64) === null || message.data !== "0x") return null;
    const atoms = atomicAmount(message.amount, 6);
    const destinationName = destination === 0n ? "Ethereum" : "Arbitrum";
    return { ...base(), title: `Withdraw Hyperliquid USDC to ${destinationName}`, amount: `${message.amount} USDC`, amountLabel: "Withdrawal requested", amountAtoms: atoms, amountDecimals: 6, tokenSymbol: "USDC",
      description: `Authorize a CCTP withdrawal to the ${destinationName} recipient. The amount received is reduced by protocol and forwarding fees. Signing authorizes the transfer; destination receipt still needs confirmation.`,
      parties: [field("From account", getAddress(operation.address)), field("Source balance", message.sourceDex === "" ? "Perpetuals" : "Spot / unified collateral"), field("Recipient", getAddress(message.destinationRecipient)), field("From network", environment), field("Destination network", `${destinationName} ${message.hyperliquidChain === "Mainnet" ? "mainnet" : "testnet (Sepolia)"}`)],
      advancedDetails: [...advanced, field("CCTP destination domain", `${destination} (${destinationName})`), field("Destination gas limit", uint(message.gasLimit, 64)!), field("Forwarding data", "0x (automatic forwarding)"), field("Withdrawal amount (USDC atomic units)", atoms)],
    };
  } catch { return null; }
}

/** The beneficiary is in the forwarding hook; the mint recipient alone is the
 * intermediary contract and cannot describe who receives HyperCore collateral. */
export function presentHyperliquidDeposit(operation: Operation): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const source = SOURCES[operation.chainId];
  if (!tx || !source || tx.to.toLowerCase() !== MESSENGER || tx.value !== "0") return null;
  try {
    const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data: tx.data as Hex });
    if (encodeFunctionData({ abi: DEPOSIT_ABI, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [atomic, destination, mintRecipient, burnToken, destinationCaller, maxFee, finality, hookData] = decoded.args;
    const hook = hookData.toLowerCase();
    if (destination !== 19 || mintRecipient.toLowerCase() !== FORWARDER_BYTES32 || destinationCaller.toLowerCase() !== FORWARDER_BYTES32 ||
      burnToken.toLowerCase() !== source.usdc || ![1000, 2000].includes(finality) || hook.length !== 114 || hook.slice(2, 66) !== HOOK_HEADER ||
      hook.slice(106) !== "00000000") return null;
    const beneficiary = getAddress(`0x${hook.slice(66, 106)}`);
    return { ...base(), title: "Deposit USDC to Hyperliquid", amount: `${amount(atomic.toString(), 6)} USDC`, amountLabel: "USDC to bridge", amountAtoms: atomic.toString(), amountDecimals: 6, tokenSymbol: "USDC", tokenAddress: source.usdc, contract: tx.to,
      description: `Burn ${source.name} USDC for CCTP forwarding into the beneficiary's Hyperliquid perpetuals balance. Protocol and forwarding fees reduce the credited amount. A source transaction receipt confirms the burn; HyperCore credit must also be confirmed.`,
      parties: [field("Paid by", getAddress(operation.address)), field("HyperCore beneficiary", beneficiary), field("Source network", source.name), field("Destination balance", "Hyperliquid mainnet perpetuals"), field("Maximum CCTP fee", `${amount(maxFee.toString(), 6)} USDC`)],
      advancedDetails: [field("Function", "depositForBurnWithHook"), field("Token", getAddress(source.usdc)), field("CCTP destination domain", "19 (HyperEVM)"), field("Mint recipient", getAddress(FORWARDER)), field("Destination caller", getAddress(FORWARDER)), field("Minimum finality", finality === 1000 ? "Fast (1000)" : "Standard (2000)"), field("Amount (USDC atomic units)", atomic), field("Maximum fee (USDC atomic units)", maxFee), field("Hook data", hookData), field("HyperCore destination DEX", "0 (perpetuals)")],
    };
  } catch { return null; }
}
