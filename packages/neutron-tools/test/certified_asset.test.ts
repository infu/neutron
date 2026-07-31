import { describe, expect, test } from "bun:test";
import { bls12_381 } from "@noble/curves/bls12-381";
import {
  Cbor,
  NodeType,
  domain_sep,
  reconstruct,
  type HashTree,
} from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { gzipSync } from "fflate";
import { sha256 } from "js-sha256";
import {
  CertifiedAssetError,
  createCertifiedAssetReader,
  decodeCertifiedAssetBytes,
  decodeCertifiedAssetJson,
  decodeCertifiedAssetText,
  type CertifiedAssetLimits,
  type KernelStaticRead,
  type KernelStaticReadResponse,
} from "../src/certified_asset.ts";

const encoder = new TextEncoder();
const canisterId = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const otherCanisterId = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const secretKey = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 1 : 0
);
const derPrefix = hexToBytes(
  "308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100"
);
const rootKey = concatBytes(
  derPrefix,
  bls12_381.getPublicKeyForShortSignatures(secretKey)
);

type Proof = {
  certificate: Uint8Array;
  witness: Uint8Array;
};

function leaf(bytes: Uint8Array): HashTree {
  return [NodeType.Leaf, bytes] as HashTree;
}

function empty(): HashTree {
  return [NodeType.Empty] as HashTree;
}

function pruned(hash: Uint8Array): HashTree {
  return [NodeType.Pruned, hash] as HashTree;
}

function labeled(label: string | Uint8Array, tree: HashTree): HashTree {
  return [
    NodeType.Labeled,
    typeof label === "string" ? encoder.encode(label) : label,
    tree,
  ] as HashTree;
}

function fork(left: HashTree, right: HashTree): HashTree {
  return [NodeType.Fork, left, right] as HashTree;
}

function assetWitness(key: string, hash: Uint8Array): HashTree {
  return labeled("http_assets", labeled(key, leaf(hash)));
}

async function proofFor(
  witnessTree: HashTree,
  options: {
    certificateCanisterId?: Principal;
    timeMs?: number;
  } = {}
): Promise<Proof> {
  const certificateCanisterId =
    options.certificateCanisterId ?? canisterId;
  const witnessRoot = await reconstruct(witnessTree);
  const certificateTree = fork(
    labeled(
      "canister",
      labeled(
        certificateCanisterId.toUint8Array(),
        labeled("certified_data", leaf(witnessRoot))
      )
    ),
    labeled(
      "time",
      leaf(unsignedLeb128(BigInt(options.timeMs ?? Date.now()) * 1_000_000n))
    )
  );
  const certificateRoot = await reconstruct(certificateTree);
  const message = concatBytes(domain_sep("ic-state-root"), certificateRoot);
  const signature = bls12_381.signShortSignature(message, secretKey);
  return {
    certificate: Cbor.encode({ tree: certificateTree, signature }),
    witness: Cbor.encode(witnessTree),
  };
}

async function foundRead(options: {
  key: string;
  chunks: Uint8Array[];
  proof?: Proof;
  declaredChunks?: bigint;
  mutate?: (response: KernelStaticReadResponse, index: number) => void;
}): Promise<{ readChunk: KernelStaticRead; proof: Proof }> {
  const body = concatBytes(...options.chunks);
  const hash = hexToBytes(sha256(body));
  const proof = options.proof ?? (await proofFor(assetWitness(options.key, hash)));
  const readChunk: KernelStaticRead = async ({ index }) => {
    const numericIndex = Number(index);
    if (numericIndex < 0 || numericIndex >= options.chunks.length) {
      throw new Error("invalid chunk index");
    }
    const response: KernelStaticReadResponse = {
      ...proof,
      asset: [
        {
          content: options.chunks[numericIndex]!,
          chunks: options.declaredChunks ?? BigInt(options.chunks.length),
        },
      ],
    };
    options.mutate?.(response, numericIndex);
    return response;
  };
  return { readChunk, proof };
}

