import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX } from "neutron-tools/package_record.js";

const execFile = promisify(callbackExecFile);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export const THIRD_PARTY_NOTICE_INDEX_PATH =
  `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}THIRD_PARTY_NOTICES.md` as const;
export const THIRD_PARTY_NOTICE_MATERIAL_DIRECTORY =
  `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}third-party` as const;
export const THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH =
  `${THIRD_PARTY_NOTICE_MATERIAL_DIRECTORY}/EXACT-MATERIALS.v1.txt` as const;

const MAX_COMPONENTS = 512;
const MAX_DIRECTORY_ENTRIES_PER_COMPONENT = 20_000;
const MAX_INDEX_LINES = 675;
const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;
const MAX_MOPS_OUTPUT_BYTES = 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

const LEGAL_FILE_PATTERN =
  /^(?:licen[cs]es?|copying|notice|copyright)(?:$|[._-])/iu;
const PRIMARY_LICENSE_FILE_PATTERN =
  /^(?:licen[cs]es?|copying)(?:$|[._-])/iu;
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
// react-icons@5.7.0 identifies io5 as Ionicons 5.5.4. These are the exact
// upstream LICENSE bytes from the immutable v5.5.4 tag:
// https://raw.githubusercontent.com/ionic-team/ionicons/v5.5.4/LICENSE
const IONICONS_VERSION = "5.5.4";
const IONICONS_LICENSE_SHA256 =
  "c89dabc60b2e4e1a04b33bd7010b5a56bb4725ffe8c00d793a5ae009fbbfebd8";
const SUPPORTED_REACT_ICONS_VERSION = "5.7.0";

const AUDITED_LICENSE_EXPRESSIONS = new Map<string, string>([
  ["0BSD", "0BSD"],
  ["Apache-2.0", "Apache-2.0"],
  ["Apache-2.0 WITH LLVM-exception", "Apache-2.0 WITH LLVM-exception"],
  ["BSD-2-Clause", "BSD-2-Clause"],
  ["BSD-3-Clause", "BSD-3-Clause"],
  ["ISC", "ISC"],
  ["MIT", "MIT"],
  ["(AFL-2.1 OR BSD-3-Clause)", "BSD-3-Clause"],
]);

const SPECIAL_NPM_LEGAL_FILES = new Map<string, readonly string[]>([
  // This package is Apache-2.0 overall, but this installed source file carries
  // an additional BSD-3-Clause notice that is not repeated in a LICENSE file.
  ["@ai-sdk/provider-utils", ["src/secure-json-parse.ts"]],
]);

// Two immutable Vessel-era transitive packages in json.mo predate mops.toml.
// Bind their exact `mops sources` identity and installed LICENSE bytes instead
// of guessing package metadata from an arbitrary directory name.
const AUDITED_LEGACY_MOPS_PACKAGES = new Map<
  string,
  Readonly<{ name: string; version: string; licenseSha256: string }>
>([
  [
    "base-0.7.3\u0000.mops/_github/base-0.7.3#aafcdee0c8328087aeed506e64aa2ff4ed329b47/src",
    {
      name: "base-0.7.3",
      version: "git:aafcdee0c8328087aeed506e64aa2ff4ed329b47",
      licenseSha256:
        "166bd8e8cf7790087d1fd18a9fa4d060cc0d0b3e5ab30689aa5f3a59a93386bf",
    },
  ],
  [
    "parser-combinators\u0000.mops/_github/parser-combinators#v0.1.2/src",
    {
      name: "parser-combinators",
      version: "git:v0.1.2",
      licenseSha256:
        "1804df81949ab073bbbc3401e7c45ca134195b799653d2ff22c9d52773918388",
    },
  ],
]);

// Some installed Mops packages omit the license field while retaining exact
// license text. Recognition is content-addressed so a changed or unfamiliar
// legal file fails closed instead of being classified heuristically.
const AUDITED_UNDECLARED_MOPS_LICENSE_SHA256 = new Map<string, string>([
  [
    "840e3d57a38a8061f55d04470fbd58b9345326fa04ea10ee42add5c6e3b2aa08",
    "Apache-2.0",
  ],
  [
    "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "Apache-2.0",
  ],
  [
    "1804df81949ab073bbbc3401e7c45ca134195b799653d2ff22c9d52773918388",
    "Apache-2.0",
  ],
  [
    "7caf02fc1ac48db886244237e0fa148cea6c360daabcbccd3e6d26da422bb06b",
    "MIT",
  ],
]);

const SKIPPED_SCAN_DIRECTORIES = new Set([".git", "node_modules"]);
const SKIPPED_APP_SCAN_DIRECTORIES = new Set([
  ".git",
  ".mops",
  "build",
  "dist",
  "node_modules",
  "test",
  "tests",
]);
const APP_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".scss",
  ".ts",
  ".tsx",
]);
const AUDITED_REACT_ICON_FAMILIES = new Set(["io5"]);
const DEFAULT_APP_NOTICE_FILE_PATTERN =
  /^(?:third_party_notices(?:\..+)?|(?:licen[cs]e|notice)[.-].+)$/iu;

type JsonObject = Record<string, unknown>;

type LegalInput = Readonly<{
  sourcePath: string;
  bytes: Uint8Array;
}>;

type DraftComponent = Readonly<{
  ecosystem: "npm" | "mops";
  name: string;
  version: string;
  declaredLicense: string;
  selectedLicense: string;
  author?: string;
  repository?: string;
  legalInputs: readonly LegalInput[];
}>;

export type ThirdPartyNoticeMaterialReference = Readonly<{
  sourcePath: string;
  path: string;
  sha256: string;
  bytes: number;
}>;

export type ThirdPartyNoticeComponent = Readonly<{
  ecosystem: "npm" | "mops";
  name: string;
  version: string;
  declaredLicense: string;
  selectedLicense: string;
  author?: string;
  repository?: string;
  materials: readonly ThirdPartyNoticeMaterialReference[];
}>;

export type MopsSourcesRunner = (appRoot: string) => Promise<string>;

/**
 * Narrow first-party owner decision for one exact installed npm package whose
 * published package.json omitted a license field. The decision is caller
 * supplied so ordinary dependency collection never guesses ownership or
 * permission from a package name.
 */
export type AuditedNpmOwnerLicenseDecision = Readonly<{
  name: string;
  version: string;
  packageJsonSha256: string;
  selectedLicense: "Apache-2.0";
  copyrightHolder: string;
  scope: string;
  excludedPaths: readonly string[];
}>;

