import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".mjs",
  ".mo",
  ".ts",
  ".tsx",
]);
const IGNORED_DIRECTORIES = new Set([
  ".icp",
  ".mops",
  "assets",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "public",
  "test",
  "tests",
]);
const IGNORED_FILES = new Set([
  "_neutron.mo",
  // Generated compiler payloads are inspected and pinned by
  // neutron-motoko-wasm. Scanning their minified bytes would neither inspect
  // authored Core policy nor produce actionable source locations.
  "moc.wasm.cjs",
  "moc.wasm.js",
]);
const REMOVED_CORE_PREFIXES = ["files_", "public_candid_", "wagyu_"] as const;
const REMOVED_CORE_VOCABULARY = [
  "FilesObject",
  "FilesPresentation",
  "InitializingCertifiedAssetsV2",
  "WagyuObject",
  "commitLegacyDeployment",
  "create_required_singleton",
  "finalizeLegacyInstallReservations",
  "kernel_certified_assets_bootstrap_files_namespace",
  "kernel_install_commit_checked",
  "legacySelfCallBinaryAudit",
  "neutralizeLegacyUntrustedText",
  "neutron_actor_v24",
  "requireCheckedCommit",
  "wagyu.network-id.v1",
] as const;

type OrdinaryApp = {
  directory: string;
  displayName?: string;
  id: string;
  methods: string[];
  packageName?: string;
};

type CoreAppPolicy = {
  appPathOwners: ReadonlyMap<string, readonly string[]>;
  appPathPattern: RegExp | null;
  archivePattern: RegExp | null;
  bareMethodPattern: RegExp | null;
  identities: ReadonlySet<string>;
  methods: ReadonlySet<string>;
  packagePattern: RegExp | null;
  physicalPattern: RegExp | null;
  removedPattern: RegExp;
};

export type CoreAppAgnosticIssue = {
  file: string;
  line: number;
  rule:
    | "app_identity_branch"
    | "app_import"
    | "app_method"
    | "kernel_sdk_boundary"
    | "removed_vocabulary";
  value: string;
};

// `agent` is both an ordinary app id and one closed Kernel delegation role.
// Only the exact `kind: "agent"` discriminator in these reviewed files is
// exempt. Any other use of that literal, including another field in one of
// these files, remains an error.
const KERNEL_AGENT_ROLE_FILES = new Set([
  "apps/kernel/src/expose.ts",
  "apps/kernel/src/AppDialogs.tsx",
  "apps/kernel/src/install_offers/InstallOfferDialog.tsx",
  "apps/kernel/src/install_offers/service.ts",
  "apps/kernel/src/install_offers/types.ts",
  "apps/kernel/src/repository/RepositorySetupDialog.tsx",
]);
const KERNEL_GENERIC_FILES_TYPE_PROPERTY_FILES = new Set([
  "apps/kernel/src/tools/app.ts",
]);
// `files_sha256` is the digest of the complete generic starter asset set, not
// a reference to the former Files app. Keep the exception tied to the three
// reviewed Dispenser wire/verification surfaces so the removed `files_`
// vocabulary remains forbidden everywhere else.
const DISPENSER_GENERIC_FILES_DIGEST_FILES = new Set([
  "support/dispenser/mo/main.mo",
  "support/dispenser/production_deploy.ts",
  "support/dispenser/starter_payload.ts",
]);

export async function checkCoreAppAgnostic(
  workspaceRoot = path.resolve(import.meta.dir, "../../.."),
): Promise<CoreAppAgnosticIssue[]> {
  const apps = await loadOrdinaryApps(workspaceRoot);
  const policy = compileCoreAppPolicy(apps);
  const files = await coreProductionFiles(workspaceRoot);
  const issues: CoreAppAgnosticIssue[] = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const inspectedSource = stripCommentsPreservingOffsets(source);
    const relative = normalizePath(path.relative(workspaceRoot, file));
    collectAppImports(
      issues,
      relative,
      file,
      inspectedSource,
      workspaceRoot,
      apps,
    );
    collectPolicyMatches(issues, relative, inspectedSource, policy);
  }

  const unique = new Map<string, CoreAppAgnosticIssue>();
  for (const issue of issues) {
    unique.set(
      `${issue.file}\u0000${issue.line}\u0000${issue.rule}\u0000${issue.value}`,
      issue,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule) ||
      left.value.localeCompare(right.value),
  );
}

