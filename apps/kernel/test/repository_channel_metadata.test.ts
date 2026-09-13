import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Cbor, domain_sep, reconstruct, type ApiQueryResponse, type HashTree } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { bls12_381 } from "@noble/curves/bls12-381";
import { hashContent } from "neutron-tools/src/hash.js";
import { repositoryChannelsPath } from "neutron-tools/src/release_channels.js";
import { createRepositoryChannelMetadataReader } from "../src/repository/channel_metadata.ts";

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const encoder = new TextEncoder();
const secretKey = new Uint8Array(32).fill(0);
secretKey[31] = 1;
const rootKey = new Uint8Array([
  ...Buffer.from("308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100", "hex"),
  ...bls12_381.getPublicKeyForShortSignatures(secretKey),
]);
const metadataReplyType = IDL.Record({
  certificate: IDL.Vec(IDL.Nat8), witness: IDL.Vec(IDL.Nat8),
  asset: IDL.Opt(IDL.Record({ content: IDL.Vec(IDL.Nat8), chunks: IDL.Nat })),
});
const rejected = (overrides: object = {}) => ({
  status: "rejected", reject_code: 5, error_code: "IC0536", reject_message: "No query method repo_channel_metadata",
  signatures: [{ timestamp: BigInt(Date.now()) * 1_000_000n, identity: new Uint8Array([1]), signature: new Uint8Array([1]) }],
  ...overrides,
}) as unknown as ApiQueryResponse;

test("legacy negotiation accepts only the already signature-verified exact missing optional method response", async () => {
  const calls: string[] = [];
  const reader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: {
    async query(source, fields) {
      expect(source).toBe(canisterId);
      calls.push(fields.methodName);
      const requestType = IDL.Record({ path: IDL.Text, index: IDL.Nat });
      expect(IDL.decode([requestType], fields.arg)).toEqual([{ path: repositoryChannelsPath(), index: 0n }]);
      // The injected agent models HttpAgent after its cryptographic validation.
      return rejected();
    },
  } });
  expect(await reader(repositoryChannelsPath())).toBeUndefined();
  expect(calls).toEqual(["repo_channel_metadata"]);
});

test("unsigned forged missing-method responses, other rejections, and transport failures cannot select legacy", async () => {
  for (const overrides of [{ signatures: [] }, { signatures: undefined }, { reject_code: 3 }, { error_code: "IC0503" }]) {
    const reader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: { async query() { return rejected(overrides); } } });
    await expect(reader(repositoryChannelsPath())).rejects.toThrow("rejected");
  }
  const failure = new Error("Query signature verification failed");
  const reader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: { async query() { throw failure; } } });
  await expect(reader(repositoryChannelsPath())).rejects.toBe(failure);
});

test("optional-method absence applies only to the descriptor and preserves explicit local deployment trust", async () => {
  const localReader = createRepositoryChannelMetadataReader({ canisterId, rootKey, local: true, agent: { async query() { return rejected({ signatures: [] }); } } });
  expect(await localReader(repositoryChannelsPath())).toBeUndefined();
  await expect(localReader("/repo/v1/channels/apps/hello.json")).rejects.toThrow("rejected");
});

test("channel query replies require an exact certified asset proof and cannot then lose their method", async () => {
  const path = repositoryChannelsPath();
  const bytes = encoder.encode(JSON.stringify({ protocol: "neutron-repo-channels-v1", source: canisterId }));
  const reply = await certifiedReply(path, bytes);
  let replies = 0;
  const reader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: {
    async query() { return replies++ === 0 ? reply : rejected(); },
  } });
  expect(await reader(path)).toEqual(bytes);
  await expect(reader(path)).rejects.toThrow("rejected");
  const wrongPathReader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: { async query() { return reply; } } });
  await expect(wrongPathReader("/repo/v1/channels/apps/hello.json")).rejects.toThrow();
});

test("a present metadata method with certified descriptor absence is broken support, not legacy", async () => {
  const reply = await certifiedReply(repositoryChannelsPath(), undefined);
  const reader = createRepositoryChannelMetadataReader({ canisterId, rootKey, agent: { async query() { return reply; } } });
  await expect(reader(repositoryChannelsPath())).rejects.toThrow("certified descriptor is missing");
});

async function certifiedReply(path: string, bytes: Uint8Array | undefined): Promise<ApiQueryResponse> {
  const labeled = (label: string | Uint8Array, tree: HashTree): HashTree => [2, typeof label === "string" ? encoder.encode(label) : label, tree] as HashTree;
  const leaf = (value: Uint8Array): HashTree => [3, value] as HashTree;
  const witness = labeled("http_assets", bytes ? labeled(path, leaf(new Uint8Array(Buffer.from(hashContent(bytes), "hex")))) : [0] as HashTree);
  const root = await reconstruct(witness);
  let time = BigInt(Date.now()) * 1_000_000n;
  const leb: number[] = [];
  do { let value = Number(time & 127n); time >>= 7n; if (time > 0n) value |= 128; leb.push(value); } while (time > 0n);
  const tree = [1,
    labeled("canister", labeled(Principal.fromText(canisterId).toUint8Array(), labeled("certified_data", leaf(root)))),
    labeled("time", leaf(new Uint8Array(leb))),
  ] as HashTree;
  const message = new Uint8Array([...domain_sep("ic-state-root"), ...await reconstruct(tree)]);
  const certificate = Cbor.encode({ tree, signature: bls12_381.signShortSignature(message, secretKey) });
  return { status: "replied", reply: { arg: IDL.encode([metadataReplyType], [{ certificate, witness: Cbor.encode(witness), asset: bytes ? [{ content: bytes, chunks: 1n }] : [] }]) } } as unknown as ApiQueryResponse;
}
