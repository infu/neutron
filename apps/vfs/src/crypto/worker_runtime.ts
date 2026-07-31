import { Principal } from "@dfinity/principal";
import {
  BROWSER_SECRET_CACHE_MAX_TTL_MS,
  createBrowserSecretCache,
  type BrowserSecretCache,
} from "neutron-tools/browser_secret_cache";
import {
  assertBytes,
  assertContentBinding,
  assertFixedBytes,
  concatBytes,
  assertVaultContextInput,
  equalBytes,
  lp,
  u64be,
  utf8,
  vaultContext,
} from "./canonical.ts";
import {
  computeNameTag,
  computeRootCommitment,
  decryptContentBlock,
  decryptMetadata,
  encryptContentBlock,
  encryptMetadata,
  generateContentCipher,
  unwrapContentCipher,
  verifyRootCommitment,
} from "./private_files.ts";
import type {
  FilesCommittedVault,
  FilesContentBinding,
  FilesGeneratedVault,
  FilesVaultContextInput,
  FilesVaultWrapper,
} from "./types.ts";
import {
  FILES_PRIVATE_FILE_MAX_BLOCKS,
  FILES_SHA256_BYTES,
  FILES_VAULT_ID_BYTES,
  FILES_VAULT_ROOT_BYTES,
  FILES_VAULT_SALT_BYTES,
} from "./types.ts";
import {
  filesIbePublicInfo,
  OfficialFilesIbeAdapter,
  sameFilesVetKeyBinding,
  validateFilesVetKeyPublicInfo,
  FilesVetKeyTransportSession,
  FILES_VETKEY_SLOT,
  FILES_IBE_SEED_BYTES,
  FILES_IBE_WRAPPER_BYTES,
  FILES_ENCRYPTED_VETKEY_BYTES,
  FILES_DERIVATION_INPUT_BYTES,
  FILES_TRANSPORT_PUBLIC_KEY_BYTES,
  type FilesIbeAdapter,
  type FilesVetKeyHandle,
  type FilesVetKeyPublicInfo,
} from "./vetkeys.ts";
import {
  FILES_WORKER_DEFAULT_INACTIVITY_MS,
  FILES_WORKER_MAX_CONTENT_CIPHERS,
  FILES_WORKER_MAX_FRAME_BYTES,
  FILES_WORKER_MAX_INACTIVITY_MS,
  FILES_WORKER_MAX_RETRY_FRAMES,
  FILES_WORKER_MIN_INACTIVITY_MS,
  FILES_WORKER_UNLOCK_CHALLENGE_MS,
  type FilesCryptoWorkerError,
  type FilesCryptoWorkerErrorCode,
  type FilesCryptoWorkerEvent,
  type FilesCryptoWorkerRequest,
  type FilesCryptoWorkerResponse,
  type FilesCryptoWorkerResult,
  type FilesCryptoWorkerStatus,
  type FilesVaultCacheDescriptor,
  type FilesVaultPublicCacheDescriptor,
} from "./worker_protocol.ts";
import {
  deriveVaultKeys,
  requireFilesSubtleCrypto,
  secureRandomBytes,
  sha256,
  zeroBytes,
  type FilesAesGcmKey,
  type FilesVaultKeys,
} from "./webcrypto.ts";

type TransportSession<KeyHandle> = {
  publicKeyBytes(): Uint8Array;
  readonly consumed: boolean;
  cancel(): void;
  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): KeyHandle;
};

type PendingUnlock<KeyHandle> = {
  generation: string;
  session: TransportSession<KeyHandle>;
  expiresAt: number;
};

type ContentCipher = {
  binding: FilesContentBinding;
  cipher: FilesAesGcmKey;
};

type RetryFrame = {
  operationId: string;
  frameOrdinal: number;
  bytes: Uint8Array;
  fingerprint: Uint8Array;
};

type VaultCacheCandidate = {
  root: Uint8Array;
  vault: FilesCommittedVault;
};

export type FilesCryptoWorkerRuntimeDependencies<KeyHandle> = Readonly<{
  ibeAdapter: FilesIbeAdapter<KeyHandle>;
  sessionFactory: () => TransportSession<KeyHandle>;
  subtle?: SubtleCrypto;
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  onInactivityLock?: () => void;
  secretCache?: Pick<
    BrowserSecretCache,
    "get" | "put" | "prune"
  > | null;
}>;

export class FilesCryptoWorkerRuntime<
  KeyHandle = FilesVetKeyHandle,
