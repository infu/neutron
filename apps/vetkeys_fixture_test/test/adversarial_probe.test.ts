import { describe, expect, test } from "bun:test";
import type {
  VetKeyDeriveOptions,
  VetKeyDeriveResult,
  VetKeyPublicInfo,
  VetKeySlotSummary,
} from "neutron-tools/app";
import {
  INJECTED_PEER_OPERATIONS,
  InstalledOriginProbe,
  type FixtureProbeDependencies,
} from "../src/adversarial_probe";
import {
  EphemeralDerivationSession,
  type OneUseTransport,
} from "../src/derivation_session";

const bytes = (length: number, value: number): number[] =>
  Array.from({ length }, () => value);

function publicInfo(): VetKeyPublicInfo {
  return {
    canisterPrincipal: "aaaaa-aa",
    slot: "mailbox",
    generation: "1",
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: bytes(96, 4),
    publicFingerprint: bytes(32, 5),
    derivationInput: bytes(32, 6),
  };
}

function slot(): VetKeySlotSummary {
  return {
    slot: "mailbox",
    purpose: "Fixture",
    keyHolder: "aaaaa-aa",
    status: "enabled",
    environment: "local",
    currentGeneration: "1",
    previousGeneration: null,
    generations: [{
      generation: "1",
      status: "current",
      keyName: "test_key_1",
      publicFingerprint: bytes(32, 5),
    }],
    createdAt: "1",
    updatedAt: "1",
    lastUsedAt: null,
    totalDerivations: "0",
    approximateCycleSpend: "0",
  };
}

class FakeTransport implements OneUseTransport {
  publicKeyBytes(): Uint8Array {
    return Uint8Array.from(bytes(48, 3));
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): object {
    expect(input.encryptedVetKey).toHaveLength(192);
    expect(input.contextPublicKey).toHaveLength(96);
    expect(input.derivationInput).toHaveLength(32);
    return Object.freeze({ opaque: true });
  }
}

function vetKeysError(code: "invalid_request" | "source_gone"): Error {
  return Object.assign(new Error(code), { code });
}

function dependencies(): FixtureProbeDependencies {
  const info = publicInfo();
  return {
    list: async () => ({ slots: [slot()] }),
    publicKey: async () => info,
    derive: async (_request, options: VetKeyDeriveOptions): Promise<VetKeyDeriveResult> => {
      options.onChallenge({
        type: "challenge",
        challengeId: `vkc_${"a".repeat(32)}`,
        expiresAt: "9999999999999",
      });
      return { encryptedKey: bytes(192, 8), publicInfo: info };
    },
    approve: async (challengeId) => {
      if (challengeId !== `vkc_${"a".repeat(32)}`) {
        throw vetKeysError("source_gone");
      }
    },
    raw: async () => {
      throw vetKeysError("invalid_request");
    },
    createSession: () => new EphemeralDerivationSession({
      createTransport: () => new FakeTransport(),
      randomBytes: (length) => Uint8Array.from(bytes(length, 9)),
    }),
  };
}

describe("installed browser-origin adversarial probe", () => {
  test("rejects app-id injection across data and lifecycle operations", async () => {
    const calls: Array<{ action: string; payload: unknown }> = [];
    const deps = dependencies();
    deps.raw = async (action, payload) => {
      calls.push({ action, payload });
      throw vetKeysError("invalid_request");
    };
    const probe = new InstalledOriginProbe("vetkeys_fixture", deps);
    const results = await probe.injectPeerAppId("vetkeys_fixture_peer");
    expect(results.map(({ operation }) => operation)).toEqual(
      [...INJECTED_PEER_OPERATIONS],
    );
    expect(results.every(({ rejected, code }) =>
      rejected && code === "invalid_request",
    )).toBe(true);
    expect(calls.slice(3)).toEqual([
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "enable",
          slot: "mailbox",
        },
      },
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "disable",
          slot: "mailbox",
        },
      },
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "rotate",
          slot: "mailbox",
        },
      },
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "retireGeneration",
          slot: "mailbox",
          generation: "1",
        },
      },
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "transfer",
          slot: "mailbox",
          newHolder: "aaaaa-aa",
        },
      },
      {
        action: "vetkeys.request",
        payload: {
          appId: "vetkeys_fixture_peer",
          action: "retireSlot",
          slot: "mailbox",
        },
      },
    ]);
  });

  test("foreign confirmation fails while exact-source confirmation completes", async () => {
    const probe = new InstalledOriginProbe("vetkeys_fixture", dependencies());
    const own = await probe.beginOwnDerivation();
    expect(own).toMatchObject({ appId: "vetkeys_fixture" });
    expect(await probe.rejectForeignChallenge(`vkc_${"b".repeat(32)}`))
      .toMatchObject({
        operation: "foreignChallenge.confirm",
        rejected: true,
        code: "source_gone",
      });
    expect(await probe.confirmOwnDerivation(own.challengeId)).toMatchObject({
      appId: "vetkeys_fixture",
      slot: "mailbox",
      environmentKey: "test_key_1",
    });
  });

  test("fails when the peer id or installed local binding is not exact", async () => {
    const probe = new InstalledOriginProbe("vetkeys_fixture", dependencies());
    await expect(probe.injectPeerAppId("vetkeys_fixture")).rejects.toThrow(
      "other exact fixture app id",
    );
    const disabled = dependencies();
    disabled.list = async () => ({
      slots: [{ ...slot(), status: "disabled" }],
    });
    await expect(new InstalledOriginProbe(
      "vetkeys_fixture",
      disabled,
    ).beginOwnDerivation()).rejects.toThrow("reserved and enabled");
  });
});
