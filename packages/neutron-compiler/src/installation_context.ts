import { IC_ROOT_KEY } from "@dfinity/agent";
import { hashContent } from "neutron-tools/src/hash.js";

const NETWORK_ID_DOMAIN = new TextEncoder().encode("neutron.network-id.v1");
const NETWORK_ID_BYTES = 32;
const ROOT_KEY_BYTES_MIN = 32;
const ROOT_KEY_BYTES_MAX = 4_096;
const TRUSTED_CONTEXT = Symbol("neutron.trusted-installation-context.v1");

/**
 * Compiler-owned, installation-scoped public identity context.
 *
 * The brand prevents an unvalidated object from accidentally entering the
 * assembler. It is not a bearer capability: the value grants no authority.
 */
export type TrustedInstallationContextV1 = Readonly<{
  readonly networkId: readonly number[];
  readonly [TRUSTED_CONTEXT]: true;
}>;

/**
 * Derive the network identity from the exact root-key SPKI DER bytes returned
 * by the trusted deployment target. The input is hashed byte-for-byte; it is
 * never parsed, rewrapped, or re-encoded.
 */
export function trustedInstallationContextFromRootKey(
  exactRootKeySpkiDer: Uint8Array,
): TrustedInstallationContextV1 {
  if (
    !(exactRootKeySpkiDer instanceof Uint8Array) ||
    exactRootKeySpkiDer.byteLength < ROOT_KEY_BYTES_MIN ||
    exactRootKeySpkiDer.byteLength > ROOT_KEY_BYTES_MAX
  ) {
    throw new Error(
      "Trusted installation root key must be exact bounded SPKI DER bytes",
    );
  }
  const rootKey = exactRootKeySpkiDer.slice();
  const digest = hashContent(
    concatenate(lengthPrefixed(NETWORK_ID_DOMAIN), lengthPrefixed(rootKey)),
  );
  return trustedInstallationContextFromNetworkId(hexBytes(digest));
}

/**
 * Return the context derived from @dfinity/agent's compiled IC mainnet root
 * key. Production callers cannot substitute a fetched or configured key.
 */
export function mainnetTrustedInstallationContext(): TrustedInstallationContextV1 {
  if (
    typeof IC_ROOT_KEY !== "string" ||
    IC_ROOT_KEY.length === 0 ||
    IC_ROOT_KEY.length % 2 !== 0 ||
    !/^[0-9a-f]+$/u.test(IC_ROOT_KEY)
  ) {
    throw new Error("The compiled IC mainnet root key is not canonical DER hex");
  }
  return trustedInstallationContextFromRootKey(hexBytes(IC_ROOT_KEY));
}

export function assertTrustedInstallationContext(
  value: unknown,
): asserts value is TrustedInstallationContextV1 {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<TrustedInstallationContextV1>)[TRUSTED_CONTEXT] !== true
  ) {
    throw new Error("Trusted installation context was not validated");
  }
  const networkId = (value as TrustedInstallationContextV1).networkId;
  if (
    !Array.isArray(networkId) ||
    networkId.length !== NETWORK_ID_BYTES ||
    networkId.some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
    ) ||
    networkId.every((byte) => byte === 0)
  ) {
    throw new Error(
      "Trusted installation network ID must be exactly 32 nonzero bytes",
    );
  }
}

export function trustedInstallationNetworkIdHex(
  context: TrustedInstallationContextV1,
): string {
  assertTrustedInstallationContext(context);
  return context.networkId
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function trustedInstallationContextFromNetworkId(
  networkId: Uint8Array,
): TrustedInstallationContextV1 {
  const immutableNetworkId = Object.freeze(Array.from(networkId));
  const context = {
    networkId: immutableNetworkId,
    [TRUSTED_CONTEXT]: true as const,
  };
  assertTrustedInstallationContext(context);
  return Object.freeze(context);
}

function lengthPrefixed(value: Uint8Array): Uint8Array {
  if (value.byteLength > 0xffff_ffff) {
    throw new Error("Trusted installation identity input is too large");
  }
  const result = new Uint8Array(4 + value.byteLength);
  new DataView(result.buffer).setUint32(0, value.byteLength, false);
  result.set(value, 4);
  return result;
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const byteLength = values.reduce(
    (total, value) => total + value.byteLength,
    0,
  );
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function hexBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error("Expected canonical lowercase hexadecimal bytes");
  }
  return Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
