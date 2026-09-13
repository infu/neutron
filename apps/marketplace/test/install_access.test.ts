import { expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import { REPOSITORY_LIMITS, repositoryManifestPath, repositoryPackagePath } from "neutron-tools/repository";
import { REPOSITORY_CHANNEL_SELECTION_PROTOCOL, repositoryChannelSelectionPath, type RepositoryChannelSelection } from "neutron-tools/src/release_channels.js";
import { readInstallAccessDescriptor, readInstallAccessSelection } from "../src/install_access.ts";
import type { ReleaseSelection } from "../src/view-types.ts";

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
const descriptor = { protocol: "neutron-repo-access-v1" as const, fee_version: "2", cycles: "250000000" };
const manifest = {
  protocol: "neutron-repo-v1", id: "saved-install", revision: 1, name: "Selected apps",
  packages: [
    { id: "editor", version: 111, sha256: "bb".repeat(32), size: 100 },
    { id: "wallet", version: 123, sha256: "aa".repeat(32), size: 200 },
  ],
};
const betaManifest = { ...manifest, protocol: "neutron-repo-channel-manifest-v1", channel: "beta" };
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
const reviewedSelection: ReleaseSelection = {
  mode: "beta",
  packages: [
    { appId: "editor", candidateId: "9007199254740993", version: "111", digest: manifest.packages[0]!.sha256, sourceDigest: "cc".repeat(32), channel: "beta", revision: "9007199254740995" },
    { appId: "wallet", candidateId: "22", version: "123", digest: manifest.packages[1]!.sha256, sourceDigest: null, channel: "stable", revision: "4" },
  ],
};
function channelEvidence(selectedManifest: typeof manifest = betaManifest): RepositoryChannelSelection {
  return {
    protocol: REPOSITORY_CHANNEL_SELECTION_PROTOCOL, source, mode: "beta",
    manifest_id: selectedManifest.id, manifest_sha256: hashContent(encoded(selectedManifest)),
    packages: selectedManifest.packages.map((pkg, index) => ({
      ...pkg, candidate_id: reviewedSelection.packages[index]!.candidateId,
      channel: reviewedSelection.packages[index]!.channel, revision: reviewedSelection.packages[index]!.revision,
    })),
  };
}
const selectionReadUrls = [
  `${origin}${repositoryManifestPath(manifest.id)}`,
  `${origin}${repositoryChannelSelectionPath(manifest.id)}`,
];
function selectionFixture(evidence: unknown = channelEvidence(), options: { headers?: Record<string, string>; status?: number; error?: Error; manifest?: typeof manifest } = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    const href = String(url); calls.push(href);
    if (href === selectionReadUrls[0]) return new Response(encoded(options.manifest ?? betaManifest), { headers: proof });
    if (href !== selectionReadUrls[1]) throw new Error(`Unexpected metadata request: ${href}`);
    if (options.error) throw options.error;
    return new Response(encoded(evidence), { headers: options.headers ?? proof, status: options.status ?? 200 });
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

test("binds the reviewed release snapshot to certified selection evidence for every dependency", async () => {
  for (const mode of ["stable", "beta"] as const) {
    const selectedManifest = mode === "beta" ? betaManifest : manifest;
    const selection = structuredClone(reviewedSelection), evidence = channelEvidence(selectedManifest);
    selection.mode = mode; evidence.mode = mode;
    if (mode === "stable") {
      for (const pkg of selection.packages) pkg.channel = "stable";
      for (const pkg of evidence.packages) pkg.channel = "stable";
    }
    // Package order is immaterial; exact candidate and revision decimals stay strings.
    evidence.packages.reverse();
    const { fetch, calls } = selectionFixture(evidence, { manifest: selectedManifest }), url = setup(selectedManifest);
    expect(await readInstallAccessSelection(url, source, ["editor"], { fetch, selection })).toEqual({
      url, source, paths: manifest.packages.map(pkg => repositoryPackagePath(pkg.sha256)).sort(),
    });
    expect(calls).toEqual(selectionReadUrls);
  }
});

test("beta selection evidence cannot authorize a legacy stable manifest even when its digest matches", async () => {
  const { fetch, calls } = selectionFixture(channelEvidence(manifest), { manifest });
  await expect(readInstallAccessSelection(setup(), source, ["editor"], { fetch, selection: reviewedSelection })).rejects.toThrow();
  expect(calls).toEqual(selectionReadUrls);
});

test("rejects selection evidence that differs from the reviewed mode, identities or dependency closure", async () => {
  const replacements: ReleaseSelection[] = [
    { ...reviewedSelection, mode: "stable" },
    { ...reviewedSelection, packages: reviewedSelection.packages.slice(0, 1) },
    { ...reviewedSelection, packages: [...reviewedSelection.packages, { ...reviewedSelection.packages[1]!, appId: "browser" }] },
    ...[
      { candidateId: "23" }, { version: "124" }, { digest: "dd".repeat(32) },
      { channel: "beta" as const }, { revision: "5" },
    ].map(change => ({ ...reviewedSelection, packages: [reviewedSelection.packages[0]!, { ...reviewedSelection.packages[1]!, ...change }] })),
  ];
  for (const selection of replacements) {
    const { fetch, calls } = selectionFixture();
    await expect(readInstallAccessSelection(setup(betaManifest), source, ["editor"], { fetch, selection })).rejects.toThrow("reviewed releases and dependencies");
    expect(calls).toEqual(selectionReadUrls);
  }
});

test("rejects certified selection evidence bound to another source, manifest or package bytes", async () => {
  const evidence = channelEvidence();
  for (const changed of [
    { ...evidence, source: other },
    { ...evidence, manifest_id: "another-install" },
    { ...evidence, manifest_sha256: "dd".repeat(32) },
    { ...evidence, packages: evidence.packages.slice(0, 1) },
    ...[{ sha256: "dd".repeat(32) }, { version: 124 }, { size: 201 }].map(change => ({
      ...evidence, packages: [evidence.packages[0]!, { ...evidence.packages[1]!, ...change }],
    })),
  ]) {
    const { fetch, calls } = selectionFixture(changed);
    await expect(readInstallAccessSelection(setup(betaManifest), source, ["editor"], { fetch, selection: reviewedSelection })).rejects.toThrow();
    expect(calls).toEqual(selectionReadUrls);
  }
});

test("missing, uncertified, malformed or interrupted selection evidence never falls back to legacy admission", async () => {
  for (const fixture of [
    selectionFixture({}, { status: 404 }),
    selectionFixture(channelEvidence(), { headers: { "content-type": "application/json" } }),
    selectionFixture(channelEvidence(), { headers: { ...proof, "ic-certificateexpression": "default_certification(ValidationArgs{certification:no_certification})" } }),
    selectionFixture({ ...channelEvidence(), mode: "unsupported" }),
    selectionFixture(channelEvidence(), { error: new Error("Selection reply interrupted") }),
  ]) {
    await expect(readInstallAccessSelection(setup(betaManifest), source, ["editor"], { fetch: fixture.fetch, selection: reviewedSelection })).rejects.toThrow();
    expect(fixture.calls).toEqual(selectionReadUrls);
  }
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
    await expect(readInstallAccessDescriptor(source, { fetch: Object.assign(async () => response, { preconnect: () => {} }) })).rejects.toThrow("different metadata resource");
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