export type BuildThirdPartyNoticeBundleOptions = Readonly<{
  /** Absolute or repository-relative application package root. */
  appRoot: string;
  /** Repository boundary containing the app and every installed dependency. */
  repositoryRoot: string;
  /** Test/offline override for exact `mops sources` stdout. */
  mopsSourcesOutput?: string;
  /** App-relative exact notice inputs. Defaults to THIRD_PARTY_NOTICES.md. */
  appSpecificNoticePaths?: readonly string[];
  /** Injectable runner used only when mopsSourcesOutput is absent. */
  runMopsSources?: MopsSourcesRunner;
  /** Canonical Apache-2.0 text used only for audited packages that omitted it. */
  apacheLicensePath?: string;
  /** Exact owner-authorized exceptions; every supplied decision must be used. */
  auditedNpmOwnerLicenseDecisions?: readonly AuditedNpmOwnerLicenseDecision[];
}>;

export type ThirdPartyNoticeBundle = Readonly<{
  /** Package-archive paths mapped to their exact uncompressed bytes. */
  files: Readonly<Record<string, Uint8Array>>;
  /** Canonically ordered paths that a package-information record must bind. */
  noticePaths: readonly string[];
  /** Auditable component-to-material mapping used to render the index. */
  components: readonly ThirdPartyNoticeComponent[];
}>;

type MaterialRecord = Readonly<{
  path: string;
  sha256: string;
  bytes: Uint8Array;
}>;

/**
 * Build a complete local dependency notice bundle for one app package.
 *
 * The function does not infer permission for remote services, downloaded
 * models, or data that is absent from the workspace. Callers must supply such
 * material as app-specific inputs or keep the release blocked separately.
 */
export async function buildThirdPartyNoticeBundle(
  options: BuildThirdPartyNoticeBundleOptions,
): Promise<ThirdPartyNoticeBundle> {
  const repositoryRoot = await fs.realpath(path.resolve(options.repositoryRoot));
  const appRoot = await fs.realpath(
    path.resolve(repositoryRoot, options.appRoot),
  );
  assertWithin(repositoryRoot, appRoot, "Application root");

  const reactIconFamilies = await collectAuditedReactIconFamilies(appRoot);
  const ioniconsLicense = await loadIoniconsLicense(reactIconFamilies);

  const apacheLicensePath = await fs.realpath(
    options.apacheLicensePath === undefined
      ? path.resolve(import.meta.dir, "../LICENSE")
      : path.resolve(repositoryRoot, options.apacheLicensePath),
  );
  assertWithin(repositoryRoot, apacheLicensePath, "Apache-2.0 license text");
  const apacheLicense = await readBoundedRegularFile(
    apacheLicensePath,
    "canonical Apache-2.0 license text",
  );
  assertCanonicalApacheLicense(apacheLicense, apacheLicensePath);

  const ownerDecisions = normalizeOwnerLicenseDecisions(
    options.auditedNpmOwnerLicenseDecisions ?? [],
  );
  const usedOwnerDecisions = new Set<string>();
  const npmComponents = await collectNpmComponents(
    appRoot,
    repositoryRoot,
    apacheLicense,
    reactIconFamilies,
    ioniconsLicense,
    ownerDecisions,
    usedOwnerDecisions,
  );
  for (const name of ownerDecisions.keys()) {
    if (!usedOwnerDecisions.has(name)) {
      throw new Error(`Audited npm owner-license decision was not used: ${name}`);
    }
  }
  const mopsSourcesOutput =
    options.mopsSourcesOutput ??
    (await (options.runMopsSources ?? runMopsSourcesCommand)(appRoot));
  if (textEncoder.encode(mopsSourcesOutput).byteLength > MAX_MOPS_OUTPUT_BYTES) {
    throw new Error(
      `mops sources output exceeds ${MAX_MOPS_OUTPUT_BYTES} bytes`,
    );
  }
  const mopsComponents = await collectMopsComponents(
    appRoot,
    repositoryRoot,
    mopsSourcesOutput,
  );
  const appInputs = await collectAppSpecificInputs(
    appRoot,
    options.appSpecificNoticePaths,
  );

  const drafts = [...npmComponents, ...mopsComponents].sort(compareDrafts);
  if (drafts.length > MAX_COMPONENTS) {
    throw new Error(
      `Third-party dependency closure has ${drafts.length} components; maximum is ${MAX_COMPONENTS}`,
    );
  }

  const materialByHash = new Map<string, MaterialRecord>();
  let components = drafts.map((draft) =>
    finalizeComponent(draft, materialByHash),
  );
  let appInputReferences = appInputs.map((input) =>
    addMaterial(input, materialByHash),
  );

  const materials = [...materialByHash.values()].sort((left, right) =>
    compareCanonical(left.path, right.path),
  );
  let emittedMaterials = materials;
  let materialBundlePath: string | undefined;
  // One exact-material bundle avoids hundreds of separately staged canister
  // assets. The index still binds each component, source path, byte length,
  // and SHA-256 to its exact entry in the bundle.
  if (materials.length > 0) {
    const bundledBytes = renderExactMaterialBundle(materials);
    materialBundlePath = THIRD_PARTY_NOTICE_MATERIAL_BUNDLE_PATH;
    emittedMaterials = [
      Object.freeze({
        path: materialBundlePath,
        sha256: hashBytes(bundledBytes),
        bytes: bundledBytes,
      }),
    ];
    components = components.map((component) =>
      remapComponentMaterialPath(component, materialBundlePath!),
    );
    appInputReferences = appInputReferences.map((reference) =>
      Object.freeze({ ...reference, path: materialBundlePath! }),
    );
  }

  const indexBytes = textEncoder.encode(
    renderNoticeIndex(
      components,
      appInputReferences,
      materials,
      materialBundlePath,
    ),
  );
  if (indexBytes.byteLength > MAX_MATERIAL_BYTES) {
    throw new Error(
      `Third-party notice index exceeds ${MAX_MATERIAL_BYTES} bytes`,
    );
  }

  const files: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  files[THIRD_PARTY_NOTICE_INDEX_PATH] = indexBytes;
  for (const material of emittedMaterials) {
    if (Object.hasOwn(files, material.path)) {
      throw new Error(`Third-party notice output collision: ${material.path}`);
    }
    files[material.path] = material.bytes.slice();
  }
  const noticePaths = Object.freeze(Object.keys(files).sort(compareCanonical));
  if (noticePaths.length === 0) {
    throw new Error("Third-party notice bundle unexpectedly contains no files");
  }

  return Object.freeze({
    files: Object.freeze(files),
    noticePaths,
    components: Object.freeze(components),
  });
}

