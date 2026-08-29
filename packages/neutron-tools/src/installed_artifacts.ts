import { APP_ID_MAX_LENGTH } from "./app_ids.ts";
import { compareCanonicalText } from "./canonical.ts";
import { hashContent } from "./hash.ts";
import { assertAppVersion } from "./version.ts";

export const KERNEL_INSTALLED_ARTIFACT_INVENTORY_FORMAT = 1 as const;
export const KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH =
  "installed-artifacts.v1.json" as const;
export const KERNEL_INSTALLED_ARTIFACT_INVENTORY_PATH =
  `/pkg/${KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH}` as const;
export const KERNEL_INSTALLED_ARTIFACT_RUNTIME_PATHS = Object.freeze([
  "/pkg/neutron.did",
  "/pkg/neutron.most",
] as const);
export const INSTALLED_ARTIFACT_PATH_BYTES_MAX =
  4_096 + "/app//".length + APP_ID_MAX_LENGTH;

export function kernelInstalledArtifactPath(packagePath: string): string {
  assertSafeRelativePath(packagePath, "Kernel package artifact path");
  if (packagePath === "web/index.html") return "/";
  return packagePath.startsWith("web/")
    ? `/${packagePath.slice("web/".length)}`
    : `/pkg/${packagePath}`;
}

export function kernelPackagePathIsInventoried(packagePath: string): boolean {
  return (
    packagePath !== KERNEL_INSTALLED_ARTIFACT_INVENTORY_PACKAGE_PATH &&
    packagePath !== "neutron.did" &&
    packagePath !== "mo" &&
    !packagePath.startsWith("mo/")
  );
}

export function kernelPackagePathRequiresInlineText(
  packagePath: string,
): boolean {
  assertSafeRelativePath(packagePath, "Kernel package artifact path");
  return packagePath === "web/system" || packagePath.startsWith("web/system/");
}

const MAX_FILES = 4_096;
const MAX_PACKAGE_PATH_BYTES = 4_096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const textEncoder = new TextEncoder();

export type KernelInstalledArtifactInventoryFile = Readonly<{
  package_path: string;
  bytes: number;
  sha256: string;
  inline_text?: string;
}>;

export type KernelInstalledArtifactInventory = Readonly<{
  format: typeof KERNEL_INSTALLED_ARTIFACT_INVENTORY_FORMAT;
  package: Readonly<{ id: "kernel"; version: number }>;
  artifacts: readonly KernelInstalledArtifactInventoryFile[];
}>;

export function createKernelInstalledArtifactInventory(
  input: Readonly<{
    version: number;
    artifacts: readonly KernelInstalledArtifactInventoryFile[];
  }>,
): KernelInstalledArtifactInventory {
  return parseKernelInstalledArtifactInventory({
    format: KERNEL_INSTALLED_ARTIFACT_INVENTORY_FORMAT,
    package: { id: "kernel", version: input.version },
    artifacts: input.artifacts,
  });
}

export function parseKernelInstalledArtifactInventory(
  value: unknown,
): KernelInstalledArtifactInventory {
  const record = exactRecord(value, ["format", "package", "artifacts"]);
  if (record.format !== KERNEL_INSTALLED_ARTIFACT_INVENTORY_FORMAT) {
    throw new Error("Unsupported Kernel installed-artifact inventory format");
  }
  const packageIdentity = exactRecord(record.package, ["id", "version"]);
  if (packageIdentity.id !== "kernel") {
    throw new Error("Installed-artifact inventory is not for the Kernel");
  }
  assertAppVersion(
    packageIdentity.version,
    "Kernel installed-artifact inventory version",
  );

  if (!Array.isArray(record.artifacts) || record.artifacts.length > MAX_FILES) {
    throw new Error("Kernel installed-artifact inventory file list is invalid");
  }
  const artifacts = record.artifacts.map((value, index) => {
    const file = exactRecord(
      value,
      ["package_path", "bytes", "sha256"],
      ["inline_text"],
    );
    const label = `Kernel installed-artifact inventory files[${index}]`;
    assertSafeRelativePath(file.package_path, `${label}.package_path`);
    if (
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > MAX_FILE_BYTES
    ) {
      throw new Error(`${label}.bytes is invalid`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error(`${label}.sha256 is invalid`);
    }
    const requiresInlineText = kernelPackagePathRequiresInlineText(
      file.package_path,
    );
    if ((file.inline_text !== undefined) !== requiresInlineText) {
      throw new Error(`${label}.inline_text is invalid`);
    }
    if (file.inline_text !== undefined) {
      if (typeof file.inline_text !== "string") {
        throw new Error(`${label}.inline_text is invalid`);
      }
      const content = textEncoder.encode(file.inline_text);
      if (
        content.byteLength > MAX_INLINE_TEXT_BYTES ||
        content.byteLength !== Number(file.bytes) ||
        hashContent(content) !== file.sha256
      ) {
        throw new Error(`${label}.inline_text does not match the artifact`);
      }
    }
    return Object.freeze({
      package_path: file.package_path,
      bytes: Number(file.bytes),
      sha256: file.sha256,
      ...(file.inline_text === undefined
        ? {}
        : { inline_text: file.inline_text }),
    });
  });
  assertCanonicalOrder(
    artifacts.map(({ package_path }) => package_path),
    "Kernel installed-artifact inventory files",
  );

  return Object.freeze({
    format: KERNEL_INSTALLED_ARTIFACT_INVENTORY_FORMAT,
    package: Object.freeze({
      id: "kernel" as const,
      version: Number(packageIdentity.version),
    }),
    artifacts: Object.freeze(artifacts),
  });
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kernel installed-artifact inventory has an invalid shape");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort(compareCanonicalText);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    actualKeys.some((key) => !allowed.has(key))
  ) {
    throw new Error("Kernel installed-artifact inventory has unknown fields");
  }
  return record;
}

function assertSafeRelativePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  assertPathBytes(value, MAX_PACKAGE_PATH_BYTES, label);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is unsafe`);
  }
}

function assertPathBytes(
  value: string,
  maximumBytes: number,
  label: string,
): void {
  if (textEncoder.encode(value).byteLength > maximumBytes) {
    throw new Error(`${label} is too long`);
  }
}

function assertCanonicalOrder(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCanonicalText(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} are not unique and canonically ordered`);
    }
  }
}
