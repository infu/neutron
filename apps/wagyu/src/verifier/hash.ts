import {
  concatBytes,
  sha256,
  unsignedLeb128,
  utf8,
} from "./bytes.ts";

type HashValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "nat"; readonly value: bigint };

async function hashValue(value: HashValue): Promise<Uint8Array> {
  switch (value.kind) {
    case "string":
      return sha256(utf8(value.value));
    case "nat":
      return sha256(unsignedLeb128(value.value));
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

async function representationIndependentHash(
  entries: readonly (readonly [string, HashValue])[],
): Promise<Uint8Array> {
  const hashed = await Promise.all(entries.map(async ([name, value], index) => ({
    key: await sha256(utf8(name)),
    value: await hashValue(value),
    index,
  })));
  hashed.sort((left, right) =>
    compareBytes(left.key, right.key) || left.index - right.index
  );
  return sha256(concatBytes(
    ...hashed.flatMap((entry) => [entry.key, entry.value]),
  ));
}

export async function certifiedRequestHashV2(): Promise<Uint8Array> {
  const mapHash = await representationIndependentHash([
    [":ic-cert-method", { kind: "string", value: "GET" }],
  ]);
  const emptyBodyHash = await sha256(new Uint8Array());
  return sha256(concatBytes(mapHash, emptyBodyHash));
}

export async function certifiedResponseHashV2(
  headers: readonly (readonly [string, string])[],
  bodyHash: Uint8Array,
): Promise<Uint8Array> {
  if (bodyHash.byteLength !== 32) throw new Error("Body hash must be 32 bytes");
  const entries: Array<readonly [string, HashValue]> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower !== "ic-certificate") {
      entries.push([lower, { kind: "string", value }]);
    }
  }
  entries.push([":ic-cert-status", { kind: "nat", value: 200n }]);
  const mapHash = await representationIndependentHash(entries);
  return sha256(concatBytes(mapHash, bodyHash));
}

export async function wagyuHash(
  domain: string,
  ...items: readonly Uint8Array[]
): Promise<Uint8Array> {
  const framed: Uint8Array[] = [];
  for (const value of [utf8(domain), ...items]) {
    const length = value.byteLength;
    framed.push(Uint8Array.of(
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ));
    framed.push(value);
  }
  return sha256(concatBytes(...framed));
}