function renderExactMaterialBundle(
  materials: readonly MaterialRecord[],
): Uint8Array {
  const chunks: Uint8Array[] = [
    textEncoder.encode(
      "# Exact third-party legal material bundle v1\n" +
        "# Each entry is delimited by its declared byte length and SHA-256.\n\n",
    ),
  ];
  let totalBytes = chunks[0]!.byteLength;
  for (const material of materials) {
    const header = textEncoder.encode(
      `----- BEGIN MATERIAL sha256=${material.sha256} bytes=${material.bytes.byteLength} -----\n`,
    );
    const trailer = textEncoder.encode(
      `\n----- END MATERIAL sha256=${material.sha256} -----\n\n`,
    );
    totalBytes += header.byteLength + material.bytes.byteLength + trailer.byteLength;
    if (totalBytes > MAX_MATERIAL_BYTES) {
      throw new Error(
        `Consolidated third-party legal materials exceed ${MAX_MATERIAL_BYTES} bytes`,
      );
    }
    chunks.push(header, material.bytes, trailer);
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function remapComponentMaterialPath(
  component: ThirdPartyNoticeComponent,
  bundlePath: string,
): ThirdPartyNoticeComponent {
  return Object.freeze({
    ...component,
    materials: Object.freeze(
      component.materials.map((material) =>
        Object.freeze({ ...material, path: bundlePath }),
      ),
    ),
  });
}

async function runMopsSourcesCommand(appRoot: string): Promise<string> {
  const { stdout } = await execFile("mops", ["sources"], {
    cwd: appRoot,
    encoding: "utf8",
    maxBuffer: MAX_MOPS_OUTPUT_BYTES,
  });
  return stdout;
}

function normalizeOwnerLicenseDecisions(
  decisions: readonly AuditedNpmOwnerLicenseDecision[],
): ReadonlyMap<string, AuditedNpmOwnerLicenseDecision> {
  const result = new Map<string, AuditedNpmOwnerLicenseDecision>();
  for (const decision of decisions) {
    assertPackageName(decision.name);
    if (result.has(decision.name)) {
      throw new Error(
        `Duplicate audited npm owner-license decision: ${decision.name}`,
      );
    }
    if (decision.version.length === 0 || decision.version.length > 128) {
      throw new Error(
        `Invalid audited npm owner-license version for ${decision.name}`,
      );
    }
    if (!SHA256_PATTERN.test(decision.packageJsonSha256)) {
      throw new Error(
        `Invalid audited npm package.json SHA-256 for ${decision.name}`,
      );
    }
    if (decision.selectedLicense !== "Apache-2.0") {
      throw new Error(
        `Unsupported audited npm owner license for ${decision.name}`,
      );
    }
    cleanMetadataText(decision.copyrightHolder, "copyright holder");
    cleanMetadataText(decision.scope, "owner-license scope");
    const excludedPaths = decision.excludedPaths.map((excludedPath) =>
      normalizeSafeRelativePath(
        excludedPath,
        `${decision.name} excluded owner-license path`,
      ),
    );
    if (
      excludedPaths.length === 0 ||
      new Set(excludedPaths).size !== excludedPaths.length ||
      [...excludedPaths].sort(compareCanonical).some(
        (excludedPath, index) => excludedPath !== excludedPaths[index],
      )
    ) {
      throw new Error(
        `${decision.name} excluded owner-license paths must be nonempty, unique, and canonically ordered`,
      );
    }
    result.set(decision.name, Object.freeze({ ...decision, excludedPaths }));
  }
  return result;
}

function validateOwnerLicenseDecision(
  decision: AuditedNpmOwnerLicenseDecision,
  packageName: string,
  packageVersion: string,
  packageJsonBytes: Uint8Array,
): void {
  if (
    decision.name !== packageName ||
    decision.version !== packageVersion ||
    hashBytes(packageJsonBytes) !== decision.packageJsonSha256
  ) {
    throw new Error(
      `Audited npm owner-license decision does not match exact ${packageName}@${packageVersion} package.json bytes`,
    );
  }
  const manifest = parseJsonObjectBytes(
    packageJsonBytes,
    `npm package ${packageName}`,
  );
  if (Object.hasOwn(manifest, "license")) {
    throw new Error(
      `Audited npm owner-license decision for ${packageName} is restricted to the reviewed package.json with no license field`,
    );
  }
}

function ownerDecisionLegalInputs(
  decision: AuditedNpmOwnerLicenseDecision,
  apacheLicense: Uint8Array,
): LegalInput[] {
  const notice = textEncoder.encode(
    [
      "Audited first-party npm owner license decision",
      "",
      `Component: ${decision.name}@${decision.version}`,
      `Exact package.json SHA-256: ${decision.packageJsonSha256}`,
      `Copyright holder: ${decision.copyrightHolder}`,
      `Selected license: ${decision.selectedLicense}`,
      `Scope: ${decision.scope}`,
      "Excluded installed paths (not licensed or attributed by this decision):",
      ...decision.excludedPaths.map((excludedPath) => `- ${excludedPath}`),
      "",
      "The canonical Apache-2.0 text carried beside this decision applies only",
      "to the stated first-party scope. Third-party material retains its own",
      "copyright and terms; this decision makes no claim about those rights.",
      "",
    ].join("\n"),
  );
  return [
    Object.freeze({
      sourcePath: `owner-decision/${decision.name}@${decision.version}.txt`,
      bytes: notice,
    }),
    Object.freeze({
      sourcePath: "owner-decision/Apache-2.0.txt",
      bytes: apacheLicense.slice(),
    }),
  ].sort((left, right) => compareCanonical(left.sourcePath, right.sourcePath));
}

async function collectNpmComponents(
  appRoot: string,
  repositoryRoot: string,
  apacheLicense: Uint8Array,
  reactIconFamilies: readonly string[],
  ioniconsLicense: LegalInput | undefined,
  ownerDecisions: ReadonlyMap<string, AuditedNpmOwnerLicenseDecision>,
  usedOwnerDecisions: Set<string>,
): Promise<DraftComponent[]> {
  const appManifest = await readJsonObject(
    path.join(appRoot, "package.json"),
    "application package.json",
  );
  const components = new Map<string, DraftComponent>();
  const reactIconsPackageRoot =
    reactIconFamilies.length === 0
      ? undefined
      : await resolveInstalledPackage(
          appRoot,
          repositoryRoot,
          "react-icons",
          false,
        );
  let collectedReactIcons = false;

  const visit = async (
    requesterRoot: string,
    dependencyName: string,
    optional: boolean,
  ): Promise<void> => {
    assertPackageName(dependencyName);
    const packageRoot = await resolveInstalledPackage(
      requesterRoot,
      repositoryRoot,
      dependencyName,
      optional,
    );
    if (packageRoot === undefined) return;
    if (packageRoot === appRoot) {
      throw new Error(
        `Application cannot be its own npm dependency: ${dependencyName}`,
      );
    }

    const manifestPath = path.join(packageRoot, "package.json");
    const manifestBytes = await readBoundedRegularFile(
      manifestPath,
      `npm package ${dependencyName}`,
      MAX_PACKAGE_JSON_BYTES,
    );
    const manifest = parseJsonObjectBytes(
      manifestBytes,
      `npm package ${dependencyName}`,
    );
    const actualName = requiredString(manifest, "name", manifestPath);
    const version = requiredString(manifest, "version", manifestPath);
    if (actualName !== dependencyName) {
      throw new Error(
        `Unsupported npm alias: dependency ${dependencyName} resolved to ${actualName}`,
      );
    }
    const componentKey = `${packageRoot}\u0000${actualName}\u0000${version}`;
    if (components.has(componentKey)) return;

    const ownerDecision = ownerDecisions.get(actualName);
    let declaredLicense: string;
    let selectedLicense: string;
    let legalInputs: LegalInput[];
    if (ownerDecision !== undefined) {
      validateOwnerLicenseDecision(
        ownerDecision,
        actualName,
        version,
        manifestBytes,
      );
      usedOwnerDecisions.add(actualName);
      declaredLicense = "package.json omits a license field";
      selectedLicense = ownerDecision.selectedLicense;
      legalInputs = ownerDecisionLegalInputs(ownerDecision, apacheLicense);
    } else {
      declaredLicense = requiredString(manifest, "license", manifestPath);
      selectedLicense = selectAuditedLicense(
        declaredLicense,
        `npm ${actualName}@${version}`,
      );
      legalInputs = await collectPackageLegalInputs({
        packageRoot,
        packageName: actualName,
        declaredLicense,
        apacheLicense,
        allowApacheFallback: true,
      });
    }
    if (packageRoot === reactIconsPackageRoot) {
      collectedReactIcons = true;
      await assertReactIconsProvenance(
        packageRoot,
        version,
        reactIconFamilies,
      );
      if (reactIconFamilies.includes("io5")) {
        if (ioniconsLicense === undefined) {
          throw new Error(
            "Internal missing Ionicons legal material for react-icons/io5",
          );
        }
        legalInputs.push(ioniconsLicense);
        legalInputs.sort((left, right) =>
          compareCanonical(left.sourcePath, right.sourcePath),
        );
      }
    }
    const effectiveLicense = detectLlvmException(
      selectedLicense,
      legalInputs,
    );
    const draft: DraftComponent = Object.freeze({
      ecosystem: "npm",
      name: actualName,
      version,
      declaredLicense,
      selectedLicense: effectiveLicense,
      ...optionalMetadataFields(manifest, `npm ${actualName}@${version}`),
      legalInputs: Object.freeze(legalInputs),
    });
    components.set(componentKey, draft);
    if (components.size > MAX_COMPONENTS) {
      throw new Error(
        `Third-party dependency closure exceeds ${MAX_COMPONENTS} components`,
      );
    }

    for (const dependency of dependencyDeclarations(manifest)) {
      await visit(packageRoot, dependency.name, dependency.optional);
    }
  };

  for (const dependency of dependencyDeclarations(appManifest)) {
    await visit(appRoot, dependency.name, dependency.optional);
  }
  if (reactIconFamilies.length > 0 && !collectedReactIcons) {
    throw new Error(
      "Application imports react-icons families but react-icons is not in its production dependency closure",
    );
  }
  return [...components.values()];
}

async function collectMopsComponents(
  appRoot: string,
  repositoryRoot: string,
  sourcesOutput: string,
): Promise<DraftComponent[]> {
  const sourceEntries = parseMopsSources(sourcesOutput);
  const components = new Map<string, DraftComponent>();

  for (const entry of sourceEntries) {
    const sourceRoot = await fs.realpath(path.resolve(appRoot, entry.source));
    assertWithin(repositoryRoot, sourceRoot, `Mops package ${entry.name}`);
    const packageRoot = await findMopsPackageRoot(
      sourceRoot,
      appRoot,
      repositoryRoot,
      entry.name,
    );
    if (packageRoot === undefined) {
      components.set(
        `${sourceRoot}\u0000${entry.name}\u0000legacy`,
        await collectAuditedLegacyMopsComponent(
          appRoot,
          entry,
          sourceRoot,
        ),
      );
      continue;
    }
    const manifestPath = path.join(packageRoot, "mops.toml");
    const manifest = parseMopsManifest(
      fatalUtf8Decoder.decode(
        await readBoundedRegularFile(manifestPath, `Mops package ${entry.name}`),
      ),
      manifestPath,
    );
    const selectedLicense =
      manifest.license === undefined
        ? await selectAuditedUndeclaredMopsLicense(packageRoot, manifest.name)
        : selectAuditedLicense(
            manifest.license,
            `Mops ${manifest.name}@${manifest.version}`,
          );
    const declaredLicense =
      manifest.license ??
      `mops.toml omits a license field; exact installed LICENSE audited as ${selectedLicense}`;
    const legalInputs = await collectPackageLegalInputs({
      packageRoot,
      packageName: manifest.name,
      declaredLicense: selectedLicense,
      apacheLicense: new Uint8Array(),
      allowApacheFallback: false,
    });
    const componentKey = `${packageRoot}\u0000${manifest.name}\u0000${manifest.version}`;
    if (components.has(componentKey)) continue;
    components.set(
      componentKey,
      Object.freeze({
        ecosystem: "mops",
        name: manifest.name,
        version: manifest.version,
        declaredLicense,
        selectedLicense: detectLlvmException(selectedLicense, legalInputs),
        ...(manifest.repository === undefined
          ? {}
          : { repository: manifest.repository }),
        legalInputs: Object.freeze(legalInputs),
      }),
    );
  }
  return [...components.values()];
}

async function selectAuditedUndeclaredMopsLicense(
  packageRoot: string,
  packageName: string,
): Promise<string> {
  const discovered = await discoverLegalFiles(packageRoot);
  const licensePaths = discovered.filter(
    (relativePath) => relativePath.toLowerCase() === "license",
  );
  if (licensePaths.length !== 1) {
    throw new Error(
      `Mops ${packageName} omits a license field and has no single audited root LICENSE`,
    );
  }
  const licenseBytes = await readBoundedRegularFile(
    path.join(packageRoot, licensePaths[0]!),
    `Mops ${packageName} undeclared LICENSE`,
  );
  const selected = AUDITED_UNDECLARED_MOPS_LICENSE_SHA256.get(
    hashBytes(licenseBytes),
  );
  if (selected === undefined) {
    throw new Error(
      `Mops ${packageName} omits a license field and its exact LICENSE bytes are unaudited`,
    );
  }
  return selected;
}

async function collectPackageLegalInputs(options: Readonly<{
  packageRoot: string;
  packageName: string;
  declaredLicense: string;
  apacheLicense: Uint8Array;
  allowApacheFallback: boolean;
}>): Promise<LegalInput[]> {
  const discoveredPaths = await discoverLegalFiles(options.packageRoot);
  const seeLicenseMatch = /^SEE LICENSE IN (.+)$/iu.exec(
    options.declaredLicense.trim(),
  );
  const declaredLegalPath =
    seeLicenseMatch === null
      ? undefined
      : normalizeSafeRelativePath(
          seeLicenseMatch[1]!,
          `${options.packageName} declared license path`,
        );
  if (
    declaredLegalPath !== undefined &&
    !discoveredPaths.includes(declaredLegalPath)
  ) {
    throw new Error(
      `${options.packageName} declared ${JSON.stringify(options.declaredLicense)} but the exact installed legal file was not found`,
    );
  }

  const hasPrimaryLicense =
    declaredLegalPath !== undefined ||
    discoveredPaths.some((relativePath) =>
      PRIMARY_LICENSE_FILE_PATTERN.test(path.posix.basename(relativePath)),
    );
  const inputs: LegalInput[] = [];
  for (const relativePath of discoveredPaths) {
    inputs.push({
      sourcePath: relativePath,
      bytes: await readBoundedRegularFile(
        path.join(options.packageRoot, ...relativePath.split("/")),
        `${options.packageName} ${relativePath}`,
      ),
    });
  }

  for (const relativePath of SPECIAL_NPM_LEGAL_FILES.get(options.packageName) ??
    []) {
    const normalized = normalizeSafeRelativePath(
      relativePath,
      `${options.packageName} special legal file`,
    );
    if (discoveredPaths.includes(normalized)) continue;
    inputs.push({
      sourcePath: normalized,
      bytes: await readBoundedRegularFile(
        path.join(options.packageRoot, ...normalized.split("/")),
        `${options.packageName} ${normalized}`,
      ),
    });
  }

  if (!hasPrimaryLicense) {
    if (
      options.allowApacheFallback &&
      options.declaredLicense.trim() === "Apache-2.0"
    ) {
      inputs.push({
        sourcePath: "SPDX/Apache-2.0.txt (publisher omitted a license file)",
        bytes: options.apacheLicense.slice(),
      });
    } else {
      throw new Error(
        `${options.packageName} has no installed LICENSE or COPYING file for ${options.declaredLicense}`,
      );
    }
  }
  if (inputs.length === 0) {
    throw new Error(`${options.packageName} has no installed legal material`);
  }
  return inputs.sort((left, right) =>
    compareCanonical(left.sourcePath, right.sourcePath),
  );
}

async function discoverLegalFiles(packageRoot: string): Promise<string[]> {
  const files: string[] = [];
  let scannedEntries = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareCanonical(left.name, right.name),
    );
    scannedEntries += entries.length;
    if (scannedEntries > MAX_DIRECTORY_ENTRIES_PER_COMPONENT) {
      throw new Error(
        `Legal-file scan for ${packageRoot} exceeds ${MAX_DIRECTORY_ENTRIES_PER_COMPONENT} entries`,
      );
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Installed dependency contains unsupported symbolic link: ${absolutePath}`,
        );
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_SCAN_DIRECTORIES.has(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Installed dependency contains non-regular entry: ${absolutePath}`,
        );
      }
      if (!LEGAL_FILE_PATTERN.test(entry.name)) continue;
      files.push(toPosixRelative(packageRoot, absolutePath));
    }
  };

  await walk(packageRoot);
  return files.sort(compareCanonical);
}

