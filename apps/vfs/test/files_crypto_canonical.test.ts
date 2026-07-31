import { describe, expect, test } from "bun:test";
import {
  contentBlockAad,
  contentBlockNonce,
  contentKeyAad,
  id128,
  lp,
  metadataAad,
  u16be,
  u32be,
  u64be,
  vaultContext,
} from "../src/crypto/canonical.ts";
import {
  computeNameTag,
  computeRootCommitment,
  decryptContentBlock,
  decryptMetadata,
  encryptContentBlock,
  encryptMetadata,
  planPrivateBlocks,
  unwrapContentCipher,
  wrapContentKey,
} from "../src/crypto/private_files.ts";
import type {
  FilesContentBinding,
  FilesContentBlockBinding,
  FilesMetadataBinding,
  FilesVaultContextInput,
} from "../src/crypto/types.ts";
import {
  decryptAesGcm,
  deriveVaultKeys,
  encryptAesGcm,
  importAesGcmKey,
} from "../src/crypto/webcrypto.ts";

const NODE_ID = {
  hi: "72623859790382856",
  lo: "1230066625199609624",
} as const;
const PARENT_ID = {
  hi: "2387509390608836392",
  lo: "3544952156018063160",
} as const;
const CONTENT_ID = {
  hi: "4702394921427289928",
  lo: "5859837686836516696",
} as const;
const CONTEXT_INPUT: FilesVaultContextInput = {
  neutronCanisterPrincipalBytes: Uint8Array.of(1, 2, 3),
  vaultId: bytes(16, 0x10),
  vaultSalt: bytes(32, 0x20),
};
const METADATA_BINDING: FilesMetadataBinding = {
  nodeId: NODE_ID,
  parentId: PARENT_ID,
  nodeKind: "file",
  metadataRevision: "9",
  declaredNameScalars: 7,
  nameTag: bytes(32, 0x70),
};
const CONTENT_BINDING: FilesContentBinding = {
  nodeId: NODE_ID,
  contentId: CONTENT_ID,
};
const BLOCK_BINDING: FilesContentBlockBinding = {
  ...CONTENT_BINDING,
  blockIndex: 0,
  totalBlockCount: 1,
  plaintextBlockLength: 3,
};

