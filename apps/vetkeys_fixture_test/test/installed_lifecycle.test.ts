import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { assertAppVersion } from "neutron-tools/src/version.js";

const archive = new URL("../vetkeys_fixture.v0.1.1.neutron", import.meta.url);

test("lifecycle variants retain the app identity while changing only declaration/version", async () => {
  const unpacked = unpackNeutronPackage(
    new Uint8Array(await readFile(archive)),
  );
  const compatible = buildLifecycleVariant(unpacked, 101, true);
  const removed = buildLifecycleVariant(unpacked, 102, false);
  const restored = buildLifecycleVariant(unpacked, 103, true);

  expect(compatible.manifest).toMatchObject({
    id: "vetkeys_fixture",
    version: 101,
    capabilities: { vetkeys: { slots: [{ id: "mailbox" }] } },
  });
  expect(removed.manifest).toMatchObject({
    id: "vetkeys_fixture",
    version: 102,
  });
  expect(removed.manifest.capabilities?.vetkeys).toBeUndefined();
  expect(restored.manifest).toMatchObject({
    id: "vetkeys_fixture",
    version: 103,
    capabilities: { vetkeys: { slots: [{ id: "mailbox" }] } },
  });
  expect(compatible.files.map(({ path }) => path)).toEqual(
    restored.files.map(({ path }) => path),
  );
});

test("active lineage requires a fresh uid and restore branches require fresh crypto", () => {
  const original = root("1", "aa", "bb", "cc");
  const reinstalled = root("2", "dd", "ee", "ff");
  expect(() => assertFreshContext(original, reinstalled, "reinstall"))
    .not.toThrow();
  expect(() => assertFreshContext(original, root("1", "dd", "ee", "ff"), "reinstall"))
    .toThrow("slot uid");
  expect(() => assertFreshContext(original, root("2", "aa", "ee", "ff"), "reinstall"))
    .toThrow("cryptographic context");

  // A full canister rollback restores the slot counter too, so a UID from the
  // discarded future branch may recur. The random namespace/root must not.
  expect(() => assertDiscardedContextNotReused(
    reinstalled,
    root("2", "11", "22", "33"),
  )).not.toThrow();
  expect(() => assertDiscardedContextNotReused(
    reinstalled,
    root("3", "dd", "44", "55"),
  )).toThrow("discarded future");
});

test("snapshot ids accept canonical management blobs and reject shell-shaped text", () => {
  expect(canonicalSnapshotId("00000000000000007fffffffff9000020101")).toBe(true);
  expect(canonicalSnapshotId("ab".repeat(64))).toBe(true);
  expect(canonicalSnapshotId("abc")).toBe(false);
  expect(canonicalSnapshotId("0xdeadbeefdeadbeef")).toBe(false);
  expect(canonicalSnapshotId("deadbeef;rm -rf /tmp")).toBe(false);
});

function root(
  slotUid: string,
  publicRoot: string,
  publicFingerprint: string,
  derivationInput: string,
) {
  return {
    slotUid,
    generation: "1",
    publicRoot,
    publicFingerprint,
    derivationInput,
  };
}

function buildLifecycleVariant(
  unpacked: Record<string, Uint8Array>,
  version: number,
  declaresVetKeys: boolean,
): PreparedPackageInstall {
  assertAppVersion(version, "Lifecycle fixture package version");
  const copied: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(unpacked).map(([key, value]) => [
      key,
      Uint8Array.from(value),
    ]),
  );
  // This test synthesizes versions which were never conveyed.  Drop the
  // immutable release envelope instead of leaving its package/source identity
  // falsely bound to v101 while the synthetic manifest is changed below.
  for (const path of Object.keys(copied)) {
    if (path.startsWith("legal/")) delete copied[path];
  }
  const manifest = decodeJson(copied["neutron.json"], "fixture manifest");
  if (manifest.id !== "vetkeys_fixture") {
    throw new Error("Lifecycle variants require the primary fixture archive");
  }
  delete manifest.package_features;
  manifest.version = version;
  if (!declaresVetKeys) {
    const capabilities = record(manifest.capabilities, "fixture capabilities");
    delete capabilities.vetkeys;
    if (Object.keys(capabilities).length === 0) delete manifest.capabilities;
  }
  const schema = decodeJson(copied["schema.json"], "fixture schema");
  record(schema.app, "fixture schema app").version = version;
  copied["neutron.json"] = encodeJson(manifest);
  copied["schema.json"] = encodeJson(schema);

  const prepared = preparePackageInstall(copied);
  if (
    prepared.manifest.version !== version ||
    Boolean(prepared.manifest.capabilities?.vetkeys) !== declaresVetKeys
  ) {
    throw new Error("Lifecycle variant metadata did not survive preparation");
  }
  return prepared;
}

type RootEvidence = ReturnType<typeof root>;

function assertFreshContext(
  previous: RootEvidence,
  next: RootEvidence,
  label: string,
): void {
  if (previous.slotUid === next.slotUid) {
    throw new Error(`${label} reused the active-lineage slot uid`);
  }
  if (sameCryptographicRoot(previous, next)) {
    throw new Error(`${label} reused the retired cryptographic context`);
  }
}

function assertDiscardedContextNotReused(
  discarded: RootEvidence,
  next: RootEvidence,
): void {
  if (sameCryptographicRoot(discarded, next)) {
    throw new Error(
      "A post-restore reinstall reused the discarded future cryptographic context",
    );
  }
}

function sameCryptographicRoot(
  left: RootEvidence,
  right: RootEvidence,
): boolean {
  return left.publicRoot === right.publicRoot ||
    left.publicFingerprint === right.publicFingerprint ||
    left.derivationInput === right.derivationInput;
}

function canonicalSnapshotId(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length <= 128 &&
    value.length % 2 === 0 &&
    /^[a-f0-9]+$/u.test(value)
  );
}

function decodeJson(
  value: Uint8Array | undefined,
  label: string,
): Record<string, unknown> {
  if (!value) throw new Error(`Missing ${label}`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(value));
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error });
  }
  return record(decoded, label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
