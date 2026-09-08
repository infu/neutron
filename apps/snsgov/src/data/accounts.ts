/**
 * ICRC-1 account handling and SNS treasury account derivation.
 *
 * The textual encoding matters beyond display: it is how a user supplies an
 * account to a custom proposal without hand-typing a 32-byte `vec nat8`, which
 * is both miserable and an excellent way to send funds to the wrong place.
 */

import { Principal } from "@dfinity/principal";
import { fromHex, toHex } from "./format";

export interface IcrcAccount {
  owner: Principal;
  /** Absent means the default (all-zero) subaccount. */
  subaccount?: Uint8Array;
}

/** The Candid shape an ICRC-1 `Account` decodes to / encodes from. */
export interface CandidAccount {
  owner: Principal;
  subaccount: [] | [Uint8Array | number[]];
}

const SUBACCOUNT_BYTES = 32;

/** Domain separator for SNS token-distribution subaccounts. */
const TOKEN_DISTRIBUTION_DOMAIN = "token-distribution";

/** `TREASURY_SUBACCOUNT_NONCE` in the SNS governance canister. */
const TREASURY_SUBACCOUNT_NONCE = 0n;

/**
 * The SNS token treasury account on the SNS's own ledger.
 *
 * subaccount = SHA256( [len(domain)] || domain || governance_principal_bytes || u64_be(nonce) )
 *
 * Verified against mainnet: reproduces Neutrinite's NTN treasury balance
 * exactly, and matches governance's own `get_metrics` byte for byte.
 */
export async function snsTreasuryAccount(governanceCanisterId: string | Principal): Promise<IcrcAccount> {
  const owner =
    typeof governanceCanisterId === "string"
      ? Principal.fromText(governanceCanisterId)
      : governanceCanisterId;
  return { owner, subaccount: await distributionSubaccount(owner, TREASURY_SUBACCOUNT_NONCE) };
}

/**
 * The ICP treasury account on the NNS ICP ledger.
 *
 * This is the governance canister's **default** subaccount — governance's
 * `icp_treasury_subaccount()` returns `None`. It is not a derived subaccount,
 * and deriving one here would read a zero balance and look like a bug.
 */
export function icpTreasuryAccount(governanceCanisterId: string | Principal): IcrcAccount {
  return {
    owner:
      typeof governanceCanisterId === "string"
        ? Principal.fromText(governanceCanisterId)
        : governanceCanisterId,
  };
}

async function distributionSubaccount(principal: Principal, nonce: bigint): Promise<Uint8Array> {
  const domain = new TextEncoder().encode(TOKEN_DISTRIBUTION_DOMAIN);
  const raw = principal.toUint8Array();
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, false);

  const input = new Uint8Array(1 + domain.length + raw.length + nonceBytes.length);
  let offset = 0;
  input[offset] = domain.length;
  offset += 1;
  input.set(domain, offset);
  offset += domain.length;
  input.set(raw, offset);
  offset += raw.length;
  input.set(nonceBytes, offset);

  return new Uint8Array(await sha256(input));
}

async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is unavailable; cannot derive a treasury subaccount");
  return subtle.digest("SHA-256", data as unknown as ArrayBuffer);
}

/** Convert to the Candid optional-subaccount shape. */
export function toCandidAccount(account: IcrcAccount): CandidAccount {
  return {
    owner: account.owner,
    subaccount: account.subaccount === undefined ? [] : [account.subaccount],
  };
}

export function fromCandidAccount(account: CandidAccount): IcrcAccount {
  const raw = account.subaccount[0];
  if (raw === undefined) return { owner: account.owner };
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  return isDefaultSubaccount(bytes) ? { owner: account.owner } : { owner: account.owner, subaccount: bytes };
}

export function isDefaultSubaccount(subaccount: Uint8Array): boolean {
  return subaccount.length === 0 || subaccount.every((byte) => byte === 0);
}

/**
 * ICRC-1 textual encoding.
 *
 * Default subaccount  -> the bare principal.
 * Otherwise           -> `<principal>-<checksum>.<subaccount hex, leading zeros trimmed>`
 *
 * The checksum is base32(CRC32(owner bytes || subaccount bytes)), lowercase.
 */
export function encodeIcrcAccount(account: IcrcAccount): string {
  const owner = account.owner.toText();
  const subaccount = account.subaccount;
  if (subaccount === undefined || isDefaultSubaccount(subaccount)) return owner;

  const padded = padSubaccount(subaccount);
  const checksum = base32Encode(crc32(concat(account.owner.toUint8Array(), padded)));
  const trimmed = toHex(padded).replace(/^0+/, "");
  return `${owner}-${checksum}.${trimmed}`;
}

/**
 * Parse the textual form. Accepts a bare principal too, so a single input field
 * can take either. Verifies the checksum — a mistyped account that still parses
 * is exactly the failure this encoding exists to prevent.
 */
export function decodeIcrcAccount(text: string): IcrcAccount {
  const value = text.trim();
  if (value === "") throw new SyntaxError("empty account");

  const separator = value.lastIndexOf(".");
  if (separator === -1) return { owner: Principal.fromText(value) };

  const head = value.slice(0, separator);
  const subaccountHex = value.slice(separator + 1);
  if (subaccountHex === "" || subaccountHex.startsWith("0")) {
    throw new SyntaxError("subaccount must be non-empty hex with no leading zeros");
  }
  const dash = head.lastIndexOf("-");
  if (dash === -1) throw new SyntaxError("missing checksum");

  const ownerText = head.slice(0, dash);
  const checksum = head.slice(dash + 1);
  const owner = Principal.fromText(ownerText);
  const subaccount = padSubaccount(fromHex(subaccountHex.padStart(subaccountHex.length + (subaccountHex.length % 2), "0")));

  const expected = base32Encode(crc32(concat(owner.toUint8Array(), subaccount)));
  if (checksum !== expected) {
    throw new SyntaxError(`account checksum mismatch: expected ${expected}, got ${checksum}`);
  }
  return isDefaultSubaccount(subaccount) ? { owner } : { owner, subaccount };
}

function padSubaccount(subaccount: Uint8Array): Uint8Array {
  if (subaccount.length > SUBACCOUNT_BYTES) throw new RangeError("subaccount exceeds 32 bytes");
  if (subaccount.length === SUBACCOUNT_BYTES) return subaccount;
  const out = new Uint8Array(SUBACCOUNT_BYTES);
  out.set(subaccount, SUBACCOUNT_BYTES - subaccount.length);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): Uint8Array {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] as number);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, crc, false);
  return out;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
