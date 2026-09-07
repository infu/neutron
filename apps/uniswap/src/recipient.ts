import type { Address } from "viem";

/** These router recipients are commands, not literal destination addresses.
 * V3 SwapRouter02 and the V4 action router map 1 to the caller and 2 to self.
 * Call only for fields that the selected contract actually maps.
 */
export function validateLiteralRecipient(recipient: Address): void {
  if (BigInt(recipient) === 1n || BigInt(recipient) === 2n) {
    throw new Error("This recipient is a Uniswap router alias, not a literal destination. Enter the intended receiving address.");
  }
}
