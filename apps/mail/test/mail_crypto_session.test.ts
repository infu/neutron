import { describe, expect, test } from "bun:test";
import { DerivedPublicKey } from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  VetKeyPublicInfo,
  VetKeySlotSummary,
} from "neutron-tools/app";
import type { MailBackendCryptoProgress } from "../src/backend.ts";
import { computeMailKeyFingerprint } from "../src/protocol.ts";
import {
  MailCryptoResidentSession,
  assertMailCryptoTileCaller,
  type MailCryptoResidentDependencies,
} from "../src/mail_crypto_session.ts";
import type {
  MailCryptoWorkerResult,
  MailWorkerCachePublicInfo,
  MailWorkerLiveGeneration,
  MailWorkerStatus,
} from "../src/crypto_worker.ts";

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

class FakeWorker {
  configured: {
    current: MailWorkerCachePublicInfo;
    previous: MailWorkerCachePublicInfo | null;
  } | null = null;
  unlockedEpochs = new Set<string>();
  cancelCount = 0;
  resetCount = 0;
  clearCacheCount = 0;
  lockCount = 0;
  beginCount = 0;
  completedKey: Uint8Array | null = null;
  prepared: {
    current: MailWorkerCachePublicInfo | null;
    previous: MailWorkerCachePublicInfo | null;
  } = { current: null, previous: null };

  constructor(
    readonly durableCache: Map<string, MailWorkerCachePublicInfo> | null = null,
  ) {}

  async prepareCache(input: {
    current: MailWorkerLiveGeneration;
    previous: MailWorkerLiveGeneration | null;
  }): Promise<MailCryptoWorkerResult> {
    const current = this.#cached(input.current);
    const previous = input.previous === null ? null : this.#cached(input.previous);
    this.prepared = { current, previous };
    if (this.configured !== null) {
      for (const hit of [current, previous]) {
        if (
          hit !== null &&
          [this.configured.current.epoch, this.configured.previous?.epoch]
            .includes(hit.epoch)
        ) this.unlockedEpochs.add(hit.epoch);
      }
    }
    return {
      type: "cache_prepared",
      current,
      previous,
      status: this.statusValue(),
    };
  }

  async configure(input: {
    current: MailWorkerCachePublicInfo;
    previous: MailWorkerCachePublicInfo | null;
  }): Promise<MailCryptoWorkerResult> {
    this.configured = input;
    const allowed = new Set([input.current.epoch, input.previous?.epoch].filter(Boolean));
    this.unlockedEpochs = new Set([...this.unlockedEpochs].filter((epoch) => allowed.has(epoch)));
    for (const hit of [this.prepared.current, this.prepared.previous]) {
      if (hit !== null && allowed.has(hit.epoch)) this.unlockedEpochs.add(hit.epoch);
    }
    this.prepared = { current: null, previous: null };
    return { type: "status", status: this.statusValue() };
  }

  async beginUnlock(epoch: string): Promise<MailCryptoWorkerResult> {
    this.beginCount += 1;
    expect(this.configured).not.toBeNull();
    expect([this.configured!.current.epoch, this.configured!.previous?.epoch]).toContain(epoch);
    return {
      type: "unlock_request",
      epoch,
      transportPublicKey: bytes(48, 0x41),
      requestNonce: bytes(32, 0x51),
      expiresAt: Date.now() + 60_000,
    };
  }

  async completeUnlock(
    epoch: string,
    encryptedVetKey: Uint8Array,
  ): Promise<MailCryptoWorkerResult> {
    expect(this.configured).not.toBeNull();
    expect([this.configured!.current.epoch, this.configured!.previous?.epoch]).toContain(epoch);
    this.completedKey = encryptedVetKey.slice();
    this.unlockedEpochs.add(epoch);
    const publicInfo = this.configured!.current.epoch === epoch
      ? this.configured!.current
      : this.configured!.previous;
    if (publicInfo !== null && publicInfo !== undefined) {
      this.durableCache?.set(epoch, publicInfo);
    }
    return { type: "status", status: this.statusValue() };
  }

  async cancelUnlock(): Promise<MailCryptoWorkerResult> {
    this.cancelCount += 1;
    return { type: "cancelled" };
  }

  async reset(): Promise<MailCryptoWorkerResult> {
    this.resetCount += 1;
    this.configured = null;
    this.unlockedEpochs.clear();
    this.prepared = { current: null, previous: null };
    return { type: "status", status: this.statusValue() };
  }

