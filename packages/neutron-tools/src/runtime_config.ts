import { Principal } from "@dfinity/principal";
import { scopedLocalIdentityProvider } from "./runtime.ts";

export const KERNEL_RUNTIME_CONFIG_PATH = "/system/runtime-config.json";
export const KERNEL_RUNTIME_CONFIG_FORMAT = 2;
export const IC_RUNTIME_GATEWAY = "https://icp-api.io";
export const IC_RUNTIME_IDENTITY_PROVIDER = "https://id.ai";
export const POCKETIC_RUNTIME_GATEWAY = "http://localhost:8000";
export const ISOLATED_FRAME_PREFIX_PLACEHOLDER = "{prefix}";

export type KernelRuntimeTarget = "ic" | "pocketic";
export type KernelRootKeyPolicy = "mainnet" | "fetch";

export type KernelRuntimeConfig = Readonly<{
  format: typeof KERNEL_RUNTIME_CONFIG_FORMAT;
  target: KernelRuntimeTarget;
  gateway: string;
  identity_provider: string;
  canister_id: string;
  deployment_id: string;
  root_key_policy: KernelRootKeyPolicy;
  allow_loopback_http: boolean;
  isolated_frame_origin_template: string;
  update_source_origin: string | null;
}>;

export type KernelRuntimeConfigInput = Omit<KernelRuntimeConfig, "format">;

export function createKernelRuntimeConfig(
  input: KernelRuntimeConfigInput,
): KernelRuntimeConfig {
  return validateKernelRuntimeConfig({
    format: KERNEL_RUNTIME_CONFIG_FORMAT,
    ...input,
  });
}

export function encodeKernelRuntimeConfig(
  config: KernelRuntimeConfig,
): Uint8Array {
  const validated = validateKernelRuntimeConfig(config);
  return new TextEncoder().encode(JSON.stringify(validated));
}

export function parseKernelRuntimeConfig(
  input: string | Uint8Array,
): KernelRuntimeConfig {
  let value: unknown;
  try {
    const text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("Kernel runtime config must be valid UTF-8 JSON", { cause });
  }
  return validateKernelRuntimeConfig(value);
}