function compileCoreAppPolicy(apps: readonly OrdinaryApp[]): CoreAppPolicy {
  const identities = new Set<string>();
  const methods = new Set<string>();
  const appPathOwners = new Map<string, Set<string>>();
  const packageNames = new Set<string>();
  const physicalPrefixes = new Set<string>();

  for (const app of apps) {
    identities.add(app.id);
    identities.add(app.directory);
    if (app.displayName !== undefined) identities.add(app.displayName);
    for (const method of app.methods) methods.add(method);
    for (const reference of new Set([app.id, app.directory])) {
      const owners = appPathOwners.get(reference) ?? new Set<string>();
      owners.add(`apps/${app.directory}`);
      appPathOwners.set(reference, owners);
    }
    if (app.packageName !== undefined) packageNames.add(app.packageName);
    physicalPrefixes.add(`app_${app.id}__`);
    physicalPrefixes.add(`a${app.id.length}_${app.id}`);
  }

  const appReferences = [...appPathOwners.keys()];
  const distinctiveMethods = [...methods].filter(conservativeBareMethod);
  const removedAlternation = alternation(
    [
      ...REMOVED_CORE_VOCABULARY.map(escapeRegExp),
      ...REMOVED_CORE_PREFIXES.map(
        (prefix) => `${escapeRegExp(prefix)}[A-Za-z0-9_]*`,
      ),
    ],
    false,
  );

  return {
    appPathOwners: new Map(
      [...appPathOwners].map(([key, owners]) => [key, [...owners].sort()]),
    ),
    appPathPattern: optionalPattern(
      appReferences,
      String.raw`(?<![A-Za-z0-9_-])apps[\\/]+(`,
      String.raw`)(?=$|[\\/"'\x60])`,
      "gm",
    ),
    archivePattern: optionalPattern(
      appReferences,
      String.raw`(?<![A-Za-z0-9_-])(`,
      String.raw`\.v[0-9]+(?:\.[0-9]+){0,3}\.neutron)\b`,
      "gm",
    ),
    bareMethodPattern: optionalPattern(
      distinctiveMethods,
      String.raw`(?:\.\s*|\b(?:func|function)\s+|(?:^|[,{;]\s*))(`,
      String.raw`)\b(?:\s*:)?`,
      "gm",
    ),
    identities,
    methods,
    packagePattern: optionalPattern(
      [...packageNames],
      String.raw`(?<![A-Za-z0-9_-])(`,
      String.raw`)(?=$|[^A-Za-z0-9_-])`,
      "gm",
    ),
    physicalPattern: optionalPattern([...physicalPrefixes], "(", ")", "g"),
    removedPattern: new RegExp(String.raw`\b(${removedAlternation})`, "g"),
  };
}

function collectPolicyMatches(
  issues: CoreAppAgnosticIssue[],
  file: string,
  source: string,
  policy: CoreAppPolicy,
): void {
  for (const match of source.matchAll(QUOTED_LITERAL_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value === undefined) continue;
    const offset = match.index ?? 0;
    if (policy.identities.has(value)) {
      if (
        value === "agent" &&
        allowedKernelAgentRoleLiteral(file, source, offset, match[0].length)
      ) {
        continue;
      }
      if (
        value === "files" &&
        allowedGenericFilesTypeProperty(file, source, offset)
      ) {
        continue;
      }
      pushMatch(issues, file, source, offset, "app_identity_branch", value);
    }
    if (policy.methods.has(value)) {
      pushMatch(issues, file, source, offset, "app_method", value);
    }
  }

  if (policy.appPathPattern !== null) {
    for (const match of source.matchAll(policy.appPathPattern)) {
      const reference = match[1]!;
      for (const owner of policy.appPathOwners.get(reference) ?? []) {
        pushMatch(issues, file, source, match.index ?? 0, "app_import", owner);
      }
    }
  }
  collectCapturedMatches(
    issues,
    file,
    source,
    "app_import",
    policy.archivePattern,
  );
  collectCapturedMatches(
    issues,
    file,
    source,
    "app_import",
    policy.packagePattern,
  );
  collectCapturedMatches(
    issues,
    file,
    source,
    "app_method",
    policy.physicalPattern,
  );
  collectCapturedMatches(
    issues,
    file,
    source,
    "app_method",
    policy.bareMethodPattern,
  );
  for (const match of source.matchAll(policy.removedPattern)) {
    if (
      match[1] === "files_sha256" &&
      DISPENSER_GENERIC_FILES_DIGEST_FILES.has(file)
    ) {
      continue;
    }
    pushMatch(
      issues,
      file,
      source,
      match.index ?? 0,
      "removed_vocabulary",
      match[1]!,
    );
  }
}

