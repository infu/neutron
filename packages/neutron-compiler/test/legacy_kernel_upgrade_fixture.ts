import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import {
  compilePackages,
  motokoFilesFromPreparedFiles,
  preparePackageInstall,
  unpackNeutronPackage,
  type CompileResult,
  type PreparedPackageInstall,
} from "../src/install.ts";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";

const encoder = new TextEncoder();

export type LegacyKernelVersion = 305 | 306 | 307;

export type LegacyKernelReleaseFixture = Readonly<{
  label: "v0.3.5" | "v0.3.6" | "v0.3.7";
  version: LegacyKernelVersion;
  archive:
    | "./kernel.v0.3.5.neutron"
    | "./kernel.v0.3.6.neutron"
    | "./kernel.v0.3.7.neutron";
  bytes: number;
  sha256: string;
  archivePath: string;
  identityUrl: URL;
}>;

export const LEGACY_KERNEL_RELEASES = [
  {
    label: "v0.3.5",
    version: 305,
    archive: "./kernel.v0.3.5.neutron",
    bytes: 1_918_481,
    sha256: "534e0ded262bb5700d92046a4fafad16ccf42473259edd3f18e8a0578347f2ae",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.5.neutron", import.meta.url),
    ),
    identityUrl: new URL(
      "./fixtures/kernel-v0.3.5.identity.json",
      import.meta.url,
    ),
  },
  {
    label: "v0.3.6",
    version: 306,
    archive: "./kernel.v0.3.6.neutron",
    bytes: 1_858_175,
    sha256: "b25948f68ed10f29c984e936ecfd18b95fa8d4cdec0bbd1e944b53b2a371bd8b",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.6.neutron", import.meta.url),
    ),
    identityUrl: new URL(
      "./fixtures/kernel-v0.3.6.identity.json",
      import.meta.url,
    ),
  },
  {
    label: "v0.3.7",
    version: 307,
    archive: "./kernel.v0.3.7.neutron",
    bytes: 1_924_034,
    sha256: "aaf329e5d526f4b5a436c440ac21a245b068172c6e4e2d6dc07696ecadc60f7d",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.7.neutron", import.meta.url),
    ),
    identityUrl: new URL(
      "./fixtures/kernel-v0.3.7.identity.json",
      import.meta.url,
    ),
  },
] as const satisfies readonly LegacyKernelReleaseFixture[];

/** Backward-compatible aliases for callers that mean the latest predecessor. */
export const LEGACY_KERNEL_VERSION = LEGACY_KERNEL_RELEASES[2].version;
export const LEGACY_KERNEL_ARCHIVE_BYTES = LEGACY_KERNEL_RELEASES[2].bytes;
export const LEGACY_KERNEL_ARCHIVE_SHA256 = LEGACY_KERNEL_RELEASES[2].sha256;
export const TEST_CANDIDATE_KERNEL_VERSION = 312;
export const LEGACY_HELLO_ARCHIVE_BYTES = 185_021;
export const LEGACY_HELLO_ARCHIVE_SHA256 =
  "82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27";
export const LEGACY_KERNEL_ARCHIVE_PATH = LEGACY_KERNEL_RELEASES[2].archivePath;
export const FINAL_CANDIDATE_KERNEL_ARCHIVE_PATH = fileURLToPath(
  new URL("../../../apps/kernel/kernel.v0.3.12.neutron", import.meta.url),
);

export type LegacyKernelIdentityFixture = Readonly<{
  schema: 1;
  archive: string;
  bytes: number;
  sha256: string;
  package: Readonly<{
    format: 3;
    id: "kernel";
    version: LegacyKernelVersion;
    update_source: string;
  }>;
  memory: readonly Readonly<{
    owner: "kernel";
    id: string;
    version: number;
    schema: string;
    entry: string;
  }>[];
}>;