  async clearCache(): Promise<MailCryptoWorkerResult> {
    this.clearCacheCount += 1;
    this.durableCache?.clear();
    return { type: "cache_cleared" };
  }

  async lock(): Promise<MailCryptoWorkerResult> {
    this.lockCount += 1;
    this.unlockedEpochs.clear();
    return { type: "status", status: this.statusValue() };
  }

  async status(): Promise<MailCryptoWorkerResult> {
    return { type: "status", status: this.statusValue() };
  }

  statusValue(): MailWorkerStatus {
    return this.configured === null
      ? {
          configured: false,
          currentEpoch: null,
          previousEpoch: null,
          unlockedEpochs: [],
          currentUnlocked: false,
          pendingEpoch: null,
          inactivityExpiresAt: null,
        }
      : {
          configured: true,
          currentEpoch: this.configured.current.epoch,
          previousEpoch: this.configured.previous?.epoch ?? null,
          unlockedEpochs: [...this.unlockedEpochs],
          currentUnlocked: this.unlockedEpochs.has(this.configured.current.epoch),
          pendingEpoch: null,
          inactivityExpiresAt: this.unlockedEpochs.size > 0 ? Date.now() + 60_000 : null,
        };
  }

  #cached(live: MailWorkerLiveGeneration): MailWorkerCachePublicInfo | null {
    if (live.publicFingerprint === null) return null;
    const value = this.durableCache?.get(live.epoch);
    return value !== undefined &&
        value.keyName === live.keyName &&
        sameNumbers(value.publicFingerprint, live.publicFingerprint)
      ? value
      : null;
  }
}

