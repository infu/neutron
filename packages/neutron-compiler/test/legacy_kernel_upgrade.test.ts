import { expect, test } from "bun:test";
import {
  LEGACY_KERNEL_RELEASES,
  PRODUCTION_KERNEL_V323_RELEASE,
  PRODUCTION_KERNEL_V324_RELEASE,
  PRODUCTION_KERNEL_V325_RELEASE,
  PRODUCTION_KERNEL_V326_RELEASE,
  PRODUCTION_KERNEL_V327_RELEASE,
  PRODUCTION_KERNEL_V328_RELEASE,
  PRODUCTION_KERNEL_V329_RELEASE,
  RETAINED_KERNEL_V321_RELEASE,
  TEST_CANDIDATE_KERNEL_VERSION,
  compileFinalCandidateLegacyKernelUpgradeFixture,
  compileFinalCandidateProductionKernelUpgradeFixture,
  compileFinalCandidateProductionKernelV324UpgradeFixture,
  compileFinalCandidateProductionKernelV325UpgradeFixture,
  compileFinalCandidateProductionKernelV326UpgradeFixture,
  compileFinalCandidateProductionKernelV327UpgradeFixture,
  compileFinalCandidateProductionKernelV328UpgradeFixture,
  compileFinalCandidateProductionKernelV329UpgradeFixture,
  compileFinalCandidateRetainedKernelUpgradeFixture,
  compileLegacyKernelUpgradeFixture,
  loadLegacyKernelIdentityFixture,
  loadProductionKernelV324Fixture,
  loadProductionKernelV325Fixture,
  loadProductionKernelV326Fixture,
  loadProductionKernelV327Fixture,
  loadProductionKernelV328Fixture,
  loadProductionKernelV329Fixture,
} from "./legacy_kernel_upgrade_fixture.ts";

for (const release of LEGACY_KERNEL_RELEASES) {
  test(`the exact predecessor ${release.label} archive is a durable compiler fixture`, async () => {
    const fixture = await loadLegacyKernelIdentityFixture(release.version);

    expect(fixture.release).toBe(release);
    expect(fixture.archivePath).toBe(release.archivePath);
    expect(fixture.identity.archive).toBe(release.archive);
    expect(fixture.archive.byteLength).toBe(release.bytes);
    expect(fixture.identity.sha256).toBe(release.sha256);
  });
}

