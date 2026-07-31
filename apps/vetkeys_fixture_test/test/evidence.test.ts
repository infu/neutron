import { describe, expect, test } from "bun:test";
import type { VetKeyPublicInfo, VetKeySlotSummary } from "neutron-tools/app";
import {
  FIXTURE_APP_IDS,
  FIXTURE_SLOT,
  assertIsolatedSameNamedSlots,
  createSafePublicEvidence,
  fixtureSlot,
  installedFixtureAppId,
  samePublicBinding,
} from "../src/evidence";
import { createIsolationReport } from "../src/isolation_report";

const bytes = (length: number, seed: number): number[] =>
  Array.from({ length }, (_, index) => (seed + index * 17) & 0xff);

function publicInfo(seed = 1): VetKeyPublicInfo {
  return {
    canisterPrincipal: "aaaaa-aa",
    slot: FIXTURE_SLOT,
    generation: "1",
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: bytes(96, seed),
    publicFingerprint: bytes(32, seed + 1),
    derivationInput: bytes(32, seed + 2),
  };
}

function summary(slot = FIXTURE_SLOT): VetKeySlotSummary {
  return {
    slot,
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
      publicFingerprint: bytes(32, 8),
    }],
    createdAt: "1",
    updatedAt: "1",
    lastUsedAt: null,
    totalDerivations: "0",
    approximateCycleSpend: "0",
  };
}

describe("safe public evidence", () => {
  test("projects only public binding facts", () => {
    const evidence = createSafePublicEvidence(publicInfo(), FIXTURE_APP_IDS[0]);
    expect(evidence).toEqual({
      appId: FIXTURE_APP_IDS[0],
      slot: FIXTURE_SLOT,
      canisterPrincipal: "aaaaa-aa",
      generation: "1",
      environmentKey: "test_key_1",
      suite: "bls12_381_g2",
      publicFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      namespaceEvidence: expect.stringMatching(/^[0-9a-f]{12}…[0-9a-f]{10}$/),
    });
    expect(evidence).not.toHaveProperty("publicKey");
    expect(evidence).not.toHaveProperty("encryptedKey");
    expect(evidence).not.toHaveProperty("privateKey");
  });

  test("rejects malformed or cross-slot public information", () => {
    expect(() => createSafePublicEvidence({
      ...publicInfo(),
      slot: "other",
    }, FIXTURE_APP_IDS[0])).toThrow("Invalid fixture public-key information");
    expect(() => createSafePublicEvidence({
      ...publicInfo(),
      publicFingerprint: bytes(31, 1),
    }, FIXTURE_APP_IDS[0])).toThrow("Invalid fixture public fingerprint");
  });

  test("compares every public binding component", () => {
    const current = publicInfo();
    expect(samePublicBinding(current, { ...current })).toBe(true);
    expect(samePublicBinding(current, {
      ...current,
      derivationInput: bytes(32, 9),
    })).toBe(false);
  });

  test("finds exactly this app's declared slot", () => {
    expect(fixtureSlot([summary("other"), summary()])?.slot).toBe(FIXTURE_SLOT);
    expect(fixtureSlot([])).toBeNull();
    expect(() => fixtureSlot([summary(), summary()])).toThrow(
      "Duplicate fixture key slot",
    );
  });

  test("derives either exact installed fixture id from both URL bindings", () => {
    for (const appId of FIXTURE_APP_IDS) {
      expect(installedFixtureAppId(
        `http://app-${appId}--aaaaa-aa.localhost:8000/app/${appId}/index.html?app=${appId}&tile=main`,
      )).toBe(appId);
    }
    expect(() => installedFixtureAppId(
      "http://app-vetkeys-fixture--aaaaa-aa.localhost:8000/app/vetkeys_fixture/index.html?app=vetkeys_fixture_peer",
    )).toThrow("not bound to an exact fixture app");
    expect(() => installedFixtureAppId(
      "http://localhost/app/mail/index.html?app=mail",
    )).toThrow("not bound to an exact fixture app");
  });
});

describe("two-app isolation proof", () => {
  const first = {
    appId: FIXTURE_APP_IDS[0],
    slot: "mailbox",
    slotUid: "41",
    canisterPrincipal: "aaaaa-aa",
    generation: "1",
    publicKey: bytes(96, 1),
    publicFingerprint: bytes(32, 2),
    derivationInput: bytes(32, 3),
  };
  const second = {
    ...first,
    appId: FIXTURE_APP_IDS[1],
    slotUid: "42",
    publicKey: bytes(96, 11),
    publicFingerprint: bytes(32, 12),
    derivationInput: bytes(32, 13),
  };

  test("accepts distinct bindings and full public roots for equal slot names", () => {
    expect(() => assertIsolatedSameNamedSlots(first, second)).not.toThrow();
    expect(createIsolationReport(first, second)).toMatchObject({
      canisterPrincipal: "aaaaa-aa",
      slot: "mailbox",
      first: { appId: FIXTURE_APP_IDS[0], slotUid: "41" },
      second: { appId: FIXTURE_APP_IDS[1], slotUid: "42" },
      isolated: true,
    });
  });

  test("fails closed if any namespace evidence is shared", () => {
    expect(() => assertIsolatedSameNamedSlots(first, {
      ...second,
      slotUid: first.slotUid,
    })).toThrow("share a slot binding");
    expect(() => assertIsolatedSameNamedSlots(first, {
      ...second,
      publicKey: first.publicKey,
    })).toThrow("share a public key root");
    expect(() => assertIsolatedSameNamedSlots(first, {
      ...second,
      publicFingerprint: first.publicFingerprint,
    })).toThrow("share a public fingerprint");
    expect(() => assertIsolatedSameNamedSlots(first, {
      ...second,
      derivationInput: first.derivationInput,
    })).toThrow("share derivation input");
  });
});