> {
  readonly #ibeAdapter: FilesIbeAdapter<KeyHandle>;
  readonly #sessionFactory: () => TransportSession<KeyHandle>;
  readonly #subtle: SubtleCrypto;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelSchedule: (handle: unknown) => void;
  readonly #onInactivityLock: () => void;
  readonly #secretCache: Pick<
    BrowserSecretCache,
    "get" | "put" | "prune"
  > | null;

  #current: FilesVetKeyPublicInfo | null = null;
  #previous: FilesVetKeyPublicInfo | null = null;
  #pending: PendingUnlock<KeyHandle> | null = null;
  #keys: FilesVaultKeys | null = null;
  #contextInput: FilesVaultContextInput | null = null;
  #unlockedGeneration: string | null = null;
  #contentCiphers = new Map<string, ContentCipher>();
  #retryFrames = new Map<string, RetryFrame>();
  #vaultCacheCandidate: VaultCacheCandidate | null = null;
  #inactivityMs: number | null = FILES_WORKER_DEFAULT_INACTIVITY_MS;
  #inactivityExpiresAt: number | null = null;
  #deadlineHandle: unknown = null;
  #serial: Promise<void> = Promise.resolve();
  #securityFence = 0;

  constructor(
    dependencies: FilesCryptoWorkerRuntimeDependencies<KeyHandle>,
  ) {
    this.#ibeAdapter = dependencies.ibeAdapter;
    this.#sessionFactory = dependencies.sessionFactory;
    this.#subtle = dependencies.subtle ?? requireFilesSubtleCrypto();
    this.#randomBytes = dependencies.randomBytes ?? secureRandomBytes;
    this.#now = dependencies.now ?? Date.now;
    this.#schedule = dependencies.schedule ?? scheduleUnrefTimeout;
    this.#cancelSchedule =
      dependencies.cancelSchedule ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onInactivityLock =
      dependencies.onInactivityLock ?? (() => undefined);
    this.#secretCache = dependencies.secretCache ?? null;
  }

  static official(
    onInactivityLock: () => void = () => undefined,
  ): FilesCryptoWorkerRuntime<FilesVetKeyHandle> {
    return new FilesCryptoWorkerRuntime({
      ibeAdapter: new OfficialFilesIbeAdapter(),
      sessionFactory: () => FilesVetKeyTransportSession.random(),
      onInactivityLock,
      secretCache: createBrowserSecretCache(),
    });
  }

  handle(
    request: FilesCryptoWorkerRequest,
  ): Promise<FilesCryptoWorkerResult> {
    assertRequestId(request.id);
    if (
      request.type === "lock" ||
      request.type === "reset" ||
      request.type === "configure"
    ) {
      this.#raiseSecurityFence();
    }
    const fence = this.#securityFence;
    return this.#enqueue(async () => {
      let result: FilesCryptoWorkerResult;
      try {
        result = await this.#handleNow(request);
      } catch (error) {
        if (
          isSensitiveWorkerRequest(request) &&
          fence !== this.#securityFence
        ) {
          // A lock or expiry that wins while crypto is awaiting must also
          // erase any state the losing operation established before failing.
          this.#lockVolatile();
          throw new FilesWorkerFault("locked");
        }
        throw error;
      }
      if (
        isSensitiveWorkerRequest(request) &&
        fence !== this.#securityFence
      ) {
        wipeWorkerResult(result);
        // The result fence alone is insufficient: an async unlock or crypto
        // operation may have touched a new deadline or installed keys before
        // noticing that the prior authority expired.
        this.#lockVolatile();
        throw new FilesWorkerFault("locked");
      }
      return result;
    });
  }

  async #handleNow(
    request: FilesCryptoWorkerRequest,
  ): Promise<FilesCryptoWorkerResult> {
    this.#expire();
    switch (request.type) {
      case "configure":
        return {
          type: "status",
          status: await this.#configure(
            request.current,
            request.previous,
            request.inactivityMs,
          ),
        };
      case "initialize_vault":
        return this.#initializeVault(request.neutronCanisterPrincipalBytes);
      case "begin_unlock":
        return this.#beginUnlock(
          request.generation,
          request.vault,
          request.rewrapToGeneration,
        );
      case "complete_unlock":
        return this.#completeUnlock(
          request.generation,
          request.encryptedVetKey,
          request.vault,
          request.rewrapToGeneration,
        );
      case "load_cached_public_info":
        return this.#loadCachedPublicInfo(request.vault);
      case "commit_vault_cache":
        return this.#commitVaultCache(request.vault);
      case "cancel_unlock":
        this.#cancelPendingUnlock();
        return { type: "cancelled" };
      case "lock":
        this.#lockVolatile();
        return { type: "status", status: this.#status() };
      case "reset":
        this.#reset();
        return { type: "status", status: this.#status() };
      case "status":
        return { type: "status", status: this.#status() };
      case "name_tag": {
        const keys = this.#requireKeys();
        const nameTag = await computeNameTag(
          keys,
          request.parentNodeId,
          request.filename,
        );
        this.#touch();
        return { type: "name_tag", nameTag };
      }
      case "encrypt_metadata": {
        const keys = this.#requireKeys();
        try {
          const ciphertext = await encryptMetadata(
            keys,
            request.binding,
            request.plaintext,
          );
          this.#touch();
          return { type: "metadata_encrypted", ciphertext };
        } finally {
          zeroBytes(request.plaintext);
        }
      }
      case "decrypt_metadata": {
        const keys = this.#requireKeys();
        try {
          const plaintext = await decryptMetadata(
            keys,
            request.binding,
            request.ciphertext,
          );
          this.#touch();
          return { type: "metadata_decrypted", plaintext };
        } finally {
          zeroBytes(request.ciphertext);
        }
      }
      case "create_content_cipher":
        return this.#createContentCipher(request.binding);
      case "open_content_cipher":
        return this.#openContentCipher(
          request.binding,
          request.wrappedKey,
        );
      case "release_content_cipher":
        this.#releaseContentCipher(request.handle);
        return { type: "content_cipher_released" };
      case "encrypt_content_block":
        return this.#encryptContentBlock(request);
      case "decrypt_content_block":
        return this.#decryptContentBlock(request);
      case "retain_retry_frame":
        return this.#retainRetryFrame(
          request.operationId,
          request.frameOrdinal,
          request.frame,
        );
      case "export_retry_frame":
        return this.#exportRetryFrame(
          request.operationId,
          request.frameOrdinal,
        );
      case "release_retry_frame":
        this.#releaseRetryFrame(
          request.operationId,
          request.frameOrdinal,
        );
        return { type: "retry_frame_released" };
    }
  }

  #enqueue<Result>(
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    const next = this.#serial.then(operation, operation);
    this.#serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #raiseSecurityFence(): void {
    this.#securityFence =
      this.#securityFence >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.#securityFence + 1;
  }

  async #configure(
    currentInput: FilesVetKeyPublicInfo,
    previousInput: FilesVetKeyPublicInfo | null,
    inactivityMsInput: number | null | undefined,
  ): Promise<FilesCryptoWorkerStatus> {
    const current = await validatedBinding(currentInput, this.#subtle);
    const previous =
      previousInput === null
        ? null
        : await validatedBinding(previousInput, this.#subtle);
    if (
      previous &&
      (previous.generation === current.generation ||
        previous.canisterPrincipal !== current.canisterPrincipal ||
        !equalBytes(
          previous.canisterPrincipalBytes,
          current.canisterPrincipalBytes,
        ) ||
        previous.slot !== current.slot ||
        previous.suite !== current.suite ||
        previous.keyName !== current.keyName)
    ) {
      throw new FilesWorkerFault("binding_changed");
    }
    const inactivityMs =
      inactivityMsInput === undefined
        ? this.#inactivityMs
        : inactivityMsInput;
    if (
      inactivityMs !== null &&
      (!Number.isSafeInteger(inactivityMs) ||
        inactivityMs < FILES_WORKER_MIN_INACTIVITY_MS ||
        inactivityMs > FILES_WORKER_MAX_INACTIVITY_MS)
    ) {
      throw new FilesWorkerFault("invalid_request");
    }
    const unchanged =
      this.#current !== null &&
      sameFilesVetKeyBinding(this.#current, current) &&
      ((this.#previous === null && previous === null) ||
        (this.#previous !== null &&
          previous !== null &&
          sameFilesVetKeyBinding(this.#previous, previous)));
    if (!unchanged) this.#lockVolatile();
    this.#current = current;
    this.#previous = previous;
    this.#inactivityMs = inactivityMs;
    this.#scheduleDeadline();
    return this.#status();
  }

  async #initializeVault(
    principalBytes: Uint8Array,
  ): Promise<FilesCryptoWorkerResult> {
    const current = this.#requireCurrent();
    if (this.#keys !== null || this.#pending !== null) {
      throw new FilesWorkerFault("busy");
    }
    assertBytes(principalBytes, "Files canister principal bytes");
    if (!equalBytes(principalBytes, current.canisterPrincipalBytes)) {
      throw new FilesWorkerFault("binding_changed");
    }
    const contextInput: FilesVaultContextInput = {
      neutronCanisterPrincipalBytes: principalBytes.slice(),
      vaultId: checkedRandom(
        this.#randomBytes,
        FILES_VAULT_ID_BYTES,
        "Files vault id",
      ),
      vaultSalt: checkedRandom(
        this.#randomBytes,
        FILES_VAULT_SALT_BYTES,
        "Files vault salt",
      ),
    };
    assertVaultContextInput(contextInput);
    const root = checkedRandom(
      this.#randomBytes,
      FILES_VAULT_ROOT_BYTES,
      "Files vault root",
    );
    const seed = checkedRandom(
      this.#randomBytes,
      FILES_IBE_SEED_BYTES,
      "Files IBE seed",
    );
    try {
      const [rootCommitment, wrapperCiphertext] = await Promise.all([
        computeRootCommitment(contextInput, root, this.#subtle),
        this.#ibeAdapter.wrapRoot({
          target: filesIbePublicInfo(current),
          vaultRoot: root,
          seed,
        }),
      ]);
      const keys = await deriveVaultKeys(
        root,
        vaultContext(contextInput),
        this.#subtle,
      );
      this.#replaceVaultKeys(keys, contextInput, current.generation);
      const vault: FilesGeneratedVault = {
        context: cloneContext(contextInput),
        rootCommitment: rootCommitment.slice(),
        wrapper: {
          generation: current.generation,
          publicKeyFingerprint: current.publicFingerprint.slice(),
          ciphertext: checkedCopy(
            wrapperCiphertext,
            FILES_IBE_WRAPPER_BYTES,
            "Files vault wrapper",
          ),
        },
      };
      this.#stageVaultCacheCandidate(vault, root);
      this.#touch();
      return {
        type: "vault_initialized",
        vault,
        status: this.#status(),
      };
    } finally {
      zeroBytes(root);
      zeroBytes(seed);
    }
  }

  async #beginUnlock(
    generation: string,
    vault: FilesCommittedVault | undefined,
    rewrapToGeneration: string | undefined,
  ): Promise<FilesCryptoWorkerResult> {
    if (this.#keys !== null) throw new FilesWorkerFault("busy");
    if (this.#pending !== null) throw new FilesWorkerFault("busy");
    const binding = this.#bindingForGeneration(generation);
    if (vault !== undefined) {
      const restored = await this.#restoreCachedVault(
        vault,
        binding,
        rewrapToGeneration,
      );
      if (restored !== null) return restored;
    } else if (rewrapToGeneration !== undefined) {
      throw new FilesWorkerFault("invalid_request");
    }
    const session = this.#sessionFactory();
    const transportPublicKey = checkedCopy(
      session.publicKeyBytes(),
      FILES_TRANSPORT_PUBLIC_KEY_BYTES,
      "Files transport public key",
    );
    const requestNonce = checkedRandom(
      this.#randomBytes,
      FILES_DERIVATION_INPUT_BYTES,
      "Files unlock nonce",
    );
    const expiresAt = this.#now() + FILES_WORKER_UNLOCK_CHALLENGE_MS;
    this.#pending = {
      generation: binding.generation,
      session,
      expiresAt,
    };
    this.#scheduleDeadline();
    return {
      type: "unlock_request",
      generation: binding.generation,
      transportPublicKey,
      requestNonce,
      expiresAt,
    };
  }

  async #completeUnlock(
    generation: string,
    encryptedVetKey: Uint8Array,
    vault: FilesCommittedVault,
    rewrapToGeneration: string | undefined,
  ): Promise<FilesCryptoWorkerResult> {
    const pending = this.#pending;
    this.#pending = null;
    this.#scheduleDeadline();
    if (!pending || pending.generation !== generation) {
      pending?.session.cancel();
      throw new FilesWorkerFault("binding_changed");
    }
    if (pending.expiresAt <= this.#now()) {
      pending.session.cancel();
      throw new FilesWorkerFault("expired");
    }
    const source = this.#bindingForGeneration(generation);
    validateCommittedVault(vault, source);
    const keyHandle = pending.session.consume({
      encryptedVetKey: checkedCopy(
        encryptedVetKey,
        FILES_ENCRYPTED_VETKEY_BYTES,
        "Encrypted Files VetKey",
      ),
      contextPublicKey: source.publicKey,
      derivationInput: source.derivationInput,
    });
    const root = await this.#ibeAdapter.unwrapRoot({
      target: filesIbePublicInfo(source),
      keyHandle,
      wrapper: vault.wrapper.ciphertext,
    });
    try {
      await verifyRootCommitment(
        vault.context,
        root,
        vault.rootCommitment,
        this.#subtle,
      );
      let rewrapped: FilesVaultWrapper | null = null;
      if (rewrapToGeneration !== undefined) {
        const target = this.#bindingForGeneration(rewrapToGeneration);
        if (
          target.generation === source.generation ||
          this.#current?.generation !== target.generation
        ) {
          throw new FilesWorkerFault("binding_changed");
        }
        const seed = checkedRandom(
          this.#randomBytes,
          FILES_IBE_SEED_BYTES,
          "Files IBE seed",
        );
        try {
          rewrapped = {
            generation: target.generation,
            publicKeyFingerprint: target.publicFingerprint.slice(),
            ciphertext: await this.#ibeAdapter.wrapRoot({
              target: filesIbePublicInfo(target),
              vaultRoot: root,
              seed,
            }),
          };
        } finally {
          zeroBytes(seed);
        }
      }
      const keys = await deriveVaultKeys(
        root,
        vaultContext(vault.context),
        this.#subtle,
      );
      this.#replaceVaultKeys(keys, vault.context, source.generation);
      await this.#storeCommittedVaultCache(vault, root);
      if (rewrapped !== null) {
        this.#stageVaultCacheCandidate(
          {
            context: cloneContext(vault.context),
            rootCommitment: vault.rootCommitment.slice(),
            wrapper: cloneVaultWrapper(rewrapped),
          },
          root,
        );
      }
      this.#touch();
      return {
        type: "vault_unlocked",
        status: this.#status(),
        rewrapped,
      };
    } finally {
      zeroBytes(root);
    }
  }

  async #loadCachedPublicInfo(
    descriptorInput: FilesVaultPublicCacheDescriptor,
  ): Promise<FilesCryptoWorkerResult> {
    const descriptor = validateVaultPublicCacheDescriptor(descriptorInput);
    const cache = this.#secretCache;
    if (cache === null) {
      return { type: "cached_public_info", publicInfo: null };
    }
    const key = publicInfoCacheKey(descriptor);
    let encoded: Uint8Array | null = null;
    try {
      await cache.prune();
      encoded = await cache.get(key);
      if (encoded === null) {
        return { type: "cached_public_info", publicInfo: null };
      }
      const decoded = decodeCachedPublicInfo(encoded);
      const validated = await validatedBinding(decoded, this.#subtle);
      if (
        validated.generation !== descriptor.generation ||
        validated.keyName !== descriptor.keyName ||
        !equalBytes(
          validated.publicFingerprint,
          descriptor.publicKeyFingerprint,
        )
      ) {
        return { type: "cached_public_info", publicInfo: null };
      }
      return {
        type: "cached_public_info",
        publicInfo: clonePublicInfo(validated),
      };
    } catch {
      return { type: "cached_public_info", publicInfo: null };
    } finally {
      if (encoded !== null) zeroBytes(encoded);
    }
  }

  async #restoreCachedVault(
    vault: FilesCommittedVault,
    source: FilesVetKeyPublicInfo,
    rewrapToGeneration: string | undefined,
  ): Promise<
    Extract<FilesCryptoWorkerResult, { type: "vault_unlocked" }> | null
  > {
    validateCommittedVault(vault, source);
    const cache = this.#secretCache;
    if (cache === null) return null;
    const descriptor = vaultCacheDescriptor(vault, source);
    let root: Uint8Array | null = null;
    try {
      root = await cache.get(rootCacheKey(descriptor));
    } catch {
      return null;
    }
    if (root === null) return null;
    if (root.byteLength !== FILES_VAULT_ROOT_BYTES) {
      zeroBytes(root);
      return null;
    }
    try {
      try {
        await verifyRootCommitment(
          vault.context,
          root,
          vault.rootCommitment,
          this.#subtle,
        );
      } catch {
        return null;
      }
      let rewrapped: FilesVaultWrapper | null = null;
      if (rewrapToGeneration !== undefined) {
        const target = this.#bindingForGeneration(rewrapToGeneration);
        if (
          target.generation === source.generation ||
          this.#current?.generation !== target.generation
        ) {
          throw new FilesWorkerFault("binding_changed");
        }
        const seed = checkedRandom(
          this.#randomBytes,
          FILES_IBE_SEED_BYTES,
          "Files IBE seed",
        );
        try {
          rewrapped = {
            generation: target.generation,
            publicKeyFingerprint: target.publicFingerprint.slice(),
            ciphertext: await this.#ibeAdapter.wrapRoot({
              target: filesIbePublicInfo(target),
              vaultRoot: root,
              seed,
            }),
          };
        } finally {
          zeroBytes(seed);
        }
      }
      const keys = await deriveVaultKeys(
        root,
        vaultContext(vault.context),
        this.#subtle,
      );
      this.#replaceVaultKeys(keys, vault.context, source.generation);
      if (rewrapped !== null) {
        this.#stageVaultCacheCandidate(
          {
            context: cloneContext(vault.context),
            rootCommitment: vault.rootCommitment.slice(),
            wrapper: cloneVaultWrapper(rewrapped),
          },
          root,
        );
      }
      this.#touch();
      return {
        type: "vault_unlocked",
        status: this.#status(),
        rewrapped,
      };
    } finally {
      zeroBytes(root);
    }
  }

  async #commitVaultCache(
    vault: FilesCommittedVault,
  ): Promise<FilesCryptoWorkerResult> {
    const candidate = this.#vaultCacheCandidate;
    if (
      candidate === null ||
      this.#keys === null ||
      this.#contextInput === null
    ) {
      throw new FilesWorkerFault("locked");
    }
    const source = this.#bindingForGeneration(vault.wrapper.generation);
    validateCommittedVault(vault, source);
    try {
      if (!sameVaultCacheIdentity(candidate.vault, vault)) {
        throw new FilesWorkerFault("binding_changed");
      }
      await verifyRootCommitment(
        vault.context,
        candidate.root,
        vault.rootCommitment,
        this.#subtle,
      );
      const stored = await this.#storeCommittedVaultCache(
        vault,
        candidate.root,
      );
      this.#unlockedGeneration = source.generation;
      this.#contextInput = cloneContext(vault.context);
      this.#touch();
      return {
        type: "vault_cache_committed",
        stored,
        status: this.#status(),
      };
    } finally {
      this.#clearVaultCacheCandidate();
    }
  }

  async #storeCommittedVaultCache(
    vault: FilesCommittedVault,
    root: Uint8Array,
  ): Promise<boolean> {
    const cache = this.#secretCache;
    if (cache === null) return false;
    assertFixedBytes(root, FILES_VAULT_ROOT_BYTES, "Files vault root");
    const source = this.#bindingForGeneration(vault.wrapper.generation);
    validateCommittedVault(vault, source);
    const descriptor = vaultCacheDescriptor(vault, source);
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - BROWSER_SECRET_CACHE_MAX_TTL_MS
    ) return false;
    const expiresAtMs = now + BROWSER_SECRET_CACHE_MAX_TTL_MS;
    const encodedPublicInfo = encodeCachedPublicInfo(source);
    const publicKey = publicInfoCacheKey(descriptor);
    const rootKey = rootCacheKey(descriptor);
    try {
      const publicStored = await cache.put({
        ...publicKey,
        secret: encodedPublicInfo,
        expiresAtMs,
      });
      const rootStored = await cache.put({
        ...rootKey,
        secret: root,
        expiresAtMs,
      });
      await cache.prune([publicKey, rootKey]);
      return publicStored && rootStored;
    } catch {
      return false;
    } finally {
      zeroBytes(encodedPublicInfo);
    }
  }

  #stageVaultCacheCandidate(
    vault: FilesCommittedVault,
    root: Uint8Array,
  ): void {
    assertFixedBytes(root, FILES_VAULT_ROOT_BYTES, "Files vault root");
    this.#clearVaultCacheCandidate();
    this.#vaultCacheCandidate = {
      root: root.slice(),
      vault: cloneCommittedVault(vault),
    };
  }

  #clearVaultCacheCandidate(): void {
    const candidate = this.#vaultCacheCandidate;
    if (candidate !== null) {
      zeroBytes(candidate.root);
      wipeCommittedVault(candidate.vault);
      this.#vaultCacheCandidate = null;
    }
  }

  async #createContentCipher(
    binding: FilesContentBinding,
  ): Promise<FilesCryptoWorkerResult> {
    const keys = this.#requireKeys();
    assertContentBinding(binding);
    this.#assertContentCapacity();
    const handle = this.#allocateHandle();
    const created = await generateContentCipher(
      keys,
      binding,
      (length) => checkedRandom(this.#randomBytes, length, "Files content key"),
    );
    this.#contentCiphers.set(handle, {
      binding: cloneContentBinding(binding),
      cipher: created.cipher,
    });
    this.#touch();
    return {
      type: "content_cipher_ready",
      handle,
      wrappedKey: created.wrappedKey,
    };
  }

  async #openContentCipher(
    binding: FilesContentBinding,
    wrappedKey: Uint8Array,
  ): Promise<FilesCryptoWorkerResult> {
    const keys = this.#requireKeys();
    assertContentBinding(binding);
    this.#assertContentCapacity();
    const cipher = await unwrapContentCipher(keys, binding, wrappedKey);
    const handle = this.#allocateHandle();
    this.#contentCiphers.set(handle, {
      binding: cloneContentBinding(binding),
      cipher,
    });
    this.#touch();
    return {
      type: "content_cipher_ready",
      handle,
      wrappedKey: null,
    };
  }

  #releaseContentCipher(handle: string): void {
    assertOpaqueHandle(handle);
    this.#contentCiphers.delete(handle);
  }

  async #encryptContentBlock(
    request: Extract<
      FilesCryptoWorkerRequest,
      { type: "encrypt_content_block" }
    >,
  ): Promise<FilesCryptoWorkerResult> {
    const { cipher, binding } = this.#contentCipher(
      request.handle,
      request.binding,
    );
    const keys = this.#requireKeys();
    try {
      const ciphertext = await encryptContentBlock(
        cipher,
        keys.context,
        request.binding,
        request.plaintext,
      );
      this.#touch();
      return { type: "content_block_encrypted", ciphertext };
    } finally {
      zeroBytes(request.plaintext);
    }
  }

  async #decryptContentBlock(
    request: Extract<
      FilesCryptoWorkerRequest,
      { type: "decrypt_content_block" }
    >,
  ): Promise<FilesCryptoWorkerResult> {
    const { cipher } = this.#contentCipher(
      request.handle,
      request.binding,
    );
    const keys = this.#requireKeys();
    try {
      const plaintext = await decryptContentBlock(
        cipher,
        keys.context,
        request.binding,
        request.ciphertext,
      );
      this.#touch();
      return { type: "content_block_decrypted", plaintext };
    } finally {
      zeroBytes(request.ciphertext);
    }
  }

  async #retainRetryFrame(
    operationId: string,
    frameOrdinal: number,
    frame: Uint8Array,
  ): Promise<FilesCryptoWorkerResult> {
    this.#requireKeys();
    assertRetryFrameKey(operationId, frameOrdinal);
    assertBytes(frame, "Files retry frame");
    if (frame.byteLength < 1 || frame.byteLength > FILES_WORKER_MAX_FRAME_BYTES) {
      throw new FilesWorkerFault("invalid_request");
    }
    const key = retryFrameKey(operationId, frameOrdinal);
    const fingerprint = await sha256(frame, this.#subtle);
    const existing = this.#retryFrames.get(key);
    if (existing) {
      const matches =
        equalBytes(existing.fingerprint, fingerprint) &&
        equalBytes(existing.bytes, frame);
      zeroBytes(frame);
      if (!matches) throw new FilesWorkerFault("invalid_request");
      this.#touch();
      return {
        type: "retry_frame_retained",
        fingerprint: existing.fingerprint.slice(),
      };
    }
    if (this.#retryFrames.size >= FILES_WORKER_MAX_RETRY_FRAMES) {
      zeroBytes(frame);
      throw new FilesWorkerFault("busy");
    }
    const retained = frame.slice();
    zeroBytes(frame);
    this.#retryFrames.set(key, {
      operationId,
      frameOrdinal,
      bytes: retained,
      fingerprint: fingerprint.slice(),
    });
    this.#touch();
    return {
      type: "retry_frame_retained",
      fingerprint,
    };
  }

  #exportRetryFrame(
    operationId: string,
    frameOrdinal: number,
  ): FilesCryptoWorkerResult {
    this.#requireKeys();
    assertRetryFrameKey(operationId, frameOrdinal);
    const frame = this.#retryFrames.get(
      retryFrameKey(operationId, frameOrdinal),
    );
    if (!frame) throw new FilesWorkerFault("not_found");
    this.#touch();
    return {
      type: "retry_frame_exported",
      frame: frame.bytes.slice(),
      fingerprint: frame.fingerprint.slice(),
    };
  }

  #releaseRetryFrame(operationId: string, frameOrdinal: number): void {
    assertRetryFrameKey(operationId, frameOrdinal);
    const key = retryFrameKey(operationId, frameOrdinal);
    const frame = this.#retryFrames.get(key);
    if (!frame) return;
    zeroBytes(frame.bytes);
    zeroBytes(frame.fingerprint);
    this.#retryFrames.delete(key);
  }

  #contentCipher(
    handle: string,
    binding: FilesContentBinding,
  ): ContentCipher {
    assertOpaqueHandle(handle);
    assertContentBinding(binding);
    const entry = this.#contentCiphers.get(handle);
    if (!entry) throw new FilesWorkerFault("not_found");
    if (!sameContentBinding(entry.binding, binding)) {
      throw new FilesWorkerFault("binding_changed");
    }
    return entry;
  }

  #assertContentCapacity(): void {
    if (this.#contentCiphers.size >= FILES_WORKER_MAX_CONTENT_CIPHERS) {
      throw new FilesWorkerFault("busy");
    }
  }

  #allocateHandle(): string {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const handle = toHex(
        checkedRandom(this.#randomBytes, 16, "Files content handle"),
      );
      if (!/^0+$/u.test(handle) && !this.#contentCiphers.has(handle)) {
        return handle;
      }
    }
    throw new FilesWorkerFault("crypto_unavailable");
  }

  #bindingForGeneration(generation: string): FilesVetKeyPublicInfo {
    if (!isPositiveCanonicalNat64(generation)) {
      throw new FilesWorkerFault("invalid_request");
    }
    if (this.#current?.generation === generation) return this.#current;
    if (this.#previous?.generation === generation) return this.#previous;
    throw new FilesWorkerFault("binding_changed");
  }

  #requireCurrent(): FilesVetKeyPublicInfo {
    if (!this.#current) throw new FilesWorkerFault("not_configured");
    return this.#current;
  }

  #requireKeys(): FilesVaultKeys {
    if (!this.#current) throw new FilesWorkerFault("not_configured");
    if (!this.#keys || !this.#contextInput) {
      throw new FilesWorkerFault("locked");
    }
    return this.#keys;
  }

  #replaceVaultKeys(
    keys: FilesVaultKeys,
    contextInput: FilesVaultContextInput,
    generation: string,
  ): void {
    this.#clearContentAndRetryState();
    this.#keys = keys;
    this.#contextInput = cloneContext(contextInput);
    this.#unlockedGeneration = generation;
  }

  #cancelPendingUnlock(): void {
    this.#pending?.session.cancel();
    this.#pending = null;
    this.#scheduleDeadline();
  }

  #lockVolatile(): void {
    this.#cancelPendingUnlock();
    this.#clearContentAndRetryState();
    this.#clearVaultCacheCandidate();
    this.#keys = null;
    this.#contextInput = null;
    this.#unlockedGeneration = null;
    this.#inactivityExpiresAt = null;
    this.#scheduleDeadline();
  }

  #reset(): void {
    this.#lockVolatile();
    this.#current = null;
    this.#previous = null;
  }

  #clearContentAndRetryState(): void {
    this.#contentCiphers.clear();
    for (const frame of this.#retryFrames.values()) {
      zeroBytes(frame.bytes);
      zeroBytes(frame.fingerprint);
    }
    this.#retryFrames.clear();
  }

  #touch(): void {
    if (this.#keys !== null) {
      this.#inactivityExpiresAt =
        this.#inactivityMs === null
          ? null
          : this.#now() + this.#inactivityMs;
    }
    this.#scheduleDeadline();
  }

  #expire(): void {
    const now = this.#now();
    if (this.#pending && this.#pending.expiresAt <= now) {
      this.#pending.session.cancel();
      this.#pending = null;
    }
    if (
      this.#inactivityExpiresAt !== null &&
      this.#inactivityExpiresAt <= now
    ) {
      const wasUnlocked = this.#keys !== null;
      if (wasUnlocked) this.#raiseSecurityFence();
      this.#clearContentAndRetryState();
      this.#clearVaultCacheCandidate();
      this.#keys = null;
      this.#contextInput = null;
      this.#unlockedGeneration = null;
      this.#inactivityExpiresAt = null;
      if (wasUnlocked) {
        try {
          this.#onInactivityLock();
        } catch {
          // Key erasure is authoritative.
        }
      }
    }
    this.#scheduleDeadline();
  }

  #status(): FilesCryptoWorkerStatus {
    return {
      configured: this.#current !== null,
      currentGeneration: this.#current?.generation ?? null,
      previousGeneration: this.#previous?.generation ?? null,
      unlocked: this.#keys !== null,
      unlockedGeneration: this.#unlockedGeneration,
      pendingGeneration: this.#pending?.generation ?? null,
      inactivityExpiresAt: this.#inactivityExpiresAt,
      contentCipherCount: this.#contentCiphers.size,
      retryFrameCount: this.#retryFrames.size,
    };
  }

  #scheduleDeadline(): void {
    if (this.#deadlineHandle !== null) {
      this.#cancelSchedule(this.#deadlineHandle);
      this.#deadlineHandle = null;
    }
    const deadlines = [
      this.#pending?.expiresAt ?? null,
      this.#inactivityExpiresAt,
    ].filter((value): value is number => value !== null);
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    this.#deadlineHandle = this.#schedule(() => {
      this.#deadlineHandle = null;
      // Fence a result already in flight before serializing the erasure.
      this.#raiseSecurityFence();
      void this.#enqueue(() => this.#expire());
    }, Math.min(
      FILES_WORKER_MAX_INACTIVITY_MS,
      Math.max(0, deadline - this.#now()),
    ));
  }
}

