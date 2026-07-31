import { describe, expect, test } from "bun:test";
import {
  DerivedPublicKey,
  VetKey,
  augmentedHashToG1,
} from "@dfinity/vetkeys";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import {
  MailCryptoVault,
  type MailTransportSession,
} from "../src/crypto_vault.ts";
import { OfficialMailIbeAdapter } from "../src/vetkeys_adapter.ts";
import type { MailIbePublicKeyInfo } from "../src/crypto.ts";
import { computeMailKeyFingerprint } from "../src/protocol.ts";

const SENDER = "un4fu-tqaaa-aaaab-qadjq-cai";
const RECIPIENT = "ryjl3-tyaaa-aaaaa-aaaba-cai";

describe("resident Mail crypto vault", () => {
  test("owns current and previous handles, rewraps locally, and expires all keys", async () => {
    const generation7 = keyFixture(7n, 0x7103n);
    const generation8 = keyFixture(8n, 0x8107n);
    const recipient = keyFixture(4n, 0x4109n);
    const handles = [generation7.handle, generation8.handle];
    const sessions: FakeTransportSession[] = [];
    let now = 10_000;
    let randomCounter = 1;
    const vault = new MailCryptoVault<VetKey>({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => {
        const handle = handles.shift();
        if (!handle) throw new Error("No fake transport handle remains");
        const session = new FakeTransportSession(handle);
        sessions.push(session);
        return session;
      },
      now: () => now,
      randomBytes: (length) => bytes(length, randomCounter++),
    });

    expect(vault.configure({
      current: generation7.info,
      previous: null,
      inactivityMs: 60_000,
    })).toMatchObject({ configured: true, currentUnlocked: false });

    const begin7 = vault.beginUnlock(7n);
    expect(begin7.transportPublicKey).toHaveLength(48);
    expect(begin7.requestNonce).toHaveLength(32);
    expect(await vault.completeUnlock(7n, bytes(192, 0x31))).toMatchObject({
      currentUnlocked: true,
      unlockedEpochs: [7n],
    });
    expect(sessions[0]!.consumed).toBe(true);

    const encrypted = await vault.encrypt({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      recipientKey: recipient.info,
      header: {
        contentSchema: 1,
        claimedSenderName: "Ada",
        subject: "Rotation test",
        senderCreatedAtNs: "123",
        inReplyTo: null,
      },
      body: { contentSchema: 1, bodyMarkdown: "Private body" },
    });
    const immutableEnvelope = encrypted.envelope.slice();

    const rotated = vault.configure({
      current: generation8.info,
      previous: generation7.info,
      inactivityMs: 60_000,
    });
    expect(rotated.currentUnlocked).toBe(false);
    expect(rotated.unlockedEpochs).toEqual([7n]);
    vault.beginUnlock(8n);
    await vault.completeUnlock(8n, bytes(192, 0x42));

    const replacement = await vault.rewrap(encrypted.senderLocalWrap);
    expect(replacement.epoch).toBe(8n);
    expect(encrypted.envelope).toEqual(immutableEnvelope);
    const decrypted = await vault.decrypt({
      senderPrincipal: SENDER,
      recipientPrincipal: RECIPIENT,
      envelope: encrypted.envelope,
      localWrap: replacement,
    });
    expect(decrypted.header.subject).toBe("Rotation test");
    expect(decrypted.body.bodyMarkdown).toBe("Private body");

    now += 60_001;
    expect(vault.status()).toMatchObject({
      currentUnlocked: false,
      unlockedEpochs: [],
      inactivityExpiresAt: null,
    });
  });

  test("an expired unlock is consumed and cannot be completed", async () => {
    const generation = keyFixture(3n, 0x3301n);
    let now = 1_000;
    const session = new FakeTransportSession(generation.handle);
    const vault = new MailCryptoVault<VetKey>({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => session,
      now: () => now,
      randomBytes: (length) => bytes(length, 0x22),
    });
    vault.configure({ current: generation.info, previous: null });
    vault.beginUnlock(3n);
    now += 60_001;
    await expect(vault.completeUnlock(3n, bytes(192, 0x44))).rejects.toThrow();
    expect(vault.status().pendingEpoch).toBeNull();
    expect(vault.status().currentUnlocked).toBe(false);
  });

  test("reset removes configuration as well as every volatile handle", async () => {
    const current = keyFixture(3n, 0x37n);
    const vault = new MailCryptoVault({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(current.handle),
    });
    vault.configure({ current: current.info, previous: null });
    vault.beginUnlock(3n);
    await vault.completeUnlock(3n, bytes(192, 0x55));

    expect(vault.reset()).toEqual({
      configured: false,
      currentEpoch: null,
      previousEpoch: null,
      unlockedEpochs: [],
      currentUnlocked: false,
      pendingEpoch: null,
      inactivityExpiresAt: null,
    });
    expect(() => vault.beginUnlock(3n)).toThrow("generation is unavailable");
  });

  test("physically clears handles at the scheduled deadline without a later request", async () => {
    const current = keyFixture(3n, 0x37n);
    let now = 1_000;
    let scheduled: (() => void) | null = null;
    let inactivityLocks = 0;
    const vault = new MailCryptoVault({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(current.handle),
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
        return callback;
      },
      cancel: (handle) => {
        if (scheduled === handle) scheduled = null;
      },
      onInactivityLock: () => {
        inactivityLocks += 1;
      },
    });
    vault.configure({ current: current.info, previous: null, inactivityMs: 60_000 });
    vault.beginUnlock(3n);
    await vault.completeUnlock(3n, bytes(192, 0x55));
    const deadlineCallback = scheduled as (() => void) | null;
    expect(deadlineCallback).not.toBeNull();

    now += 60_001;
    deadlineCallback!();
    // The callback is emitted only after the key-handle map is cleared; no
    // status/decrypt worker request was needed to trigger expiry.
    expect(inactivityLocks).toBe(1);
    expect(vault.status().currentUnlocked).toBe(false);
    expect(() => vault.beginUnlock(3n)).not.toThrow();
  });

  test("awaits worker-only recovery and restores only an exact configured handle", async () => {
    const current = keyFixture(9n, 0x97n);
    const mismatched = keyFixture(9n, 0x9bn);
    let recovered = false;
    const vault = new MailCryptoVault({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(current.handle),
      onHandleRecovered: async ({ key, handle }) => {
        await Promise.resolve();
        expect(key.epoch).toBe(9n);
        expect(handle).toBe(current.handle);
        recovered = true;
      },
    });
    vault.configure({ current: current.info, previous: null });
    vault.beginUnlock(9n);
    const completed = await vault.completeUnlock(9n, bytes(192, 0x61));
    expect(recovered).toBe(true);
    expect(completed.currentUnlocked).toBe(true);

    vault.lock();
    expect(() => vault.restoreHandle(mismatched.info, mismatched.handle))
      .toThrow("does not match");
    expect(vault.restoreHandle(current.info, current.handle).currentUnlocked)
      .toBe(true);
  });

  test("keeps a recovered handle when optional persistence fails", async () => {
    const current = keyFixture(10n, 0xa7n);
    const vault = new MailCryptoVault({
      adapter: new OfficialMailIbeAdapter(),
      sessionFactory: () => new FakeTransportSession(current.handle),
      onHandleRecovered: async () => {
        throw new Error("storage unavailable");
      },
    });
    vault.configure({ current: current.info, previous: null });
    vault.beginUnlock(10n);
    await expect(vault.completeUnlock(10n, bytes(192, 0x71)))
      .resolves.toMatchObject({
        currentUnlocked: true,
        unlockedEpochs: [10n],
      });
  });
});

class FakeTransportSession implements MailTransportSession<VetKey> {
  consumed = false;

  constructor(private readonly handle: VetKey) {}

  publicKeyBytes(): Uint8Array {
    return bytes(48, 0x91);
  }

  consume(): VetKey {
    if (this.consumed) throw new Error("already consumed");
    this.consumed = true;
    return this.handle;
  }
}

function keyFixture(epoch: bigint, secretScalar: bigint): {
  info: MailIbePublicKeyInfo;
  handle: VetKey;
} {
  const publicPoint = bls12_381.G2.Point.BASE.multiply(secretScalar);
  const publicKey = new DerivedPublicKey(publicPoint);
  const identity = bytes(32, Number(epoch));
  const handle = new VetKey(
    augmentedHashToG1(publicKey, identity).multiply(secretScalar),
  );
  const contextPublicKey = publicKey.publicKeyBytes();
  return {
    handle,
    info: {
      suite: 1,
      epoch,
      contextPublicKey,
      effectiveIbeIdentity: identity,
      fingerprint: computeMailKeyFingerprint({
        suite: 1,
        epoch,
        contextPublicKey,
        effectiveIbeIdentity: identity,
      }),
    },
  };
}

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 29) & 0xff);
}