describe("Mail resident crypto session", () => {
  test("admits only a direct Mail tile caller to internal key-session methods", () => {
    expect(() => assertMailCryptoTileCaller({
      endpoint: "app:mail:tile:mail:instance:1",
      appId: "mail",
      role: "tile",
    })).not.toThrow();
    for (const caller of [
      undefined,
      { endpoint: "app:mail:background", appId: "mail", role: "background" },
      { endpoint: "app:mail:tray:instance:1", appId: "mail", role: "tray" },
      { endpoint: "app:agent:tile:x:instance:1", appId: "agent", role: "tile" },
    ]) {
      expect(() => assertMailCryptoTileCaller(caller)).toThrow("only to a Mail tile");
    }
  });

  test("configures from exact public capability state and recovers automatically", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    let deriveRequest: unknown;
    const approved: string[] = [];
    const dependencies = fixtureDependencies(current, {
      async derive(request, options) {
        deriveRequest = request;
        options.onChallenge({
          type: "challenge",
          challengeId: "opaque_challenge_123456789",
          expiresAt: String(Date.now() + 60_000),
        });
        return { encryptedKey: [...bytes(192, 0x71)], publicInfo: current };
      },
      approve: async (challengeId) => { approved.push(challengeId); },
    });
    const resident = new MailCryptoResidentSession(worker, dependencies);

    expect(await resident.sync()).toMatchObject({
      lockState: "locked",
      currentEpoch: "7",
    });
    expect(worker.configured?.current).toMatchObject({ suite: 1, epoch: "7" });
    expect(worker.configured?.current.contextPublicKey).toEqual(
      Uint8Array.from(current.publicKey),
    );

    const ready = await resident.status();
    expect(approved).toEqual(["opaque_challenge_123456789"]);
    expect(deriveRequest).toMatchObject({
      slot: "mailbox",
      generation: "7",
      transportPublicKey: expect.any(Uint8Array),
      requestNonce: expect.any(Uint8Array),
    });
    expect(worker.completedKey).toEqual(bytes(192, 0x71));
    expect(ready).toMatchObject({ lockState: "unlocked", currentUnlocked: true });
  });

  test("scoped status observation configures but never starts paid recovery", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    let deriveCount = 0;
    const resident = new MailCryptoResidentSession(
      worker,
      fixtureDependencies(current, {
        async derive() {
          deriveCount += 1;
          throw new Error("Status observation must not derive");
        },
      }),
    );

    expect(await resident.observeLocal(fixtureProgress("7"))).toMatchObject({
      lockState: "locked",
      currentEpoch: "7",
      currentUnlocked: false,
    });
    expect(worker.beginCount).toBe(0);
    expect(deriveCount).toBe(0);
  });

  test("coalesces concurrent automatic recovery and permits a fresh recovery after eviction", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    let releaseDerive!: () => void;
    let reportDeriveStarted!: () => void;
    const deriveGate = new Promise<void>((resolve) => { releaseDerive = resolve; });
    const deriveStarted = new Promise<void>((resolve) => { reportDeriveStarted = resolve; });
    let deriveCount = 0;
    const resident = new MailCryptoResidentSession(worker, fixtureDependencies(current, {
      async derive(_request, options) {
        deriveCount += 1;
        options.onChallenge({
          type: "challenge",
          challengeId: `opaque_challenge_${String(deriveCount).padStart(17, "0")}`,
          expiresAt: String(Date.now() + 60_000),
        });
        if (deriveCount === 1) {
          reportDeriveStarted();
          await deriveGate;
        }
        return { encryptedKey: [...bytes(192, 0x71)], publicInfo: current };
      },
    }));

    const first = resident.status();
    await deriveStarted;
    const second = resident.status();
    expect(worker.beginCount).toBe(1);
    expect(deriveCount).toBe(1);

    releaseDerive();
    expect(await first).toMatchObject({ currentUnlocked: true });
    expect(await second).toMatchObject({ currentUnlocked: true });
    await worker.lock();
    expect(await resident.status()).toMatchObject({ currentUnlocked: true });
    expect(worker.beginCount).toBe(2);
    expect(deriveCount).toBe(2);
  });

  test("coalesces paid recovery across residents and warm reload skips public-key fetch", async () => {
    const current = publicInfo("7", 0x31);
    const durableCache = new Map<string, MailWorkerCachePublicInfo>();
    const withRecoveryLock = createRecoveryLock();
    let publicKeyReads = 0;
    let deriveCount = 0;
    const dependencies = fixtureDependencies(current, {
      listSlots: async () => ({ slots: [slotForPublicInfo(current)] }),
      getPublicKey: async () => {
        publicKeyReads += 1;
        return current;
      },
      async derive(_request, options) {
        deriveCount += 1;
        options.onChallenge({
          type: "challenge",
          challengeId: `opaque_challenge_${String(deriveCount).padStart(17, "0")}`,
          expiresAt: String(Date.now() + 60_000),
        });
        return { encryptedKey: [...bytes(192, 0x71)], publicInfo: current };
      },
      withRecoveryLock,
    });
    const first = new MailCryptoResidentSession(
      new FakeWorker(durableCache),
      dependencies,
    );
    const second = new MailCryptoResidentSession(
      new FakeWorker(durableCache),
      dependencies,
    );

    const [firstStatus, secondStatus] = await Promise.all([
      first.status(),
      second.status(),
    ]);
    expect(firstStatus.currentUnlocked).toBe(true);
    expect(secondStatus.currentUnlocked).toBe(true);
    expect(deriveCount).toBe(1);

    const readsBeforeReload = publicKeyReads;
    const warm = new MailCryptoResidentSession(
      new FakeWorker(durableCache),
      dependencies,
    );
    expect(await warm.status()).toMatchObject({
      currentEpoch: "7",
      currentUnlocked: true,
    });
    expect(publicKeyReads).toBe(readsBeforeReload);
    expect(deriveCount).toBe(1);
  });

  test("restores a known retained generation while the new fingerprint is pending", async () => {
    const current = publicInfo("8", 0x41);
    const previous = publicInfo("7", 0x31);
    const durableCache = new Map<string, MailWorkerCachePublicInfo>([
      ["7", workerPublicInfo(previous)],
    ]);
    const liveSlot = slotForPublicInfo(current, previous);
    liveSlot.generations = liveSlot.generations.map((generation) =>
      generation.generation === current.generation
        ? { ...generation, publicFingerprint: null }
        : generation
    );
    let publicFetched = false;
    const publicKeyReads: string[] = [];
    const derivations: string[] = [];
    const resident = new MailCryptoResidentSession(
      new FakeWorker(durableCache),
      {
        getBackendStatus: async () => rotationProgress("8", "7"),
        listSlots: async () => ({
          slots: [
            publicFetched ? slotForPublicInfo(current, previous) : liveSlot,
          ],
        }),
        getPublicKey: async ({ generation }) => {
          publicKeyReads.push(generation);
          if (generation !== "8") throw new Error("Previous key should be cached");
          publicFetched = true;
          return current;
        },
        derive: async (request, options) => {
          derivations.push(request.generation);
          options.onChallenge({
            type: "challenge",
            challengeId: "opaque_challenge_123456789",
            expiresAt: String(Date.now() + 60_000),
          });
          return {
            encryptedKey: [...bytes(192, 0x81)],
            publicInfo: current,
          };
        },
        approve: async () => undefined,
      },
    );

    expect(await resident.status()).toMatchObject({
      currentUnlocked: true,
      previousUnlocked: true,
    });
    expect(publicKeyReads).toEqual(["8"]);
    expect(derivations).toEqual(["8"]);
  });

  test("fails closed when lifecycle changes during a cache restore", async () => {
    const current = publicInfo("7", 0x31);
    const durableCache = new Map<string, MailWorkerCachePublicInfo>([
      ["7", workerPublicInfo(current)],
    ]);
    const worker = new FakeWorker(durableCache);
    let liveReads = 0;
    const enabled = slotForPublicInfo(current);
    const resident = new MailCryptoResidentSession(
      worker,
      fixtureDependencies(current, {
        listSlots: async () => {
          liveReads += 1;
          return {
            slots: liveReads === 1
              ? [enabled]
              : [{
                  ...enabled,
                  generations: enabled.generations.map((generation) => ({
                    ...generation,
                    publicFingerprint: [...bytes(32, 0xe1)],
                  })),
                }],
          };
        },
        getPublicKey: async () => {
          throw new Error("A warm restore must not fetch the public key");
        },
      }),
    );

    await expect(resident.sync()).rejects.toThrow("capability_changed");
    expect(liveReads).toBe(2);
    expect(worker.resetCount).toBe(1);
    expect(worker.configured).toBeNull();
    expect(worker.unlockedEpochs.size).toBe(0);
  });

  test("cancels the one-use worker transport on a closed derivation failure", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    const failure = Object.assign(new Error("holder changed"), {
      code: "owner_required" as const,
    });
    const resident = new MailCryptoResidentSession(worker, fixtureDependencies(current, {
      async derive() {
        throw failure;
      },
    }));

    const result = await resident.ensureGeneration();
    expect(result).toEqual({
      ok: false,
      error: { code: "owner_required", retryAfterSeconds: null },
    });
    expect(worker.cancelCount).toBe(1);
    expect(worker.unlockedEpochs.size).toBe(0);
  });

  test("cancels the worker transport when automatic endpoint confirmation fails", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    const resident = new MailCryptoResidentSession(worker, fixtureDependencies(current, {
      approve: async () => { throw new Error("endpoint replaced"); },
      async derive(_request, options) {
        options.onChallenge({
          type: "challenge",
          challengeId: "opaque_challenge_123456789",
          expiresAt: String(Date.now() + 60_000),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { encryptedKey: [...bytes(192, 0x71)], publicInfo: current };
      },
    }));

    expect(await resident.ensureGeneration()).toEqual({
      ok: false,
      error: { code: "unavailable", retryAfterSeconds: null },
    });
    expect(worker.cancelCount).toBe(1);
    expect(worker.completedKey).toBeNull();
  });

  test("does not treat lifecycle-manager transfer as a cryptographic binding change", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    const dependencies = fixtureDependencies(current);
    const resident = new MailCryptoResidentSession(worker, dependencies);
    let transitions = 0;
    resident.onBindingChange(() => { transitions += 1; });
    await resident.sync();
    dependencies.listSlots = async () => ({
      slots: [{
        ...slotForPublicInfo(current),
        keyHolder: "2ibo7-dia",
      }],
    });

    expect(await resident.sync()).toMatchObject({ currentEpoch: "7" });
    expect(worker.resetCount).toBe(0);
    expect(worker.configured).not.toBeNull();
    expect(transitions).toBe(0);
  });

  test("an unconfigured backend clears all volatile worker state", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    const dependencies = fixtureDependencies(current);
    const resident = new MailCryptoResidentSession(worker, dependencies);
    let transitions = 0;
    resident.onBindingChange(() => { transitions += 1; });
    await resident.sync();
    dependencies.getBackendStatus = async () => null;

    expect(await resident.status()).toEqual({
      version: 1,
      lockState: "not_configured",
      currentEpoch: null,
      previousEpoch: null,
      currentUnlocked: false,
      previousUnlocked: false,
      inactivityExpiresAt: null,
    });
    expect(worker.resetCount).toBe(1);
    expect(worker.clearCacheCount).toBe(1);
    expect(transitions).toBe(1);
    await resident.status();
    expect(transitions).toBe(1);
    expect(worker.clearCacheCount).toBe(1);
  });

  test("recovers during a scoped tool call and revalidates its backend lifecycle", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("7", 0x31);
    const dependencies = fixtureDependencies(current);
    let globalReads = 0;
    const originalStatus = dependencies.getBackendStatus;
    dependencies.getBackendStatus = async () => {
      globalReads += 1;
      return originalStatus();
    };
    dependencies.derive = async (_request, options) => {
      options.onChallenge({
        type: "challenge",
        challengeId: "opaque_challenge_123456789",
        expiresAt: String(Date.now() + 60_000),
      });
      return { encryptedKey: [...bytes(192, 0x71)], publicInfo: current };
    };
    const resident = new MailCryptoResidentSession(worker, dependencies);
    let transitions = 0;
    resident.onBindingChange(() => { transitions += 1; });
    await resident.sync();
    globalReads = 0;

    expect(await resident.statusLocal(fixtureProgress("7"))).toMatchObject({
      currentEpoch: "7",
      currentUnlocked: true,
    });
    expect(globalReads).toBeGreaterThan(0);

    await expect(resident.statusLocal(fixtureProgress("8")))
      .rejects.toThrow("capability_changed");
    expect(globalReads).toBeGreaterThan(0);
    expect(worker.resetCount).toBe(1);
    expect(worker.configured).toBeNull();
    expect(transitions).toBe(1);
  });

  test("recovers current and previous generations automatically", async () => {
    const worker = new FakeWorker();
    const current = publicInfo("8", 0x41);
    const previous = publicInfo("7", 0x31);
    const progress = rotationProgress("8", "7");
    const generations: string[] = [];
    const dependencies: MailCryptoResidentDependencies = {
      getBackendStatus: async () => progress,
      listSlots: async () => ({ slots: [slotForPublicInfo(current, previous)] }),
      getPublicKey: async ({ generation }) => generation === "8" ? current : previous,
      derive: async (request, options) => {
        generations.push(request.generation);
        options.onChallenge({
          type: "challenge",
          challengeId: `opaque_challenge_${request.generation.padStart(17, "0")}`,
          expiresAt: String(Date.now() + 60_000),
        });
        return {
          encryptedKey: [...bytes(192, Number(request.generation))],
          publicInfo: request.generation === "8" ? current : previous,
        };
      },
      approve: async () => undefined,
    };
    const resident = new MailCryptoResidentSession(worker, dependencies);

    expect(await resident.status()).toMatchObject({
      currentUnlocked: true,
      previousUnlocked: true,
    });
    expect(generations).toEqual(["8", "7"]);
  });

  test("fails closed and re-syncs when rotation races an in-flight derivation", async () => {
    const worker = new FakeWorker();
    const oldCurrent = publicInfo("7", 0x31);
    const newCurrent = publicInfo("8", 0x41);
    let rotated = false;
    const dependencies: MailCryptoResidentDependencies = {
      getBackendStatus: async () => rotated
        ? rotationProgress("8", "7")
        : fixtureProgress("7"),
      listSlots: async () => ({
        slots: [
          rotated
            ? slotForPublicInfo(newCurrent, oldCurrent)
            : slotForPublicInfo(oldCurrent),
        ],
      }),
      getPublicKey: async ({ generation }) => generation === "8" ? newCurrent : oldCurrent,
      derive: async (_request, options) => {
        options.onChallenge({
          type: "challenge",
          challengeId: "opaque_challenge_123456789",
          expiresAt: String(Date.now() + 60_000),
        });
        rotated = true;
        return { encryptedKey: [...bytes(192, 0x71)], publicInfo: oldCurrent };
      },
      approve: async () => undefined,
    };
    const resident = new MailCryptoResidentSession(worker, dependencies);
    await resident.sync();

    expect(await resident.ensureGeneration()).toEqual({
      ok: false,
      error: { code: "capability_changed", retryAfterSeconds: null },
    });
    expect(worker.completedKey).toBeNull();
    expect(await resident.sync()).toMatchObject({
      lockState: "locked",
      currentEpoch: "8",
      previousEpoch: "7",
      currentUnlocked: false,
      previousUnlocked: false,
    });
    expect(worker.clearCacheCount).toBe(0);
  });
});