function dependencyDeclarations(
  manifest: JsonObject,
): readonly Readonly<{ name: string; optional: boolean }>[] {
  const required = dependencyNames(manifest.dependencies, "dependencies");
  const optional = new Set(
    dependencyNames(
      manifest.optionalDependencies,
      "optionalDependencies",
    ),
  );
  const bundled = new Set(bundledDependencyNames(manifest));
  const requiredPeers = new Set(requiredPeerDependencyNames(manifest));
  const names = new Set([
    ...required,
    ...optional,
    ...bundled,
    ...requiredPeers,
  ]);
  return [...names]
    .sort(compareCanonical)
    .map((name) =>
      Object.freeze({
        name,
        optional:
          optional.has(name) &&
          !bundled.has(name) &&
          !requiredPeers.has(name),
      }),
    );
}

function requiredPeerDependencyNames(manifest: JsonObject): string[] {
  const peerNames = dependencyNames(
    manifest.peerDependencies,
    "peerDependencies",
  );
  const metadata = manifest.peerDependenciesMeta;
  if (metadata === undefined) return peerNames;
  if (!isObject(metadata)) {
    throw new Error("package.json peerDependenciesMeta must be an object");
  }
  const optionalPeers = new Set<string>();
  for (const [name, entry] of Object.entries(metadata)) {
    assertPackageName(name);
    if (!isObject(entry)) {
      throw new Error(
        `package.json peerDependenciesMeta.${name} must be an object`,
      );
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      throw new Error(
        `package.json peerDependenciesMeta.${name}.optional must be boolean`,
      );
    }
    if (entry.optional === true) optionalPeers.add(name);
  }
  return peerNames.filter((name) => !optionalPeers.has(name));
}

