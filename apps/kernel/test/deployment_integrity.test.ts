import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  compareInstalledModuleHash,
  loadCertifiedInstalledModuleHash,
  type CertifiedInstalledModuleHash,
} from "../src/settings/deployment_integrity.ts";

const ACTUAL = "ab".repeat(32);
const EXPECTED = "cd".repeat(32);
const certified = (sha256 = ACTUAL): CertifiedInstalledModuleHash => ({
  sha256,
  source: "ic_certified_read_state_v1",
});

test("certified module-hash loading validates the public state result", async () => {
  let observedCanister = "";
  const loaded = await loadCertifiedInstalledModuleHash({
    canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    readModuleHash: async (canisterId) => {
      observedCanister = canisterId.toText();
      return ACTUAL;
    },
  });

  expect(observedCanister).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(loaded).toEqual({
    sha256: ACTUAL,
    source: "ic_certified_read_state_v1",
  });
  expect(Object.isFrozen(loaded)).toBe(true);
});

test("certified module-hash loading rejects absent or malformed results", async () => {
  for (const value of [
    null,
    undefined,
    "",
    "ab".repeat(31),
    "AB".repeat(32),
    `0x${ACTUAL}`,
    new Uint8Array(32),
  ]) {
    await expect(
      loadCertifiedInstalledModuleHash({
        canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        readModuleHash: async () => value,
      }),
    ).rejects.toThrow("must be a lowercase SHA-256 digest");
  }
});

test("certified module-hash loading preserves read-state failures", async () => {
  await expect(
    loadCertifiedInstalledModuleHash({
      canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      readModuleHash: async () => {
        throw new Error("certificate is stale");
      },
    }),
  ).rejects.toThrow("certificate is stale");
});

test("module-hash comparison distinguishes unavailable, stale, match, and mismatch", () => {
  expect(compareInstalledModuleHash(certified(), "deploy-current", null)).toEqual({
    status: "build_record_unavailable",
    actual_sha256: ACTUAL,
  });
  expect(
    compareInstalledModuleHash(certified(), "deploy-current", {
      deployment_id: "deploy-old",
      sha256: ACTUAL,
    }),
  ).toEqual({
    status: "deployment_mismatch",
    actual_sha256: ACTUAL,
    expected_deployment_id: "deploy-old",
    runtime_deployment_id: "deploy-current",
  });
  expect(
    compareInstalledModuleHash(certified(), "deploy-current", {
      deployment_id: "deploy-current",
      sha256: ACTUAL,
    }),
  ).toEqual({
    status: "match",
    actual_sha256: ACTUAL,
    expected_sha256: ACTUAL,
  });
  expect(
    compareInstalledModuleHash(certified(), "deploy-current", {
      deployment_id: "deploy-current",
      sha256: EXPECTED,
    }),
  ).toEqual({
    status: "mismatch",
    actual_sha256: ACTUAL,
    expected_sha256: EXPECTED,
  });
});

test("module-hash comparison rejects uncertified or malformed evidence", () => {
  expect(() =>
    compareInstalledModuleHash(
      {
        sha256: ACTUAL,
        source: "other",
      } as unknown as CertifiedInstalledModuleHash,
      "deploy-current",
      null,
    ),
  ).toThrow("not certified IC state");
  expect(() =>
    compareInstalledModuleHash(certified(), "deploy-current", {
      deployment_id: "deploy-old",
      sha256: "not-a-digest",
    }),
  ).toThrow("Expected installed module hash must be a lowercase SHA-256 digest");
});

test("production loader uses certificate-verified module_hash with freshness enabled", async () => {
  const source = await readFile(
    new URL("../src/settings/deployment_integrity.ts", import.meta.url),
    "utf8",
  );
  const auth = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("CanisterStatus.request");
  expect(source).toContain('paths: ["module_hash"]');
  expect(source).toContain("agent instanceof HttpAgent");
  expect(source).not.toContain("disableCertificateTimeVerification");
  expect(auth).toContain('rootKeyPolicy === "fetch"');
  expect(auth).toContain("await agent.fetchRootKey()");
});
