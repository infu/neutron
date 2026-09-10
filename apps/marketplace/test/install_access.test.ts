import { expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import { REPOSITORY_LIMITS } from "neutron-tools/repository";
import { readInstallAccessDescriptor, readInstallAccessSelection } from "../src/install_access.ts";

const source = "sj2r4-haaaa-aaaay-aadgq-cai";
const other = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const origin = `https://${source}.icp0.io`;
// The test covers response policy; IC cryptographic verification belongs to
// the canonical gateway, which is exercised by the installed-browser suite.
const proof = {
  "ic-certificate": "certificate=:Y2VydA==:, tree=:dHJlZQ==:, expr_path=:cGF0aA==:, version=2",
  "ic-certificateexpression": "default_certification(ValidationArgs{certification:Certification{}})",
  "content-type": "application/json; charset=utf-8",
};
const descriptor = { protocol: "neutron-repo-access-v1", fee_version: "2", cycles: "250000000" };
const manifest = {
  protocol: "neutron-repo-v1", id: "saved-install", revision: 1, name: "Selected apps",
  packages: [
    { id: "editor", version: 111, sha256: "bb".repeat(32), size: 100 },
    { id: "wallet", version: 123, sha256: "aa".repeat(32), size: 200 },
  ],
};
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const setup = (value: unknown = manifest, options: { repo?: string; id?: string; digest?: string } = {}) =>
  `https://provider.example/#repo=${options.repo ?? source}&manifest=${options.id ?? manifest.id}&digest=${options.digest ?? hashContent(encoded(value))}`;
function fixture(value: unknown, headers: Record<string, string> = proof) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(encoded(value), { headers });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("reads certified source costs directly without browser credentials or a backend call", async () => {
  const { fetch, calls } = fixture(descriptor);
  expect(await readInstallAccessDescriptor(source, { fetch, host: "https://icp-api.io" })).toEqual(descriptor);
  expect(calls).toEqual([{ url: `${origin}/repo/v1/access.json`, init: {
    method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store",
    redirect: "error", mode: "cors", referrerPolicy: "no-referrer",
  } }]);
});

test("verifies a saved manifest and includes exactly its roots and resolved dependencies", async () => {
  const { fetch, calls } = fixture(manifest);
  const url = setup();
  expect(await readInstallAccessSelection(url, source, ["editor"], { fetch })).toEqual({
    url, source, paths: [`/repo/v1/packages/${"aa".repeat(32)}.neutron`, `/repo/v1/packages/${"bb".repeat(32)}.neutron`],
  });
  expect(calls.map(call => call.url)).toEqual([`${origin}/repo/v1/manifests/saved-install.json`]);
  // The provider URL, package bodies and individual dependency metadata are
  // unnecessary: the protocol already retained the exact closure in one hash.
  expect(calls).toHaveLength(1);
});

test("validates the saved source before requesting any metadata", async () => {
  const { fetch, calls } = fixture(manifest);
  await expect(readInstallAccessSelection(setup(manifest, { repo: other }), source, ["editor"], { fetch })).rejects.toThrow("different package source");
  expect(calls).toEqual([]);
});

test("rejects a manifest whose bytes, identifier or selected roots changed", async () => {
  const { fetch } = fixture(manifest);
  await expect(readInstallAccessSelection(setup(manifest, { digest: "00".repeat(32) }), source, ["editor"], { fetch })).rejects.toThrow("saved digest");
  await expect(readInstallAccessSelection(setup(manifest, { id: "different" }), source, ["editor"], { fetch })).rejects.toThrow("different installation manifest");
  await expect(readInstallAccessSelection(setup(), source, ["browser"], { fetch })).rejects.toThrow("selected apps");
  await expect(readInstallAccessSelection(setup(), source, [], { fetch })).rejects.toThrow("selected apps");
});

test("uses the shared manifest schema to reject repeated dependency/package entries", async () => {
  const duplicate = { ...manifest, packages: [...manifest.packages, manifest.packages[1]] };
  const { fetch } = fixture(duplicate);
  await expect(readInstallAccessSelection(setup(duplicate), source, ["editor"], { fetch })).rejects.toThrow("repeats app id");
  const duplicateDigest = { ...manifest, packages: [{ ...manifest.packages[0], sha256: manifest.packages[1]!.sha256 }, manifest.packages[1]] };
  await expect(readInstallAccessSelection(setup(duplicateDigest), source, ["editor"], fixture(duplicateDigest))).rejects.toThrow("repeats package digest");
});

test("rejects absent, skipped and malformed certification on descriptors and manifests", async () => {
  for (const headers of [
    { "content-type": "application/json" },
    { ...proof, "ic-certificate": "certificate=:Y2VydA==:, tree=:dHJlZQ==:, version=1" },
    { ...proof, "ic-certificateexpression": "default_certification(ValidationArgs{certification:no_certification})" },
    { ...proof, "ic-certificateexpression": " " },
  ]) {
    await expect(readInstallAccessDescriptor(source, fixture(descriptor, headers))).rejects.toThrow("not certified");
    await expect(readInstallAccessSelection(setup(), source, ["editor"], fixture(manifest, headers))).rejects.toThrow("not certified");
  }
});

test("rejects redirected or substituted responses without trusting their certification headers", async () => {
  for (const property of [{ redirected: true }, { url: `https://${other}.icp0.io/repo/v1/access.json` }]) {
    const response = new Response(encoded(descriptor), { headers: proof });
    for (const [key, value] of Object.entries(property)) Object.defineProperty(response, key, { value });
    await expect(readInstallAccessDescriptor(source, { fetch: (async () => response) as typeof fetch })).rejects.toThrow("different metadata resource");
  }
});

test("retains the existing metadata byte limit and descriptor schema", async () => {
  await expect(readInstallAccessDescriptor(source, fixture({ ...descriptor, cycles: 250000000 }))).rejects.toThrow("supported V1 record");
  await expect(readInstallAccessDescriptor(source, fixture({ ...descriptor, padding: "a".repeat(REPOSITORY_LIMITS.releaseJsonBytes) }))).rejects.toThrow("metadata limit");
  await expect(readInstallAccessSelection(setup(), source, ["editor"], fixture({ ...manifest, padding: "a".repeat(REPOSITORY_LIMITS.manifestJsonBytes) }))).rejects.toThrow("metadata limit");
});

test("uses local canister origins only for configured loopback hosts", async () => {
  const { fetch, calls } = fixture(descriptor);
  await readInstallAccessDescriptor(source, { fetch, host: "http://127.0.0.1:8000" });
  expect(calls[0]?.url).toBe(`http://${source}.localhost:8000/repo/v1/access.json`);
  await readInstallAccessDescriptor(source, { fetch, host: "https://untrusted-replica.example" });
  expect(calls[1]?.url).toBe(`${origin}/repo/v1/access.json`);
});

test("a canceled metadata read does not start a request", async () => {
  const { fetch, calls } = fixture(descriptor);
  const controller = new AbortController(); controller.abort();
  await expect(readInstallAccessDescriptor(source, { fetch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([]);
});
