import { Principal } from "@icp-sdk/core/principal";
import type { SelfCallObject } from "neutron-tools/app";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";

export function parseCandidIcrcAccount(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const account = value as Record<string, unknown>;
  const owner = parsePrincipal(account.owner, `${label} owner`);
  const subaccount = account.subaccount == null
    ? undefined
    : parseFixedBytes(account.subaccount, 32, `${label} subaccount`);
  return encodeIcrcAccount({
    owner,
    ...(subaccount === undefined ? {} : { subaccount }),
  });
}

export function candidIcrcAccountFromText(
  value: string,
  label: string,
): SelfCallObject {
  const text = value.trim();
  try {
    const account = decodeIcrcAccount(text);
    if (encodeIcrcAccount(account) !== text) throw new Error("noncanonical");
    return {
      owner: account.owner.toText(),
      subaccount:
        account.subaccount === undefined
          ? null
          : Uint8Array.from(account.subaccount),
    };
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function parsePrincipal(value: unknown, label: string): Principal {
  try {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("missing principal");
    }
    const principal = Principal.fromText(value);
    if (principal.toText() !== value) throw new Error("noncanonical principal");
    return principal;
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