function dependencyNames(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!isObject(value)) throw new Error(`package.json ${field} must be an object`);
  const names: string[] = [];
  for (const [name, specifier] of Object.entries(value)) {
    assertPackageName(name);
    if (typeof specifier !== "string" || specifier.length === 0) {
      throw new Error(`package.json ${field}.${name} must be a non-empty string`);
    }
    names.push(name);
  }
  return names;
}

function bundledDependencyNames(manifest: JsonObject): string[] {
  const value = manifest.bundledDependencies ?? manifest.bundleDependencies;
  if (value === undefined || value === false) return [];
  if (value === true) {
    return dependencyNames(manifest.dependencies, "dependencies");
  }
  if (!Array.isArray(value)) {
    throw new Error("package.json bundledDependencies must be a boolean or array");
  }
  return value.map((name) => {
    if (typeof name !== "string") {
      throw new Error("package.json bundledDependencies entries must be strings");
    }
    assertPackageName(name);
    return name;
  });
}

async function resolveInstalledPackage(
  requesterRoot: string,
  repositoryRoot: string,
  packageName: string,
  optional: boolean,
): Promise<string | undefined> {
  const segments = packageName.split("/");
  let directory = requesterRoot;
  while (isWithin(repositoryRoot, directory)) {
    const packageJsonPath = path.join(
      directory,
      "node_modules",
      ...segments,
      "package.json",
    );
    try {
      const realPackageJson = await fs.realpath(packageJsonPath);
      assertWithin(repositoryRoot, realPackageJson, `npm dependency ${packageName}`);
      return await fs.realpath(path.dirname(realPackageJson));
    } catch (error) {
      if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTDIR")) throw error;
    }
    if (directory === repositoryRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (optional) return undefined;
  throw new Error(
    `Required npm dependency ${packageName} is not installed for ${requesterRoot}`,
  );
}

function parseMopsSources(
  output: string,
): readonly Readonly<{ name: string; source: string }>[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/\s+/u);
  if (tokens.length % 3 !== 0) {
    throw new Error(`Malformed mops sources output: ${JSON.stringify(output)}`);
  }
  const entries: Array<Readonly<{ name: string; source: string }>> = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < tokens.length; index += 3) {
    const marker = tokens[index];
    const name = tokens[index + 1];
    const source = tokens[index + 2];
    if (marker !== "--package" || name === undefined || source === undefined) {
      throw new Error(`Malformed mops sources output: ${JSON.stringify(output)}`);
    }
    assertMopsAlias(name);
    if (seenNames.has(name)) {
      throw new Error(`Duplicate Mops source alias: ${name}`);
    }
    seenNames.add(name);
    entries.push(Object.freeze({ name, source }));
  }
  return entries.sort((left, right) => compareCanonical(left.name, right.name));
}