function validateKernelRuntimeConfig(value: unknown): KernelRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error("Kernel runtime config must be an object");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "allow_loopback_http",
    "canister_id",
    "deployment_id",
    "format",
    "gateway",
    "identity_provider",
    "isolated_frame_origin_template",
    "root_key_policy",
    "target",
    "update_source_origin",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Kernel runtime config has unknown or missing fields");
  }
  if (value.format !== KERNEL_RUNTIME_CONFIG_FORMAT) {
    throw new Error(
      `Unsupported Kernel runtime config format ${String(value.format)}`,
    );
  }
  assertKernelRuntimeTarget(value.target);
  if (
    typeof value.canister_id !== "string" ||
    !isCanisterIdLike(value.canister_id)
  ) {
    throw new Error("Kernel runtime config has an invalid canister id");
  }
  if (
    typeof value.deployment_id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.deployment_id)
  ) {
    throw new Error("Kernel runtime config has an invalid deployment id");
  }
  if (typeof value.gateway !== "string") {
    throw new Error("Kernel runtime config has an invalid gateway");
  }
  if (typeof value.identity_provider !== "string") {
    throw new Error("Kernel runtime config has an invalid identity provider");
  }
  if (
    value.root_key_policy !== "mainnet" &&
    value.root_key_policy !== "fetch"
  ) {
    throw new Error("Kernel runtime config has an invalid root-key policy");
  }
  if (typeof value.allow_loopback_http !== "boolean") {
    throw new Error("Kernel runtime config has an invalid loopback policy");
  }
  if (typeof value.isolated_frame_origin_template !== "string") {
    throw new Error(
      "Kernel runtime config has an invalid frame-origin template",
    );
  }
  if (
    value.update_source_origin !== null &&
    typeof value.update_source_origin !== "string"
  ) {
    throw new Error("Kernel runtime config has an invalid update-source origin");
  }

  const expectedFrameOriginTemplate = isolatedFrameOriginTemplate(
    value.target,
    value.canister_id,
  );
  if (value.isolated_frame_origin_template !== expectedFrameOriginTemplate) {
    throw new Error(
      "Kernel runtime config has an inconsistent frame-origin policy",
    );
  }

  if (value.target === "ic") {
    if (
      value.gateway !== IC_RUNTIME_GATEWAY ||
      value.identity_provider !== IC_RUNTIME_IDENTITY_PROVIDER ||
      value.root_key_policy !== "mainnet" ||
      value.allow_loopback_http ||
      !isExactUpdateSourceOrigin(value.update_source_origin, "ic")
    ) {
      throw new Error("IC runtime config has inconsistent network policy");
    }
  } else {
    const identityProvider = scopedLocalIdentityProvider({
      neutronCanisterId: value.canister_id,
      localHost: POCKETIC_RUNTIME_GATEWAY,
    });
    if (
      value.gateway !== POCKETIC_RUNTIME_GATEWAY ||
      value.identity_provider !== identityProvider ||
      value.root_key_policy !== "fetch" ||
      !value.allow_loopback_http ||
      value.update_source_origin === null ||
      !isExactUpdateSourceOrigin(value.update_source_origin, "pocketic")
    ) {
      throw new Error("PocketIC runtime config has inconsistent network policy");
    }
  }

  return Object.freeze({
    format: KERNEL_RUNTIME_CONFIG_FORMAT,
    target: value.target,
    gateway: value.gateway,
    identity_provider: value.identity_provider,
    canister_id: value.canister_id,
    deployment_id: value.deployment_id,
    root_key_policy: value.root_key_policy,
    allow_loopback_http: value.allow_loopback_http,
    isolated_frame_origin_template: value.isolated_frame_origin_template,
    update_source_origin: value.update_source_origin,
  });
}

export function isolatedFrameOriginTemplate(
  target: KernelRuntimeTarget,
  canisterId: string,
): string {
  assertKernelRuntimeTarget(target);
  if (!isCanisterIdLike(canisterId)) {
    throw new Error("Kernel runtime frame policy has an invalid canister id");
  }
  return target === "ic"
    ? `https://${ISOLATED_FRAME_PREFIX_PLACEHOLDER}--${canisterId}.icp0.io`
    : `http://${ISOLATED_FRAME_PREFIX_PLACEHOLDER}--${canisterId}.localhost:8000`;
}

export function runtimeUpdateSourceOrigin(
  target: KernelRuntimeTarget,
  canisterId: string,
): string {
  assertKernelRuntimeTarget(target);
  if (!isCanisterIdLike(canisterId)) {
    throw new Error("Kernel runtime update source has an invalid canister id");
  }
  return target === "ic"
    ? `https://${canisterId}.icp0.io`
    : `http://${canisterId}.localhost:8000`;
}

function isExactUpdateSourceOrigin(
  origin: string | null,
  target: KernelRuntimeTarget,
): boolean {
  if (origin === null) return target === "ic";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.href !== `${url.origin}/`) return false;
  const canisterId = url.hostname.split(".", 1)[0] ?? "";
  return (
    isCanisterIdLike(canisterId) &&
    origin === runtimeUpdateSourceOrigin(target, canisterId)
  );
}

function isCanisterIdLike(value: string): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-cai$/u.test(value)) return false;
  try {
    return Principal.fromText(value).toText() === value;
  } catch {
    return false;
  }
}

function assertKernelRuntimeTarget(
  value: unknown,
): asserts value is KernelRuntimeTarget {
  if (value !== "ic" && value !== "pocketic") {
    throw new Error("Kernel runtime config target must be 'ic' or 'pocketic'");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