export type LegacyUpgradeCompileFixture = Readonly<{
  release: LegacyKernelReleaseFixture;
  identity: LegacyKernelIdentityFixture;
  legacyArchive: Uint8Array;
  helloArchive: Uint8Array;
  candidateArchive: Uint8Array;
  legacyKernel: PreparedPackageInstall;
  hello: PreparedPackageInstall;
  candidateKernel: PreparedPackageInstall;
  initial: CompileResult;
  upgraded: CompileResult;
}>;

export function legacyKernelRelease(
  version: LegacyKernelVersion,
): LegacyKernelReleaseFixture {
  const release = LEGACY_KERNEL_RELEASES.find(
    (candidate) => candidate.version === version,
  );
  if (release === undefined) {
    throw new Error(`Unsupported legacy Kernel version ${version}`);
  }
  return release;
}

export async function loadLegacyKernelIdentityFixture(
  version: LegacyKernelVersion = LEGACY_KERNEL_VERSION,
): Promise<{
  release: LegacyKernelReleaseFixture;
  identity: LegacyKernelIdentityFixture;
  archivePath: string;
  archive: Uint8Array;
}> {
  const release = legacyKernelRelease(version);
  const identityUrl = release.identityUrl;
  const identity = JSON.parse(
    await readFile(identityUrl, "utf8"),
  ) as LegacyKernelIdentityFixture;
  const archivePath = fileURLToPath(new URL(identity.archive, identityUrl));
  if (
    identity.archive !== release.archive ||
    archivePath !== release.archivePath
  ) {
    throw new Error(
      `The ${release.label} identity must resolve to its durable compiler test fixture`,
    );
  }
  let archive: Uint8Array;
  try {
    archive = new Uint8Array(await readFile(archivePath));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new Error(
      `The durable exact ${release.label} baseline is absent at ${archivePath}`,
      { cause: error },
    );
  }
  assertLegacyKernelArchive(identity, archive, release);
  return { release, identity, archivePath, archive };
}

export async function compileLegacyKernelUpgradeFixture(
  legacyVersion: LegacyKernelVersion = LEGACY_KERNEL_VERSION,
): Promise<LegacyUpgradeCompileFixture> {
  return compileLegacyKernelUpgradeCandidate(
    legacyKernelRelease(legacyVersion),
    (legacyArchive) => testCandidateArchive(legacyArchive),
  );
}

/**
 * Decode and compile the actual packed v0.3.12 candidate. This never invokes
 * the packer: the caller must deliberately create and review the archive first.
 */
export async function compileFinalCandidateLegacyKernelUpgradeFixture({
  expectedSha256,
  legacyVersion = LEGACY_KERNEL_VERSION,
}: {
  expectedSha256: string;
  legacyVersion?: LegacyKernelVersion;
}): Promise<LegacyUpgradeCompileFixture> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error(
      "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
    );
  }
  return compileLegacyKernelUpgradeCandidate(
    legacyKernelRelease(legacyVersion),
    async () => {
      try {
        return new Uint8Array(
          await readFile(FINAL_CANDIDATE_KERNEL_ARCHIVE_PATH),
        );
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        throw new Error(
          `The reviewed final candidate does not exist at ${FINAL_CANDIDATE_KERNEL_ARCHIVE_PATH}`,
        );
      }
    },
    expectedSha256,
  );
}

