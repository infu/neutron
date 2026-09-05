import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildPackagesCompileInput,
  buildPackagesInstallAssets,
  compilePackages,
  compileFreshPackages,
  motokoFilesFromPreparedFiles,
  preparePackageInstall,
  type CompileResult,
  type AppRegistry,
  type PreparedPackageInstall,
} from "../src/install.ts";
import { compileLegacyV25Compatibility } from "../src/compile.ts";
import {
  ASSEMBLER_ID,
  assemblerForFreshKernelVersion,
} from "../src/assemble.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import { assertAppVersion } from "neutron-tools/src/version.js";

export type LegacyKernelVersion = 305 | 306 | 307 | 315;

export type LegacyKernelReleaseFixture = Readonly<{
  label: "v0.3.5" | "v0.3.6" | "v0.3.7" | "v0.3.15";
  version: LegacyKernelVersion;
  archive:
    | "./kernel.v0.3.5.neutron"
    | "./kernel.v0.3.6.neutron"
    | "./kernel.v0.3.7.neutron"
    | "./kernel.v0.3.15.neutron";
  bytes: number;
  sha256: string;
  persistenceMode: "enhanced" | "classical";
  archivePath: string;
  identityUrl: URL;
}>;

type RetainedKernelReleaseFixture = Readonly<{
  label:
    | "v0.3.21"
    | "v0.3.23"
    | "v0.3.24"
    | "v0.3.25"
    | "v0.3.26"
    | "v0.3.27"
    | "v0.3.28"
    | "v0.3.29"
    | "v0.3.30"
    | "v0.3.31"
    | "v0.3.32";
  version: 321 | 323 | 324 | 325 | 326 | 327 | 328 | 329 | 330 | 331 | 332;
  archive:
    | "../../../apps/kernel/kernel.v0.3.21.neutron"
    | "../../../apps/kernel/kernel.v0.3.23.neutron"
    | "../../../apps/kernel/kernel.v0.3.24.neutron"
    | "../../../apps/kernel/kernel.v0.3.25.neutron"
    | "../../../apps/kernel/kernel.v0.3.26.neutron"
    | "../../../apps/kernel/kernel.v0.3.27.neutron"
    | "../../../apps/kernel/kernel.v0.3.28.neutron"
    | "../../../apps/kernel/kernel.v0.3.29.neutron"
    | "../../../apps/kernel/kernel.v0.3.30.neutron"
    | "../../../apps/kernel/kernel.v0.3.31.neutron"
    | "../../../apps/kernel/kernel.v0.3.32.neutron";
  bytes: number;
  sha256: string;
  persistenceMode: "classical";
  archivePath: string;
}>;

type KernelUpgradeReleaseFixture =
  LegacyKernelReleaseFixture | RetainedKernelReleaseFixture;

// v305-v307 self-upgrades hardcode `wasm_memory_persistence = keep`; v315
// introduced caller-selected persistence and shipped on the classical line.
export const LEGACY_KERNEL_RELEASES = [
  {
    label: "v0.3.5",
    version: 305,
    archive: "./kernel.v0.3.5.neutron",
    bytes: 1_918_481,
    sha256: "534e0ded262bb5700d92046a4fafad16ccf42473259edd3f18e8a0578347f2ae",
    persistenceMode: "enhanced",
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
    persistenceMode: "enhanced",
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
    persistenceMode: "enhanced",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.7.neutron", import.meta.url),
    ),
    identityUrl: new URL(
      "./fixtures/kernel-v0.3.7.identity.json",
      import.meta.url,
    ),
  },
  {
    label: "v0.3.15",
    version: 315,
    archive: "./kernel.v0.3.15.neutron",
    bytes: 2_011_370,
    sha256: "9deeea94795589ee8a331e005c63a85a42886c3f6c0a948e194915539d6a13db",
    persistenceMode: "classical",
    archivePath: fileURLToPath(
      new URL("./fixtures/kernel.v0.3.15.neutron", import.meta.url),
    ),
    identityUrl: new URL(
      "./fixtures/kernel-v0.3.15.identity.json",
      import.meta.url,
    ),
  },
] as const satisfies readonly LegacyKernelReleaseFixture[];

