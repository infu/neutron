import { expect, test } from "bun:test";
import { parseInstallProvenance } from "../src/repository/provenance.ts";
import {
  loadCertifiedInstalledModuleHash,
} from "../src/settings/deployment_integrity.ts";

test("one certified deployment module hash remains distinct from per-app package digests", async () => {
  const alphaPackageDigest = "11".repeat(32);
  const betaPackageDigest = "22".repeat(32);
  const deploymentModuleHash = "33".repeat(32);
  const provenance = parseInstallProvenance({
    format: 1,
    apps: {
      alpha: {
        kind: "manual",
        acquisition: "file",
        package_digest: alphaPackageDigest,
      },
      beta: {
        kind: "manual",
        acquisition: "url",
        package_digest: betaPackageDigest,
      },
    },
  });

  let reads = 0;
  let observedCanister = "";
  const installed = await loadCertifiedInstalledModuleHash({
    canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    readModuleHash: async (canisterId) => {
      reads += 1;
      observedCanister = canisterId.toText();
      return deploymentModuleHash;
    },
  });

  expect(reads).toBe(1);
  expect(observedCanister).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
  expect(provenance.apps.alpha?.package_digest).toBe(alphaPackageDigest);
  expect(provenance.apps.beta?.package_digest).toBe(betaPackageDigest);
  expect(installed).toEqual({
    sha256: deploymentModuleHash,
    source: "ic_certified_read_state_v1",
  });
  expect(installed.sha256).not.toBe(alphaPackageDigest);
  expect(installed.sha256).not.toBe(betaPackageDigest);
  expect(Object.keys(installed).sort()).toEqual(["sha256", "source"]);
});