function isSensitiveWorkerRequest(
  request: FilesCryptoWorkerRequest,
): boolean {
  return (
    request.type !== "status" &&
    request.type !== "lock" &&
    request.type !== "reset" &&
    request.type !== "configure" &&
    request.type !== "cancel_unlock"
  );
}

function wipeWorkerResult(result: FilesCryptoWorkerResult): void {
  const visit = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      zeroBytes(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(result);
}

export function classifyFilesWorkerError(
  error: unknown,
): FilesCryptoWorkerError {
  if (error instanceof FilesWorkerFault) return { code: error.code };
  const message = error instanceof Error ? error.message : "";
  if (/authenticate|decrypt|unwrap|commitment|ciphertext/iu.test(message)) {
    return { code: "authentication_failed" };
  }
  if (/not configured|unavailable generation/iu.test(message)) {
    return { code: "not_configured" };
  }
  if (/locked/iu.test(message)) return { code: "locked" };
  if (/busy|capacity|already pending/iu.test(message)) return { code: "busy" };
  if (/expired/iu.test(message)) return { code: "expired" };
  if (/binding|fingerprint|generation/iu.test(message)) {
    return { code: "binding_changed" };
  }
  if (/invalid|must|outside|mismatch|noncanonical|wrong/iu.test(message)) {
    return { code: "invalid_request" };
  }
  return { code: "crypto_unavailable" };
}

class FilesWorkerFault extends Error {
  constructor(readonly code: FilesCryptoWorkerErrorCode) {
    super(code);
    this.name = "FilesWorkerFault";
  }
}

async function validatedBinding(
  input: FilesVetKeyPublicInfo,
  subtle: SubtleCrypto,
): Promise<FilesVetKeyPublicInfo> {
  const binding = validateFilesVetKeyPublicInfo(input);
  const fingerprint = await sha256(binding.publicKey, subtle);
  try {
    if (!equalBytes(fingerprint, binding.publicFingerprint)) {
      throw new FilesWorkerFault("binding_changed");
    }
  } finally {
    zeroBytes(fingerprint);
  }
  return binding;
}

function validateCommittedVault(
  vault: FilesCommittedVault,
  binding: FilesVetKeyPublicInfo,
): void {
  if (!vault || typeof vault !== "object") {
    throw new FilesWorkerFault("invalid_request");
  }
  assertVaultContextInput(vault.context);
  if (
    !equalBytes(
      vault.context.neutronCanisterPrincipalBytes,
      binding.canisterPrincipalBytes,
    )
  ) {
    throw new FilesWorkerFault("binding_changed");
  }
  assertFixedBytes(
    vault.rootCommitment,
    FILES_SHA256_BYTES,
    "Files root commitment",
  );
  if (
    !vault.wrapper ||
    vault.wrapper.generation !== binding.generation ||
    !equalBytes(
      vault.wrapper.publicKeyFingerprint,
      binding.publicFingerprint,
    )
  ) {
    throw new FilesWorkerFault("binding_changed");
  }
  assertFixedBytes(
    vault.wrapper.ciphertext,
    FILES_IBE_WRAPPER_BYTES,
    "Files vault wrapper",
  );
}

const FILES_ROOT_CACHE_ID_PREFIX = "files-vault-root:v1:";
const FILES_PUBLIC_INFO_CACHE_ID_PREFIX = "files-vault-public:v1:";

function vaultCacheDescriptor(
  vault: FilesCommittedVault,
  source: FilesVetKeyPublicInfo,
): FilesVaultCacheDescriptor {
  validateCommittedVault(vault, source);
  return {
    generation: source.generation,
    keyName: source.keyName,
    publicKeyFingerprint: source.publicFingerprint.slice(),
    neutronCanisterPrincipalBytes:
      vault.context.neutronCanisterPrincipalBytes.slice(),
    vaultId: vault.context.vaultId.slice(),
    vaultSalt: vault.context.vaultSalt.slice(),
    rootCommitment: vault.rootCommitment.slice(),
    wrapperCiphertext: vault.wrapper.ciphertext.slice(),
  };
}

function validateVaultPublicCacheDescriptor(
  input: FilesVaultPublicCacheDescriptor,
): FilesVaultPublicCacheDescriptor {
  if (
    !input ||
    typeof input !== "object" ||
    !isPositiveCanonicalNat64(input.generation) ||
    (input.keyName !== "key_1" && input.keyName !== "test_key_1")
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
  assertFixedBytes(
    input.publicKeyFingerprint,
    FILES_SHA256_BYTES,
    "Files public-key fingerprint",
  );
  assertFixedBytes(input.vaultId, FILES_VAULT_ID_BYTES, "Files vault id");
  assertFixedBytes(
    input.vaultSalt,
    FILES_VAULT_SALT_BYTES,
    "Files vault salt",
  );
  assertFixedBytes(
    input.rootCommitment,
    FILES_SHA256_BYTES,
    "Files root commitment",
  );
  assertFixedBytes(
    input.wrapperCiphertext,
    FILES_IBE_WRAPPER_BYTES,
    "Files vault wrapper",
  );
  return {
    generation: input.generation,
    keyName: input.keyName,
    publicKeyFingerprint: input.publicKeyFingerprint.slice(),
    vaultId: input.vaultId.slice(),
    vaultSalt: input.vaultSalt.slice(),
    rootCommitment: input.rootCommitment.slice(),
    wrapperCiphertext: input.wrapperCiphertext.slice(),
  };
}

function validateVaultCacheDescriptor(
  input: FilesVaultCacheDescriptor,
): FilesVaultCacheDescriptor {
  const descriptor = validateVaultPublicCacheDescriptor(input);
  if (
    !(input.neutronCanisterPrincipalBytes instanceof Uint8Array) ||
    input.neutronCanisterPrincipalBytes.byteLength < 1 ||
    input.neutronCanisterPrincipalBytes.byteLength > 29
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
  return {
    ...descriptor,
    neutronCanisterPrincipalBytes:
      input.neutronCanisterPrincipalBytes.slice(),
  };
}

function publicInfoCacheKey(
  descriptorInput: FilesVaultPublicCacheDescriptor,
): { id: string; binding: Uint8Array } {
  const descriptor = validateVaultPublicCacheDescriptor(descriptorInput);
  return {
    id: `${FILES_PUBLIC_INFO_CACHE_ID_PREFIX}${descriptor.generation}`,
    binding: publicInfoCacheBinding(descriptor),
  };
}

function rootCacheKey(
  descriptorInput: FilesVaultCacheDescriptor,
): { id: string; binding: Uint8Array } {
  const descriptor = validateVaultCacheDescriptor(descriptorInput);
  return {
    id: `${FILES_ROOT_CACHE_ID_PREFIX}${descriptor.generation}`,
    binding: concatBytes(
      publicInfoCacheBinding(descriptor),
      lp(descriptor.neutronCanisterPrincipalBytes),
    ),
  };
}

function publicInfoCacheBinding(
  descriptor: FilesVaultPublicCacheDescriptor,
): Uint8Array {
  return concatBytes(
    lp("neutron.files.vault-cache.v1"),
    lp(FILES_VETKEY_SLOT),
    u64be(descriptor.generation),
    lp(descriptor.keyName),
    descriptor.publicKeyFingerprint,
    lp(descriptor.vaultId),
    lp(descriptor.vaultSalt),
    descriptor.rootCommitment,
    lp(descriptor.wrapperCiphertext),
  );
}

function encodeCachedPublicInfo(
  input: FilesVetKeyPublicInfo,
): Uint8Array {
  const value = validateFilesVetKeyPublicInfo(input);
  return utf8(JSON.stringify({
    schema: 1,
    canisterPrincipal: value.canisterPrincipal,
    canisterPrincipalBytes: [...value.canisterPrincipalBytes],
    slot: value.slot,
    generation: value.generation,
    suite: value.suite,
    keyName: value.keyName,
    publicKey: [...value.publicKey],
    publicFingerprint: [...value.publicFingerprint],
    derivationInput: [...value.derivationInput],
  }));
}

function decodeCachedPublicInfo(
  encoded: Uint8Array,
): FilesVetKeyPublicInfo {
  if (!(encoded instanceof Uint8Array) || encoded.byteLength > 4_096) {
    throw new FilesWorkerFault("invalid_request");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      encoded,
    ));
  } catch {
    throw new FilesWorkerFault("invalid_request");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new FilesWorkerFault("invalid_request");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schema !== 1 ||
    value.slot !== FILES_VETKEY_SLOT ||
    value.suite !== "bls12_381_g2" ||
    typeof value.canisterPrincipal !== "string" ||
    typeof value.generation !== "string" ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1")
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
  const canisterPrincipalBytes = cachedByteArray(
    value.canisterPrincipalBytes,
    null,
  );
  const publicInfo = validateFilesVetKeyPublicInfo({
    canisterPrincipal: value.canisterPrincipal,
    canisterPrincipalBytes,
    slot: FILES_VETKEY_SLOT,
    generation: value.generation,
    suite: "bls12_381_g2",
    keyName: value.keyName,
    publicKey: cachedByteArray(value.publicKey, 96),
    publicFingerprint: cachedByteArray(
      value.publicFingerprint,
      FILES_SHA256_BYTES,
    ),
    derivationInput: cachedByteArray(
      value.derivationInput,
      FILES_DERIVATION_INPUT_BYTES,
    ),
  });
  let principalBytes: Uint8Array;
  try {
    principalBytes = Principal.fromText(
      publicInfo.canisterPrincipal,
    ).toUint8Array();
  } catch {
    throw new FilesWorkerFault("invalid_request");
  }
  if (!equalBytes(principalBytes, publicInfo.canisterPrincipalBytes)) {
    throw new FilesWorkerFault("binding_changed");
  }
  return publicInfo;
}

function cachedByteArray(
  input: unknown,
  exactLength: number | null,
): Uint8Array {
  if (
    !Array.isArray(input) ||
    (exactLength === null
      ? input.length < 1 || input.length > 29
      : input.length !== exactLength) ||
    !input.every(
      (value) =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 0xff,
    )
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
  return Uint8Array.from(input as number[]);
}

function clonePublicInfo(
  input: FilesVetKeyPublicInfo,
): FilesVetKeyPublicInfo {
  return {
    ...input,
    canisterPrincipalBytes: input.canisterPrincipalBytes.slice(),
    publicKey: input.publicKey.slice(),
    publicFingerprint: input.publicFingerprint.slice(),
    derivationInput: input.derivationInput.slice(),
  };
}

function cloneVaultWrapper(
  wrapper: FilesVaultWrapper,
): FilesVaultWrapper {
  return {
    generation: wrapper.generation,
    publicKeyFingerprint: wrapper.publicKeyFingerprint.slice(),
    ciphertext: wrapper.ciphertext.slice(),
  };
}

function cloneCommittedVault(
  vault: FilesCommittedVault,
): FilesCommittedVault {
  return {
    context: cloneContext(vault.context),
    rootCommitment: vault.rootCommitment.slice(),
    wrapper: cloneVaultWrapper(vault.wrapper),
  };
}

function wipeCommittedVault(vault: FilesCommittedVault): void {
  zeroBytes(vault.context.neutronCanisterPrincipalBytes);
  zeroBytes(vault.context.vaultId);
  zeroBytes(vault.context.vaultSalt);
  zeroBytes(vault.rootCommitment);
  zeroBytes(vault.wrapper.publicKeyFingerprint);
  zeroBytes(vault.wrapper.ciphertext);
}

function sameVaultCacheIdentity(
  left: FilesCommittedVault,
  right: FilesCommittedVault,
): boolean {
  return (
    left.wrapper.generation === right.wrapper.generation &&
    equalBytes(
      left.wrapper.publicKeyFingerprint,
      right.wrapper.publicKeyFingerprint,
    ) &&
    equalBytes(
      left.context.neutronCanisterPrincipalBytes,
      right.context.neutronCanisterPrincipalBytes,
    ) &&
    equalBytes(left.context.vaultId, right.context.vaultId) &&
    equalBytes(left.context.vaultSalt, right.context.vaultSalt) &&
    equalBytes(left.rootCommitment, right.rootCommitment)
  );
}

function cloneContext(
  input: FilesVaultContextInput,
): FilesVaultContextInput {
  assertVaultContextInput(input);
  return {
    neutronCanisterPrincipalBytes:
      input.neutronCanisterPrincipalBytes.slice(),
    vaultId: input.vaultId.slice(),
    vaultSalt: input.vaultSalt.slice(),
  };
}

function cloneContentBinding(
  input: FilesContentBinding,
): FilesContentBinding {
  assertContentBinding(input);
  return {
    nodeId: { hi: input.nodeId.hi, lo: input.nodeId.lo },
    contentId: { hi: input.contentId.hi, lo: input.contentId.lo },
  };
}

function sameContentBinding(
  left: FilesContentBinding,
  right: FilesContentBinding,
): boolean {
  return (
    left.nodeId.hi === right.nodeId.hi &&
    left.nodeId.lo === right.nodeId.lo &&
    left.contentId.hi === right.contentId.hi &&
    left.contentId.lo === right.contentId.lo
  );
}

function checkedRandom(
  randomBytes: (length: number) => Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  const output = randomBytes(length);
  assertFixedBytes(output, length, label);
  if (
    output.byteOffset === 0 &&
    output.byteLength === output.buffer.byteLength
  ) {
    return output;
  }
  const copy = output.slice();
  zeroBytes(output);
  return copy;
}

function checkedCopy(
  value: Uint8Array,
  length: number,
  label: string,
): Uint8Array {
  assertFixedBytes(value, length, label);
  return value.slice();
}

function assertRequestId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new FilesWorkerFault("invalid_request");
  }
}

function assertOpaqueHandle(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value) ||
    /^0+$/u.test(value)
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
}

