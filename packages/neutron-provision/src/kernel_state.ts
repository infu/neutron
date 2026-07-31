import type {
  KernelPackageInstaller,
  KernelPackageState,
} from "neutron-compiler/src/install.js";
import { readKernelPackageState as readSharedKernelPackageState } from "neutron-compiler/src/install.js";
import { canisterOrigin, localCanisterOrigin } from "neutron-tools/src/runtime.js";

export async function readKernelPackageState({
  actor,
  canisterId,
  host,
  local,
  expectedModuleContents,
  fetchImpl = fetch,
}: {
  actor: KernelPackageInstaller;
  canisterId: string;
  host: string;
  local: boolean;
  /**
   * Locally verified content-addressed module bodies. This avoids downloading
   * every source again after its individual successful `kernel_static` call;
   * the canister's complete key inventory is verified by the caller.
   */
  expectedModuleContents?: ReadonlyMap<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<KernelPackageState> {
  return readSharedKernelPackageState({
    listStatic: (prefix) => actor.kernel_static_query({ list: { prefix } }),
    fetchText: (assetPath) => {
      if (assetPath.startsWith("/mo/") && expectedModuleContents !== undefined) {
        const expected = expectedModuleContents.get(assetPath);
        if (expected === undefined) {
          throw new Error(`Installed module ${assetPath} is not in the deployment`);
        }
        return Promise.resolve(expected);
      }
      return fetchText(
        fetchImpl,
        assetUrl({ canisterId, host, local, path: assetPath }),
      );
    },
    fetchJson: (assetPath, fallback) =>
      fetchJson(
        fetchImpl,
        assetUrl({ canisterId, host, local, path: assetPath }),
        fallback,
      ),
  });
}

export function assetUrl({
  canisterId,
  host,
  local,
  path: assetPath,
}: {
  canisterId: string;
  host: string;
  local: boolean;
  path: string;
}): string {
  const origin = local
    ? localCanisterOrigin(canisterId, host)
    : canisterOrigin({ canisterId });
  return new URL(assetPath.startsWith("/") ? assetPath : `/${assetPath}`, origin)
    .href;
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  fallback: T,
): Promise<T> {
  const response = await fetchImpl(url);
  if (response.status === 404) return fallback;
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}
