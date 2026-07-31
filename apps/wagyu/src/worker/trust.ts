import { HttpAgent } from "@dfinity/agent";
import { loadNeutronCanisterId } from "neutron-tools/app";
import {
  KERNEL_RUNTIME_CONFIG_PATH,
  parseKernelRuntimeConfig,
} from "neutron-tools/src/runtime_config.js";
import { deriveNetworkId } from "../protocol/index.ts";
import type { WagyuWorkerTrustedConfigV1 } from "./types.ts";
import { readTrustedRuntimeConfigBytes } from "./trusted_runtime_response.ts";

/**
 * Loads the same kernel-authored runtime configuration used by the tile.
 * The background derives network_id from that root itself; no peer or caller
 * supplies a trust decision.
 */
export async function loadTrustedWorkerRuntime(
  storageMode: "memory" | "persistent-background" = "memory",
): Promise<WagyuWorkerTrustedConfigV1> {
  const configUrl = new URL(
    KERNEL_RUNTIME_CONFIG_PATH,
    globalThis.location.href,
  );
  const response = await fetch(configUrl.href, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (
    !response.ok ||
    response.redirected ||
    response.type === "opaque" ||
    response.type === "opaqueredirect"
  ) {
    throw new Error(
      `Trusted runtime configuration is unavailable (HTTP ${response.status})`,
    );
  }
  if (response.url !== configUrl.href) {
    throw new Error("Trusted runtime configuration changed origin");
  }
  const bytes = await readTrustedRuntimeConfigBytes(response);
  const config = parseKernelRuntimeConfig(bytes);
  const canisterId = await loadNeutronCanisterId();
  if (config.canister_id !== canisterId) {
    throw new Error("Trusted runtime configuration belongs to another Neutron");
  }
  // A dedicated local resident origin must not reach "inward" to bare
  // localhost: Chromium's Private Network Access policy blocks that request.
  // PocketIC serves its replica API on every gateway hostname, so the
  // resident's own certified origin is the equivalent same-gateway endpoint.
  const packageAssetOrigin = new URL(globalThis.location.href).origin;
  const agentHost =
    config.target === "pocketic"
      ? packageAssetOrigin
      : config.gateway;
  const agent = new HttpAgent({
    host: agentHost,
    shouldFetchRootKey: config.root_key_policy === "fetch",
    verifyQuerySignatures: config.root_key_policy !== "fetch",
  });
  if (config.root_key_policy === "fetch") await agent.fetchRootKey();
  if (!agent.rootKey || agent.rootKey.byteLength === 0) {
    throw new Error("The configured IC root key is unavailable");
  }
  const rootKey = agent.rootKey.slice();
  return {
    rootKey,
    networkId: deriveNetworkId(rootKey).slice(),
    gatewayOrigin:
      config.target === "ic" ? "https://icp0.io" : config.gateway,
    ...(config.target === "pocketic"
      ? {
          allowInsecureLocalhost: true,
          localAgentHost: packageAssetOrigin,
        }
      : {}),
    // PocketIC currently serves this background through an opaque sandbox
    // fallback rather than the manifest's persistent dedicated origin.
    // Opaque origins cannot open IndexedDB/CacheStorage, and these caches are
    // rebuildable rather than protocol authority, so local verification uses
    // the same bounded in-memory stores explicitly.
    storageMode: config.target === "pocketic" ? "memory" : storageMode,
  };
}
