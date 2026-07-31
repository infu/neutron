import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { Principal } from "@dfinity/principal";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import type {
  FilesCommittedVault,
  FilesContentBinding,
  FilesMetadataBinding,
} from "../src/crypto/types.ts";
import type {
  BrowserSecretCacheKey,
  BrowserSecretCachePut,
} from "neutron-tools/browser_secret_cache";
import type { FilesVetKeyPublicInfo } from "../src/crypto/vetkeys.ts";
import {
  OfficialFilesIbeAdapter,
  type FilesVetKeyHandle,
} from "../src/crypto/vetkeys.ts";
import {
  FilesCryptoWorkerClient,
  FilesCryptoWorkerClientError,
  assertFilesPersistentResident,
} from "../src/crypto/worker_client.ts";
import type {
  FilesCryptoWorkerResponse,
  FilesCryptoWorkerStatus,
} from "../src/crypto/worker_protocol.ts";
import {
  FilesCryptoWorkerRuntime,
  classifyFilesWorkerError,
} from "../src/crypto/worker_runtime.ts";
import { sha256 } from "../src/crypto/webcrypto.ts";

const PRINCIPAL_TEXT = "un4fu-tqaaa-aaaab-qadjq-cai";
const PRINCIPAL_BYTES =
  Principal.fromText(PRINCIPAL_TEXT).toUint8Array();
const NODE_ID = { hi: "1", lo: "2" } as const;
const CONTENT_BINDING: FilesContentBinding = {
  nodeId: NODE_ID,
  contentId: { hi: "3", lo: "4" },
};
const METADATA_BINDING: FilesMetadataBinding = {
  nodeId: NODE_ID,
  parentId: { hi: "0", lo: "0" },
  nodeKind: "file",
  metadataRevision: "1",
  declaredNameScalars: 8,
  nameTag: bytes(32, 0x71),
};

