import {
  appRegistryEntry,
  type AppRegistryEntry,
  type KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import type {
  NeutronManifest,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";
import { residentFrameSecurityMode } from "../src/capabilities/plan.ts";

type RegistryManifestInput = Omit<
  NeutronManifest,
  "format" | "id" | "name" | "version" | "entry" | "src"
> & {
  id: string;
  name?: string;
  version?: number;
};

export function registryApp({
  id,
  name = id,
  version = 100,
  ...manifest
}: RegistryManifestInput): AppRegistryEntry {
  return appRegistryEntry({
    format: 3,
    id,
    name: displayName(name),
    version,
    entry: "0".repeat(64),
    ...manifest,
  } satisfies PackagedNeutronManifest);
}

export function runtimeApp({
  id,
  entry,
  version = BigInt(entry.version),
  deploymentId = "deployment",
  installationUid = 1n,
}: {
  id: string;
  entry: AppRegistryEntry;
  version?: bigint | number;
  deploymentId?: string;
  installationUid?: bigint | number;
}): KernelRuntimeInfo["apps"][number] {
  const nonce = BigInt(installationUid).toString(16).padStart(32, "0");
  return {
    scope: { app_id: id, installation_uid: installationUid },
    version,
    deployment_id: deploymentId,
    capability_plan_fingerprint: entry.capability_plan_fingerprint,
    browser_origin_nonce: nonce,
    browser_origin_authority_epoch: 1n,
    resident_frame_security: candidResidentFrameSecurity(
      residentFrameSecurityMode(entry),
    ),
  };
}

function candidResidentFrameSecurity(
  mode: ReturnType<typeof residentFrameSecurityMode>,
): KernelRuntimeInfo["apps"][number]["resident_frame_security"] {
  switch (mode) {
    case "credentialless_opaque_v1":
      return { credentialless_opaque_v1: null };
    case "credentialless_ephemeral_dedicated_v1":
      return { credentialless_ephemeral_dedicated_v1: null };
    case "persistent_dedicated_v1":
      return { persistent_dedicated_v1: null };
  }
}

function displayName(value: string): string {
  const normalized = value
    .replaceAll("_", " ")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim();
  return (normalized.length >= 3 ? normalized : `${normalized} App`).slice(
    0,
    20,
  );
}
