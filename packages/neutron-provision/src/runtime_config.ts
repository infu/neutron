import { applyRuntimeDeploymentConfig } from "neutron-compiler/src/install.js";
import {
  createKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
  type KernelRuntimeConfig,
} from "neutron-tools/src/runtime_config.js";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import type { PreparedDeployment } from "./artifact.ts";

/** Bind target-neutral Kernel assets after the final canister ID is known. */
export function bindDeploymentRuntimeConfig({
  deployment,
  canisterId,
  target,
  updateSourceCanisterId,
}: {
  deployment: PreparedDeployment;
  canisterId: string;
  target: "ic" | "pocketic";
  updateSourceCanisterId?: string;
}): KernelRuntimeConfig {
  const config = deploymentRuntimeConfig({
    deployment,
    canisterId,
    target,
    ...(updateSourceCanisterId === undefined ? {} : { updateSourceCanisterId }),
  });
  applyRuntimeDeploymentConfig(deployment.packages, config);
  return config;
}

export function deploymentRuntimeConfig({
  deployment,
  canisterId,
  target,
  updateSourceCanisterId,
}: {
  deployment: PreparedDeployment;
  canisterId: string;
  target: "ic" | "pocketic";
  updateSourceCanisterId?: string;
}): KernelRuntimeConfig {
  if (target === "pocketic" && updateSourceCanisterId === undefined) {
    throw new Error(
      "PocketIC runtime binding requires the provision-owned update source",
    );
  }
  const frameOriginTemplate = isolatedFrameOriginTemplate(target, canisterId);
  const updateSourceOrigin =
    updateSourceCanisterId === undefined
      ? null
      : runtimeUpdateSourceOrigin(target, updateSourceCanisterId);
  const isIc = target === "ic";
  return createKernelRuntimeConfig({
    target,
    gateway: isIc ? IC_RUNTIME_GATEWAY : POCKETIC_RUNTIME_GATEWAY,
    identity_provider: isIc
      ? IC_RUNTIME_IDENTITY_PROVIDER
      : scopedLocalIdentityProvider({
          neutronCanisterId: canisterId,
          localHost: POCKETIC_RUNTIME_GATEWAY,
        }),
    canister_id: canisterId,
    deployment_id: deployment.compiled.deploymentId,
    root_key_policy: isIc ? "mainnet" : "fetch",
    allow_loopback_http: !isIc,
    isolated_frame_origin_template: frameOriginTemplate,
    update_source_origin: updateSourceOrigin,
  });
}
