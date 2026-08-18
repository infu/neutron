import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { packageMotoko } from "neutron-scripts/src/mopack.js";
import { packDirectory } from "neutron-scripts/src/pack.js";
import { type PackageMap } from "neutron-scripts/src/walk.js";
import {
  CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST,
  certifiedAssetsQualificationMotokoPackageMap,
} from "../certified_assets_candidate_binding.ts";
import {
  CERTIFIED_ASSETS_QUALIFICATION_FIXTURES,
  certifiedAssetsQualificationFixture,
  certifiedAssetsQualificationManifestBytes,
  generateCertifiedAssetsQualificationManifest,
  type CertifiedAssetsQualificationFixture,
  type CertifiedAssetsQualificationFixtureId,
} from "./fixture_manifests.ts";
import {
  assertQualificationFixtureSetAdmission,
} from "./fixture_admission.ts";

const executeFile = promisify(execFile);

/**
 * Package the current Kernel source without mutating its working tree. The
 * qualification candidate must not depend on a previously generated archive.
 */
export async function buildQualificationKernelArchive(input: {
  repositoryRoot: string;
  temporaryRoot: string;
}): Promise<string> {
  const sourceDirectory = path.join(
    input.repositoryRoot,
    "apps",
    "kernel",
  );
  const targetDirectory = path.join(
    input.temporaryRoot,
    "kernel-package",
  );
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await cp(
    path.join(sourceDirectory, "backend"),
    path.join(targetDirectory, "backend"),
    { recursive: true, dereference: false },
  );
  await copyFile(
    path.join(sourceDirectory, "neutron.json"),
    path.join(targetDirectory, "neutron.json"),
  );
  await copyFile(
    path.join(sourceDirectory, "neutron.lock.json"),
    path.join(targetDirectory, "neutron.lock.json"),
  );
  await executeMogen(input.repositoryRoot, targetDirectory);
  await packageMotoko({
    cwd: targetDirectory,
    packages: await qualificationPackageMap(input.repositoryRoot),
  });
  await copyFile(
    path.join(
      sourceDirectory,
      "connections",
      "provider-support.generated.json",
    ),
    path.join(targetDirectory, "dist", "connection-providers.json"),
  );
  return packDirectory(targetDirectory);
}

export async function buildQualificationFixtureArchives(input: {
  repositoryRoot: string;
  temporaryRoot: string;
}): Promise<
  readonly Readonly<{
    fixture: CertifiedAssetsQualificationFixture;
    archivePath: string;
  }>[]
> {
  assertQualificationFixtureSetAdmission();
  const archives = [];
  for (const fixture of CERTIFIED_ASSETS_QUALIFICATION_FIXTURES) {
    archives.push({
      fixture,
      archivePath: await buildQualificationFixtureArchive({
        ...input,
        appId: fixture.app_id,
      }),
    });
  }
  return archives;
}

export async function buildQualificationFixtureArchive(input: {
  repositoryRoot: string;
  temporaryRoot: string;
  appId: CertifiedAssetsQualificationFixtureId;
}): Promise<string> {
  const fixture = certifiedAssetsQualificationFixture(input.appId);
  const sourceDirectory = path.dirname(
    path.join(
      input.repositoryRoot,
      CERTIFIED_ASSETS_SYNTHETIC_ACTOR_MANIFEST,
    ),
  );
  const targetDirectory = path.join(
    input.temporaryRoot,
    "fixture-packages",
    fixture.app_id,
  );
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  await cp(
    path.join(sourceDirectory, "backend"),
    path.join(targetDirectory, "backend"),
    { recursive: true, dereference: false },
  );
  const manifestTemplate = JSON.parse(
    await readFile(path.join(sourceDirectory, "neutron.json"), "utf8"),
  ) as unknown;
  const manifest = generateCertifiedAssetsQualificationManifest(
    manifestTemplate,
    fixture,
  );
  const boundManifestBytes =
    certifiedAssetsQualificationManifestBytes(manifest);
  await writeFile(
    path.join(targetDirectory, "neutron.json"),
    boundManifestBytes,
    { mode: 0o600, flag: "wx" },
  );
  await executeMogen(input.repositoryRoot, targetDirectory);
  const generatedManifestBytes = await readFile(
    path.join(targetDirectory, "neutron.json"),
  );
  if (
    !generatedManifestBytes.equals(Buffer.from(boundManifestBytes))
  ) {
    throw new Error(
      `Qualification fixture ${fixture.app_id} mogen output does not match its candidate-bound manifest`,
    );
  }
  const packages = await qualificationPackageMap(input.repositoryRoot);
  await packageMotoko({ cwd: targetDirectory, packages });
  await removeQualificationOnlySourceDeliveryMarker(targetDirectory);
  return packDirectory(targetDirectory);
}

/**
 * These local-only synthetic packages exercise Certified Assets behavior; they
 * are never conveyed or published and deliberately have no legal/source
 * envelope. `mopack` marks packages without an update source for embedded
 * source delivery, so remove that production-only negotiation marker before
 * feeding the fixtures to the current installer.
 */
async function removeQualificationOnlySourceDeliveryMarker(
  packageDirectory: string,
): Promise<void> {
  const manifestPath = path.join(packageDirectory, "dist", "neutron.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    package_features?: unknown;
  };
  if (
    !Array.isArray(manifest.package_features) ||
    manifest.package_features.length !== 1 ||
    manifest.package_features[0] !== "archive-only-legal-v1"
  ) {
    throw new Error(
      "Qualification fixture has an unexpected source-delivery marker",
    );
  }
  delete manifest.package_features;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function executeMogen(
  repositoryRoot: string,
  cwd: string,
): Promise<void> {
  await executeFile(
    process.execPath,
    [
      path.join(
        repositoryRoot,
        "packages",
        "neutron-scripts",
        "src",
        "mogen.ts",
      ),
    ],
    { cwd, maxBuffer: 4 * 1024 * 1024 },
  );
}

export async function qualificationPackageMap(
  repositoryRoot: string,
): Promise<PackageMap> {
  return certifiedAssetsQualificationMotokoPackageMap(repositoryRoot);
}
