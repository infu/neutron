import {
  base58,
  bech32,
  bech32m,
  createBase58check,
} from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Principal } from "@dfinity/principal";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";
import type { Destination, Network } from "./model.ts";

const base58check = createBase58check(sha256);
const textEncoder = new TextEncoder();
const hexPattern = /^[0-9a-fA-F]+$/;
const asciiPattern = /^[\x21-\x7e]+$/;
const unsafeMetadataPattern =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export class AddressValidationError extends Error {
  constructor(
    public readonly network: Network,
    message: string,
  ) {
    super(message);
    this.name = "AddressValidationError";
  }
}

export type DestinationInput =
  | {
      network: "neutron";
      principal: string;
    }
  | {
      network: "internet_computer";
      account: string;
    }
  | {
      network: Exclude<Network, "internet_computer" | "neutron">;
      address: string;
    };

export function normalizeDestination(
  input: DestinationInput,
  selfCanister?: string | null,
): Destination {
  switch (input.network) {
    case "neutron":
      return normalizeNeutron(input.principal, selfCanister);
    case "internet_computer":
      return normalizeInternetComputer(input.account);
    case "bitcoin_mainnet":
      return {
        network: input.network,
        address: normalizeBitcoin(input.address),
      };
    case "dogecoin_mainnet":
      return {
        network: input.network,
        address: normalizeDogecoin(input.address),
      };
    case "ethereum_mainnet":
      return {
        network: input.network,
        address: normalizeEthereum(input.address),
      };
    case "solana_mainnet":
      return {
        network: input.network,
        address: normalizeSolana(input.address),
      };
  }
}

export function normalizeNeutron(
  rawPrincipal: string,
  selfCanister?: string | null,
): Destination {
  const value = rawPrincipal.trim();
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw invalid("neutron", "Enter a valid Neutron canister principal");
  }
  const bytes = principal.toUint8Array();
  if (bytes.length === 0 || bytes.length > 29 || bytes.at(-1) !== 0x01) {
    throw invalid("neutron", "A Neutron address must be a canister principal");
  }
  const canonical = principal.toText();
  if (selfCanister) {
    let self: string;
    try {
      self = Principal.fromText(selfCanister).toText();
    } catch {
      throw new Error("Neutron returned an invalid local canister id");
    }
    if (canonical === self) {
      throw invalid("neutron", "Use another Neutron canister, not this one");
    }
  }
  return { network: "neutron", principal: canonical };
}

export function normalizeInternetComputer(rawAccount: string): Destination {
  const value = rawAccount.trim();
  let account;
  try {
    account = decodeIcrcAccount(value);
  } catch {
    throw invalid("internet_computer", "Enter a valid ICRC account");
  }
  if (account.owner.isAnonymous()) {
    throw invalid("internet_computer", "Anonymous cannot be a contact account");
  }
  return {
    network: "internet_computer",
    account: encodeIcrcAccount(account),
  };
}

export function normalizeBitcoin(raw: string): string {
  const value = cleanExternal(raw, "bitcoin_mainnet");
  if (/^bc1/i.test(value)) {
    if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
      throw invalid("bitcoin_mainnet", "Bech32 addresses cannot mix case");
    }
    const canonical = value.toLowerCase();
    const decoded = decodeWitness(canonical);
    if (decoded.prefix !== "bc") {
      throw invalid("bitcoin_mainnet", "Address is not for Bitcoin mainnet");
    }
    const version = decoded.words[0];
    if (version === undefined || version > 16) {
      throw invalid("bitcoin_mainnet", "Unsupported witness version");
    }
    let program: Uint8Array;
    try {
      program = bech32.fromWords(decoded.words.slice(1));
    } catch {
      throw invalid("bitcoin_mainnet", "Invalid witness program");
    }
    if (program.length < 2 || program.length > 40) {
      throw invalid("bitcoin_mainnet", "Invalid witness program length");
    }
    if (version === 0 && program.length !== 20 && program.length !== 32) {
      throw invalid("bitcoin_mainnet", "Invalid version 0 witness program");
    }
    return canonical;
  }

  const payload = decodeChecked(value, "bitcoin_mainnet");
  if (payload.length !== 21 || (payload[0] !== 0 && payload[0] !== 5)) {
    throw invalid("bitcoin_mainnet", "Address is not for Bitcoin mainnet");
  }
  return value;
}