function reader(
  readChunk: KernelStaticRead,
  options: {
    canister?: Principal;
    trustedRootKey?: Uint8Array;
    limits?: Partial<CertifiedAssetLimits>;
  } = {}
) {
  return createCertifiedAssetReader({
    readChunk,
    canisterId: (options.canister ?? canisterId).toText(),
    rootKey: options.trustedRootKey ?? rootKey,
    ...(options.limits ? { limits: options.limits } : {}),
  });
}

describe("certified asset proof reader", () => {
  test("verifies and assembles exact single- and multi-chunk bytes", async () => {
    const key = "/mo/base/Array.mo";
    const chunks = [encoder.encode("module {"), encoder.encode(" public };"),];
    const calls: bigint[] = [];
    const fixture = await foundRead({ key, chunks });
    const readChunk: KernelStaticRead = async (input) => {
      calls.push(input.index);
      return fixture.readChunk(input);
    };

    const raw = await reader(readChunk).readRaw(key);
    expect(raw).toEqual(concatBytes(...chunks));
    expect(calls).toEqual([0n, 1n]);
  });

  test("accepts cryptographically proven absence", async () => {
    const key = "/system/missing.json";
    const proof = await proofFor(labeled("http_assets", empty()));
    const value = await reader(async () => ({ ...proof, asset: [] })).readRaw(
      key
    );
    expect(value).toBeUndefined();
  });

  test("rejects Unknown, forged null, and present/absent mismatches", async () => {
    const key = "/system/apps.json";
    const body = encoder.encode("[]");
    const hash = hexToBytes(sha256(body));

    const unknownProof = await proofFor(
      labeled("http_assets", pruned(new Uint8Array(32)))
    );
    await expect(
      reader(async () => ({ ...unknownProof, asset: [] })).readRaw(key)
    ).rejects.toMatchObject({ code: "uncertified_path" });

    const foundProof = await proofFor(assetWitness(key, hash));
    await expect(
      reader(async () => ({ ...foundProof, asset: [] })).readRaw(key)
    ).rejects.toMatchObject({ code: "presence_mismatch" });

    const absentProof = await proofFor(labeled("http_assets", empty()));
    await expect(
      reader(async () => ({
        ...absentProof,
        asset: [{ content: body, chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "presence_mismatch" });
  });

  test("rejects stale, corrupt, wrong-root, and wrong-canister certificates", async () => {
    const key = "/pkg/neutron.did";
    const body = encoder.encode("service : {}");
    const hash = hexToBytes(sha256(body));

    const staleProof = await proofFor(assetWitness(key, hash), {
      timeMs: Date.now() - 10 * 60 * 1000,
    });
    await expect(
      reader(async () => ({
        ...staleProof,
        asset: [{ content: body, chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "invalid_certificate" });

    const goodProof = await proofFor(assetWitness(key, hash));
    const corruptCertificate = goodProof.certificate.slice();
    corruptCertificate[corruptCertificate.length - 1] =
      corruptCertificate[corruptCertificate.length - 1]! ^ 1;
    await expect(
      reader(async () => ({
        certificate: corruptCertificate,
        witness: goodProof.witness,
        asset: [{ content: body, chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "invalid_certificate" });

    const otherRoot = rootKey.slice();
    otherRoot[otherRoot.length - 1] = otherRoot[otherRoot.length - 1]! ^ 1;
    await expect(
      reader(
        async () => ({
          ...goodProof,
          asset: [{ content: body, chunks: 1n }],
        }),
        { trustedRootKey: otherRoot }
      ).readRaw(key)
    ).rejects.toMatchObject({ code: "invalid_certificate" });

    await expect(
      reader(
        async () => ({
          ...goodProof,
          asset: [{ content: body, chunks: 1n }],
        }),
        { canister: otherCanisterId }
      ).readRaw(key)
    ).rejects.toMatchObject({ code: "certified_data_mismatch" });
  });

  test("rejects wrong paths, witness roots, hashes, and mid-read proof changes", async () => {
    const key = "/system/apps.json";
    const body = encoder.encode("[]");
    const bodyHash = hexToBytes(sha256(body));

    const wrongPathProof = await proofFor(
      assetWitness("/system/other.json", bodyHash)
    );
    await expect(
      reader(async () => ({
        ...wrongPathProof,
        asset: [{ content: body, chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "presence_mismatch" });

    const goodProof = await proofFor(assetWitness(key, bodyHash));
    const otherWitness = Cbor.encode(
      assetWitness(key, hexToBytes(sha256(encoder.encode("different"))))
    );
    await expect(
      reader(async () => ({
        certificate: goodProof.certificate,
        witness: otherWitness,
        asset: [{ content: body, chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "certified_data_mismatch" });

    await expect(
      reader(async () => ({
        ...goodProof,
        asset: [{ content: encoder.encode("{}"), chunks: 1n }],
      })).readRaw(key)
    ).rejects.toMatchObject({ code: "hash_mismatch" });

    const first = encoder.encode("first");
    const second = encoder.encode("second");
    const fixture = await foundRead({ key, chunks: [first, second] });
    const changedProof = await proofFor(
      assetWitness(key, hexToBytes(sha256(encoder.encode("changed"))))
    );
    await expect(
      reader(async (input) =>
        input.index === 0n
          ? fixture.readChunk(input)
          : {
              ...changedProof,
              asset: [{ content: second, chunks: 2n }],
            }
      ).readRaw(key)
    ).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  test("verifies every chunk proof and propagates invalid-index transport errors", async () => {
    const key = "/mo/chunked.mo";
    const fixture = await foundRead({
      key,
      chunks: [encoder.encode("a"), encoder.encode("b")],
    });
    await expect(
      reader(async (input) => {
        if (input.index === 1n) {
          const response = await fixture.readChunk(input);
          const certificate = response.certificate as Uint8Array;
          const corrupt = certificate.slice();
          corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
          return { ...response, certificate: corrupt };
        }
        return fixture.readChunk(input);
      }).readRaw(key)
    ).rejects.toMatchObject({ code: "invalid_certificate" });

    const indexError = new Error("invalid chunk index");
    await expect(
      reader(async (input) => {
        if (input.index === 1n) throw indexError;
        return fixture.readChunk(input);
      }).readRaw(key)
    ).rejects.toBe(indexError);
  });

  test("enforces proof, chunk, chunk-count, and assembled byte limits", async () => {
    const key = "/mo/large.mo";
    const content = encoder.encode("12345");
    const normal = await foundRead({ key, chunks: [content] });

    await expect(
      reader(normal.readChunk, { limits: { maxCertificateBytes: 1 } }).readRaw(
        key
      )
    ).rejects.toMatchObject({ code: "size_limit" });

    await expect(
      reader(normal.readChunk, { limits: { maxWitnessBytes: 1 } }).readRaw(key)
    ).rejects.toMatchObject({ code: "size_limit" });

    await expect(
      reader(normal.readChunk, { limits: { maxChunkBytes: 4 } }).readRaw(key)
    ).rejects.toMatchObject({ code: "size_limit" });

    const tooMany = await foundRead({
      key,
      chunks: [content],
      declaredChunks: 65n,
    });
    await expect(reader(tooMany.readChunk).readRaw(key)).rejects.toMatchObject({
      code: "size_limit",
    });

    const multi = await foundRead({
      key,
      chunks: [encoder.encode("123"), encoder.encode("456")],
    });
    await expect(
      reader(multi.readChunk, { limits: { maxEncodedBytes: 5 } }).readRaw(key)
    ).rejects.toMatchObject({ code: "size_limit" });
  });

  test("requires canonical exact keys and rejects malformed optionals", async () => {
    const noop: KernelStaticRead = async () => {
      throw new Error("should not read");
    };
    await expect(reader(noop).readRaw("/pkg/file?query")).rejects.toMatchObject({
      code: "invalid_configuration",
    });

    const key = "/system/apps.json";
    const body = encoder.encode("[]");
    const fixture = await foundRead({ key, chunks: [body] });
    await expect(
      reader(async (input) => {
        const response = await fixture.readChunk(input);
        return {
          ...response,
          asset: [response.asset[0]!, response.asset[0]!],
        };
      }).readRaw(key)
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("certified asset deterministic decoding", () => {
  test("decodes identity and gzip text and JSON from verified bytes", () => {
    const text = "hello certified world";
    const identity = encoder.encode(text);
    const compressed = gzipSync(identity, { mtime: 0 });

    expect(
      decodeCertifiedAssetText(identity, { maxDecodedBytes: identity.length })
    ).toBe(text);
    expect(
      decodeCertifiedAssetText(compressed, {
        maxDecodedBytes: identity.length,
      })
    ).toBe(text);

    const json = gzipSync(encoder.encode('{"ok":true}'), { mtime: 0 });
    expect(
      decodeCertifiedAssetJson<{ ok: boolean }>(json, {
        maxDecodedBytes: 64,
      })
    ).toEqual({ ok: true });
  });

  test("uses only gzip magic and rejects bad or concatenated streams", () => {
    expect(() =>
      decodeCertifiedAssetBytes(new Uint8Array([0x1f, 0x8b, 0x00]), {
        maxDecodedBytes: 100,
      })
    ).toThrow(CertifiedAssetError);

    const concatenated = concatBytes(
      gzipSync(encoder.encode("a"), { mtime: 0 }),
      gzipSync(encoder.encode("b"), { mtime: 0 })
    );
    expect(() =>
      decodeCertifiedAssetBytes(concatenated, { maxDecodedBytes: 100 })
    ).toThrow(/Concatenated gzip/);

    const truncated = gzipSync(encoder.encode("truncated"), { mtime: 0 }).slice(
      0,
      -1
    );
    expect(() =>
      decodeCertifiedAssetBytes(truncated, { maxDecodedBytes: 100 })
    ).toThrow(/checksum or size footer/);

    const badChecksum = gzipSync(encoder.encode("checksum"), {
      mtime: 0,
    });
    badChecksum[badChecksum.length - 8] =
      badChecksum[badChecksum.length - 8]! ^ 1;
    expect(() =>
      decodeCertifiedAssetBytes(badChecksum, { maxDecodedBytes: 100 })
    ).toThrow(/checksum or size footer/);
  });

  test("enforces identity and streaming post-gunzip limits", () => {
    expect(() =>
      decodeCertifiedAssetBytes(encoder.encode("too large"), {
        maxDecodedBytes: 4,
      })
    ).toThrow(/decoded bytes/);

    const expanded = new Uint8Array(2 * 1024 * 1024).fill(65);
    const compressed = gzipSync(expanded, { mtime: 0 });
    expect(compressed.byteLength).toBeLessThan(4096);
    expect(() =>
      decodeCertifiedAssetBytes(compressed, { maxDecodedBytes: 1024 })
    ).toThrow(/exceeds 1024 decoded bytes/);
  });

  test("fails closed on invalid UTF-8 and JSON", () => {
    expect(() =>
      decodeCertifiedAssetText(new Uint8Array([0xff]), {
        maxDecodedBytes: 1,
      })
    ).toThrow(/valid UTF-8/);
    expect(() =>
      decodeCertifiedAssetJson(encoder.encode("not-json"), {
        maxDecodedBytes: 64,
      })
    ).toThrow(/valid JSON/);
  });
});

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
}

function unsignedLeb128(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}