async function compileLegacyKernelUpgradeCandidate(
  release: LegacyKernelReleaseFixture,
  loadCandidateArchive: (legacyArchive: Uint8Array) => Promise<Uint8Array>,
  expectedCandidateSha256?: string,
): Promise<LegacyUpgradeCompileFixture> {
  const { identity, archive: legacyArchive } =
    await loadLegacyKernelIdentityFixture(release.version);
  assertLegacyKernelArchive(identity, legacyArchive, release);

  const helloArchive = new Uint8Array(
    await readFile(
      new URL("../../../apps/hello/hello.v0.2.1.neutron", import.meta.url),
    ),
  );
  assertArchiveIdentity(
    "Hello v0.2.1",
    helloArchive,
    LEGACY_HELLO_ARCHIVE_BYTES,
    LEGACY_HELLO_ARCHIVE_SHA256,
  );
  const legacyKernel = preparePackageInstall(legacyArchive);
  const hello = preparePackageInstall(helloArchive);
  assertLegacyPackageIdentity(identity, legacyKernel);
  assertLegacyPackageRecord(release, legacyKernel);

  const candidateArchive = await loadCandidateArchive(legacyArchive);
  const candidateKernel =
    expectedCandidateSha256 === undefined
      ? preparePackageInstall(candidateArchive)
      : preparePackageInstall(candidateArchive, {
          expectedIdentity: {
            id: "kernel",
            version: TEST_CANDIDATE_KERNEL_VERSION,
            sha256: expectedCandidateSha256,
          },
        });
  assertCandidateManifest(identity, candidateKernel);
  if (candidateKernel.packageRecord === undefined) {
    throw new Error("The v0.3.12 candidate package record was not verified");
  }
  if (expectedCandidateSha256 !== undefined) {
    assertFinalCandidatePackageRecord(candidateKernel);
  }

  const initial = await compilePackages({
    packages: [legacyKernel, hello],
    versionPolicy: "allow-same-version",
  });
  const existingModules = motokoFilesFromPreparedFiles([
    ...legacyKernel.files,
    ...hello.files,
  ]);
  const existingConfigs: Record<string, PackagedNeutronManifest> = {
    kernel: legacyKernel.manifest,
    hello: hello.manifest,
  };
  const upgraded = await compilePackages({
    packages: [candidateKernel],
    existingModules,
    existingConfigs,
    existingStable: initial.stable,
    ...(legacyKernel.connectionProviderSupport
      ? { connectionProviderSupport: legacyKernel.connectionProviderSupport }
      : {}),
    versionPolicy: "strict-upgrade",
  });

  return {
    release,
    identity,
    legacyArchive,
    helloArchive,
    candidateArchive,
    legacyKernel,
    hello,
    candidateKernel,
    initial,
    upgraded,
  };
}

function assertFinalCandidatePackageRecord(
  candidate: PreparedPackageInstall,
): void {
  const record = candidate.packageRecord;
  if (
    record?.license.id !== "LicenseRef-Neutron-Public-License-1.0" ||
    record.source.kind !== "https" ||
    record.build.inputs.length === 0
  ) {
    throw new Error(
      "The v0.3.12 candidate must carry the reviewed NPL source record",
    );
  }
}

function assertLegacyPackageRecord(
  release: LegacyKernelReleaseFixture,
  prepared: PreparedPackageInstall,
): void {
  const record = prepared.packageRecord;
  if (release.version < 307) {
    if (record !== undefined) {
      throw new Error(
        `The immutable ${release.label} archive unexpectedly has a package record`,
      );
    }
    return;
  }
  if (
    record?.package.version !== 307 ||
    record.license.id !== "GPL-3.0-only" ||
    record.source.kind !== "status" ||
    record.source.status !== "not-provided" ||
    !record.notices.some(
      ({ path }) => path === "legal/GPL-TRANSITION-NOTICE.txt",
    )
  ) {
    throw new Error(
      "The immutable v0.3.7 archive must retain its reviewed GPL transition record",
    );
  }
}

function assertCandidateManifest(
  identity: LegacyKernelIdentityFixture,
  candidate: PreparedPackageInstall,
): void {
  const { manifest } = candidate;
  if (
    manifest.format !== 3 ||
    manifest.id !== "kernel" ||
    manifest.version !== TEST_CANDIDATE_KERNEL_VERSION ||
    manifest.update_source !== identity.package.update_source
  ) {
    throw new Error(
      "The candidate must be Kernel v0.3.12 in format 3 with the production update source",
    );
  }
}

