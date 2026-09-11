import { Principal } from "@dfinity/principal";
import {
  REPOSITORY_LIMITS,
  parseRepositoryManifest,
  parseRepositorySetupUrl,
  repositoryManifestPath,
  repositoryPackagePath,
} from "neutron-tools/repository";
import {
  REPOSITORY_ACCESS_PATH,
  parseRepositoryAccessDescriptor,
  type RepositoryAccessDescriptor,
} from "neutron-tools/src/repository_access.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { canisterOrigin } from "neutron-tools/src/runtime.js";

export type InstallAccessReadOptions = {
  host?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};
export type InstallAccessSelection = { url: string; source: string; paths: string[] };

/** Public source metadata only: no grant, identity, or charged update. */
export async function readInstallAccessDescriptor(
  source: string,
  options: InstallAccessReadOptions = {},
): Promise<RepositoryAccessDescriptor> {
  const origin = sourceOrigin(source, options.host);
  const bytes = await readCertifiedJson(new URL(REPOSITORY_ACCESS_PATH, origin), REPOSITORY_LIMITS.releaseJsonBytes, options);
  return parseRepositoryAccessDescriptor(parseJson(bytes, "source access description"));
}

/**
 * The protocol's pinned setup manifest already contains the selected roots and
 * their resolved dependency closure. Read it without downloading any packages;
 * authorization names exactly those immutable package paths. The Kernel still
 * verifies the packages and their dependency declarations during installation.
 */
export async function readInstallAccessSelection(
  setupUrl: string,
  source: string,
  appIds: readonly string[],
  options: InstallAccessReadOptions = {},
): Promise<InstallAccessSelection> {
  const canister = Principal.fromText(source).toText();
  const origin = sourceOrigin(canister, options.host);
  const reference = parseRepositorySetupUrl(setupUrl, { allowLoopbackHttp: isLocalHost(options.host) });
  if (reference.repo !== canister) throw new Error("The installation offer names a different package source.");
  const bytes = await readCertifiedJson(new URL(repositoryManifestPath(reference.manifest), origin), REPOSITORY_LIMITS.manifestJsonBytes, options);
  if (hashContent(bytes) !== reference.digest) throw new Error("The installation manifest does not match its saved digest.");
  const manifest = parseRepositoryManifest(parseJson(bytes, "installation manifest"));
  if (manifest.id !== reference.manifest) throw new Error("The source returned a different installation manifest.");
  if (!appIds.length || appIds.some(id => !manifest.packages.some(pkg => pkg.id === id))) {
    throw new Error("The installation manifest does not contain the selected apps.");
  }
  return {
    url: setupUrl,
    source: canister,
    paths: manifest.packages.map(pkg => repositoryPackagePath(pkg.sha256)).sort(),
  };
}

function isLocalHost(host?: string): boolean {
  if (!host) return false;
  const hostname = new URL(host).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function sourceOrigin(source: string, host?: string): string {
  const canisterId = Principal.fromText(source).toText();
  return canisterOrigin({ canisterId, ...(host && isLocalHost(host) ? { local: true, localHost: host } : {}) });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The installation metadata read was canceled.", "AbortError");
}

// These are the same response-policy checks used by the existing repository
// client. The canonical verified IC gateway verifies the certificate itself;
// raw gateways and arbitrary source-provided origins are never used here.
function assertCertified(response: Response, url: URL): void {
  if (response.redirected || (response.url && response.url !== url.href)) {
    throw new Error("The package source redirected or returned a different metadata resource.");
  }
  const certificate = response.headers.get("ic-certificate");
  const expression = response.headers.get("ic-certificateexpression");
  if (!certificate || !/(?:^|[,;]\s*)certificate\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)tree\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)expr_path\s*=\s*:[A-Za-z0-9+/=_-]+:/iu.test(certificate) ||
    !/(?:^|[,;]\s*)version\s*=\s*2(?:\s*[,;]|\s*$)/iu.test(certificate) ||
    !expression?.trim() || /\bno_certification\b/iu.test(expression)) {
    throw new Error("The package source metadata response is not certified.");
  }
}

async function readCertifiedJson(url: URL, maximum: number, options: InstallAccessReadOptions): Promise<Uint8Array> {
  assertNotAborted(options.signal);
  const response = await (options.fetch ?? globalThis.fetch)(url.href, {
    method: "GET", headers: { accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
    credentials: "omit", cache: "no-store", redirect: "error", mode: "cors", referrerPolicy: "no-referrer",
  });
  try {
    assertCertified(response, url);
    if (!response.ok) throw new Error(`The package source metadata request failed (${response.status}).`);
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("The package source did not return JSON metadata.");
    }
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The package source metadata is empty.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      assertNotAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("The package source metadata exceeds the repository metadata limit.");
      }
      chunks.push(value);
    }
    assertNotAborted(options.signal);
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`The ${label} is not valid UTF-8 JSON.`); }
}