async function findMopsPackageRoot(
  sourceRoot: string,
  appRoot: string,
  repositoryRoot: string,
  packageName: string,
): Promise<string | undefined> {
  let directory = sourceRoot;
  while (isWithin(repositoryRoot, directory)) {
    if (directory === appRoot) break;
    try {
      const manifestPath = path.join(directory, "mops.toml");
      const stats = await fs.lstat(manifestPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Mops manifest is not a regular file: ${manifestPath}`);
      }
      return directory;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

async function collectAuditedLegacyMopsComponent(
  appRoot: string,
  entry: Readonly<{ name: string; source: string }>,
  sourceRoot: string,
): Promise<DraftComponent> {
  const normalizedSource = normalizeSafeRelativePath(
    entry.source,
    `Mops package ${entry.name} source`,
  );
  const decision = AUDITED_LEGACY_MOPS_PACKAGES.get(
    `${entry.name}\u0000${normalizedSource}`,
  );
  if (decision === undefined) {
    throw new Error(
      `Cannot find mops.toml or an exact audited legacy identity for Mops package ${entry.name}`,
    );
  }
  const expectedSourceRoot = path.resolve(
    appRoot,
    ...normalizedSource.split("/"),
  );
  if (sourceRoot !== (await fs.realpath(expectedSourceRoot))) {
    throw new Error(`Legacy Mops source identity changed for ${entry.name}`);
  }
  if (path.basename(sourceRoot) !== "src") {
    throw new Error(`Legacy Mops package ${entry.name} must expose a src root`);
  }
  const packageRoot = path.dirname(sourceRoot);
  const legalInputs = await collectPackageLegalInputs({
    packageRoot,
    packageName: decision.name,
    declaredLicense: "Apache-2.0",
    apacheLicense: new Uint8Array(),
    allowApacheFallback: false,
  });
  const installedLicense = legalInputs.find(
    ({ sourcePath }) => sourcePath.toLowerCase() === "license",
  );
  if (
    installedLicense === undefined ||
    hashBytes(installedLicense.bytes) !== decision.licenseSha256
  ) {
    throw new Error(
      `Audited legacy Mops LICENSE identity changed for ${entry.name}`,
    );
  }
  return Object.freeze({
    ecosystem: "mops",
    name: decision.name,
    version: decision.version,
    declaredLicense:
      "legacy package has no mops.toml; exact installed LICENSE audited as Apache-2.0",
    selectedLicense: "Apache-2.0",
    legalInputs: Object.freeze(legalInputs),
  });
}

function parseMopsManifest(
  source: string,
  manifestPath: string,
): Readonly<{
  name: string;
  version: string;
  license?: string;
  repository?: string;
}> {
  const heading = /^\[package\][^\S\r\n]*(?:\r?\n|$)/mu.exec(source);
  if (heading === null) {
    throw new Error(`${manifestPath} has no [package] section`);
  }
  const sectionStart = heading.index + heading[0].length;
  const afterHeading = source.slice(sectionStart);
  const nextHeading = /^\[[^\]]+\][^\S\r\n]*(?:\r?\n|$)/mu.exec(afterHeading);
  const packageSection = afterHeading.slice(0, nextHeading?.index);
  const readValue = (field: string, required: boolean): string | undefined => {
    const match = new RegExp(`^${field}\\s*=\\s*"([^"\\r\\n]+)"\\s*$`, "mu").exec(
      packageSection,
    );
    if (match?.[1] !== undefined) return cleanMetadataText(match[1], field);
    if (required) throw new Error(`${manifestPath} has no string ${field}`);
    return undefined;
  };
  const repository = readValue("repository", false);
  return Object.freeze({
    name: readValue("name", true)!,
    version: readValue("version", true)!,
    ...(readValue("license", false) === undefined
      ? {}
      : { license: readValue("license", false)! }),
    ...(repository === undefined ? {} : { repository }),
  });
}