export const RETAINED_KERNEL_V321_RELEASE = {
  label: "v0.3.21",
  version: 321,
  archive: "../../../apps/kernel/kernel.v0.3.21.neutron",
  bytes: 2_411_860,
  sha256: "1143b525ce869cae6c44297ec973b56bec06e2250a0885bca12ca87e030c999e",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.21.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V323_RELEASE = {
  label: "v0.3.23",
  version: 323,
  archive: "../../../apps/kernel/kernel.v0.3.23.neutron",
  bytes: 2_448_813,
  sha256: "e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.23.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V324_RELEASE = {
  label: "v0.3.24",
  version: 324,
  archive: "../../../apps/kernel/kernel.v0.3.24.neutron",
  bytes: 2_449_608,
  sha256: "6ae401a934160410ec7d099f9d3a7f62c94126ab491fc115cc2e38b5b27c067a",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.24.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V325_RELEASE = {
  label: "v0.3.25",
  version: 325,
  archive: "../../../apps/kernel/kernel.v0.3.25.neutron",
  bytes: 2_415_653,
  sha256: "3f7293fb8ab0fe25fd59b2a02e20b66eb4c2920858ed660e163265a4481a098b",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.25.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V326_RELEASE = {
  label: "v0.3.26",
  version: 326,
  archive: "../../../apps/kernel/kernel.v0.3.26.neutron",
  bytes: 2_415_895,
  sha256: "738aa64943c759b573d8dd5d9094c7ce9b3017768a9c2616f638a272a591bda4",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.26.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V327_RELEASE = {
  label: "v0.3.27",
  version: 327,
  archive: "../../../apps/kernel/kernel.v0.3.27.neutron",
  bytes: 2_414_971,
  sha256: "b3a1e57c6201147eb8c5956592e1e389f23f8cef4ae972d831aa67de5151c65b",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.27.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V328_RELEASE = {
  label: "v0.3.28",
  version: 328,
  archive: "../../../apps/kernel/kernel.v0.3.28.neutron",
  bytes: 2_414_532,
  sha256: "46afbf14e5050771b77b9e7d573e5a6f77bc32a07915842dbb752f46d0c06e93",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.28.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V329_RELEASE = {
  label: "v0.3.29",
  version: 329,
  archive: "../../../apps/kernel/kernel.v0.3.29.neutron",
  bytes: 2_414_606,
  sha256: "6442ace1b0453c251a81a6b2ecce06b2ae76c765f57d02621037a4fd601a0d6e",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.29.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V330_RELEASE = {
  label: "v0.3.30",
  version: 330,
  archive: "../../../apps/kernel/kernel.v0.3.30.neutron",
  bytes: 2_429_420,
  sha256: "ce552920aca9c969e180ff283fa37baadce61de338f65216749afa70b6ec0bd4",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.30.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V331_RELEASE = {
  label: "v0.3.31",
  version: 331,
  archive: "../../../apps/kernel/kernel.v0.3.31.neutron",
  bytes: 2_467_137,
  sha256: "97c3000576a98d233241f99924bae5bb74e7e377fb95bfde423483caf4f69f01",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.31.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

export const PRODUCTION_KERNEL_V332_RELEASE = {
  label: "v0.3.32",
  version: 332,
  archive: "../../../apps/kernel/kernel.v0.3.32.neutron",
  bytes: 2_467_394,
  sha256: "1f6ddff197b9562a20da9e63d0daf2f3d169f3ec4f70736cf8b68445386c069f",
  persistenceMode: "classical",
  archivePath: fileURLToPath(
    new URL("../../../apps/kernel/kernel.v0.3.32.neutron", import.meta.url),
  ),
} as const satisfies RetainedKernelReleaseFixture;

/** Backward-compatible aliases for callers that mean the latest predecessor. */
export const LEGACY_KERNEL_VERSION = LEGACY_KERNEL_RELEASES[3].version;
export const LEGACY_KERNEL_ARCHIVE_BYTES = LEGACY_KERNEL_RELEASES[3].bytes;
export const LEGACY_KERNEL_ARCHIVE_SHA256 = LEGACY_KERNEL_RELEASES[3].sha256;
export const TEST_CANDIDATE_KERNEL_VERSION = 316;
export const LEGACY_HELLO_ARCHIVE_BYTES = 185_021;
export const LEGACY_HELLO_ARCHIVE_SHA256 =
  "82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27";
export const LEGACY_KERNEL_ARCHIVE_PATH = LEGACY_KERNEL_RELEASES[3].archivePath;
const HISTORICAL_TEST_CANDIDATE_KERNEL_ARCHIVE_PATH = fileURLToPath(
  new URL("../../../apps/kernel/kernel.v0.3.16.neutron", import.meta.url),
);

type KernelUpgradeIdentityFixture<Version extends number = number> = Readonly<{
  schema: 1;
  archive: string;
  bytes: number;
  sha256: string;
  package: Readonly<{
    format: 3;
    id: "kernel";
    version: Version;
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

export type LegacyKernelIdentityFixture =
  KernelUpgradeIdentityFixture<LegacyKernelVersion>;

const RETAINED_KERNEL_V321_IDENTITY = {
  schema: 1,
  archive: RETAINED_KERNEL_V321_RELEASE.archive,
  bytes: RETAINED_KERNEL_V321_RELEASE.bytes,
  sha256: RETAINED_KERNEL_V321_RELEASE.sha256,
  package: {
    format: 3,
    id: "kernel",
    version: RETAINED_KERNEL_V321_RELEASE.version,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
  },
  memory: [
    {
      owner: "kernel",
      id: "kernel",
      version: 3,
      schema:
        "50d5dcda32504525875af20f38d3fcb46e61f3e1413f8b99fd7ce8163c0f3477",
      entry: "bac62a48a7c70cc09cc6e8200784f306db044f5c055cf2a61b3f16f42babce5b",
    },
    {
      owner: "kernel",
      id: "kernel_activation",
      version: 1,
      schema:
        "f73560cae883ddc894cc4ad8e474aaea0cb4d7f64a017d9fd72e391306e88d9b",
      entry: "f2380721e6147d0f0af208a70183e3d8ce6ac19ad533e1367b3f5780305e7ad3",
    },
  ],
} as const satisfies KernelUpgradeIdentityFixture<321>;

const PRODUCTION_KERNEL_V323_IDENTITY = {
  ...RETAINED_KERNEL_V321_IDENTITY,
  archive: PRODUCTION_KERNEL_V323_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V323_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V323_RELEASE.sha256,
  package: {
    ...RETAINED_KERNEL_V321_IDENTITY.package,
    version: PRODUCTION_KERNEL_V323_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<323>;

const PRODUCTION_KERNEL_V324_IDENTITY = {
  ...PRODUCTION_KERNEL_V323_IDENTITY,
  archive: PRODUCTION_KERNEL_V324_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V324_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V324_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V323_IDENTITY.package,
    version: PRODUCTION_KERNEL_V324_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<324>;

const PRODUCTION_KERNEL_V325_IDENTITY = {
  ...PRODUCTION_KERNEL_V324_IDENTITY,
  archive: PRODUCTION_KERNEL_V325_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V325_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V325_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V324_IDENTITY.package,
    version: PRODUCTION_KERNEL_V325_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<325>;

const PRODUCTION_KERNEL_V326_IDENTITY = {
  ...PRODUCTION_KERNEL_V325_IDENTITY,
  archive: PRODUCTION_KERNEL_V326_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V326_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V326_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V325_IDENTITY.package,
    version: PRODUCTION_KERNEL_V326_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<326>;

const PRODUCTION_KERNEL_V327_IDENTITY = {
  ...PRODUCTION_KERNEL_V326_IDENTITY,
  archive: PRODUCTION_KERNEL_V327_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V327_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V327_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V326_IDENTITY.package,
    version: PRODUCTION_KERNEL_V327_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<327>;

const PRODUCTION_KERNEL_V328_IDENTITY = {
  ...PRODUCTION_KERNEL_V327_IDENTITY,
  archive: PRODUCTION_KERNEL_V328_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V328_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V328_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V327_IDENTITY.package,
    version: PRODUCTION_KERNEL_V328_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<328>;

const PRODUCTION_KERNEL_V329_IDENTITY = {
  ...PRODUCTION_KERNEL_V328_IDENTITY,
  archive: PRODUCTION_KERNEL_V329_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V329_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V329_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V328_IDENTITY.package,
    version: PRODUCTION_KERNEL_V329_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<329>;

const PRODUCTION_KERNEL_V330_IDENTITY = {
  ...PRODUCTION_KERNEL_V329_IDENTITY,
  archive: PRODUCTION_KERNEL_V330_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V330_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V330_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V329_IDENTITY.package,
    version: PRODUCTION_KERNEL_V330_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<330>;

const PRODUCTION_KERNEL_V331_IDENTITY = {
  ...PRODUCTION_KERNEL_V330_IDENTITY,
  archive: PRODUCTION_KERNEL_V331_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V331_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V331_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V330_IDENTITY.package,
    version: PRODUCTION_KERNEL_V331_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<331>;

const PRODUCTION_KERNEL_V332_IDENTITY = {
  ...PRODUCTION_KERNEL_V331_IDENTITY,
  archive: PRODUCTION_KERNEL_V332_RELEASE.archive,
  bytes: PRODUCTION_KERNEL_V332_RELEASE.bytes,
  sha256: PRODUCTION_KERNEL_V332_RELEASE.sha256,
  package: {
    ...PRODUCTION_KERNEL_V331_IDENTITY.package,
    version: PRODUCTION_KERNEL_V332_RELEASE.version,
  },
} as const satisfies KernelUpgradeIdentityFixture<332>;

export type LegacyUpgradeCompileFixture = Readonly<{
  release: KernelUpgradeReleaseFixture;
  identity: KernelUpgradeIdentityFixture;
  legacyArchive: Uint8Array;
  helloArchive: Uint8Array;
  candidateArchive: Uint8Array;
  legacyKernel: PreparedPackageInstall;
  hello: PreparedPackageInstall;
  candidateKernel: PreparedPackageInstall;
  /** Exact registry produced by the selected predecessor package set. */
  existingApps: AppRegistry;
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

async function loadRetainedKernelV321Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<321>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    RETAINED_KERNEL_V321_RELEASE.archivePath,
    "The retained v0.3.21 Kernel predecessor",
  );
  assertArchiveIdentity(
    RETAINED_KERNEL_V321_RELEASE.label,
    archive,
    RETAINED_KERNEL_V321_RELEASE.bytes,
    RETAINED_KERNEL_V321_RELEASE.sha256,
  );
  return { identity: RETAINED_KERNEL_V321_IDENTITY, archive };
}

async function loadProductionKernelV323Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<323>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V323_RELEASE.archivePath,
    "The production v0.3.23 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V323_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V323_RELEASE.bytes,
    PRODUCTION_KERNEL_V323_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V323_IDENTITY, archive };
}

export async function loadProductionKernelV324Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<324>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V324_RELEASE.archivePath,
    "The production v0.3.24 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V324_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V324_RELEASE.bytes,
    PRODUCTION_KERNEL_V324_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V324_IDENTITY, archive };
}

export async function loadProductionKernelV325Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<325>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V325_RELEASE.archivePath,
    "The production v0.3.25 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V325_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V325_RELEASE.bytes,
    PRODUCTION_KERNEL_V325_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V325_IDENTITY, archive };
}

export async function loadProductionKernelV326Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<326>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V326_RELEASE.archivePath,
    "The production v0.3.26 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V326_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V326_RELEASE.bytes,
    PRODUCTION_KERNEL_V326_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V326_IDENTITY, archive };
}

export async function loadProductionKernelV327Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<327>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V327_RELEASE.archivePath,
    "The production v0.3.27 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V327_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V327_RELEASE.bytes,
    PRODUCTION_KERNEL_V327_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V327_IDENTITY, archive };
}

export async function loadProductionKernelV328Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<328>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V328_RELEASE.archivePath,
    "The production v0.3.28 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V328_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V328_RELEASE.bytes,
    PRODUCTION_KERNEL_V328_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V328_IDENTITY, archive };
}

export async function loadProductionKernelV329Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<329>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V329_RELEASE.archivePath,
    "The production v0.3.29 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V329_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V329_RELEASE.bytes,
    PRODUCTION_KERNEL_V329_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V329_IDENTITY, archive };
}

export async function loadProductionKernelV330Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<330>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V330_RELEASE.archivePath,
    "The production v0.3.30 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V330_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V330_RELEASE.bytes,
    PRODUCTION_KERNEL_V330_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V330_IDENTITY, archive };
}

export async function loadProductionKernelV331Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<331>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V331_RELEASE.archivePath,
    "The production v0.3.31 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V331_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V331_RELEASE.bytes,
    PRODUCTION_KERNEL_V331_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V331_IDENTITY, archive };
}

export async function loadProductionKernelV332Fixture(): Promise<{
  identity: KernelUpgradeIdentityFixture<332>;
  archive: Uint8Array;
}> {
  const archive = await loadKernelArchive(
    PRODUCTION_KERNEL_V332_RELEASE.archivePath,
    "The production v0.3.32 Kernel predecessor",
  );
  assertArchiveIdentity(
    PRODUCTION_KERNEL_V332_RELEASE.label,
    archive,
    PRODUCTION_KERNEL_V332_RELEASE.bytes,
    PRODUCTION_KERNEL_V332_RELEASE.sha256,
  );
  return { identity: PRODUCTION_KERNEL_V332_IDENTITY, archive };
}

export async function compileLegacyKernelUpgradeFixture(
  legacyVersion: LegacyKernelVersion = LEGACY_KERNEL_VERSION,
): Promise<LegacyUpgradeCompileFixture> {
  const release = legacyKernelRelease(legacyVersion);
  return compileKernelUpgradeCandidate(
    release,
    () => loadLegacyKernelIdentityFixture(release.version),
    () =>
      loadKernelArchive(
        HISTORICAL_TEST_CANDIDATE_KERNEL_ARCHIVE_PATH,
        "The generated v0.3.16 Kernel candidate",
      ),
  );
}

/**
 * Decode and compile the actual packed current candidate. This never invokes
 * the packer: the caller must deliberately create and review the archive first.
 */
export async function compileFinalCandidateLegacyKernelUpgradeFixture({
  expectedSha256,
  legacyVersion = LEGACY_KERNEL_VERSION,
}: {
  expectedSha256: string;
  legacyVersion?: LegacyKernelVersion;
}): Promise<LegacyUpgradeCompileFixture> {
  const release = legacyKernelRelease(legacyVersion);
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release,
    loadPredecessor: () => loadLegacyKernelIdentityFixture(release.version),
  });
}

export async function compileFinalCandidateRetainedKernelUpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: RETAINED_KERNEL_V321_RELEASE,
    loadPredecessor: loadRetainedKernelV321Fixture,
  });
}

export async function compileFinalCandidateProductionKernelUpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V323_RELEASE,
    loadPredecessor: loadProductionKernelV323Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV324UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V324_RELEASE,
    loadPredecessor: loadProductionKernelV324Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV325UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V325_RELEASE,
    loadPredecessor: loadProductionKernelV325Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV326UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V326_RELEASE,
    loadPredecessor: loadProductionKernelV326Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV327UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V327_RELEASE,
    loadPredecessor: loadProductionKernelV327Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV328UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V328_RELEASE,
    loadPredecessor: loadProductionKernelV328Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV329UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V329_RELEASE,
    loadPredecessor: loadProductionKernelV329Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV330UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V330_RELEASE,
    loadPredecessor: loadProductionKernelV330Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV331UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V331_RELEASE,
    loadPredecessor: loadProductionKernelV331Fixture,
  });
}

export async function compileFinalCandidateProductionKernelV332UpgradeFixture({
  expectedSha256,
}: {
  expectedSha256: string;
}): Promise<LegacyUpgradeCompileFixture> {
  return compileFinalCandidateKernelUpgradeFixture({
    expectedSha256,
    release: PRODUCTION_KERNEL_V332_RELEASE,
    loadPredecessor: loadProductionKernelV332Fixture,
  });
}