describe("Files canonical crypto encodings", () => {
  test("freezes length prefixes, fixed integers, ids, context, and AAD", () => {
    const context = vaultContext(CONTEXT_INPUT);
    expect(hex(lp("abc"))).toBe("00000003616263");
    expect(hex(u16be(0x1234))).toBe("1234");
    expect(hex(u32be(0x89ab_cdef))).toBe("89abcdef");
    expect(hex(u64be("72623859790382856"))).toBe("0102030405060708");
    expect(hex(id128(NODE_ID))).toBe(
      "01020304050607081112131415161718",
    );
    expect(hex(context)).toBe(
      "000000166e657574726f6e2e66696c65732e7661756c742e7632" +
        "00000003010203" +
        "0000000566696c6573" +
        "00000010102132435465768798a9bacbdcedfe0f" +
        "000000202031425364758697a8b9cadbecfd0e1f30415263748596a7b8c9daebfc0d1e2f",
    );
    expect(hex(metadataAad(context, METADATA_BINDING))).toBe(
      "000000196e657574726f6e2e66696c65732e6d657461646174612e7632" +
        "00000062" +
        hex(context) +
        "01020304050607081112131415161718" +
        "21222324252627283132333435363738" +
        "01" +
        "0000000000000009" +
        "0007" +
        "708192a3b4c5d6e7f8091a2b3c4d5e6f8091a2b3c4d5e6f708192a3b4c5d6e7f",
    );
    expect(hex(contentKeyAad(context, CONTENT_BINDING))).toBe(
      "0000001c6e657574726f6e2e66696c65732e636f6e74656e742d6b65792e7632" +
        "00000062" +
        hex(context) +
        "01020304050607081112131415161718" +
        "41424344454647485152535455565758",
    );
    expect(hex(contentBlockAad(context, BLOCK_BINDING))).toBe(
      "000000186e657574726f6e2e66696c65732e636f6e74656e742e7632" +
        "00000062" +
        hex(context) +
        "01020304050607081112131415161718" +
        "41424344454647485152535455565758" +
        "000000000000000100000003",
    );
    expect(hex(contentBlockNonce(0))).toBe("000000000000000000000000");
    expect(hex(contentBlockNonce(8))).toBe("000000000000000000000008");
  });

  test("freezes root, HKDF/HMAC, metadata, wrapper, and block vectors", async () => {
    const root = bytes(32, 0x40);
    const context = vaultContext(CONTEXT_INPUT);
    const keys = await deriveVaultKeys(root, context);
    expect(hex(await computeRootCommitment(CONTEXT_INPUT, root))).toBe(
      "4fb2920a49b99d3f14b7b4b0202644ca901ab41a9b10958477eaa25b35d80c5f",
    );
    expect(hex(await computeNameTag(keys, PARENT_ID, "cafe\u0301.txt"))).toBe(
      "794d699dd6a8b089871a57664b5396b684042b41b46ff9ac781dea68cc1c1564",
    );

    const metadataPlaintext = Uint8Array.of(0x61, 0x62, 0x63);
    const encryptedMetadata = await encryptMetadata(
      keys,
      METADATA_BINDING,
      metadataPlaintext,
    );
    expect(hex(encryptedMetadata)).toBe(
      "7cb36421e985a175a3e38d9470f7c32b7d1381",
    );
    expect(
      await decryptMetadata(keys, METADATA_BINDING, encryptedMetadata),
    ).toEqual(metadataPlaintext);

    const rawContentKey = bytes(32, 0x90);
    const wrapped = await wrapContentKey(
      keys,
      CONTENT_BINDING,
      rawContentKey,
    );
    expect(hex(wrapped)).toBe(
      "80848fe3bf86025c98293326e8b272c5e71af618a526a43877156a93ec0b2f5" +
        "161681642b039ae794741d5b483359326",
    );
    const cipher = await unwrapContentCipher(
      keys,
      CONTENT_BINDING,
      wrapped,
    );
    const encryptedBlock = await encryptContentBlock(
      cipher,
      context,
      BLOCK_BINDING,
      Uint8Array.of(1, 2, 3),
    );
    expect(hex(encryptedBlock)).toBe(
      "5364e66c1637a934d10425b14a57e1a7f50841",
    );
    expect(
      await decryptContentBlock(
        cipher,
        context,
        BLOCK_BINDING,
        encryptedBlock,
      ),
    ).toEqual(Uint8Array.of(1, 2, 3));
  });

  test("binds authentication to every metadata and content scalar", async () => {
    const context = vaultContext(CONTEXT_INPUT);
    const keys = await deriveVaultKeys(bytes(32, 0x40), context);
    const encryptedMetadata = await encryptMetadata(
      keys,
      METADATA_BINDING,
      Uint8Array.of(7, 8, 9),
    );
    await expect(
      decryptMetadata(
        keys,
        { ...METADATA_BINDING, metadataRevision: "10" },
        encryptedMetadata,
      ),
    ).rejects.toThrow();

    const raw = bytes(32, 0x90);
    const cipher = await importAesGcmKey(raw, ["encrypt", "decrypt"]);
    const encrypted = await encryptContentBlock(
      cipher,
      context,
      BLOCK_BINDING,
      Uint8Array.of(1, 2, 3),
    );
    await expect(
      decryptContentBlock(
        cipher,
        context,
        { ...BLOCK_BINDING, contentId: { ...CONTENT_ID, lo: "2" } },
        encrypted,
      ),
    ).rejects.toThrow();
    const changedTag = encrypted.slice();
    changedTag[changedTag.length - 1] =
      changedTag[changedTag.length - 1]! ^ 1;
    await expect(
      decryptContentBlock(cipher, context, BLOCK_BINDING, changedTag),
    ).rejects.toThrow();
  });

  test("accepts every private-file block and rejects geometry above the 64 MiB limit", () => {
    expect(() =>
      contentBlockAad(vaultContext(CONTEXT_INPUT), {
        ...CONTENT_BINDING,
        blockIndex: 35,
        totalBlockCount: 36,
        plaintextBlockLength: 1,
      })
    ).not.toThrow();
    expect(() =>
      contentBlockAad(vaultContext(CONTEXT_INPUT), {
        ...CONTENT_BINDING,
        blockIndex: 36,
        totalBlockCount: 37,
        plaintextBlockLength: 1,
      })
    ).toThrow("block index");
  });

  test("protects the root special binding and metadata size", async () => {
    const context = vaultContext(CONTEXT_INPUT);
    const keys = await deriveVaultKeys(bytes(32, 0x40), context);
    const rootBinding: FilesMetadataBinding = {
      nodeId: { hi: "0", lo: "0" },
      parentId: { hi: "0", lo: "0" },
      nodeKind: "folder",
      metadataRevision: "1",
      declaredNameScalars: 0,
      nameTag: new Uint8Array(32),
    };
    const encrypted = await encryptMetadata(
      keys,
      rootBinding,
      new Uint8Array(),
    );
    expect(encrypted).toHaveLength(16);
    expect(await decryptMetadata(keys, rootBinding, encrypted)).toHaveLength(0);
    await expect(
      encryptMetadata(
        keys,
        { ...rootBinding, nameTag: bytes(32, 1) },
        new Uint8Array(),
      ),
    ).rejects.toThrow("root metadata binding");
    await expect(
      encryptMetadata(keys, METADATA_BINDING, new Uint8Array(2_033)),
    ).rejects.toThrow("exceeds");
  });
});