const QUOTED_LITERAL_PATTERN =
  /"([^"\\\r\n]*(?:\\.[^"\\\r\n]*)*)"|'([^'\\\r\n]*(?:\\.[^'\\\r\n]*)*)'|`([^`\\$]*(?:\\.[^`\\$]*)*)`/g;

function collectCapturedMatches(
  issues: CoreAppAgnosticIssue[],
  file: string,
  source: string,
  rule: CoreAppAgnosticIssue["rule"],
  pattern: RegExp | null,
): void {
  if (pattern === null) return;
  for (const match of source.matchAll(pattern)) {
    pushMatch(issues, file, source, match.index ?? 0, rule, match[1]!);
  }
}

function optionalPattern(
  values: readonly string[],
  prefix: string,
  suffix: string,
  flags: string,
): RegExp | null {
  if (values.length === 0) return null;
  return new RegExp(`${prefix}(?:${alternation(values)})${suffix}`, flags);
}

function alternation(values: readonly string[], escape = true): string {
  return [...new Set(values)]
    .sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    )
    .map((value) => (escape ? escapeRegExp(value) : value))
    .join("|");
}

function allowedKernelAgentRoleLiteral(
  file: string,
  source: string,
  offset: number,
  length: number,
): boolean {
  if (!KERNEL_AGENT_ROLE_FILES.has(file)) return false;
  const before = source.slice(Math.max(0, offset - 96), offset);
  const after = source.slice(offset + length, offset + length + 96);
  return (
    /(?:^|[^$\w])kind\s*(?::|===|!==|==|!=)\s*$/u.test(before) ||
    /^\s*(?:===|!==|==|!=)\s*[$A-Za-z_][$\w]*(?:\s*\.\s*[$A-Za-z_][$\w]*)*\.kind\b/u.test(
      after,
    )
  );
}

function allowedGenericFilesTypeProperty(
  file: string,
  source: string,
  offset: number,
): boolean {
  if (!KERNEL_GENERIC_FILES_TYPE_PROPERTY_FILES.has(file)) return false;
  const before = source.slice(Math.max(0, offset - 96), offset);
  return /\b[A-Z][$\w]*(?:\s*<[^>\r\n]*>)?\s*\[\s*$/u.test(before);
}

function conservativeBareMethod(method: string): boolean {
  // Very short app methods such as `add` and `echo` are ordinary programming
  // vocabulary. Their exact quoted/template literals remain checked, while a
  // bare-property finding is reserved for distinctive private method names.
  return method.length >= 8 && method.includes("_");
}

function collectAppImports(
  issues: CoreAppAgnosticIssue[],
  relativeFile: string,
  absoluteFile: string,
  source: string,
  workspaceRoot: string,
  apps: readonly OrdinaryApp[],
): void {
  const imports =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\s*\.\s*resolve)?\s*\(\s*|\bimport\s+(?:type\s+)?(?:[$A-Za-z_][$\w]*\s+)?)(["'\x60])([^"'`\r\n]+)\1/g;
  for (const match of source.matchAll(imports)) {
    const specifier = match[2]!;
    if (
      relativeFile.startsWith("apps/kernel/") &&
      (specifier === "neutron-tools" ||
        /^neutron-tools\/app(?:_entry)?(?:\.(?:js|ts))?$/u.test(specifier))
    ) {
      issues.push({
        file: relativeFile,
        line: 1 + countNewlines(source, match.index ?? 0),
        rule: "kernel_sdk_boundary",
        value: specifier,
      });
    }
    const resolved = specifier.startsWith(".")
      ? path.resolve(path.dirname(absoluteFile), specifier)
      : path.resolve(workspaceRoot, specifier);
    for (const app of apps) {
      const appRoot = path.resolve(workspaceRoot, "apps", app.directory);
      if (
        resolved !== appRoot &&
        !resolved.startsWith(`${appRoot}${path.sep}`)
      ) {
        continue;
      }
      issues.push({
        file: relativeFile,
        line: 1 + countNewlines(source, match.index ?? 0),
        rule: "app_import",
        value: `apps/${app.directory}`,
      });
    }
  }
}

async function loadOrdinaryApps(workspaceRoot: string): Promise<OrdinaryApp[]> {
  const appsRoot = path.join(workspaceRoot, "apps");
  const directories = await fs.readdir(appsRoot, { withFileTypes: true });
  const apps: OrdinaryApp[] = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(appsRoot, entry.name, "neutron.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    if (!isRecord(manifest) || typeof manifest.id !== "string") continue;
    if (manifest.id === "kernel") continue;
    const methods = isRecord(manifest.func)
      ? Object.keys(manifest.func).filter((method) => method.length > 0)
      : [];
    const packageName = await loadPackageName(
      path.join(appsRoot, entry.name, "package.json"),
    );
    apps.push({
      directory: entry.name,
      ...(typeof manifest.name === "string"
        ? { displayName: manifest.name }
        : {}),
      id: manifest.id,
      methods,
      ...(packageName === undefined ? {} : { packageName }),
    });
  }
  return apps.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadPackageName(filename: string): Promise<string | undefined> {
  try {
    const packageJson: unknown = JSON.parse(
      await fs.readFile(filename, "utf8"),
    );
    return isRecord(packageJson) && typeof packageJson.name === "string"
      ? packageJson.name
      : undefined;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function coreProductionFiles(workspaceRoot: string): Promise<string[]> {
  const roots = [
    "apps/kernel",
    "packages/neutron-cli",
    "packages/neutron-compiler",
    "packages/neutron-motoko-capabilities/src",
    "packages/neutron-motoko-wasm/scripts",
    "packages/neutron-motoko-wasm/src",
    "packages/neutron-provision/src",
    "packages/neutron-scripts",
    "packages/neutron-tools/src",
    "support/dispenser",
    "support/update-source",
  ];
  const files = await Promise.all(
    roots.map((root) => walk(path.join(workspaceRoot, root))),
  );
  const individualFiles = [
    "packages/neutron-motoko-wasm/compiler-service.cjs",
    "packages/neutron-motoko-wasm/compiler/compiler-worker.js",
  ];
  for (const relative of individualFiles) {
    const file = path.join(workspaceRoot, relative);
    try {
      await fs.access(file);
      files.push([file]);
    } catch {
      // A fixture workspace need not contain every production file.
    }
  }
  return [...new Set(files.flat())].sort();
}

async function walk(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await walk(path.join(root, entry.name))));
      }
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !IGNORED_FILES.has(entry.name) &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.")
    ) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

function pushMatch(
  issues: CoreAppAgnosticIssue[],
  file: string,
  source: string,
  offset: number,
  rule: CoreAppAgnosticIssue["rule"],
  value: string,
): void {
  issues.push({
    file,
    line: 1 + countNewlines(source, offset),
    rule,
    value,
  });
}

/**
 * Remove line and nested block comments without changing offsets or line
 * numbers. String and template contents remain available to the literal
 * checks. This is intentionally a small lexical pass, not a language parser.
 */
function stripCommentsPreservingOffsets(source: string): string {
  // `split("")` deliberately preserves UTF-16 code-unit indexing, matching
  // String.length, RegExp match offsets, and the line-number calculation.
  const output = source.split("");
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let blockDepth = 0;
  let lineComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
      } else {
        output[index] = " ";
      }
      continue;
    }

    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        blockDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        blockDepth -= 1;
        index += 1;
      } else if (char !== "\n" && char !== "\r") {
        output[index] = " ";
      }
      continue;
    }

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      blockDepth = 1;
      index += 1;
    }
  }

  return output.join("");
}

function countNewlines(value: string, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
