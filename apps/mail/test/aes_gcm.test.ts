import { expect, test } from "bun:test";
import {
  decryptMailAesGcm,
  encryptMailAesGcm,
  importMailAesGcmKey,
} from "../src/aes_gcm.ts";

const ZERO_AES_256_GCM_VECTOR =
  "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919";

test("WebCrypto matches the frozen AES-256-GCM vector with a non-extractable key", async () => {
  const rawKey = new Uint8Array(32);
  const nonce = new Uint8Array(12);
  const aad = new Uint8Array();
  const plaintext = new Uint8Array(16);
  const webcrypto = await importMailAesGcmKey(
    rawKey,
    ["encrypt", "decrypt"],
    requireSubtleCrypto(),
  );

  expect(webcrypto.key.extractable).toBe(false);
  expect(webcrypto.key.type).toBe("secret");
  expect(webcrypto.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  await expect(webcrypto.subtle.exportKey("raw", webcrypto.key)).rejects.toThrow();
  const webcryptoCiphertext = await encryptMailAesGcm(webcrypto, nonce, aad, plaintext);

  expect(hex(webcryptoCiphertext)).toBe(ZERO_AES_256_GCM_VECTOR);
  expect(await decryptMailAesGcm(webcrypto, nonce, aad, webcryptoCiphertext))
    .toEqual(plaintext);
});

test("WebCrypto authenticates a canonical Mail header-sized section", async () => {
  const rawKey = bytes(32, 0x21);
  const nonce = bytes(12, 0x71);
  const aad = bytes(137, 0x42);
  const plaintext = bytes(2_048, 0x91);
  const webcrypto = await importMailAesGcmKey(
    rawKey,
    ["encrypt", "decrypt"],
    requireSubtleCrypto(),
  );
  const webcryptoCiphertext = await encryptMailAesGcm(webcrypto, nonce, aad, plaintext);

  expect(webcryptoCiphertext.byteLength).toBe(2_064);
  expect(await decryptMailAesGcm(webcrypto, nonce, aad, webcryptoCiphertext))
    .toEqual(plaintext);

  const tampered = webcryptoCiphertext.slice();
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  await expect(decryptMailAesGcm(webcrypto, nonce, aad, tampered)).rejects.toThrow();
});

test("AES-GCM fails closed without SubtleCrypto", async () => {
  await expect(importMailAesGcmKey(new Uint8Array(32), ["encrypt"], null))
    .rejects.toThrow("Secure WebCrypto AES-GCM is unavailable");
});

test("AES-GCM boundary rejects malformed key, usage, nonce, and short ciphertext", async () => {
  await expect(importMailAesGcmKey(new Uint8Array(31), ["encrypt"], null))
    .rejects.toThrow("AES-256 key must be 32 bytes");
  await expect(importMailAesGcmKey(
    new Uint8Array(32),
    [],
    requireSubtleCrypto(),
  )).rejects.toThrow("AES-GCM key usages are invalid");
  await expect(importMailAesGcmKey(
    new Uint8Array(32),
    ["decrypt", "decrypt"],
    requireSubtleCrypto(),
  )).rejects.toThrow("AES-GCM key usages are invalid");
  const key = await importMailAesGcmKey(
    new Uint8Array(32),
    ["decrypt"],
    requireSubtleCrypto(),
  );
  await expect(decryptMailAesGcm(
    key,
    new Uint8Array(11),
    new Uint8Array(),
    new Uint8Array(16),
  )).rejects.toThrow("AES-GCM nonce must be 12 bytes");
  await expect(decryptMailAesGcm(
    key,
    new Uint8Array(12),
    new Uint8Array(),
    new Uint8Array(15),
  )).rejects.toThrow("AES-GCM ciphertext is too short");
});

function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("The test runtime has no WebCrypto SubtleCrypto");
  return subtle;
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index * 29) & 0xff);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
