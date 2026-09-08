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
const TRANSMITTER = "0x81d40f21f12a8f0e3252bccb954d722d4c464b64";
const CORE_DEPOSIT = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const HYPER_USDC = "0xb88339cb7199b77e23db6e890353e22632ba630f";
const FORWARDER_BYTES32 = `0x${"0".repeat(24)}${FORWARDER.slice(2)}`;
const HOOK_HEADER = "636374702d666f7277617264".padEnd(48, "0") + "0000000000000018";
const DEPOSIT_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold,bytes hookData)",
]);
type Struct = readonly (readonly [string, string])[];
const DOMAIN: Struct = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"]];
const APPROVE: Struct = [["hyperliquidChain", "string"], ["agentAddress", "address"], ["agentName", "string"], ["nonce", "uint64"]];
const CASH_TO_PERPS: Struct = [["hyperliquidChain", "string"], ["amount", "string"], ["toPerp", "bool"], ["nonce", "uint64"]];
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
    const cashToPerps = parsed.primaryType === "HyperliquidTransaction:UsdClassTransfer";
    if (!approval && !cashToPerps && parsed.primaryType !== "HyperliquidTransaction:SendToEvmWithData") return null;
    const primaryType = parsed.primaryType as string, expected = approval ? APPROVE : cashToPerps ? CASH_TO_PERPS : WITHDRAW;
    if (!keys(types, ["EIP712Domain", primaryType]) || !schema(types[primaryType], expected)) return null;
    const messageFields = expected.map(([name]) => name);
    const nonce = uint(message.nonce, 64);
    if (!keys(message, messageFields) || nonce === null || !["Mainnet", "Testnet"].includes(String(message.hyperliquidChain)) || !address(operation.address)) return null;
    const environment = `Hyperliquid ${message.hyperliquidChain}`;
    const advanced = [field("Signing domain", "HyperliquidSignTransaction v1"), field("Signature type", primaryType), field("Signing chain", "Arbitrum (42161)"), field("Nonce (milliseconds)", nonce)];
    if (cashToPerps) {
      if (message.toPerp !== true || typeof message.amount !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(message.amount)) return null;
      const atoms = atomicAmount(message.amount, 6);
      if (BigInt(atoms) <= 0n) return null;
      return { ...base(), title: "Move Hyperliquid cash to perpetuals", amount: `${message.amount} USDC`, amountLabel: "USDC to move", amountAtoms: atoms, amountDecimals: 6, tokenSymbol: "USDC",
        description: "Move this account's existing Hyperliquid USDC cash balance into its perpetuals balance. This does not place a trade or bridge additional funds from your EVM wallet.",
        parties: [field("Account", getAddress(operation.address)), field("From balance", "Hyperliquid cash"), field("To balance", "Hyperliquid perpetuals"), field("Network", environment)],
        advancedDetails: advanced,
      };
    }
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

const RECOVERY_ABI = parseAbi([
  "function mintAndForward(bytes message,bytes attestation)",
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
]);
const word = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;

/** Independently interpret the exact CCTP V2 bytes. The destination contract
 * verifies the attestation and single-use nonce; a presentation match does not
 * claim that a signature is valid or that the transfer has already completed.
 * https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CctpForwarder.sol
 * https://developers.circle.com/cctp/references/technical-guide */