test("the final candidate lane requires an externally reviewed archive digest", async () => {
  await expect(
    compileFinalCandidateLegacyKernelUpgradeFixture({ expectedSha256: "" }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the retained v0.3.21 predecessor is final-candidate-only and identity-bound", () => {
  expect(LEGACY_KERNEL_RELEASES.map(({ version }) => version)).not.toContain(
    RETAINED_KERNEL_V321_RELEASE.version,
  );
  expect(RETAINED_KERNEL_V321_RELEASE).toMatchObject({
    label: "v0.3.21",
    version: 321,
    bytes: 2_411_860,
    sha256: "1143b525ce869cae6c44297ec973b56bec06e2250a0885bca12ca87e030c999e",
    persistenceMode: "classical",
  });
});

test("the retained predecessor lane also requires the reviewed candidate digest", async () => {
  await expect(
    compileFinalCandidateRetainedKernelUpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.23 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V323_RELEASE).toMatchObject({
    version: 323,
    bytes: 2_448_813,
    sha256: "e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334",
    persistenceMode: "classical",
  });
  await expect(
    compileFinalCandidateProductionKernelUpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.24 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V324_RELEASE).toMatchObject({
    version: 324,
    bytes: 2_449_608,
    sha256: "6ae401a934160410ec7d099f9d3a7f62c94126ab491fc115cc2e38b5b27c067a",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV324Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V324_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V324_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V324_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V324_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV324UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.25 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V325_RELEASE).toMatchObject({
    version: 325,
    bytes: 2_415_653,
    sha256: "3f7293fb8ab0fe25fd59b2a02e20b66eb4c2920858ed660e163265a4481a098b",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV325Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V325_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V325_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V325_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V325_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV325UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.26 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V326_RELEASE).toMatchObject({
    version: 326,
    bytes: 2_415_895,
    sha256: "738aa64943c759b573d8dd5d9094c7ce9b3017768a9c2616f638a272a591bda4",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV326Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V326_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V326_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V326_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V326_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV326UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.27 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V327_RELEASE).toMatchObject({
    version: 327,
    bytes: 2_414_971,
    sha256: "b3a1e57c6201147eb8c5956592e1e389f23f8cef4ae972d831aa67de5151c65b",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV327Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V327_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V327_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V327_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V327_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV327UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.28 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V328_RELEASE).toMatchObject({
    version: 328,
    bytes: 2_414_532,
    sha256: "46afbf14e5050771b77b9e7d573e5a6f77bc32a07915842dbb752f46d0c06e93",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV328Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V328_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V328_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V328_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V328_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV328UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

test("the exact production v0.3.29 predecessor is identity-bound", async () => {
  expect(PRODUCTION_KERNEL_V329_RELEASE).toMatchObject({
    version: 329,
    bytes: 2_414_606,
    sha256: "6442ace1b0453c251a81a6b2ecce06b2ae76c765f57d02621037a4fd601a0d6e",
    persistenceMode: "classical",
  });
  const fixture = await loadProductionKernelV329Fixture();
  expect(fixture.archive.byteLength).toBe(PRODUCTION_KERNEL_V329_RELEASE.bytes);
  expect(fixture.identity).toMatchObject({
    bytes: PRODUCTION_KERNEL_V329_RELEASE.bytes,
    sha256: PRODUCTION_KERNEL_V329_RELEASE.sha256,
    package: { version: PRODUCTION_KERNEL_V329_RELEASE.version },
  });
  await expect(
    compileFinalCandidateProductionKernelV329UpgradeFixture({
      expectedSha256: "",
    }),
  ).rejects.toThrow(
    "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
  );
});

for (const release of LEGACY_KERNEL_RELEASES) {
  test(`the exact predecessor ${release.label} Kernel compiles a format-3 sidecar upgrade without changing memory roots`, async () => {
    const fixture = await compileLegacyKernelUpgradeFixture(release.version);
    const helloSchema =
      fixture.hello.manifest.memory?.hello?.schemas?.["1"]?.hash;
    if (helloSchema === undefined) {
      throw new Error(
        "The released Hello fixture has no v1 managed-memory schema",
      );
    }

    expect(fixture.release).toBe(release);
    expect(fixture.legacyArchive.byteLength).toBe(release.bytes);
    expect(fixture.identity.sha256).toBe(release.sha256);
    expect(fixture.legacyKernel.manifest).toMatchObject({
      format: 3,
      id: "kernel",
      version: release.version,
      update_source: "233tv-xiaaa-aaaay-aacta-cai",
    });
    expect(fixture.candidateKernel.manifest).toMatchObject({
      format: 3,
      id: "kernel",
      version: TEST_CANDIDATE_KERNEL_VERSION,
      update_source: "233tv-xiaaa-aaaay-aacta-cai",
    });
    expect(fixture.candidateKernel.packageRecord).toMatchObject({
      format: 1,
      package: { id: "kernel", version: TEST_CANDIDATE_KERNEL_VERSION },
      license: { id: "LicenseRef-Neutron-Public-License-1.0" },
      source: { kind: "https" },
    });
    expect(
      fixture.candidateKernel.packageRecord?.build.inputs.length,
    ).toBeGreaterThan(0);
    const candidatePaths = fixture.candidateKernel.files.map(
      ({ path }) => path,
    );
    expect(candidatePaths).toContain("pkg/legal/package-record.v1.json");
    expect(candidatePaths).not.toContain("pkg/legal/GPL-3.0.txt");
    expect(candidatePaths).not.toContain("pkg/legal/LICENSE.GPL-3.0");
    expect(candidatePaths).not.toContain(
      "pkg/legal/GPL-TRANSITION-NOTICE.txt",
    );

    expect(fixture.initial.compatibilityDiagnostics).toEqual([]);
    expect(fixture.upgraded.compatibilityDiagnostics).toEqual([]);
    expect(fixture.initial.appInstanceInventory).toEqual([
      expect.objectContaining({ app_id: "hello", version: 201 }),
      expect.objectContaining({
        app_id: "kernel",
        version: release.version,
      }),
    ]);
    expect(fixture.upgraded.migrationPlan).toEqual({
      upgrades: [
        { kind: "keep", owner: "hello", memoryId: "hello", version: 1 },
        { kind: "keep", owner: "kernel", memoryId: "kernel", version: 3 },
        {
          kind: "keep",
          owner: "kernel",
          memoryId: "kernel_activation",
          version: 1,
        },
      ],
      removedApps: [],
      destructiveMemoryRoots: [],
    });
    expect(fixture.upgraded.managedMemoryRetirements).toEqual([]);
    expect(fixture.upgraded.managedMemoryInventory).toEqual([
      {
        owner: "hello",
        id: "hello",
        version: 1,
        schema: helloSchema,
      },
      ...fixture.identity.memory.map(({ owner, id, version, schema }) => ({
        owner,
        id,
        version,
        schema,
      })),
    ]);
    expect(fixture.upgraded.appInstanceInventory).toEqual([
      expect.objectContaining({ app_id: "hello", version: 201 }),
      expect.objectContaining({
        app_id: "kernel",
        version: TEST_CANDIDATE_KERNEL_VERSION,
      }),
    ]);

    for (const expected of fixture.identity.memory) {
      const declaration =
        fixture.candidateKernel.manifest.memory?.[expected.id];
      if (declaration?.schemas === undefined) {
        throw new Error(`The candidate omitted ${expected.id} schemas`);
      }
      expect(declaration?.version).toBe(expected.version);
      expect(declaration.schemas[String(expected.version)]).toMatchObject({
        hash: expected.schema,
        entry: expected.entry,
      });
      expect(declaration?.migrations ?? []).toEqual([]);
    }

    // A state-preserving compile consumes the prior stable signature. A fresh
    // install or provisioner reinstall has no previous stable declaration.
    expect(fixture.initial.stable.length).toBeGreaterThan(0);
    expect(fixture.upgraded.stable.length).toBeGreaterThan(0);
  }, 120_000);
}
