import { canisterIdFromUrl } from "neutron-tools/src/runtime.js";
import {
  ISOLATED_FRAME_PREFIX_PLACEHOLDER,
  KERNEL_RUNTIME_CONFIG_PATH,
  parseKernelRuntimeConfig,
  type KernelRootKeyPolicy,
  type KernelRuntimeConfig,
  type KernelRuntimeTarget,
} from "neutron-tools/src/runtime_config.js";

const MAX_RUNTIME_CONFIG_BYTES = 4_096;

export type RuntimeDeployment = Readonly<{
  target: KernelRuntimeTarget;
  canisterId: string;
  deploymentId: string;
  gateway: string;
  identityProvider: string;
  rootKeyPolicy: KernelRootKeyPolicy;
  allowLoopbackHttp: boolean;
  isolatedFrameOriginTemplate: string;
  updateSourceOrigin: string | null;
  local: boolean;
  localHost?: string;
}>;

let activeDeployment: RuntimeDeployment | null = null;

export async function loadRuntimeDeployment(
  fetchImpl: typeof fetch = globalThis.fetch,
  href = globalThis.location?.href ?? "",
): Promise<RuntimeDeployment> {
  const pageUrl = new URL(href);
  const configUrl = new URL(KERNEL_RUNTIME_CONFIG_PATH, pageUrl);
  const response = await fetchImpl(configUrl.href, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok || response.redirected) {
    throw new Error(
      `Kernel runtime config could not be loaded (HTTP ${response.status})`,
    );
  }
  if (response.url && response.url !== configUrl.href) {
    throw new Error("Kernel runtime config came from a different URL");
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Kernel runtime config has the wrong content type");
  }
  assertGatewayCertificationV2(response);
  const bytes = await readBoundedBody(response, MAX_RUNTIME_CONFIG_BYTES);
  const config = parseKernelRuntimeConfig(bytes);
  const resolved = resolveRuntimeDeployment(config, pageUrl);
  activeDeployment = resolved;
  return resolved;
}

export function getRuntimeDeployment(): RuntimeDeployment {
  if (!activeDeployment) {
    throw new Error("Kernel runtime deployment has not been loaded");
  }
  return activeDeployment;
}

export function resolveRuntimeDeployment(
  config: KernelRuntimeConfig,
  href: string | URL,
): RuntimeDeployment {
  const url = new URL(href);
  const canisterId = canisterIdFromUrl(url);
  if (!canisterId || canisterId !== config.canister_id) {
    throw new Error("Kernel runtime config does not match the page canister");
  }
  const common = {
    target: config.target,
    canisterId,
    deploymentId: config.deployment_id,
    gateway: config.gateway,
    identityProvider: config.identity_provider,
    rootKeyPolicy: config.root_key_policy,
    allowLoopbackHttp: config.allow_loopback_http,
    isolatedFrameOriginTemplate: config.isolated_frame_origin_template,
    updateSourceOrigin: config.update_source_origin,
  };
  if (config.target === "ic") {
    if (url.origin !== `https://${canisterId}.icp0.io`) {
      throw new Error("IC Kernel must use its certified canister origin");
    }
    return Object.freeze({ ...common, local: false });
  }

  if (url.origin !== `http://${canisterId}.localhost:8000`) {
    throw new Error(
      "PocketIC Kernel must use its unprefixed loopback canister origin",
    );
  }
  return Object.freeze({
    ...common,
    local: true,
    localHost: config.gateway,
  });
}

/**
 * Fail closed if a generated frame URL escapes the certified deployment's
 * exact shell or isolated-subdomain origin policy.
 */
export function assertRuntimeFrameUrl(
  frameUrl: string,
  isolated: boolean,
  deployment: RuntimeDeployment = getRuntimeDeployment(),
): string {
  const origin = new URL(frameUrl).origin;
  if (!isolated) {
    const expected = deployment.local
      ? `http://${deployment.canisterId}.localhost:8000`
      : `https://${deployment.canisterId}.icp0.io`;
    if (origin !== expected) {
      throw new Error("App frame does not match the Kernel runtime origin");
    }
    return frameUrl;
  }

  const template = deployment.isolatedFrameOriginTemplate;
  const marker = ISOLATED_FRAME_PREFIX_PLACEHOLDER;
  const markerIndex = template.indexOf(marker);
  if (markerIndex < 0 || markerIndex !== template.lastIndexOf(marker)) {
    throw new Error("Kernel runtime frame-origin template is invalid");
  }
  const before = template.slice(0, markerIndex);
  const after = template.slice(markerIndex + marker.length);
  if (!origin.startsWith(before) || !origin.endsWith(after)) {
    throw new Error("App frame does not match the isolated runtime origin");
  }
  const prefix = origin.slice(before.length, origin.length - after.length);
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(prefix) ||
    template.replace(marker, prefix) !== origin
  ) {
    throw new Error("App frame has an invalid isolated runtime origin prefix");
  }
  return frameUrl;
}

function assertGatewayCertificationV2(response: Response): void {
  const certificate = response.headers.get("ic-certificate");
  const expression = response.headers.get("ic-certificateexpression");
  if (
    !certificate ||
    !/(?:^|[,;]\s*)certificate\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(
      certificate,
    ) ||
    !/(?:^|[,;]\s*)tree\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)expr_path\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(
      certificate,
    ) ||
    !/(?:^|[,;]\s*)version\s*=\s*2(?:\s*[,;]|\s*$)/iu.test(certificate) ||
    !expression?.trim() ||
    /\bno_certification\b/iu.test(expression)
  ) {
    throw new Error("Kernel runtime config response is not certified");
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared.trim())) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new Error("Kernel runtime config exceeds its size limit");
    }
  }
  if (!response.body) {
    throw new Error("Kernel runtime config returned no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Kernel runtime config exceeds its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("Kernel runtime config is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
