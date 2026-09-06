import {
  isAddress,
  stringToHex,
  verifyMessage,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";

export const kitchenSinkPersonalMessage =
  "Neutron Kitchen Sink signature demo.\nThis message only demonstrates wallet signing.";

/** The personal-sign request carries the exact UTF-8 bytes of the visible text. */
export function kitchenSinkPersonalMessageHex(): Hex {
  return stringToHex(kitchenSinkPersonalMessage);
}

/** A fixed demonstration message, with no contract or token authorization. */
export function kitchenSinkTypedData(chainId: number) {
  assertChainId(chainId);
  // Keep JSON-compatible numbers in this request. Explicit domain definitions
  // with literal uint256 types would make viem's generic types require bigint.
  const types: Record<string, Array<{ name: string; type: string }>> = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    KitchenSinkMessage: [{ name: "message", type: "string" }],
  };
  return {
    domain: {
      name: "Neutron Kitchen Sink",
      version: "1",
      chainId,
    },
    types,
    primaryType: "KitchenSinkMessage" as const,
    message: { message: kitchenSinkPersonalMessage },
  };
}

/** Verify locally against the selected chain-key EOA, independently of Wallet. */
export async function verifyKitchenSinkPersonal(
  address: string,
  signature: string,
): Promise<boolean> {
  assertAddress(address);
  assertSignature(signature);
  try {
    return await verifyMessage({
      address,
      message: kitchenSinkPersonalMessage,
      signature,
    });
  } catch {
    // Well-formed hex can still encode an invalid elliptic-curve signature.
    return false;
  }
}

export async function verifyKitchenSinkTyped(
  chainId: number,
  address: string,
  signature: string,
): Promise<boolean> {
  const typedData = kitchenSinkTypedData(chainId);
  assertAddress(address);
  assertSignature(signature);
  try {
    return await verifyTypedData({ ...typedData, address, signature });
  } catch {
    return false;
  }
}

function assertChainId(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid EVM demo chain ID");
  }
}

function assertAddress(value: unknown): asserts value is Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new Error("Invalid EVM demo account address");
  }
}

function assertSignature(value: unknown): asserts value is Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(value)) {
    throw new Error("Invalid EVM demo signature: expected 65 hex-encoded bytes");
  }
}