export function presentHyperliquidRecovery(operation: Operation): OperationPresentation | null {
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  if (operation.kind !== "transaction" || !tx || tx.value !== "0") return null;
  const deposit = operation.chainId === "999" && tx.to.toLowerCase() === FORWARDER;
  const destination = SOURCES[operation.chainId];
  if (!deposit && (!destination || tx.to.toLowerCase() !== TRANSMITTER)) return null;
  try {
    const decoded = decodeFunctionData({ abi: RECOVERY_ABI, data: tx.data as Hex });
    if (decoded.functionName !== (deposit ? "mintAndForward" : "receiveMessage") || encodeFunctionData({ abi: RECOVERY_ABI, ...decoded }).toLowerCase() !== tx.data.toLowerCase()) return null;
    const [rawMessage, attestation] = decoded.args;
    const message = rawMessage.toLowerCase();
    if (message.length < 754 || attestation.length < 132 || ((attestation.length - 2) / 2) % 65 !== 0) return null;
    const at = (offset: number, bytes: number) => `0x${message.slice(2 + offset * 2, 2 + (offset + bytes) * 2)}`;
    const n = (offset: number, bytes: number) => BigInt(at(offset, bytes));
    const accountAt = (offset: number) => {
      const bytes = at(offset, 32);
      if (bytes.slice(2, 26) !== "0".repeat(24)) throw new Error("Not an EVM address word");
      return getAddress(`0x${bytes.slice(26)}`);
    };
    if (n(0, 4) !== 1n || n(148, 4) !== 1n || at(44, 32) !== word(MESSENGER) || at(76, 32) !== word(MESSENGER)) return null;
    const sourceDomain = n(4, 4), destinationDomain = n(8, 4), atomic = n(216, 32), maxFee = n(280, 32), executedFee = n(312, 32);
    if (atomic <= executedFee || executedFee > maxFee || ![1000n, 2000n].includes(n(140, 4)) || n(144, 4) < n(140, 4)) return null;
    const hook = message.slice(754);
    let beneficiary: string, sourceName: string;
    if (deposit) {
      const source = sourceDomain === 0n ? SOURCES["1"] : sourceDomain === 3n ? SOURCES["42161"] : undefined;
      if (!source || destinationDomain !== 19n || at(152, 32) !== word(source.usdc) || at(184, 32) !== FORWARDER_BYTES32 || at(108, 32) !== FORWARDER_BYTES32 || hook.length !== 112 || hook.slice(0, 64) !== HOOK_HEADER || hook.slice(104) !== "00000000") return null;
      beneficiary = getAddress(`0x${hook.slice(64, 104)}`);
      sourceName = source.name;
    } else {
      if (sourceDomain !== 19n || destinationDomain !== (operation.chainId === "1" ? 0n : 3n) || at(152, 32) !== word(HYPER_USDC) || at(108, 32) !== word(ZERO) || at(248, 32) !== word(CORE_DEPOSIT) || hook.length !== 120 || hook.slice(0, 64) !== HOOK_HEADER.slice(0, -2) + "1c") return null;
      beneficiary = accountAt(184);
      if (hook.slice(64, 104) !== beneficiary.slice(2).toLowerCase()) return null;
      sourceName = "Hyperliquid mainnet";
    }
    const received = (atomic - executedFee).toString();
    return { ...base(), title: deposit ? "Complete Hyperliquid deposit" : `Complete Hyperliquid withdrawal to ${destination!.name.replace(" mainnet", "")}`,
      amount: `${amount(received, 6)} USDC`, amountLabel: "USDC after CCTP fees", amountAtoms: received, amountDecimals: 6, tokenSymbol: "USDC", tokenAddress: deposit ? HYPER_USDC : destination!.usdc, contract: tx.to,
      description: deposit
        ? "Submit the existing CCTP message to mint USDC and forward it into Hyperliquid. No additional USDC is burned or approved. Only HYPE gas is paid on HyperEVM; a new HyperCore account may also incur its activation fee. HyperCore credit is checked separately after EVM forwarding."
        : "Submit the existing CCTP message to mint the withdrawn USDC at its original recipient. No additional USDC leaves Hyperliquid. Only destination-network gas is paid.",
      parties: [field("Gas paid by", getAddress(operation.address)), field(deposit ? "HyperCore beneficiary" : "Recipient", beneficiary), field("Source network", sourceName), field("Destination", deposit ? "Hyperliquid mainnet perpetuals" : destination!.name), field("Gas token", deposit ? "HYPE (HyperEVM)" : "ETH")],
      advancedDetails: [field("Function", decoded.functionName), field("CCTP nonce", at(12, 32)), field("Source domain", sourceDomain), field("Destination domain", destinationDomain), field("Original burn amount (USDC)", amount(atomic.toString(), 6)), field("Executed CCTP fee (USDC)", amount(executedFee.toString(), 6)), field("Original message sender", accountAt(248)), field("Mint recipient", accountAt(184)), field("Destination caller", accountAt(108)), field("Message", rawMessage), field("Attestation", attestation)],
    };
  } catch { return null; }
}
