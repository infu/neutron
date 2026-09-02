import { isJsonObject } from "neutron-tools/app";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
  type IcrcAccount,
} from "neutron-tools/src/icrc_account.js";

export function canonicalIcrcAccountText(
  value: unknown,
  label: string,
): string {
  try {
    if (typeof value !== "string") throw new Error("not text");
    const account = decodeIcrcAccount(value);
    if (encodeIcrcAccount(account) !== value) throw new Error("noncanonical");
    return value;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function parseCandidIcrcAccount(
  value: unknown,
  label: string,
): string {
  const account = exactCandidAccount(value, label);
  const owner = parsePrincipal(account.owner, `${label} owner`);
  const subaccount = Object.hasOwn(account, "subaccount")
    ? account.subaccount === null
      ? undefined
      : parseFixedBytes(account.subaccount, 32, `${label} subaccount`)
    : undefined;
  return encodeIcrcAccount({
    owner,
    ...(subaccount === undefined ? {} : { subaccount }),
  });
}

export function parsePrincipal(
  value: unknown,
  label: string,
): IcrcAccount["owner"] {
  try {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("missing principal");
    }
    const account = decodeIcrcAccount(value);
    if (
      account.subaccount !== undefined ||
      account.owner.toText() !== value
    ) {
      throw new Error("noncanonical principal");
    }
    return account.owner;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function parseFixedBytes(
  value: unknown,
  byteLength: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    throw new Error(`Invalid ${label}`);
  }
  return Uint8Array.from(value);
}

export function bytesToHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function hexToBytes(value: string, label: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return Uint8Array.from(
    { length: value.length / 2 },
    (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function exactCandidAccount(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  const expected = Object.hasOwn(value, "subaccount")
    ? ["owner", "subaccount"]
    : ["owner"];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