describe("Files private block geometry and AES boundary", () => {
  test("freezes empty, boundary, and maximum private block plans", () => {
    expect(planPrivateBlocks(0)).toEqual({
      plaintextBytes: 0,
      plaintextBlockLengths: [0],
      ciphertextBlockLengths: [16],
      ciphertextBytes: 16,
    });
    expect(planPrivateBlocks(1_889_984)).toEqual({
      plaintextBytes: 1_889_984,
      plaintextBlockLengths: [1_889_984],
      ciphertextBlockLengths: [1_890_000],
      ciphertextBytes: 1_890_000,
    });
    expect(planPrivateBlocks(67_108_864)).toEqual({
      plaintextBytes: 67_108_864,
      plaintextBlockLengths: [
        959_424,
        ...new Array(35).fill(1_889_984),
      ],
      ciphertextBlockLengths: [
        959_440,
        ...new Array(35).fill(1_890_000),
      ],
      ciphertextBytes: 67_109_440,
    });
    expect(() => planPrivateBlocks(67_108_865)).toThrow();
  });

  test("matches the frozen AES-256-GCM zero vector with nonextractable keys", async () => {
    const key = await importAesGcmKey(
      new Uint8Array(32),
      ["encrypt", "decrypt"],
    );
    expect(key.key.extractable).toBe(false);
    await expect(key.subtle.exportKey("raw", key.key)).rejects.toThrow();
    const ciphertext = await encryptAesGcm(
      key,
      new Uint8Array(12),
      new Uint8Array(),
      new Uint8Array(16),
    );
    expect(hex(ciphertext)).toBe(
      "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919",
    );
    expect(
      await decryptAesGcm(
        key,
        new Uint8Array(12),
        new Uint8Array(),
        ciphertext,
      ),
    ).toEqual(new Uint8Array(16));
  });
});

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_value, index) => (seed + index * 17) & 0xff,
  );
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
