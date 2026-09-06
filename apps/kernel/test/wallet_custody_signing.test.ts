import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Principal } from "@dfinity/principal";

// Independent crypto/codec checks for the actual Motoko adapter fixture.
const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const signature = "91c5bd51ba175134ee4a6634a93c2f5cc3ae8fc9bac3c98b896055bf0e5cf71c44f3bb8f35cd8e2704c3630ab1a3a92475502316d25cb8c166d77bdad9f3a6c9";
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const hashParts = (parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts.flatMap((part) => {
  const size = Buffer.alloc(4); size.writeUInt32BE(part.length); return [size, Buffer.from(part)];
}))).digest("hex");
const text = (s: string) => Buffer.from(s, "utf8");
const literal = (hex: string) => `"${hex.match(/../g)!.map((byte) => `\\${byte}`).join("")}"`;

test("custody adapter fixture independently verifies the exact digest and compressed secp256k1 key", async () => {
  const source = await Bun.file(new URL("./motoko/wallet_custody_signing_service_test.mo", import.meta.url)).text();
  expect(source).toContain(literal(publicKey));
  expect(source).toContain(literal(signature));
  const digest = Buffer.alloc(32, 0x42);
  expect(secp256k1.verify(signature, digest, publicKey)).toBe(true);
  expect(secp256k1.verify(signature, createHash("sha256").update(digest).digest(), publicKey)).toBe(false);
});

test("custody namespace vector independently binds canister, installation, app, slot and authority", async () => {
  const namespace = hashParts([
    text("neutron.wallet-custody-signing.key.v1"), u64(3n),
    Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai").toUint8Array(),
    text("evm_wallet"), u64(17n), text("main"), text("ecdsa_secp256k1"),
    text("key_1"), text("neutron_wallet_custody_digest_v1"),
  ]);
  const source = await Bun.file(new URL("./motoko/wallet_custody_signing_service_test.mo", import.meta.url)).text();
  expect(source).toContain(`Namespace.hex(namespace.derivation_path[0]) == "${namespace}"`);
});