function fixtureDependencies(
  current: VetKeyPublicInfo,
  overrides: Partial<MailCryptoResidentDependencies> = {},
): MailCryptoResidentDependencies {
  const progress: MailBackendCryptoProgress = {
    revision: "1",
    keyHolder: HOLDER,
    currentEpoch: current.generation,
    previousEpoch: null,
    previousReferences: { settings: "0", inbox: "0", outbox: "0", total: "0" },
    readyToRetire: false,
  };
  return {
    getBackendStatus: async () => progress,
    listSlots: async () => ({ slots: [slotForPublicInfo(current)] }),
    getPublicKey: async () => current,
    derive: async () => {
      throw new Error("Unexpected derive");
    },
    approve: async () => undefined,
    ...overrides,
  };
}

function slot(generation: string, previous: string | null = null): VetKeySlotSummary {
  return {
    slot: "mailbox",
    purpose: "Encrypt and decrypt private Mail",
    keyHolder: HOLDER,
    status: "enabled",
    environment: "local",
    currentGeneration: generation,
    previousGeneration: previous,
    generations: [
      {
        generation,
        status: "current",
        keyName: "test_key_1",
        publicFingerprint: null,
      },
      ...(previous === null ? [] : [{
        generation: previous,
        status: "previous" as const,
        keyName: "test_key_1" as const,
        publicFingerprint: null,
      }]),
    ],
    createdAt: "1",
    updatedAt: "1",
    lastUsedAt: null,
    totalDerivations: "0",
    approximateCycleSpend: "0",
  };
}

