import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";

const symbolOutput = [{ type: "string" }] as const;

export function decodeTokenDecimals(value: string): number {
  // decimals() is uint8, including its ABI padding. Never truncate a uint256
  // response into a different monetary scale through a permissive ABI decoder.
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) > 255n) throw new Error("Invalid ERC20 decimals return value");
  return Number(BigInt(value));
}

export function decodeTokenSymbol(value: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) {
    // Older ERC20 contracts expose symbol() as bytes32. Remove only trailing
    // ABI null padding from the same observed response.
    const bytes = Uint8Array.from(value.slice(2).match(/../g)!, byte => parseInt(byte, 16));
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  }
  const [symbol] = decodeAbiParameters(symbolOutput, value as Hex);
  if (encodeAbiParameters(symbolOutput, [symbol]).toLowerCase() !== value.toLowerCase()) {
    throw new Error("Invalid ERC20 symbol return value");
  }
  // Metadata remains inert text, never HTML or executable UI.
  return symbol;
}