describe("Files crypto worker runtime", () => {
  test("stores an initialized vault only after commit and restores it before opening a transport session", async () => {
    const setup = await configuredCacheRuntime();
    const initialized = await setup.runtime.handle({
      id: 1,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    if (initialized.type !== "vault_initialized") {
      throw new Error("Expected a generated Files vault");
    }
    expect(setup.cache.putCalls).toHaveLength(0);

    const committed = await setup.runtime.handle({
      id: 2,
      type: "commit_vault_cache",
      vault: initialized.vault,
    });
    if (committed.type !== "vault_cache_committed") {
      throw new Error("Expected a committed Files vault cache");
    }
    expect(committed.stored).toBe(true);
    expect(setup.cache.putCalls.map(({ id }) => id).sort()).toEqual([
      "files-vault-public:v1:1",
      "files-vault-root:v1:1",
    ]);
    const cachedPublic = await setup.runtime.handle({
      id: 3,
      type: "load_cached_public_info",
      vault: {
        generation: "1",
        keyName: setup.current.keyName,
        publicKeyFingerprint:
          initialized.vault.wrapper.publicKeyFingerprint.slice(),
        vaultId: initialized.vault.context.vaultId.slice(),
        vaultSalt: initialized.vault.context.vaultSalt.slice(),
        rootCommitment: initialized.vault.rootCommitment.slice(),
        wrapperCiphertext:
          initialized.vault.wrapper.ciphertext.slice(),
      },
    });
    if (
      cachedPublic.type !== "cached_public_info" ||
      cachedPublic.publicInfo === null
    ) {
      throw new Error("Expected cached Files public information");
    }
    expect(cachedPublic.publicInfo.publicFingerprint).toEqual(
      setup.current.publicFingerprint,
    );

    await setup.runtime.handle({ id: 4, type: "lock" });
    const restored = await setup.runtime.handle({
      id: 5,
      type: "begin_unlock",
      generation: "1",
      vault: initialized.vault,
    });
    if (restored.type !== "vault_unlocked") {
      throw new Error("Expected a cached Files vault unlock");
    }
    expect(restored.status.unlockedGeneration).toBe("1");
    expect(restored.rewrapped).toBeNull();
    expect(setup.sessionCreations()).toBe(0);
  });

  test("falls back to a transport unlock for changed context, fingerprint, or cached root", async () => {
    const setup = await configuredCacheRuntime();
    const initialized = await setup.runtime.handle({
      id: 11,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    if (initialized.type !== "vault_initialized") {
      throw new Error("Expected a generated Files vault");
    }
    await setup.runtime.handle({
      id: 12,
      type: "commit_vault_cache",
      vault: initialized.vault,
    });
    await setup.runtime.handle({ id: 13, type: "lock" });

    const changedContext = cloneCommittedVault(initialized.vault);
    changedContext.context.vaultSalt[0] =
      changedContext.context.vaultSalt[0]! ^ 0xff;
    const contextMiss = await setup.runtime.handle({
      id: 14,
      type: "begin_unlock",
      generation: "1",
      vault: changedContext,
    });
    expect(contextMiss.type).toBe("unlock_request");
    expect(setup.sessionCreations()).toBe(1);
    await setup.runtime.handle({ id: 15, type: "cancel_unlock" });

    const rootEntry = setup.cache.entries.get("files-vault-root:v1:1");
    if (!rootEntry) throw new Error("Expected a cached Files vault root");
    rootEntry.secret[0] = rootEntry.secret[0]! ^ 0xff;
    const rootMiss = await setup.runtime.handle({
      id: 16,
      type: "begin_unlock",
      generation: "1",
      vault: initialized.vault,
    });
    expect(rootMiss.type).toBe("unlock_request");
    expect(setup.sessionCreations()).toBe(2);
    await setup.runtime.handle({ id: 17, type: "cancel_unlock" });
    rootEntry.secret[0] = rootEntry.secret[0]! ^ 0xff;

    const changedFixture = keyFixture(0x8c3bn, 0x61);
    const changed = await configuredCacheRuntime({
      cache: setup.cache,
      fixture: changedFixture,
    });
    const changedFingerprint = cloneCommittedVault(initialized.vault);
    changedFingerprint.wrapper.publicKeyFingerprint.set(
      changed.current.publicFingerprint,
    );
    const fingerprintMiss = await changed.runtime.handle({
      id: 18,
      type: "begin_unlock",
      generation: "1",
      vault: changedFingerprint,
    });
    expect(fingerprintMiss.type).toBe("unlock_request");
    expect(changed.sessionCreations()).toBe(1);
  });

  test("clears an uncommitted initialization candidate when locked", async () => {
    const setup = await configuredCacheRuntime();
    const initialized = await setup.runtime.handle({
      id: 21,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    if (initialized.type !== "vault_initialized") {
      throw new Error("Expected a generated Files vault");
    }
    expect(setup.cache.putCalls).toHaveLength(0);

    await setup.runtime.handle({ id: 22, type: "lock" });
    const pending = await setup.runtime.handle({
      id: 23,
      type: "begin_unlock",
      generation: "1",
      vault: initialized.vault,
    });
    if (pending.type !== "unlock_request") {
      throw new Error("Expected a transport Files vault unlock");
    }
    const unlocked = await setup.runtime.handle({
      id: 24,
      type: "complete_unlock",
      generation: "1",
      encryptedVetKey: bytes(192, 0x91),
      vault: initialized.vault,
    });
    expect(unlocked.type).toBe("vault_unlocked");

    await expect(setup.runtime.handle({
      id: 25,
      type: "commit_vault_cache",
      vault: initialized.vault,
    })).rejects.toThrow("locked");
  });

  test("keeps keys worker-local across initialize, use, rotation, and inactivity", async () => {
    const legacyFixture = keyFixture(0x5a17n, 0x31);
    const currentFixture = keyFixture(0x7b29n, 0x51);
    const previous = await publicInfo("1", legacyFixture);
    const current = await publicInfo("2", currentFixture);
    const sessionHandles = [
      legacyFixture.handle,
      currentFixture.handle,
    ];
    let now = 0;
    let inactivityLocks = 0;
    const runtime = new FilesCryptoWorkerRuntime<FilesVetKeyHandle>({
      ibeAdapter: new OfficialFilesIbeAdapter(),
      sessionFactory: () => {
        const handle = sessionHandles.shift();
        if (!handle) throw new Error("No test vetKey handle is queued");
        return new FakeTransportSession(handle);
      },
      randomBytes: deterministicRandom(),
      now: () => now,
      schedule: () => Object.freeze({}),
      cancelSchedule: () => undefined,
      onInactivityLock: () => {
        inactivityLocks += 1;
      },
    });

    const configured = await runtime.handle({
      id: 1,
      type: "configure",
      current: previous,
      previous: null,
      inactivityMs: 60_000,
    });
    expect(statusOf(configured).unlocked).toBe(false);

    const initialized = await runtime.handle({
      id: 2,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    if (initialized.type !== "vault_initialized") {
      throw new Error("Expected a generated Files vault");
    }
    expect(initialized.vault.wrapper.generation).toBe("1");
    expect(initialized.status.unlocked).toBe(true);
    expect(initialized.status.unlockedGeneration).toBe("1");

    const nameTag = await runtime.handle({
      id: 3,
      type: "name_tag",
      parentNodeId: { hi: "0", lo: "0" },
      filename: "report.txt",
    });
    if (nameTag.type !== "name_tag") throw new Error("Expected a name tag");
    expect(nameTag.nameTag).toHaveLength(32);

    const metadataPlaintext = Uint8Array.of(7, 8, 9);
    const metadataEncrypted = await runtime.handle({
      id: 4,
      type: "encrypt_metadata",
      binding: METADATA_BINDING,
      plaintext: metadataPlaintext,
    });
    expect(metadataPlaintext).toEqual(new Uint8Array(3));
    if (metadataEncrypted.type !== "metadata_encrypted") {
      throw new Error("Expected encrypted metadata");
    }
    const metadataCiphertext = metadataEncrypted.ciphertext.slice();
    const metadataDecrypted = await runtime.handle({
      id: 5,
      type: "decrypt_metadata",
      binding: METADATA_BINDING,
      ciphertext: metadataCiphertext,
    });
    expect(metadataCiphertext).toEqual(
      new Uint8Array(metadataEncrypted.ciphertext.byteLength),
    );
    if (metadataDecrypted.type !== "metadata_decrypted") {
      throw new Error("Expected decrypted metadata");
    }
    expect(metadataDecrypted.plaintext).toEqual(Uint8Array.of(7, 8, 9));

    const created = await runtime.handle({
      id: 6,
      type: "create_content_cipher",
      binding: CONTENT_BINDING,
    });
    if (created.type !== "content_cipher_ready" || !created.wrappedKey) {
      throw new Error("Expected a generated content cipher");
    }
    expect(created.wrappedKey).toHaveLength(48);
    const blockPlaintext = Uint8Array.of(1, 2, 3, 4);
    const blockBinding = {
      ...CONTENT_BINDING,
      blockIndex: 0,
      totalBlockCount: 1,
      plaintextBlockLength: 4,
    } as const;
    const blockEncrypted = await runtime.handle({
      id: 7,
      type: "encrypt_content_block",
      handle: created.handle,
      binding: blockBinding,
      plaintext: blockPlaintext,
    });
    expect(blockPlaintext).toEqual(new Uint8Array(4));
    if (blockEncrypted.type !== "content_block_encrypted") {
      throw new Error("Expected encrypted content");
    }
    const blockCiphertext = blockEncrypted.ciphertext.slice();
    const blockDecrypted = await runtime.handle({
      id: 8,
      type: "decrypt_content_block",
      handle: created.handle,
      binding: blockBinding,
      ciphertext: blockCiphertext,
    });
    expect(blockCiphertext).toEqual(
      new Uint8Array(blockEncrypted.ciphertext.byteLength),
    );
    if (blockDecrypted.type !== "content_block_decrypted") {
      throw new Error("Expected decrypted content");
    }
    expect(blockDecrypted.plaintext).toEqual(Uint8Array.of(1, 2, 3, 4));

    const operationId = "0123456789abcdef0123456789abcdef";
    const retryBytes = Uint8Array.of(0x61, 0x62, 0x63);
    const retained = await runtime.handle({
      id: 9,
      type: "retain_retry_frame",
      operationId,
      frameOrdinal: 0,
      frame: retryBytes,
    });
    expect(retryBytes).toEqual(new Uint8Array(3));
    if (retained.type !== "retry_frame_retained") {
      throw new Error("Expected a retained retry frame");
    }
    expect(retained.fingerprint).toHaveLength(32);
    const firstExport = await runtime.handle({
      id: 10,
      type: "export_retry_frame",
      operationId,
      frameOrdinal: 0,
    });
    const secondExport = await runtime.handle({
      id: 11,
      type: "export_retry_frame",
      operationId,
      frameOrdinal: 0,
    });
    if (
      firstExport.type !== "retry_frame_exported" ||
      secondExport.type !== "retry_frame_exported"
    ) {
      throw new Error("Expected exported retry frames");
    }
    firstExport.frame.fill(0);
    expect(secondExport.frame).toEqual(Uint8Array.of(0x61, 0x62, 0x63));
    const conflictingFrame = Uint8Array.of(0x61, 0x62, 0x64);
    await expect(
      runtime.handle({
        id: 12,
        type: "retain_retry_frame",
        operationId,
        frameOrdinal: 0,
        frame: conflictingFrame,
      }),
    ).rejects.toThrow("invalid_request");
    expect(conflictingFrame).toEqual(new Uint8Array(3));
    const lastPrivateFrame = Uint8Array.of(0x64);
    await expect(runtime.handle({
      id: 100,
      type: "retain_retry_frame",
      operationId,
      frameOrdinal: 35,
      frame: lastPrivateFrame,
    })).resolves.toMatchObject({ type: "retry_frame_retained" });
    const beyondPrivateFrame = Uint8Array.of(0x65);
    await expect(runtime.handle({
      id: 101,
      type: "retain_retry_frame",
      operationId,
      frameOrdinal: 36,
      frame: beyondPrivateFrame,
    })).rejects.toThrow("invalid_request");

    const rotated = await runtime.handle({
      id: 13,
      type: "configure",
      current,
      previous,
      inactivityMs: 60_000,
    });
    expect(statusOf(rotated).unlocked).toBe(false);
    expect(statusOf(rotated).contentCipherCount).toBe(0);
    expect(statusOf(rotated).retryFrameCount).toBe(0);

    const legacyBegin = await runtime.handle({
      id: 14,
      type: "begin_unlock",
      generation: "1",
    });
    if (legacyBegin.type !== "unlock_request") {
      throw new Error("Expected a previous unlock request");
    }
    expect(legacyBegin.requestNonce).toHaveLength(32);
    expect(legacyBegin.transportPublicKey).toHaveLength(48);
    const legacyUnlocked = await runtime.handle({
      id: 15,
      type: "complete_unlock",
      generation: "1",
      encryptedVetKey: bytes(192, 0x91),
      vault: initialized.vault,
      rewrapToGeneration: "2",
    });
    if (
      legacyUnlocked.type !== "vault_unlocked" ||
      legacyUnlocked.rewrapped === null
    ) {
      throw new Error("Expected an atomic Files vault rewrap");
    }
    expect(legacyUnlocked.status.unlockedGeneration).toBe("1");
    expect(legacyUnlocked.rewrapped.generation).toBe("2");
    expect(legacyUnlocked.rewrapped.publicKeyFingerprint).toEqual(
      current.publicFingerprint,
    );

    await runtime.handle({ id: 16, type: "lock" });
    await runtime.handle({
      id: 17,
      type: "begin_unlock",
      generation: "2",
    });
    const currentUnlocked = await runtime.handle({
      id: 18,
      type: "complete_unlock",
      generation: "2",
      encryptedVetKey: bytes(192, 0xa1),
      vault: {
        ...initialized.vault,
        wrapper: legacyUnlocked.rewrapped,
      },
    });
    if (currentUnlocked.type !== "vault_unlocked") {
      throw new Error("Expected the rewrapped vault to unlock");
    }
    expect(currentUnlocked.status.unlockedGeneration).toBe("2");

    now = 60_000;
    const expired = await runtime.handle({ id: 19, type: "status" });
    expect(statusOf(expired).unlocked).toBe(false);
    expect(statusOf(expired).contentCipherCount).toBe(0);
    expect(statusOf(expired).retryFrameCount).toBe(0);
    expect(inactivityLocks).toBe(1);
  });

  test("can keep an active Files session open without an inactivity deadline", async () => {
    const fixture = keyFixture(0x7b29n, 0x51);
    const current = await publicInfo("1", fixture);
    let now = 0;
    let inactivityLocks = 0;
    const runtime = new FilesCryptoWorkerRuntime<FilesVetKeyHandle>({
      ibeAdapter: new OfficialFilesIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(fixture.handle),
      randomBytes: deterministicRandom(),
      now: () => now,
      schedule: () => Object.freeze({}),
      cancelSchedule: () => undefined,
      onInactivityLock: () => {
        inactivityLocks += 1;
      },
    });

    await runtime.handle({
      id: 1,
      type: "configure",
      current,
      previous: null,
      inactivityMs: null,
    });
    const initialized = await runtime.handle({
      id: 2,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    if (initialized.type !== "vault_initialized") {
      throw new Error("Expected a generated Files vault");
    }
    expect(initialized.status.unlocked).toBe(true);
    expect(initialized.status.inactivityExpiresAt).toBeNull();

    now = 365 * 24 * 60 * 60_000;
    const stillOpen = await runtime.handle({ id: 3, type: "status" });
    expect(statusOf(stillOpen).unlocked).toBe(true);
    expect(inactivityLocks).toBe(0);
  });

  test("a deadline that wins during crypto erases state installed by the losing operation", async () => {
    const fixture = keyFixture(0x6c31n, 0x41);
    const current = await publicInfo("1", fixture);
    const realSubtle = globalThis.crypto.subtle;
    let holdSign = false;
    let markSignStarted: () => void = () => {};
    const signStarted = new Promise<void>((resolve) => {
      markSignStarted = resolve;
    });
    let releaseSign: () => void = () => {};
    const signReleased = new Promise<void>((resolve) => {
      releaseSign = resolve;
    });
    const subtle = new Proxy(realSubtle, {
      get(target, property) {
        if (property === "sign") {
          return async (...args: Parameters<SubtleCrypto["sign"]>) => {
            if (holdSign) {
              markSignStarted();
              await signReleased;
            }
            return target.sign(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SubtleCrypto;
    type DeadlineHandle = {
      callback(): void;
      cancelled: boolean;
      delayMs: number;
    };
    let latestDeadline: DeadlineHandle | null = null;
    let now = 0;
    const runtime = new FilesCryptoWorkerRuntime<FilesVetKeyHandle>({
      ibeAdapter: new OfficialFilesIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(fixture.handle),
      randomBytes: deterministicRandom(),
      subtle,
      now: () => now,
      schedule(callback, delayMs) {
        const handle: DeadlineHandle = {
          callback,
          cancelled: false,
          delayMs,
        };
        latestDeadline = handle;
        return handle;
      },
      cancelSchedule(handle) {
        (handle as DeadlineHandle).cancelled = true;
      },
    });

    await runtime.handle({
      id: 201,
      type: "configure",
      current,
      previous: null,
      inactivityMs: 60_000,
    });
    await runtime.handle({
      id: 202,
      type: "initialize_vault",
      neutronCanisterPrincipalBytes: PRINCIPAL_BYTES,
    });
    holdSign = true;
    const operation = runtime.handle({
      id: 203,
      type: "name_tag",
      parentNodeId: { hi: "0", lo: "0" },
      filename: "deadline.txt",
    });
    await signStarted;
    const expiry = latestDeadline as DeadlineHandle | null;
    if (!expiry || expiry.cancelled) {
      throw new Error("Expected an active Files crypto deadline");
    }
    expect(expiry.delayMs).toBe(60_000);
    now = 60_000;
    expiry.callback();
    releaseSign();
    await expect(operation).rejects.toThrow("locked");

    const status = statusOf(await runtime.handle({
      id: 204,
      type: "status",
    }));
    expect(status.unlocked).toBe(false);
    expect(status.unlockedGeneration).toBeNull();
    expect(status.inactivityExpiresAt).toBeNull();
  });

  test("classifies caller-safe worker failures without leaking details", () => {
    expect(classifyFilesWorkerError(new Error("AES decrypt failed"))).toEqual({
      code: "authentication_failed",
    });
    expect(classifyFilesWorkerError(new Error("wrong binding"))).toEqual({
      code: "binding_changed",
    });
    expect(classifyFilesWorkerError(new Error("implementation exploded"))).toEqual({
      code: "crypto_unavailable",
    });
  });
});

describe("Files crypto worker client boundary", () => {
  test("transfers owned sensitive buffers and keeps retry/error state bounded", async () => {
    const worker = new FakeWorker();
    const client = new FilesCryptoWorkerClient(
      worker as unknown as Worker,
    );
    const plaintext = Uint8Array.of(1, 2, 3);
    const response = client.call({
      type: "encrypt_metadata",
      binding: METADATA_BINDING,
      plaintext,
    });
    expect(plaintext.byteLength).toBe(0);
    expect(await response).toEqual({
      type: "metadata_encrypted",
      ciphertext: Uint8Array.of(0xaa),
    });
    expect(worker.lastMessage?.type).toBe("encrypt_metadata");
    expect(
      (
        worker.lastMessage as
          | { plaintext?: Uint8Array }
          | undefined
      )?.plaintext,
    ).toEqual(Uint8Array.of(1, 2, 3));

    const backing = new ArrayBuffer(4);
    const partial = new Uint8Array(backing, 1, 2);
    await expect(
      client.call({
        type: "encrypt_metadata",
        binding: METADATA_BINDING,
        plaintext: partial,
      }),
    ).rejects.toThrow("standalone ArrayBuffer");
    expect(backing.byteLength).toBe(4);

    worker.nextError = "locked";
    await expect(client.status()).rejects.toBeInstanceOf(
      FilesCryptoWorkerClientError,
    );
    let inactivityEvents = 0;
    client.onInactivityLock(() => {
      inactivityEvents += 1;
    });
    worker.emitMessage({ event: "inactivity_locked" });
    expect(inactivityEvents).toBe(1);
    client.close();
    expect(worker.terminated).toBe(true);
  });

  test("requires the persistent resident boundary", () => {
    expect(() =>
      assertFilesPersistentResident({ credentialless: true })
    ).toThrow("persistent");
    expect(() =>
      assertFilesPersistentResident({ credentialless: false })
    ).not.toThrow();
    expect(() => assertFilesPersistentResident({})).not.toThrow();
  });

  test("terminates on timeout and ignores every late worker response", async () => {
    const worker = new FakeWorker();
    worker.holdResponses = true;
    const client = new FilesCryptoWorkerClient(
      worker as unknown as Worker,
    );
    let lockEvents = 0;
    client.onInactivityLock(() => {
      lockEvents += 1;
    });

    const pending = client.call({ type: "status" }, 1);
    const pendingRejected = expect(pending).rejects.toThrow("timed out");
    const requestId = worker.lastMessage?.id;
    expect(typeof requestId).toBe("number");
    await pendingRejected;
    expect(worker.terminated).toBe(true);
    expect(lockEvents).toBe(1);

    worker.emitMessage({
      id: requestId as number,
      ok: { type: "status", status: lockedStatus() },
    });
    await expect(client.status()).rejects.toThrow("closed");
    expect(lockEvents).toBe(1);
  });
});

class FakeTransportSession {
  #handle: VetKey | null;
  readonly #publicKey = bytes(48, 0xc1);

  constructor(handle: VetKey) {
    this.#handle = handle;
  }

  get consumed(): boolean {
    return this.#handle === null;
  }

  publicKeyBytes(): Uint8Array {
    return this.#publicKey.slice();
  }

  cancel(): void {
    this.#handle = null;
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): VetKey {
    const handle = this.#handle;
    this.#handle = null;
    if (!handle) throw new Error("Test transport session was consumed");
    if (
      input.encryptedVetKey.byteLength !== 192 ||
      input.contextPublicKey.byteLength !== 96 ||
      input.derivationInput.byteLength !== 32
    ) {
      throw new Error("Test transport input was invalid");
    }
    return handle;
  }
}

type InMemorySecretCacheEntry = {
  binding: Uint8Array;
  secret: Uint8Array;
  expiresAtMs: number;
};

class InMemorySecretCache {
  readonly entries = new Map<string, InMemorySecretCacheEntry>();
  readonly putCalls: BrowserSecretCachePut[] = [];

  async get(key: BrowserSecretCacheKey): Promise<Uint8Array | null> {
    const entry = this.entries.get(key.id);
    if (!entry || !equalTestBytes(entry.binding, key.binding)) return null;
    return entry.secret.slice();
  }

  async put(value: BrowserSecretCachePut): Promise<boolean> {
    const copy = {
      id: value.id,
      binding: value.binding.slice(),
      secret: value.secret.slice(),
      expiresAtMs: value.expiresAtMs,
    };
    this.putCalls.push(copy);
    this.entries.set(value.id, {
      binding: copy.binding.slice(),
      secret: copy.secret.slice(),
      expiresAtMs: copy.expiresAtMs,
    });
    return true;
  }

  async prune(): Promise<void> {
    // The runtime tests exercise binding and secret validation, not expiry.
  }
}

class FakeWorker {
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
  lastMessage: Record<string, unknown> | null = null;
  nextError: "locked" | null = null;
  holdResponses = false;
  terminated = false;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const callback =
      typeof listener === "function"
        ? (event: unknown) => listener(event as Event)
        : (event: unknown) => listener.handleEvent(event as Event);
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.#listeners.set(type, listeners);
  }

  postMessage(
    message: Record<string, unknown>,
    transfer: Transferable[],
  ): void {
    const received = structuredClone(message, { transfer });
    this.lastMessage = received;
    if (this.holdResponses) return;
    queueMicrotask(() => {
      const id = received.id as number;
      if (this.nextError) {
        const code = this.nextError;
        this.nextError = null;
        this.emitMessage({ id, error: { code } });
        return;
      }
      const ok =
        received.type === "encrypt_metadata"
          ? {
              type: "metadata_encrypted" as const,
              ciphertext: Uint8Array.of(0xaa),
            }
          : {
              type: "status" as const,
              status: lockedStatus(),
            };
      this.emitMessage({ id, ok });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(
    data: FilesCryptoWorkerResponse | { event: "inactivity_locked" },
  ): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data });
    }
  }
}

function statusOf(
  result: Awaited<ReturnType<FilesCryptoWorkerRuntime["handle"]>>,
): FilesCryptoWorkerStatus {
  if (result.type !== "status") throw new Error("Expected Files status");
  return result.status;
}

function lockedStatus(): FilesCryptoWorkerStatus {
  return {
    configured: true,
    currentGeneration: "2",
    previousGeneration: "1",
    unlocked: false,
    unlockedGeneration: null,
    pendingGeneration: null,
    inactivityExpiresAt: null,
    contentCipherCount: 0,
    retryFrameCount: 0,
  };
}

async function configuredCacheRuntime(options: {
  cache?: InMemorySecretCache;
  fixture?: ReturnType<typeof keyFixture>;
} = {}): Promise<{
  runtime: FilesCryptoWorkerRuntime<FilesVetKeyHandle>;
  current: FilesVetKeyPublicInfo;
  cache: InMemorySecretCache;
  sessionCreations(): number;
}> {
  const fixture = options.fixture ?? keyFixture(0x7b29n, 0x51);
  const current = await publicInfo("1", fixture);
  const cache = options.cache ?? new InMemorySecretCache();
  let sessionCreations = 0;
  const runtime = new FilesCryptoWorkerRuntime<FilesVetKeyHandle>({
    ibeAdapter: new OfficialFilesIbeAdapter(),
    sessionFactory: () => {
      sessionCreations += 1;
      return new FakeTransportSession(fixture.handle);
    },
    randomBytes: deterministicRandom(),
    now: () => 1_000,
    schedule: () => Object.freeze({}),
    cancelSchedule: () => undefined,
    secretCache: cache,
  });
  await runtime.handle({
    id: 1000,
    type: "configure",
    current,
    previous: null,
    inactivityMs: null,
  });
  return {
    runtime,
    current,
    cache,
    sessionCreations: () => sessionCreations,
  };
}

function cloneCommittedVault(
  vault: FilesCommittedVault,
): FilesCommittedVault {
  return {
    context: {
      neutronCanisterPrincipalBytes:
        vault.context.neutronCanisterPrincipalBytes.slice(),
      vaultId: vault.context.vaultId.slice(),
      vaultSalt: vault.context.vaultSalt.slice(),
    },
    rootCommitment: vault.rootCommitment.slice(),
    wrapper: {
      generation: vault.wrapper.generation,
      publicKeyFingerprint: vault.wrapper.publicKeyFingerprint.slice(),
      ciphertext: vault.wrapper.ciphertext.slice(),
    },
  };
}

function equalTestBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function publicInfo(
  generation: string,
  fixture: ReturnType<typeof keyFixture>,
): Promise<FilesVetKeyPublicInfo> {
  return {
    canisterPrincipal: PRINCIPAL_TEXT,
    canisterPrincipalBytes: PRINCIPAL_BYTES,
    slot: "files_vault",
    generation,
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: fixture.publicKey,
    publicFingerprint: await sha256(fixture.publicKey),
    derivationInput: fixture.identity,
  };
}

function keyFixture(
  secretScalar: bigint,
  identitySeed: number,
): {
  publicKey: Uint8Array;
  identity: Uint8Array;
  handle: VetKey;
} {
  const publicPoint = bls12_381.G2.Point.BASE.multiply(secretScalar);
  const publicKey = new DerivedPublicKey(publicPoint);
  const identity = bytes(32, identitySeed);
  return {
    publicKey: publicKey.publicKeyBytes(),
    identity,
    handle: new VetKey(
      augmentedHashToG1(publicKey, identity).multiply(secretScalar),
    ),
  };
}

function deterministicRandom(): (length: number) => Uint8Array {
  let seed = 1;
  return (length) => bytes(length, seed++);
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_value, index) => (seed + index * 17) & 0xff,
  );
}