async function collectAppSpecificInputs(
  appRoot: string,
  configuredPaths: readonly string[] | undefined,
): Promise<LegalInput[]> {
  let inputPaths: readonly string[];
  if (configuredPaths !== undefined) {
    inputPaths = configuredPaths;
  } else {
    const discovered: string[] = [];
    for (const entry of (await fs.readdir(appRoot, { withFileTypes: true })).sort(
      (left, right) => compareCanonical(left.name, right.name),
    )) {
      if (!DEFAULT_APP_NOTICE_FILE_PATTERN.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Application notice input is not a regular file: ${path.join(appRoot, entry.name)}`,
        );
      }
      discovered.push(entry.name);
    }
    inputPaths = discovered;
  }

  const normalized = inputPaths.map((inputPath) =>
    normalizeSafeRelativePath(inputPath, "Application notice input"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Application notice inputs contain a duplicate path");
  }
  const inputs: LegalInput[] = [];
  for (const relativePath of normalized.sort(compareCanonical)) {
    const absolutePath = path.resolve(appRoot, ...relativePath.split("/"));
    assertWithin(appRoot, absolutePath, "Application notice input");
    inputs.push({
      sourcePath: `application/${relativePath}`,
      bytes: await readBoundedRegularFile(
        absolutePath,
        `application notice ${relativePath}`,
      ),
    });
  }
  return inputs;
}

async function collectAuditedReactIconFamilies(
  appRoot: string,
): Promise<readonly string[]> {
  const families = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareCanonical(left.name, right.name),
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Application source contains a symbolic link: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_APP_SCAN_DIRECTORIES.has(entry.name)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !APP_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }
      const source = fatalUtf8Decoder.decode(
        await readBoundedRegularFile(
          absolutePath,
          "application source",
          MAX_MATERIAL_BYTES,
          true,
        ),
      );
      for (const match of source.matchAll(/["']react-icons\/([^/"']+)["']/gu)) {
        const family = match[1];
        if (family !== undefined) families.add(family);
      }
    }
  };
  await walk(appRoot);
  const orderedFamilies = [...families].sort(compareCanonical);
  for (const family of orderedFamilies) {
    if (AUDITED_REACT_ICON_FAMILIES.has(family)) continue;
    if (family === "fa6") {
      throw new Error(
        "react-icons/fa6 embeds Font Awesome 6 icons under CC-BY-4.0, but the installed react-icons package does not carry a complete upstream attribution/license payload; replace those icons or add an explicit audited material rule",
      );
    }
    throw new Error(
      `react-icons/${family} has no audited embedded-icon license rule`,
    );
  }
  return Object.freeze(orderedFamilies);
}

async function loadIoniconsLicense(
  reactIconFamilies: readonly string[],
): Promise<LegalInput | undefined> {
  if (!reactIconFamilies.includes("io5")) return undefined;
  const licensePath = path.resolve(
    import.meta.dir,
    "../assets/legal/Ionicons-5.5.4.LICENSE",
  );
  const bytes = await readBoundedRegularFile(
    licensePath,
    `Ionicons ${IONICONS_VERSION} upstream license`,
  );
  const actualHash = hashBytes(bytes);
  if (actualHash !== IONICONS_LICENSE_SHA256) {
    throw new Error(
      `Ionicons ${IONICONS_VERSION} upstream license hash changed: expected ${IONICONS_LICENSE_SHA256}, got ${actualHash}`,
    );
  }
  const text = fatalUtf8Decoder.decode(bytes);
  if (
    !text.startsWith("The MIT License (MIT)\n") ||
    !text.includes("Copyright (c) 2015-present Ionic (http://ionic.io/)")
  ) {
    throw new Error(`Ionicons ${IONICONS_VERSION} upstream license is invalid`);
  }
  return Object.freeze({
    sourcePath: `upstream/ionic-team/ionicons@v${IONICONS_VERSION}/LICENSE`,
    bytes,
  });
}

async function assertReactIconsProvenance(
  packageRoot: string,
  packageVersion: string,
  reactIconFamilies: readonly string[],
): Promise<void> {
  if (packageVersion !== SUPPORTED_REACT_ICONS_VERSION) {
    throw new Error(
      `react-icons@${packageVersion} needs a fresh embedded-icon license audit; supported version is ${SUPPORTED_REACT_ICONS_VERSION}`,
    );
  }
  if (!reactIconFamilies.includes("io5")) return;
  const readmePath = path.join(packageRoot, "README.md");
  const readme = fatalUtf8Decoder.decode(
    await readBoundedRegularFile(readmePath, "react-icons installed README"),
  );
  if (
    !/\|\s*\[Ionicons 5\][^\r\n]*\|\s*\[MIT\][^\r\n]*\|\s*5\.5\.4\s*\|/u.test(
      readme,
    )
  ) {
    throw new Error(
      `react-icons@${packageVersion} does not bind io5 to audited Ionicons ${IONICONS_VERSION}`,
    );
  }
}

function finalizeComponent(
  draft: DraftComponent,
  materialByHash: Map<string, MaterialRecord>,
): ThirdPartyNoticeComponent {
  const materials = draft.legalInputs
    .map((input) => addMaterial(input, materialByHash))
    .sort((left, right) => {
      const sourceOrder = compareCanonical(left.sourcePath, right.sourcePath);
      return sourceOrder === 0
        ? compareCanonical(left.path, right.path)
        : sourceOrder;
    });
  return Object.freeze({
    ecosystem: draft.ecosystem,
    name: draft.name,
    version: draft.version,
    declaredLicense: draft.declaredLicense,
    selectedLicense: draft.selectedLicense,
    ...(draft.author === undefined ? {} : { author: draft.author }),
    ...(draft.repository === undefined ? {} : { repository: draft.repository }),
    materials: Object.freeze(materials),
  });
}

function addMaterial(
  input: LegalInput,
  materialByHash: Map<string, MaterialRecord>,
): ThirdPartyNoticeMaterialReference {
  assertLegalMaterial(input.bytes, input.sourcePath);
  const sha256 = hashBytes(input.bytes);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Internal invalid SHA-256 for ${input.sourcePath}`);
  }
  const materialPath = `${THIRD_PARTY_NOTICE_MATERIAL_DIRECTORY}/${sha256}.txt`;
  const existing = materialByHash.get(sha256);
  if (existing === undefined) {
    materialByHash.set(
      sha256,
      Object.freeze({
        path: materialPath,
        sha256,
        bytes: input.bytes.slice(),
      }),
    );
  } else if (!equalBytes(existing.bytes, input.bytes)) {
    throw new Error(`SHA-256 collision while adding ${input.sourcePath}`);
  }
  return Object.freeze({
    sourcePath: input.sourcePath,
    path: materialPath,
    sha256,
    bytes: input.bytes.byteLength,
  });
}

function renderNoticeIndex(
  components: readonly ThirdPartyNoticeComponent[],
  appInputs: readonly ThirdPartyNoticeMaterialReference[],
  materials: readonly MaterialRecord[],
  materialBundlePath?: string,
): string {
  const lines = [
    "# Third-party notices",
    "",
    "This deterministic index covers installed production npm dependencies,",
    "the exact package roots reported by `mops sources`, and the app-specific",
    "inputs listed below. Each linked material preserves the installed input bytes",
    "exactly; identical material is stored once by SHA-256.",
    "",
    "Remote services, downloaded models, and data absent from the package are not",
    "inferred by this index and require separate app-specific review.",
    "",
    "## Installed components",
    "",
  ];
  if (components.length === 0) lines.push("- None.");
  for (const component of components) {
    const selected =
      component.selectedLicense === component.declaredLicense
        ? ""
        : `; selected compatible branch ${JSON.stringify(component.selectedLicense)}`;
    const author =
      component.author === undefined
        ? ""
        : `; author ${JSON.stringify(component.author)}`;
    const repository =
      component.repository === undefined
        ? ""
        : `; repository ${JSON.stringify(component.repository)}`;
    const materialLinks = component.materials
      .map(
        (material) =>
          `[${material.sha256.slice(0, 12)}](${noticeRelativeLink(material.path)}) from ${JSON.stringify(material.sourcePath)}`,
      )
      .join(", ");
    lines.push(
      `- ${component.ecosystem} \`${component.name}@${component.version}\` — declared ${JSON.stringify(component.declaredLicense)}${selected}${author}${repository}; materials: ${materialLinks}`,
    );
  }

  lines.push("", "## App-specific notice inputs", "");
  if (appInputs.length === 0) lines.push("- None supplied.");
  for (const input of appInputs) {
    lines.push(
      `- ${JSON.stringify(input.sourcePath)} — [${input.sha256.slice(0, 12)}](${noticeRelativeLink(input.path)}), ${input.bytes} bytes`,
    );
  }

  lines.push("", "## Exact material inventory", "");
  for (const material of materials) {
    const location =
      materialBundlePath === undefined
        ? `[${material.sha256}](${noticeRelativeLink(material.path)})`
        : `\`${material.sha256}\` in [the exact-material bundle](${noticeRelativeLink(materialBundlePath)})`;
    lines.push(`- ${location} — ${material.bytes.byteLength} bytes`);
  }
  lines.push("");
  if (lines.length > MAX_INDEX_LINES) {
    throw new Error(
      `Third-party notice index has ${lines.length} lines; maximum is ${MAX_INDEX_LINES}`,
    );
  }
  return lines.join("\n");
}

function noticeRelativeLink(noticePath: string): string {
  const prefix = `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}`;
  if (!noticePath.startsWith(prefix)) {
    throw new Error(`Internal third-party notice path is outside ${prefix}`);
  }
  return noticePath.slice(prefix.length);
}

function compareDrafts(left: DraftComponent, right: DraftComponent): number {
  const ecosystem = compareCanonical(left.ecosystem, right.ecosystem);
  if (ecosystem !== 0) return ecosystem;
  const name = compareCanonical(left.name, right.name);
  if (name !== 0) return name;
  const version = compareCanonical(left.version, right.version);
  if (version !== 0) return version;
  return compareCanonical(
    left.legalInputs.map(({ sourcePath }) => sourcePath).join("\u0000"),
    right.legalInputs.map(({ sourcePath }) => sourcePath).join("\u0000"),
  );
}

function selectAuditedLicense(expression: string, component: string): string {
  const normalized = expression.trim().replace(/\s+/gu, " ");
  if (/^SEE LICENSE IN .+$/iu.test(normalized)) return normalized;
  const selected = AUDITED_LICENSE_EXPRESSIONS.get(normalized);
  if (selected === undefined) {
    throw new Error(
      `${component} declares unaudited license expression ${JSON.stringify(expression)}`,
    );
  }
  return selected;
}

function detectLlvmException(
  selectedLicense: string,
  inputs: readonly LegalInput[],
): string {
  if (selectedLicense !== "Apache-2.0") return selectedLicense;
  const hasException = inputs.some((input) =>
    fatalUtf8Decoder
      .decode(input.bytes)
      .includes("LLVM EXCEPTIONS TO THE APACHE 2.0 LICENSE"),
  );
  return hasException ? "Apache-2.0 WITH LLVM-exception" : selectedLicense;
}

function optionalMetadataFields(
  manifest: JsonObject,
  component: string,
): Readonly<{ author?: string; repository?: string }> {
  try {
    const author = formatAuthor(manifest.author);
    const repository = formatRepository(manifest.repository);
    return Object.freeze({
      ...(author === undefined ? {} : { author }),
      ...(repository === undefined ? {} : { repository }),
    });
  } catch (error) {
    throw new Error(`${component} has invalid package metadata: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function formatAuthor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return cleanOptionalMetadataText(value, "author");
  }
  if (!isObject(value)) throw new Error("package.json author must be text or an object");
  const fields = ["name", "email", "url"]
    .map((field) => {
      const item = value[field];
      if (item === undefined) return undefined;
      if (typeof item !== "string") {
        throw new Error(`package.json author.${field} must be text`);
      }
      return cleanOptionalMetadataText(item, `author.${field}`);
    })
    .filter((item): item is string => item !== undefined);
  return fields.length === 0 ? undefined : fields.join("; ");
}

function formatRepository(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return cleanOptionalMetadataText(value, "repository");
  }
  if (!isObject(value)) {
    throw new Error("package.json repository must be text or an object");
  }
  const url = value.url;
  if (typeof url !== "string") {
    throw new Error("package.json repository.url must be text");
  }
  return cleanOptionalMetadataText(url, "repository.url");
}

function cleanOptionalMetadataText(
  value: string,
  field: string,
): string | undefined {
  assertNoDangerousMetadataCharacters(value, field);
  if (value.trim().length === 0) return undefined;
  return cleanMetadataText(value, field);
}

function cleanMetadataText(value: string, field: string): string {
  assertNoDangerousMetadataCharacters(value, field);
  const cleaned = value.trim().replace(/\s+/gu, " ");
  if (
    cleaned.length === 0 ||
    cleaned.length > 2048
  ) {
    throw new Error(`Invalid ${field} metadata`);
  }
  return cleaned;
}

function assertNoDangerousMetadataCharacters(
  value: string,
  field: string,
): void {
  if (
    /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
      value,
    )
  ) {
    throw new Error(`Invalid ${field} metadata`);
  }
}

async function readJsonObject(filePath: string, label: string): Promise<JsonObject> {
  const bytes = await readBoundedRegularFile(
    filePath,
    label,
    MAX_PACKAGE_JSON_BYTES,
  );
  return parseJsonObjectBytes(bytes, label);
}

function parseJsonObjectBytes(bytes: Uint8Array, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${errorMessage(error)}`, { cause: error });
  }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

async function readBoundedRegularFile(
  filePath: string,
  label: string,
  maximumBytes = MAX_MATERIAL_BYTES,
  allowEmpty = false,
): Promise<Uint8Array> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (!allowEmpty && stats.size <= 0) {
      throw new Error(`${label} is empty: ${filePath}`);
    }
    if (stats.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes: ${filePath}`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stats.size) {
      throw new Error(`${label} changed while it was being read: ${filePath}`);
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
}

function assertLegalMaterial(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MATERIAL_BYTES) {
    throw new Error(`Invalid legal material size for ${label}`);
  }
  try {
    const text = fatalUtf8Decoder.decode(bytes);
    if (text.includes("\u0000")) throw new Error("contains NUL");
  } catch (error) {
    throw new Error(`Legal material is not valid UTF-8: ${label}`, { cause: error });
  }
}

function assertCanonicalApacheLicense(bytes: Uint8Array, filePath: string): void {
  const text = fatalUtf8Decoder.decode(bytes);
  if (
    !text.includes("Apache License") ||
    !text.includes("Version 2.0, January 2004") ||
    !text.includes("END OF TERMS AND CONDITIONS") ||
    text.includes("LLVM EXCEPTIONS TO THE APACHE 2.0 LICENSE")
  ) {
    throw new Error(`Not a canonical Apache-2.0 license text: ${filePath}`);
  }
}

function parseStringField(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string") throw new Error(`${source} ${field} must be text`);
  return cleanMetadataText(value, field);
}

function requiredString(
  object: JsonObject,
  field: string,
  source: string,
): string {
  return parseStringField(object[field], field, source);
}

function normalizeSafeRelativePath(input: string, label: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    path.isAbsolute(input) ||
    input.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw new Error(`${label} must be a safe relative POSIX path: ${input}`);
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== input
  ) {
    throw new Error(`${label} must be a normalized relative path: ${input}`);
  }
  return normalized;
}

function toPosixRelative(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes dependency root: ${target}`);
  }
  return relative.split(path.sep).join("/");
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid dependency package name: ${name}`);
  }
}

function assertMopsAlias(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 128 ||
    !/^[A-Za-z0-9._@~-]+$/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`Invalid Mops source alias: ${name}`);
  }
}

function assertWithin(root: string, target: string, label: string): void {
  if (!isWithin(root, target)) {
    throw new Error(`${label} escapes repository boundary: ${target}`);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function compareCanonical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