function assertRetryFrameKey(
  operationId: string,
  frameOrdinal: number,
): void {
  assertOpaqueHandle(operationId);
  if (
    !Number.isSafeInteger(frameOrdinal) ||
    frameOrdinal < 0 ||
    frameOrdinal >= FILES_PRIVATE_FILE_MAX_BLOCKS
  ) {
    throw new FilesWorkerFault("invalid_request");
  }
}

function retryFrameKey(
  operationId: string,
  frameOrdinal: number,
): string {
  return `${operationId}:${frameOrdinal}`;
}

function toHex(value: Uint8Array): string {
  let output = "";
  for (const byte of value) output += byte.toString(16).padStart(2, "0");
  zeroBytes(value);
  return output;
}

function isPositiveCanonicalNat64(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 0xffff_ffff_ffff_ffffn
  );
}

function scheduleUnrefTimeout(
  callback: () => void,
  delayMs: number,
): unknown {
  const handle = setTimeout(callback, delayMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref?: () => void }).unref?.();
  }
  return handle;
}

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FilesCryptoWorkerRequest>) => void,
  ): void;
  postMessage(
    message: FilesCryptoWorkerResponse | FilesCryptoWorkerEvent,
    transfer?: Transferable[],
  ): void;
};

const workerScope = globalThis as unknown as WorkerScope;
if (
  typeof workerScope.addEventListener === "function" &&
  typeof workerScope.postMessage === "function" &&
  !("document" in globalThis)
) {
  const runtime = FilesCryptoWorkerRuntime.official(() => {
    workerScope.postMessage({ event: "inactivity_locked" });
  });
  workerScope.addEventListener("message", (event) => {
    const id = Number(
      (event.data as { id?: unknown } | null)?.id,
    );
    void runtime.handle(event.data).then(
      (ok) => {
        const response: FilesCryptoWorkerResponse = { id, ok };
        workerScope.postMessage(response, transferableBuffers(ok));
      },
      (error) => {
        workerScope.postMessage({
          id,
          error: classifyFilesWorkerError(error),
        });
      },
    );
  });
}

function transferableBuffers(value: unknown): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const visit = (candidate: unknown): void => {
    if (candidate instanceof Uint8Array) {
      if (
        candidate.buffer instanceof ArrayBuffer &&
        candidate.byteOffset === 0 &&
        candidate.byteLength === candidate.buffer.byteLength
      ) {
        buffers.add(candidate.buffer);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item);
    }
  };
  visit(value);
  return [...buffers];
}