/** Fail closed on the released-memory invariants shared by every candidate. */
export function assertLegacyUpgradeCompileInvariants(
  fixture: LegacyUpgradeCompileFixture,
): void {
  const helloSchema =
    fixture.hello.manifest.memory?.hello?.schemas?.["1"]?.hash;
  if (helloSchema === undefined) {
    throw new Error(
      "The released Hello fixture has no v1 managed-memory schema",
    );
  }
  assertJsonEqual(
    "legacy upgrade migration plan",
    fixture.upgraded.migrationPlan,
    {
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
    },
  );
  assertJsonEqual(
    "legacy upgrade managed-memory inventory",
    fixture.upgraded.managedMemoryInventory,
    [
      { owner: "hello", id: "hello", version: 1, schema: helloSchema },
      ...fixture.identity.memory.map(({ owner, id, version, schema }) => ({
        owner,
        id,
        version,
        schema,
      })),
    ],
  );
  if (
    fixture.initial.compatibilityDiagnostics.length !== 0 ||
    fixture.upgraded.compatibilityDiagnostics.length !== 0 ||
    fixture.upgraded.managedMemoryRetirements.length !== 0
  ) {
    throw new Error(
      "The legacy upgrade must have no compatibility diagnostics or memory retirements",
    );
  }
  assertJsonEqual(
    "legacy initial app inventory",
    fixture.initial.appInstanceInventory.map(({ app_id, version }) => ({
      app_id,
      version,
    })),
    [
      { app_id: "hello", version: 201 },
      { app_id: "kernel", version: fixture.identity.package.version },
    ],
  );
  assertJsonEqual(
    "legacy upgrade app inventory",
    fixture.upgraded.appInstanceInventory.map(({ app_id, version }) => ({
      app_id,
      version,
    })),
    [
      { app_id: "hello", version: 201 },
      { app_id: "kernel", version: TEST_CANDIDATE_KERNEL_VERSION },
    ],
  );
  for (const expected of fixture.identity.memory) {
    const declaration = fixture.candidateKernel.manifest.memory?.[expected.id];
    const schema = declaration?.schemas?.[String(expected.version)];
    if (
      declaration?.version !== expected.version ||
      schema?.hash !== expected.schema ||
      schema?.entry !== expected.entry ||
      (declaration.migrations?.length ?? 0) !== 0
    ) {
      throw new Error(
        `The v0.3.12 candidate changed released memory ${expected.id} v${expected.version}`,
      );
    }
  }
}