function slotForPublicInfo(
  current: VetKeyPublicInfo,
  previous: VetKeyPublicInfo | null = null,
): VetKeySlotSummary {
  const summary = slot(current.generation, previous?.generation ?? null);
  return {
    ...summary,
    generations: summary.generations.map((generation) => ({
      ...generation,
      publicFingerprint: generation.generation === current.generation
        ? [...current.publicFingerprint]
        : previous === null
          ? null
          : [...previous.publicFingerprint],
    })),
  };
}

function fixtureProgress(currentEpoch: string): MailBackendCryptoProgress {
  return {
    revision: "1",
    keyHolder: HOLDER,
    currentEpoch,
    previousEpoch: null,
    previousReferences: { settings: "0", inbox: "0", outbox: "0", total: "0" },
    readyToRetire: false,
  };
}

function rotationProgress(
  currentEpoch: string,
  previousEpoch: string,
): MailBackendCryptoProgress {
  return {
    revision: "1",
    keyHolder: HOLDER,
    currentEpoch,
    previousEpoch,
    previousReferences: { settings: "0", inbox: "1", outbox: "0", total: "1" },
    readyToRetire: false,
  };
}

function publicInfo(generation: string, seed: number): VetKeyPublicInfo {
  const point = bls12_381.G2.Point.BASE.multiply(BigInt(seed + 1));
  const publicKey = new DerivedPublicKey(point).publicKeyBytes();
  const publicFingerprint = sha256(publicKey);
  return {
    canisterPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    slot: "mailbox",
    generation,
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: [...publicKey],
    publicFingerprint: [...publicFingerprint],
    derivationInput: [...bytes(32, seed + 1)],
  };
}

function workerPublicInfo(info: VetKeyPublicInfo): MailWorkerCachePublicInfo {
  const contextPublicKey = Uint8Array.from(info.publicKey);
  const effectiveIbeIdentity = Uint8Array.from(info.derivationInput);
  return {
    canisterPrincipal: info.canisterPrincipal,
    slot: "mailbox",
    suite: 1,
    keyName: info.keyName,
    epoch: info.generation,
    publicFingerprint: Uint8Array.from(info.publicFingerprint),
    fingerprint: computeMailKeyFingerprint({
      suite: 1,
      epoch: BigInt(info.generation),
      contextPublicKey,
      effectiveIbeIdentity,
    }),
    contextPublicKey,
    effectiveIbeIdentity,
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 19) & 0xff);
}

function sameNumbers(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function createRecoveryLock(): NonNullable<
  MailCryptoResidentDependencies["withRecoveryLock"]
> {
  let tail = Promise.resolve();
  return async <Result>(
    _name: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}