async function compileFinalCandidateKernelUpgradeFixture({
  expectedSha256,
  release,
  loadPredecessor,
}: {
  expectedSha256: string;
  release: KernelUpgradeReleaseFixture;
  loadPredecessor: () => Promise<{
    identity: KernelUpgradeIdentityFixture;
    archive: Uint8Array;
  }>;
}): Promise<LegacyUpgradeCompileFixture> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error(
      "NEUTRON_FINAL_KERNEL_CANDIDATE_SHA256 must be a reviewed lowercase SHA-256",
    );
  }
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../apps/kernel/neutron.json", import.meta.url),
      "utf8",
    ),
  ) as { version?: unknown };
  assertAppVersion(manifest.version, "Current Kernel source manifest version");
  const archivePath = fileURLToPath(
    new URL(
      `../../../apps/kernel/${packageArchiveFilename("kernel", manifest.version)}`,
      import.meta.url,
    ),
  );
  return compileKernelUpgradeCandidate(
    release,
    loadPredecessor,
    () =>
      loadKernelArchive(archivePath, "The reviewed current Kernel candidate"),
    expectedSha256,
    manifest.version,
  );
}

async function compileKernelUpgradeCandidate(
  release: KernelUpgradeReleaseFixture,
  loadPredecessor: () => Promise<{
    identity: KernelUpgradeIdentityFixture;
    archive: Uint8Array;
  }>,
  loadCandidateArchive: () => Promise<Uint8Array>,
  expectedCandidateSha256?: string,
  expectedCandidateVersion = TEST_CANDIDATE_KERNEL_VERSION,
): Promise<LegacyUpgradeCompileFixture> {
  const { identity, archive: legacyArchive } = await loadPredecessor();

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
  assertPredecessorPackageIdentity(identity, legacyKernel);
  assertPredecessorPackageRecord(release, legacyKernel);

  const candidateArchive = await loadCandidateArchive();
  const candidateKernel =
    expectedCandidateSha256 === undefined
      ? preparePackageInstall(candidateArchive)
      : preparePackageInstall(candidateArchive, {
          expectedIdentity: {
            id: "kernel",
            version: expectedCandidateVersion,
            sha256: expectedCandidateSha256,
          },
        });
  assertCandidateManifest(identity, candidateKernel, expectedCandidateVersion);
  if (candidateKernel.packageRecord === undefined) {
    throw new Error("The Kernel candidate package record was not verified");
  }
  assertCandidatePackageRecord(candidateKernel);

  let initial: CompileResult;
  if (
    release.version === RETAINED_KERNEL_V321_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V323_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V324_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V325_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V326_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V327_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V328_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V329_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V330_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V331_RELEASE.version ||
    release.version === PRODUCTION_KERNEL_V332_RELEASE.version
  ) {
    initial = await compileFreshPackages({
      packages: [legacyKernel, hello],
      persistenceMode: release.persistenceMode,
    });
  } else {
    const { browserSurfaceOriginAppIds: _v26Selection, ...legacyCompileInput } =
      buildPackagesCompileInput({
        packages: [legacyKernel, hello],
        existingApps: {},
        existingBrowserSurfaceOriginAppIds: [],
        versionPolicy: "allow-same-version",
      });
    initial = await compileLegacyV25Compatibility({
      ...legacyCompileInput,
      persistenceMode: release.persistenceMode,
    });
  }
  const existingModules = motokoFilesFromPreparedFiles([
    ...legacyKernel.files,
    ...hello.files,
  ]);
  const existingConfigs: Record<string, PackagedNeutronManifest> = {
    kernel: legacyKernel.manifest,
    hello: hello.manifest,
  };
  const existingApps = buildPackagesInstallAssets({
    existingApps: {},
    existingBrowserSurfaceOriginAppIds: [],
    packages: [legacyKernel, hello],
    candid: initial.candid,
  }).apps;
  const upgraded = await compilePackages({
    packages: [candidateKernel],
    existingModules,
    existingConfigs,
    existingApps,
    existingBrowserSurfaceOriginAppIds: initial.browserSurfaceOriginAppIds,
    existingStable: initial.stable,
    ...(legacyKernel.connectionProviderSupport
      ? { connectionProviderSupport: legacyKernel.connectionProviderSupport }
      : {}),
    persistenceMode: release.persistenceMode,
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
    existingApps,
    initial,
    upgraded,
  };
}

function assertCandidatePackageRecord(
  candidate: PreparedPackageInstall,
): void {
  const record = candidate.packageRecord;
  if (
    record?.license.id !== "LicenseRef-Neutron-Public-License-1.0" ||
    record.source.kind !== "https" ||
    record.build.inputs.length === 0
  ) {
    throw new Error(
      "The Kernel candidate must carry the reviewed NPL source record",
    );
  }
}

function assertPredecessorPackageRecord(
  release: KernelUpgradeReleaseFixture,
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
    release.version === 315 ||
    release.version === 321 ||
    release.version === 323 ||
    release.version === 324 ||
    release.version === 325 ||
    release.version === 326 ||
    release.version === 327 ||
    release.version === 328 ||
    release.version === 329 ||
    release.version === 330 ||
    release.version === 331 ||
    release.version === 332
  ) {
    if (
      record?.package.version !== release.version ||
      record.license.id !== "LicenseRef-Neutron-Public-License-1.0" ||
      record.source.kind !== "https"
    ) {
      throw new Error(
        `The immutable ${release.label} archive must retain its reviewed NPL source record`,
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
  identity: KernelUpgradeIdentityFixture,
  candidate: PreparedPackageInstall,
  expectedVersion: number,
): void {
  const { manifest } = candidate;
  if (
    manifest.format !== 3 ||
    manifest.id !== "kernel" ||
    manifest.version !== expectedVersion ||
    manifest.update_source !== identity.package.update_source
  ) {
    throw new Error(
      "The candidate must match the expected Kernel version in format 3 with the production update source",
    );
  }
}

/** Fail closed on the released-memory invariants shared by every candidate. */
export function assertLegacyUpgradeCompileInvariants(
  fixture: LegacyUpgradeCompileFixture,
): void {
  const candidateVersion = fixture.candidateKernel.manifest.version;
  const expectedInitialAssemblerId = assemblerForFreshKernelVersion(
    fixture.release.version,
  );
  if (
    fixture.initial.assemblerId !== expectedInitialAssemblerId ||
    fixture.upgraded.assemblerId !== ASSEMBLER_ID
  ) {
    throw new Error(
      `The upgrade did not compile exact ${expectedInitialAssemblerId} then ${ASSEMBLER_ID}`,
    );
  }
  if (
    fixture.initial.persistenceMode !== fixture.release.persistenceMode ||
    fixture.upgraded.persistenceMode !== fixture.release.persistenceMode
  ) {
    throw new Error("The legacy bridge changed its released persistence mode");
  }
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
      { app_id: "kernel", version: candidateVersion },
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
        `The Kernel candidate changed released memory ${expected.id} v${expected.version}`,
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

function assertPredecessorPackageIdentity(
  identity: KernelUpgradeIdentityFixture,
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

async function loadKernelArchive(
  archivePath: string,
  missingLabel: string,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(archivePath));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new Error(`${missingLabel} does not exist at ${archivePath}`);
  }
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