function assertJsonEqual(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} does not match the immutable qualification fixture`,
    );
  }
}

export function assertLegacyKernelArchive(
  identity: LegacyKernelIdentityFixture,
  archive: Uint8Array,
  release: LegacyKernelReleaseFixture = legacyKernelRelease(
    identity.package.version,
  ),
): void {
  if (identity.schema !== 1)
    throw new Error("Unsupported legacy identity fixture");
  if (
    identity.archive !== release.archive ||
    identity.bytes !== release.bytes ||
    identity.sha256 !== release.sha256 ||
    identity.package.format !== 3 ||
    identity.package.id !== "kernel" ||
    identity.package.version !== release.version ||
    identity.package.update_source !== "233tv-xiaaa-aaaay-aacta-cai"
  ) {
    throw new Error("The checked-in legacy identity fixture was rewritten");
  }
  if (archive.byteLength !== identity.bytes) {
    throw new Error(
      `Legacy Kernel archive byte length changed: expected ${identity.bytes}, found ${archive.byteLength}`,
    );
  }
  const actualSha256 = sha256Hex(archive);
  if (actualSha256 !== identity.sha256) {
    throw new Error(
      `Legacy Kernel archive SHA-256 changed: expected ${identity.sha256}, found ${actualSha256}`,
    );
  }
}

function assertLegacyPackageIdentity(
  identity: LegacyKernelIdentityFixture,
  prepared: PreparedPackageInstall,
): void {
  const { manifest } = prepared;
  if (
    manifest.format !== identity.package.format ||
    manifest.id !== identity.package.id ||
    manifest.version !== identity.package.version ||
    manifest.update_source !== identity.package.update_source
  ) {
    throw new Error(
      `The exact v${identity.package.version} archive does not match its package identity`,
    );
  }
  for (const expected of identity.memory) {
    const declaration = manifest.memory?.[expected.id];
    const schema = declaration?.schemas?.[String(expected.version)];
    if (
      declaration?.version !== expected.version ||
      schema?.hash !== expected.schema ||
      schema?.entry !== expected.entry
    ) {
      throw new Error(
        `The exact v${identity.package.version} archive does not match released memory ${expected.id} v${expected.version}`,
      );
    }
  }
}

function assertArchiveIdentity(
  label: string,
  archive: Uint8Array,
  expectedBytes: number,
  expectedSha256: string,
): void {
  if (
    archive.byteLength !== expectedBytes ||
    sha256Hex(archive) !== expectedSha256
  ) {
    throw new Error(
      `${label} archive must be ${expectedBytes} bytes with SHA-256 ${expectedSha256}`,
    );
  }
}

async function testCandidateArchive(
  legacyArchive: Uint8Array,
): Promise<Uint8Array> {
  const files = unpackNeutronPackage(legacyArchive);
  const legacyManifest = JSON.parse(
    new TextDecoder().decode(files["neutron.json"]!),
  ) as PackagedNeutronManifest;
  const manifest = encoder.encode(
    JSON.stringify({
      ...legacyManifest,
      version: TEST_CANDIDATE_KERNEL_VERSION,
    }),
  );
  files["neutron.json"] = manifest;
  delete files["legal/GPL-3.0.txt"];
  delete files["legal/LICENSE.GPL-3.0"];
  delete files["legal/GPL-TRANSITION-NOTICE.txt"];
  delete files["legal/package-record.v1.json"];

  const license = new Uint8Array(
    await readFile(new URL("../../../LICENSE", import.meta.url)),
  );
  files["legal/LICENSE.NPL.txt"] = license;
  const lock = files["neutron.lock.json"];
  if (lock === undefined) {
    throw new Error("The legacy Kernel archive has no neutron.lock.json");
  }
  const offeredSource = encoder.encode(
    "synthetic v0.3.12 corresponding-source fixture\n",
  );
  const sourceSha256 = sha256Hex(offeredSource);
  const packageRecord = {
    format: 1,
    package: {
      id: "kernel",
      version: TEST_CANDIDATE_KERNEL_VERSION,
      manifest: embeddedFile("neutron.json", manifest),
    },
    license: {
      id: "LicenseRef-Neutron-Public-License-1.0",
      texts: [
        {
          id: "LicenseRef-Neutron-Public-License-1.0",
          ...embeddedFile("legal/LICENSE.NPL.txt", license),
        },
      ],
    },
    source: {
      kind: "https",
      revision: `source-sha256:${sourceSha256}`,
      url:
        "https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/" +
        `${sourceSha256}.source.v1.msgpack.gz`,
      sha256: sourceSha256,
      bytes: offeredSource.byteLength,
    },
    dependencies: [],
    notices: [],
    memory: {
      lock: embeddedFile("neutron.lock.json", lock),
    },
    build: {
      inputs: [
        {
          path: "apps/kernel/neutron.json",
          sha256: sha256Hex(manifest),
          bytes: manifest.byteLength,
        },
      ],
      commands: [
        {
          purpose: "package",
          cwd: ".",
          argv: ["npm", "--workspace", "neutron-kernel", "run", "package"],
        },
      ],
    },
  } as const;
  files["legal/package-record.v1.json"] = encoder.encode(
    JSON.stringify(packageRecord),
  );

  return msgpack.encode(
    Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, content]) => [path, gzipSync(content)]),
    ),
  );
}

function embeddedFile(path: string, content: Uint8Array) {
  return {
    path,
    sha256: sha256Hex(content),
    bytes: content.byteLength,
  };
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
