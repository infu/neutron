import type { VetKeyPublicInfo, VetKeySlotSummary } from "neutron-tools/app";
import { isValidAppId } from "neutron-tools/src/app_ids.js";

export const FIXTURE_APP_IDS = [
  "vetkeys_fixture",
  "vetkeys_fixture_peer",
] as const;
export type FixtureAppId = (typeof FIXTURE_APP_IDS)[number];
export const FIXTURE_SLOT = "mailbox";

const MAX_U64 = 18_446_744_073_709_551_615n;

export type SafePublicEvidence = {
  appId: FixtureAppId;
  slot: typeof FIXTURE_SLOT;
  canisterPrincipal: string;
  generation: string;
  environmentKey: "key_1" | "test_key_1";
  suite: "bls12_381_g2";
  publicFingerprint: string;
  namespaceEvidence: string;
};

export type InstalledSlotProof = {
  appId: string;
  slot: string;
  slotUid: string;
  publicKey: readonly number[];
  publicFingerprint: readonly number[];
  derivationInput: readonly number[];
};

export function fixtureSlot(
  slots: readonly VetKeySlotSummary[],
): VetKeySlotSummary | null {
  const matches = slots.filter((slot) => slot.slot === FIXTURE_SLOT);
  if (matches.length > 1) throw new Error("Duplicate fixture key slot");
  return matches[0] ?? null;
}

export function createSafePublicEvidence(
  value: VetKeyPublicInfo,
  appId: FixtureAppId,
): SafePublicEvidence {
  assertPublicInfo(value);
  return {
    appId,
    slot: FIXTURE_SLOT,
    canisterPrincipal: value.canisterPrincipal,
    generation: value.generation,
    environmentKey: value.keyName,
    suite: value.suite,
    publicFingerprint: hex(value.publicFingerprint),
    namespaceEvidence: compactHex(value.derivationInput),
  };
}

export function installedFixtureAppId(href: string): FixtureAppId {
  const url = new URL(href);
  const match = /^\/app\/(vetkeys_fixture(?:_peer)?)\//u.exec(url.pathname);
  const pathApp = match?.[1];
  const queryApp = url.searchParams.get("app");
  if (
    !pathApp ||
    !isFixtureAppId(pathApp) ||
    queryApp !== pathApp
  ) {
    throw new Error("Fixture asset URL is not bound to an exact fixture app");
  }
  return pathApp;
}

export function isFixtureAppId(value: unknown): value is FixtureAppId {
  return FIXTURE_APP_IDS.some((candidate) => candidate === value);
}

export function samePublicBinding(
  left: VetKeyPublicInfo,
  right: VetKeyPublicInfo,
): boolean {
  assertPublicInfo(left);
  assertPublicInfo(right);
  return (
    left.canisterPrincipal === right.canisterPrincipal &&
    left.slot === right.slot &&
    left.generation === right.generation &&
    left.keyName === right.keyName &&
    equalBytes(left.publicKey, right.publicKey) &&
    equalBytes(left.publicFingerprint, right.publicFingerprint) &&
    equalBytes(left.derivationInput, right.derivationInput)
  );
}

/**
 * Assertion used by the local integration verifier. It compares only public
 * information and the kernel's never-reused administrative slot identity.
 */
export function assertIsolatedSameNamedSlots(
  left: InstalledSlotProof,
  right: InstalledSlotProof,
): void {
  assertInstalledProof(left, "first");
  assertInstalledProof(right, "second");
  if (left.appId === right.appId) {
    throw new Error("Isolation proof requires two distinct installed apps");
  }
  if (left.slot !== right.slot) {
    throw new Error("Isolation proof requires the same declared slot name");
  }
  if (left.slotUid === right.slotUid) {
    throw new Error("Installed apps unexpectedly share a slot binding");
  }
  if (equalBytes(left.publicKey, right.publicKey)) {
    throw new Error("Installed apps unexpectedly share a public key root");
  }
  if (equalBytes(left.publicFingerprint, right.publicFingerprint)) {
    throw new Error("Installed apps unexpectedly share a public fingerprint");
  }
  if (equalBytes(left.derivationInput, right.derivationInput)) {
    throw new Error("Installed apps unexpectedly share derivation input");
  }
}

export function compactHex(bytes: readonly number[]): string {
  const value = hex(bytes);
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

export function compactPrincipal(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function assertPublicInfo(value: VetKeyPublicInfo): void {
  if (
    !value ||
    value.slot !== FIXTURE_SLOT ||
    typeof value.canisterPrincipal !== "string" ||
    value.canisterPrincipal.length < 3 ||
    value.canisterPrincipal.length > 80 ||
    value.suite !== "bls12_381_g2" ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1") ||
    !canonicalGeneration(value.generation)
  ) {
    throw new Error("Invalid fixture public-key information");
  }
  assertBytes(value.publicKey, 96, "public key");
  assertBytes(value.publicFingerprint, 32, "public fingerprint");
  assertBytes(value.derivationInput, 32, "derivation input");
}

function assertInstalledProof(value: InstalledSlotProof, label: string): void {
  if (
    !value ||
    !isValidAppId(value.appId) ||
    typeof value.slot !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(value.slot) ||
    !canonicalU64(value.slotUid, false)
  ) {
    throw new Error(`Invalid ${label} installed slot proof`);
  }
  assertBytes(value.publicKey, 96, `${label} public key`);
  assertBytes(value.publicFingerprint, 32, `${label} public fingerprint`);
  assertBytes(value.derivationInput, 32, `${label} derivation input`);
}

function canonicalGeneration(value: unknown): value is string {
  return typeof value === "string" && canonicalU64(value, false);
}

function canonicalU64(value: string, allowZero: boolean): boolean {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= MAX_U64 && (allowZero || parsed > 0n);
}

function assertBytes(
  value: readonly number[],
  length: number,
  label: string,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error(`Invalid fixture ${label}`);
  }
}

function equalBytes(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