export function normalizeDogecoin(raw: string): string {
  const value = cleanExternal(raw, "dogecoin_mainnet");
  const payload = decodeChecked(value, "dogecoin_mainnet");
  if (payload.length !== 21 || (payload[0] !== 30 && payload[0] !== 22)) {
    throw invalid("dogecoin_mainnet", "Address is not for Dogecoin mainnet");
  }
  return value;
}

export function normalizeEthereum(raw: string): string {
  const value = cleanExternal(raw, "ethereum_mainnet");
  const body = value.replace(/^0x/i, "");
  if (body.length !== 40 || !hexPattern.test(body)) {
    throw invalid("ethereum_mainnet", "Address must contain exactly 20 bytes");
  }
  if (/^0+$/.test(body)) {
    throw invalid("ethereum_mainnet", "The zero address is not a contact destination");
  }
  const checksummed = ethereumChecksum(body.toLowerCase());
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && `0x${body}` !== checksummed) {
    throw invalid("ethereum_mainnet", "Address has an invalid EIP-55 checksum");
  }
  return checksummed;
}

export function normalizeSolana(raw: string): string {
  const value = cleanExternal(raw, "solana_mainnet");
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    throw invalid("solana_mainnet", "Enter a valid Base58 address");
  }
  if (bytes.length !== 32) {
    throw invalid("solana_mainnet", "Address must decode to exactly 32 bytes");
  }
  const canonical = base58.encode(bytes);
  if (canonical !== value) {
    throw invalid("solana_mainnet", "Address is not canonical Base58");
  }
  return canonical;
}

export function normalizeContactName(raw: string): string {
  const name = raw.trim();
  if (!name || [...name].length > 120) {
    throw new Error("Name must contain 1 to 120 characters");
  }
  if (unsafeMetadataPattern.test(name)) {
    throw new Error("Name contains unsupported control characters");
  }
  return name;
}

export function normalizeAddressLabel(raw: string | null): string | null {
  const label = raw?.trim() ?? "";
  if (!label) return null;
  if ([...label].length > 64) throw new Error("Label is longer than 64 characters");
  if (unsafeMetadataPattern.test(label)) {
    throw new Error("Label contains unsupported control characters");
  }
  return label;
}

export function validateNotes(notes: string): string {
  if (textEncoder.encode(notes).byteLength > 8 * 1024) {
    throw new Error("Notes are larger than 8 KiB");
  }
  if (/\0/u.test(notes) || unsafeMetadataPattern.test(notes)) {
    throw new Error("Notes contain unsupported control characters");
  }
  return notes;
}

function decodeWitness(value: string): { prefix: string; words: number[] } {
  try {
    const decoded = bech32.decode(value, 90);
    if (decoded.words[0] !== 0) throw new Error("wrong checksum");
    return decoded;
  } catch {
    try {
      const decoded = bech32m.decode(value, 90);
      if (decoded.words[0] === 0) throw new Error("wrong checksum");
      return decoded;
    } catch {
      throw invalid("bitcoin_mainnet", "Address has an invalid Bech32 checksum");
    }
  }
}

function decodeChecked(value: string, network: Network): Uint8Array {
  try {
    return base58check.decode(value);
  } catch {
    throw invalid(network, "Address has an invalid Base58Check checksum");
  }
}

function cleanExternal(raw: string, network: Network): string {
  const value = raw.trim();
  if (!value || value.length > 128 || !asciiPattern.test(value)) {
    throw invalid(network, "Address must use visible ASCII without whitespace");
  }
  return value;
}

function ethereumChecksum(lower: string): string {
  const hash = bytesToHex(keccak_256(textEncoder.encode(lower)));
  let output = "";
  for (let index = 0; index < lower.length; index += 1) {
    const character = lower[index]!;
    output +=
      character >= "a" && character <= "f" && Number.parseInt(hash[index]!, 16) >= 8
        ? character.toUpperCase()
        : character;
  }
  return `0x${output}`;
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(network: Network, message: string): AddressValidationError {
  return new AddressValidationError(network, message);
}
