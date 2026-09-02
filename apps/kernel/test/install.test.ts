import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { prepare_files } from "../src/tools/install.ts";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

test("kernel generated artifacts keep V3 and add isolated activation V1", async () => {
  const [
    manifestText,
    lockText,
    wrapper,
    packagedManifestText,
    packagedLockText,
    candid,
    archive,
  ] = await Promise.all([
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../neutron.lock.json", import.meta.url), "utf8"),
    readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
    readFile(new URL("../dist/neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/neutron.lock.json", import.meta.url), "utf8"),
    readFile(new URL("../dist/neutron.did", import.meta.url), "utf8"),
    readFile(new URL("../kernel.v0.3.26.neutron", import.meta.url)),
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  const packagedManifest = JSON.parse(packagedManifestText);
  const packagedLock = JSON.parse(packagedLockText);
  const packagedArchive = preparePackageInstall(new Uint8Array(archive));

  expect(manifest.format).toBe(3);
  expect(manifest.version).toBe(326);
  expect(manifest.update_source).toBe("233tv-xiaaa-aaaay-aacta-cai");
  expect(manifest.memory.kernel.version).toBe(3);
  expect(Object.keys(manifest.memory.kernel.schemas)).toEqual(["3"]);
  expect(manifest.memory.kernel.migrations).toBeUndefined();
  expect(manifest.memory.kernel_activation.version).toBe(1);
  expect(Object.keys(manifest.memory.kernel_activation.schemas)).toEqual(["1"]);
  expect(manifest.memory.kernel_activation.migrations).toEqual([]);
  expect(Object.keys(lock.memory.kernel.schemas)).toEqual(["3"]);
  expect(lock.memory.kernel.migrations).toEqual({});
  expect(lock.memory.kernel.schemas["3"].hash).toMatch(/^[0-9a-f]{64}$/);
  expect(lock.memory.kernel.schemas["3"].entry).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(lock.memory.kernel_activation.schemas)).toEqual(["1"]);
  expect(lock.memory.kernel_activation.migrations).toEqual({});
  expect(lock.memory.kernel_activation.schemas["1"].hash).toMatch(
    /^[0-9a-f]{64}$/,
  );
  expect(lock.format).toBe(2);
  expect(lock.app).toBe("kernel");
  expect(packagedManifest.format).toBe(3);
  expect(packagedManifest.version).toBe(326);
  expect(packagedManifest.update_source).toBe(
    "233tv-xiaaa-aaaay-aacta-cai",
  );
  expect(packagedManifest.memory.kernel.version).toBe(3);
  expect(Object.keys(packagedManifest.memory.kernel.schemas)).toEqual(["3"]);
  expect(packagedManifest.memory.kernel.migrations).toBeUndefined();
  expect(packagedManifest.memory.kernel_activation.version).toBe(1);
  expect(packagedManifest.memory.kernel_activation.migrations).toEqual([]);
  expect(packagedLock).toEqual(lock);
  expect(packagedArchive.manifest.memory?.kernel?.version).toBe(3);
  expect(packagedArchive.manifest.version).toBe(326);
  expect(packagedArchive.packageRecord).toMatchObject({
    format: 1,
    package: { id: "kernel", version: 326 },
    license: { id: "LicenseRef-Neutron-Public-License-1.0" },
    source: { kind: "https" },
  });
  expect(packagedArchive.packageRecord?.build.inputs.length).toBeGreaterThan(
    0,
  );
  expect(
    Object.keys(packagedArchive.manifest.memory?.kernel?.schemas ?? {}),
  ).toEqual(["3"]);
  expect(packagedArchive.manifest.memory?.kernel?.migrations).toBeUndefined();
  expect(
    packagedArchive.manifest.memory?.kernel_activation?.version,
  ).toBe(1);

  // `r6_kernel` encodes the six-character memory id, not schema version 6.
  expect(wrapper).toContain(
    'import NeutronMemorySchema_a6_kernel_r6_kernel_v3 "memory/kernel/v3"',
  );
  expect(wrapper).toContain(
    "#v3 : NeutronMemorySchema_a6_kernel_r6_kernel_v3.Mem",
  );
  expect(wrapper).toContain(
    "let #v3(NeutronMemory_a6_kernel_r6_kernel) = NeutronMemoryStore_a6_kernel_r6_kernel",
  );
  expect(wrapper).toContain(
    'import NeutronMemorySchema_a6_kernel_r17_kernel_activation_v1 "memory/activation/v1"',
  );
  expect(wrapper).toContain('assembler_id = "neutron_actor_v26"');
  expect(wrapper).toContain(
    '{ id = "kernel_activation"; owner = "kernel"; version = 1; schema = "memory/activation/v1" }',
  );
  expect(candid).toContain("kernel_activation:");
  const activationWrapper = wrapper.slice(
    wrapper.indexOf("func kernel_activation"),
    wrapper.indexOf("func kernel_static"),
  );
  expect(activationWrapper).toContain("NeutronKernel.kernel_activation");
  expect(activationWrapper).not.toContain("await*");
  expect(activationWrapper).not.toContain(
    "assert(NeutronKernel.is_authorized",
  );
  for (const method of [
    "kernel_certified_assets_scope_info",
    "kernel_certified_assets_usage",
    "kernel_certified_assets_diagnostics",
    "kernel_certified_assets_set_admission_ceilings",
    "kernel_certified_assets_set_writes_frozen",
    "kernel_certified_assets_maintenance_page",
    "kernel_certified_assets_retire_scope",
    "kernel_publication_entropy_initialize",
  ]) {
    expect(candid).toContain(`${method}:`);
  }
});

test("certified-assets capability toggles rotate stable write authority", async () => {
  const [main, service] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(
      new URL("../backend/certified_assets/Service.mo", import.meta.url),
      "utf8",
    ),
  ]);
  const toggleCase = main.slice(
    main.indexOf("case (#certified_assets)"),
    main.indexOf("case (#certified_read_routes)"),
  );

  expect(toggleCase).toContain(
    "certifiedAssets.rotateStoreAuthority(updated.scope)",
  );
  expect(toggleCase).not.toContain("if (updated.enabled)");
  expect(service).toMatch(
    /public func rotateStoreAuthority[\s\S]*?store_authority_epoch = epoch;[\s\S]*?collections;/,
  );
});

test("pending install journals freeze public static mutations", async () => {
  const main = await readFile(
    new URL("../backend/main.mo", import.meta.url),
    "utf8",
  );
  const start = main.indexOf("public func /*update*/kernel_static");
  const commandSwitch = main.indexOf("switch(cmd)", start);
  expect(start).toBeGreaterThan(-1);
  expect(commandSwitch).toBeGreaterThan(start);
  expect(main.slice(start, commandSwitch)).toContain(
    "assert(installs.publicStaticMutationsAllowed())",
  );
});

test("resident-origin toggles reconcile only the affected app subtree", async () => {
  const main = await readFile(
    new URL("../backend/main.mo", import.meta.url),
    "utf8",
  );
  expect(main).toMatch(
    /func reconcileResidentOriginPolicy[\s\S]*?cert\.beginV2PublicationBatch\(\)[\s\S]*?reconcilePublicStaticAssetsForApp\(appId\)[\s\S]*?cert\.finishV2PublicationBatch\(\)/,
  );
  const reconcile = main.slice(
    main.indexOf("func reconcileResidentOriginPolicy"),
    main.indexOf("func deleteStaticAssetCertification"),
  );
  expect(reconcile).not.toContain("runtime-config.json");
  expect(main).not.toContain('"wagyu"');
  for (const kind of [
    "#persistent_browser_storage",
    "#dedicated_resident_origin",
  ]) {
    const start = main.indexOf(`case (${kind})`);
    expect(start).toBeGreaterThan(-1);
    expect(main.slice(start, start + 240)).toContain(
      "reconcileResidentOriginPolicy(updated.scope.app_id)",
    );
  }
});

test("capability toggles publish runtime authority only after reconciliation", async () => {
  const main = await readFile(
    new URL("../backend/main.mo", import.meta.url),
    "utf8",
  );
  const start = main.indexOf("func setCapabilityEnabled(");
  const end = main.indexOf(
    "public func /*update*/kernel_backend_reservations_apply",
    start,
  );
  const toggle = main.slice(start, end);
  expect(toggle).toContain("capabilityRegistry.setEnabled(input, caller)");
  expect(toggle).toContain("capabilityRegistry.advanceAuthorityRevision()");
  expect(toggle.indexOf("switch (updated.kind)")).toBeLessThan(
    toggle.indexOf("capabilityRegistry.advanceAuthorityRevision()"),
  );
  expect(toggle.indexOf("capabilityRegistry.advanceAuthorityRevision()")).toBeLessThan(
    toggle.lastIndexOf("updated;"),
  );
});

test("installation CSP is exact to the certified gateway environment", async () => {
  const main = await readFile(
    new URL("../backend/main.mo", import.meta.url),
    "utf8",
  );
  const start = main.indexOf("func browserGatewayEnvironment");
  const end = main.indexOf("public func isSharedAppRoutePath", start);
  const csp = main.slice(start, end);
  expect(csp).toContain('let appPath = "/app/" # appId # "/"');
  expect(csp).toContain('authority == surfaceHostLabel # ".icp0.io"');
  expect(csp).toContain(
    'authority == surfaceHostLabel # ".localhost:8000"',
  );
  expect(csp).toContain("else return null");
  expect(csp).toContain(
    '"sandbox allow-scripts allow-same-origin; script-src "',
  );
  expect(csp).toContain('"\'unsafe-inline\' \'unsafe-eval\' blob: "');
  expect(csp).toContain('"; object-src \'none\'; "');
  expect(csp).toContain('"worker-src blob: "');
  expect(csp).toContain("environment.surface_origin # appPath");
  expect(csp).toContain("environment.kernel_origin");
  expect(csp).toContain("public func residentDocumentCspForAuthority");
  expect(csp).toContain(
    '"sandbox allow-scripts allow-same-origin; frame-ancestors "',
  );
  expect(csp).not.toContain("gemma");

  const headersStart = main.indexOf("func certifiedResponseHeaders");
  const headersEnd = main.indexOf(
    "func certifiedAuthorities",
    headersStart,
  );
  const headers = main.slice(headersStart, headersEnd);
  expect(headers).toContain("documentAuthority : ?BrowserDocumentAuthority");
  expect(headers).toContain(
    "installationDocumentCspForAuthority(\n                            surface.host_label",
  );
  expect(headers).toContain("case (#persistent_app)");
  expect(headers).toContain("residentDocumentCspForAuthority(");

  const variantsStart = main.indexOf(
    "for (surface in browserSurfaces(appId).vals())",
  );
  const variantsEnd = main.indexOf(
    "if (dedicatedResidentOriginActive(instance))",
    variantsStart,
  );
  expect(main.slice(variantsStart, variantsEnd)).toMatch(
    /for \(authority in certifiedAuthorities[\s\S]*?#installation_app,[\s\S]*?\?surface,[\s\S]*?host_label = surface\.host_label;[\s\S]*?authority;/,
  );
  const residentVariantsStart = main.indexOf(
    "let hostLabel = persistentAppOriginPrefix",
    variantsEnd,
  );
  const residentVariantsEnd = main.indexOf(
    "List.toArray(result)",
    residentVariantsStart,
  );
  expect(main.slice(residentVariantsStart, residentVariantsEnd)).toMatch(
    /#persistent_app,[\s\S]*?host_label = hostLabel;[\s\S]*?authority;/,
  );
  expect(main).toMatch(
    /let originDocumentAuthority = if \([\s\S]*?#persistent_app[\s\S]*?requestHostAuthority\([\s\S]*?host_label = authority\.host_label;[\s\S]*?certifiedResponseHeaders\([\s\S]*?originDocumentAuthority,/,
  );
});

test("selected app package proofs are retired into a passive MIME profile", async () => {
  const main = await readFile(
    new URL("../backend/main.mo", import.meta.url),
    "utf8",
  );
  expect(main).toContain(
    "if (passiveAppPackage and isAppPackageHttpAssetPath(path))",
  );
  const headersStart = main.indexOf("func certifiedResponseHeaders");
  const headersEnd = main.indexOf("func certifiedAuthorities", headersStart);
  const headers = main.slice(headersStart, headersEnd);
  expect(headers).toContain(
    "let responseContentType = httpAssetResponseContentType(",
  );
  expect(headers).toMatch(
    /let adoptedApp = switch \(appIdFromAssetUrl\(key\)\)[\s\S]*?browserSurfaceOriginApps,[\s\S]*?appId,[\s\S]*?\) != null/,
  );
  expect(headers).toMatch(
    /let passiveAppPackage =\s+\(\s*InstallMemory\.deploymentCommitted\([\s\S]*?\) or\s+installBrowserSurfaceCertificationUnitsRemaining != null\s+\) and\s+adoptedApp and\s+isAppPackageHttpAssetPath\(key\)/,
  );
  expect(headers).toContain(
    "file.content_type,\n                passiveAppPackage,",
  );
  expect(headers).toContain('(\"Content-Type\", responseContentType)');
  expect(headers).toContain('(\"X-Content-Type-Options\", \"nosniff\")');

  expect(main).not.toContain("func reconcileSelectedAppPackageAssets");
  const commitStart = main.indexOf("func commitInstall<system>");
  const commitEnd = main.indexOf("public func /*update*/kernel_install_abort", commitStart);
  const commit = main.slice(commitStart, commitEnd);
  const enableCopyTimeProfile = commit.indexOf(
    "installBrowserSurfaceCertificationUnitsRemaining :=\n                ?MAX_BROWSER_SURFACE_CERTIFICATION_UNITS",
  );
  const copyAssets = commit.indexOf("ignore installs.commit(inp");
  const disableCopyTimeProfile = commit.indexOf(
    "installBrowserSurfaceCertificationUnitsRemaining := null",
  );
  expect(enableCopyTimeProfile).toBeGreaterThan(-1);
  expect(copyAssets).toBeGreaterThan(enableCopyTimeProfile);
  expect(disableCopyTimeProfile).toBeGreaterThan(copyAssets);
  expect(commit.indexOf("cert.finishV2PublicationBatch()"))
    .toBeGreaterThan(disableCopyTimeProfile);
});

test("Kernel activation retires every retained Kernel-profile response", async () => {
  const [main, assets] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/assets.mo", import.meta.url), "utf8"),
  ]);

  const sandboxHeaders = main.slice(
    main.indexOf("public func appAssetSandboxHeaders"),
    main.indexOf("public class Init"),
  );
  const kernelPolicy = sandboxHeaders.slice(
    sandboxHeaders.indexOf("case (#kernel)"),
    sandboxHeaders.indexOf("case (#opaque_app)"),
  );
  expect(kernelPolicy).toContain('"frame-ancestors \'none\'"');
  expect(kernelPolicy).not.toContain("if (html)");

  const reconciliation = main.slice(
    main.indexOf("func reconcileRetainedKernelStaticAssets"),
    main.indexOf("func reconcileResidentBackgroundEntrypoints"),
  );
  expect(assets).toContain("Map.entriesFrom(store, Text.compare, key)");
  expect(reconciliation).toContain("assets.entriesFrom(start)");
  expect(reconciliation).toContain('visitRange("/", ?"/app/")');
  expect(reconciliation).toContain('visitFiltered("/app/")');
  expect(reconciliation).toContain('visitRange("/app0", ?"/mo/")');
  expect(reconciliation).toContain('visitRange("/mo0", ?"/pkg/")');
  expect(reconciliation).toContain('visitRange("/pkg0", ?"/system/")');
  expect(reconciliation).toContain('visitRange("/system0", null)');
  expect(reconciliation).toContain("isPackageHttpAssetPath(key)");
  expect(reconciliation).toContain("isInternalHttpStatePath(key)");
  expect(reconciliation).toContain("isSharedAppRoutePath(key)");
  expect(reconciliation).toContain(
    "Cert.KERNEL_RESPONSE_POLICY_REBUILD_SYSTEM_PATHS_V316",
  );
  expect(reconciliation).toContain(
    "cert.removeQuarantinedKernelStaticExpressionV316(key)",
  );
  expect(reconciliation.match(/forEachKernelAsset\(func/g)).toHaveLength(2);
  expect(reconciliation).toContain(
    "candidateCount <= MAX_STATIC_LIST_KEYS",
  );
  expect(reconciliation).toMatch(
    /not Cert\.validCanonicalPath\(key\)[\s\S]*?cert\.deleteRestoredLegacyStaticAssetHash\(key\)/u,
  );
  expect(reconciliation).toContain("staticCertificationMutations(");
  expect(reconciliation).not.toContain(
    "publicStaticAssetCertificationIsCurrent(key, bodyHash)",
  );

  const init = main.slice(
    main.indexOf("public class Init("),
    main.indexOf("public func /*update*/kernel_install_commit"),
  );
  const initializeFresh = init.indexOf("InstallService.initializeFresh(");
  const activationGate = init.indexOf("let activatingKernelInstall");
  const versionGate = init.indexOf(
    "let requiresKernelResponsePolicyV316Cutover",
  );
  const restoreCertification = init.indexOf("cert.initialize(");
  const activationCutoverComment = init.indexOf(
    "Actor activation publishes restored certification",
  );
  const activationBatch = init.indexOf(
    "cert.beginV2PublicationBatch()",
    activationCutoverComment,
  );
  const activationReconcile = init.indexOf(
    "reconcileRetainedKernelStaticAssets()",
    activationCutoverComment,
  );
  const activationFinish = init.indexOf(
    "cert.finishV2PublicationBatch()",
    activationCutoverComment,
  );
  const installServiceConstruction = init.indexOf("let installs =");
  expect(initializeFresh).toBeGreaterThan(-1);
  expect(activationGate).toBeGreaterThan(initializeFresh);
  expect(versionGate).toBeGreaterThan(activationGate);
  const gate = init.slice(
    activationGate,
    init.indexOf("let assets =", activationGate),
  );
  expect(gate).toContain("journal.deployment_id == runningDeploymentId");
  expect(gate).toContain("InstallService.changedInstances(");
  expect(gate).toContain('"kernel"');
  expect(gate).toContain(
    "target >= KERNEL_RESPONSE_POLICY_V316_MIN_VERSION",
  );
  expect(gate).toContain(
    "committed < KERNEL_RESPONSE_POLICY_V316_MIN_VERSION",
  );
  expect(restoreCertification).toBeGreaterThan(activationGate);
  expect(activationBatch).toBeGreaterThan(restoreCertification);
  expect(activationReconcile).toBeGreaterThan(activationBatch);
  expect(activationFinish).toBeGreaterThan(activationReconcile);
  expect(installServiceConstruction).toBeGreaterThan(activationFinish);

  const commit = main.slice(
    main.indexOf("func commitInstall<system>"),
    main.indexOf("public func /*update*/kernel_install_abort"),
  );
  const outerBatch = commit.indexOf("cert.beginV2PublicationBatch()");
  const promotion = commit.indexOf(
    "ignore installs.commit(inp, caller, managedMemoryCommit)",
  );
  const finishBatch = commit.lastIndexOf("cert.finishV2PublicationBatch()");
  expect(outerBatch).toBeGreaterThan(-1);
  expect(promotion).toBeGreaterThan(outerBatch);
  expect(finishBatch).toBeGreaterThan(promotion);
  expect(commit).not.toContain("reconcileRetainedKernelStaticAssets()");
});

test("certified reads and POST handlers have independent runtime toggles", async () => {
  const [main, certifiedAssets] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(
      new URL("../backend/certified_assets/Service.mo", import.meta.url),
      "utf8",
    ),
  ]);
  const certifiedReadCase = main.slice(
    main.indexOf("case (#certified_read_routes)"),
    main.indexOf("case (#http_routes)"),
  );
  const postCase = main.slice(
    main.indexOf("case (#http_routes)"),
    main.indexOf("case (#public_ingress)"),
  );

  expect(certifiedReadCase).toContain("certifiedAssets.setMountEnabled");
  expect(certifiedReadCase).not.toContain(
    "httpPostUpdateHandlers.setMountEnabled",
  );
  expect(postCase).toContain("httpPostUpdateHandlers.setMountEnabled");
  expect(postCase).not.toContain("certifiedAssets.setMountEnabled");
  expect(certifiedAssets).toContain(
    "registry.allowed(committed.scope, #certified_read_routes, mount.id)",
  );
  expect(certifiedAssets).not.toMatch(
    /registry\.allowed\([^)]*, #http_routes, mount\.id\)/,
  );
});

test("prepare_files rewrites valid package paths", async () => {
  const motoko = bytes("actor {}");
  const hash = hashContent(motoko);
  const files = await prepare_files(
    {
      [`mo/${hash}.mo`]: motoko,
      "web/index.html": bytes("<main></main>"),
      "neutron.json": bytes("{}"),
    },
    "mo/",
    "app/hello/",
  );

  expect(files.map((file) => file.path).sort()).toEqual([
    "app/hello/index.html",
    "app/hello/pkg/neutron.json",
    `mo/${hash}.mo`,
  ]);
});

test("prepare_files rejects malformed Motoko package paths", async () => {
  await expect(() =>
    prepare_files(
      {
        "mo/not-a-hash.mo": bytes("actor {}"),
      },
      "mo/",
      "app/hello/",
    ),
  ).toThrow(/Invalid mo package path/);
});

test("prepare_files rejects Motoko hash mismatches", async () => {
  await expect(() =>
    prepare_files(
      {
        [`mo/${"a".repeat(64)}.mo`]: bytes("actor {}"),
      },
      "mo/",
      "app/hello/",
    ),
  ).toThrow(/Invalid mo hash/);
});

test("prepare_files rejects unsafe package paths", async () => {
  for (const packagePath of [
    "/absolute",
    "web/../index.html",
    "web//index.html",
    "web\\index.html",
  ]) {
    await expect(() =>
      prepare_files(
        {
          [packagePath]: bytes("x"),
        },
        "mo/",
        "app/hello/",
      ),
    ).toThrow(/Unsafe package path/);
  }
});

test("kernel self-upgrade keeps the management install call one-way", async () => {
  const [management, main] = await Promise.all([
    readFile(new URL("../backend/aaa_interface.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
  ]);

  expect(management).toMatch(
    /install_code\s*:\s*shared\s+install_code_args\s*->\s*\(\)/,
  );
  expect(management).not.toMatch(
    /install_code\s*:\s*shared\s+install_code_args\s*->\s*async/,
  );
  expect(main).toContain("IC.management.install_code({");
  expect(main).not.toMatch(/await\s+IC\.management\.install_code/);
  expect(main).toMatch(/kernel_install_code[\s\S]*:\s*async\*\s*\(\)/);
  expect(main).toMatch(
    /kernel_install_code[\s\S]*?sender_canister_version\s*=\s*\?Prim\.canisterVersion\(\)/,
  );
  expect(main).toContain('\"public, max-age=31536000, immutable\"');
  expect(main).toContain('\"no-cache\"');
  expect(main).toContain("skip_pre_upgrade = null");
});

test("large self-upgrades use bounded journal-scoped management chunks", async () => {
  const [management, main] = await Promise.all([
    readFile(new URL("../backend/aaa_interface.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
  ]);

  expect(management).toMatch(
    /upload_chunk\s*:\s*shared\s+upload_chunk_args\s*->\s*async\s+chunk_hash/,
  );
  expect(management).toMatch(
    /install_chunked_code\s*:\s*shared\s+install_chunked_code_args\s*->\s*\(\)/,
  );
  expect(management).not.toMatch(
    /install_chunked_code\s*:\s*shared\s+install_chunked_code_args\s*->\s*async/,
  );
  expect(main).toMatch(
    /MAX_INSTALL_WASM_CHUNK_BYTES = 1_048_576[\s\S]*MAX_INSTALL_WASM_CHUNKS = 100/,
  );
  expect(main).toMatch(
    /kernel_install_wasm_chunk[\s\S]*?reservationPreparation[\s\S]*?management\.upload_chunk[\s\S]*?reservationPreparation[\s\S]*?uploaded\.hash == inp\.sha256/,
  );
  expect(main).toMatch(
    /kernel_install_code_chunked[\s\S]*?chunk_hashes\.size\(\) <= MAX_INSTALL_WASM_CHUNKS[\s\S]*?installs\.markDispatched[\s\S]*?management\.install_chunked_code/,
  );
  expect(main).not.toMatch(
    /await\s+IC\.management\.install_chunked_code/,
  );
  expect(main).toMatch(
    /kernel_install_wasm_chunks_clear[\s\S]*?isDispatched[\s\S]*?management\.canister_status[\s\S]*?management\.clear_chunk_store/,
  );
});

test("upgrade and install work never scales with existing certified records", async () => {
  const [main, certifiedHttp, certifiedAssets] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(
      new URL("../backend/certified_http.mo", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../backend/certified_assets/Service.mo", import.meta.url),
      "utf8",
    ),
  ]);

  expect(main).toMatch(
    /func reconcilePublicStaticAssetsAtPrefix[\s\S]*?assets\.allKeys\(prefix\)[\s\S]*?publicStaticAssetCertificationIsCurrent\(\s*key,\s*bodyHash,\s*\)[\s\S]*?continue/,
  );
  expect(main).toMatch(
    /func dedicatedResidentOriginActive[\s\S]*?enabledAfterCommit\([\s\S]*?#dedicated_resident_origin[\s\S]*?enabledAfterCommit\([\s\S]*?#persistent_browser_storage/,
  );
  const commit = main.slice(
    main.indexOf("func commitInstall<system>"),
    main.indexOf("public func /*update*/kernel_install_abort"),
  );
  expect(commit).toContain("installs.commit");
  expect(commit).toContain("capabilityRegistry.commitConfiguration");
  expect(commit).toContain("reconcileResidentBackgroundEntrypoints()");
  expect(commit).not.toContain("reconcilePublicStaticAssets");

  const initialize = certifiedHttp.slice(
    certifiedHttp.indexOf("public func initialize("),
    certifiedHttp.indexOf("public func chunkedSend"),
  );
  expect(initialize).toContain("AuthenticatedForest.validateAndRestore");
  expect(initialize).toContain("CertifiedData.set(combinedRoot())");
  expect(initialize).not.toContain("allKeys");
  expect(initialize).not.toContain("recordsForScope");

  const runtimeSync = certifiedAssets.slice(
    certifiedAssets.indexOf("public func syncRuntimeState()"),
    certifiedAssets.indexOf("// Captured app capability"),
  );
  expect(runtimeSync).toContain("Map.values(mem.mounts)");
  expect(runtimeSync).not.toContain("recordsForScope");
  expect(runtimeSync).not.toContain("mem.records");
});

test("checked install APIs are hard-cutover and fail closed", async () => {
  const [
    main,
    wrapper,
    manifestText,
    installService,
    installTypes,
  ] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    readFile(new URL("../backend/install/Service.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/install/Types.mo", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  expect(manifest.func.kernel_install_begin).toBeUndefined();
  expect(manifest.func.kernel_install_begin_checked).toEqual({
    type: "update",
    async: false,
  });
  expect(manifest.func.kernel_install_abort).toEqual({
    type: "update",
    async: "async*",
    arg: ["this"],
  });
  for (const method of [
    "kernel_install_wasm_chunks_clear",
    "kernel_install_wasm_chunk",
    "kernel_install_code_chunked",
  ]) {
    expect(manifest.func[method]).toEqual({
      type: "update",
      async: "async*",
      arg: ["this"],
    });
    expect(wrapper).toMatch(
      new RegExp(
        `func ${method}[\\s\\S]*?assert\\(NeutronKernel\\.is_authorized\\(NeutronCaller\\)\\)`,
      ),
    );
  }
  expect(installTypes).toMatch(
    /CheckedBeginInput[\s\S]*?journal\s*:\s*BeginInput[\s\S]*?expected_deployment_id\s*:\s*Text/,
  );
  expect(main).toMatch(
    /kernel_install_begin_checked[\s\S]*?expected_deployment_id == runningDeploymentId[\s\S]*?installs\.begin\(inp\.journal\)/,
  );
  expect(main).toMatch(
    /activeAppInstanceInventory\s*:\s*\[InstallTypes\.RuntimeApp\][\s\S]*?initializeFresh\([\s\S]*?activeAppInstanceInventory[\s\S]*?InstallService\.Service\([\s\S]*?activeAppInstanceInventory/,
  );
  expect(installService).toMatch(
    /func begin[\s\S]*?committedMatchesActiveRuntime\([\s\S]*?activeAppInstanceInventory[\s\S]*?reconcileTarget\([\s\S]*?committed_app_instances[\s\S]*?target_app_instances[\s\S]*?mem\.pending := \?journal/,
  );
  expect(main).not.toContain("kernel_install_commit_checked");
  expect(main).toMatch(
    /func commitInstall<system>[\s\S]*?canFinalizeInstallReservations[\s\S]*?return #blocked[\s\S]*?cert\.beginV2PublicationBatch[\s\S]*?finalizeInstallReservations[\s\S]*?installs\.commit[\s\S]*?capabilityRegistry\.commitConfiguration/,
  );
  expect(installService).toMatch(
    /func commit[\s\S]*?targetMatchesActiveRuntime\([\s\S]*?journal[\s\S]*?activeAppInstanceInventory[\s\S]*?changedInstances\([\s\S]*?mem\.committed_app_instances := journal\.target_app_instances[\s\S]*?clearAssets/,
  );
  expect(main).toMatch(
    /kernel_install_code[\s\S]*?installs\.markDispatched[\s\S]*?IC\.management\.install_code/,
  );
  expect(wrapper).toMatch(
    /func kernel_install_begin_checked[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\)/,
  );
  expect(wrapper).toMatch(
    /transient let NeutronActiveAppInstanceInventory = \[[\s\S]*?NeutronModule_a6_kernel\.Init\(NeutronMemory_a6_kernel_r6_kernel,NeutronMemory_a6_kernel_r17_kernel_activation,"development",NeutronActiveAppInstanceInventory,NeutronPrim\.principalOfActor\(NeutronActor\)\)/,
  );

  expect(
    Object.keys(manifest.func).filter((method) =>
      method.startsWith("kernel_bootstrap_"),
    ),
  ).toEqual([]);
  expect(main).not.toContain("BootstrapService");
  expect(wrapper).not.toContain("kernel_bootstrap_");
  expect(main).toMatch(
    /kernel_install_abort[\s\S]*?deployment_id != runningDeploymentId[\s\S]*?isDispatched[\s\S]*?management\.canister_status[\s\S]*?abortAfterManagementFence[\s\S]*?installs\.abort/,
  );
  expect(installService).toMatch(
    /markDispatched[\s\S]*?dispatchMarkerPath[\s\S]*?public func abort[\s\S]*?dispatchMarkerPath[\s\S]*?== null/,
  );
  expect(installService).toMatch(
    /isDispatchMarkerPath[\s\S]*?\/system\/staging\/[\s\S]*?\/dispatched/,
  );
  expect(installService).toMatch(
    /applyModuleGc[\s\S]*?MAX_MODULE_GC_BYTES[\s\S]*?isModulePath[\s\S]*?assets\.delete\(key\)/,
  );
  expect(installService).toContain('Text.stripEnd(value, #text ".mo")');
  expect(installService).toMatch(/isModulePath[\s\S]*?hash\.size\(\) != 64/);
  expect(main).toMatch(
    /MAX_STATIC_LIST_KEYS = 20_000[\s\S]*?assets\.keys\(prefix, MAX_STATIC_LIST_KEYS \+ 1\)[\s\S]*?assert\(keys\.size\(\) <= MAX_STATIC_LIST_KEYS\)/,
  );
  expect(main).toMatch(
    /kernel_static[\s\S]*?isDispatchMarkerPath\(x\.key\)[\s\S]*?isDispatchMarkerPath\(key\)[\s\S]*?case\(#delete[\s\S]*?isDispatchMarkerPath\(key\)[\s\S]*?case\(#clear[\s\S]*?isDispatchMarkerPath\(k\)/,
  );
  expect(main).toMatch(
    /kernel_static[\s\S]*?isSeedOncePublicRegistryStaticTarget\(key\)[\s\S]*?current == next[\s\S]*?case\(#delete[\s\S]*?not isSeedOncePublicRegistryStaticTarget\(key\)[\s\S]*?case\(#clear[\s\S]*?not staticClearTouchesSeedOncePublicRegistry\(prefix\)/,
  );
  expect(main).toMatch(
    /BROWSER_SURFACE_ORIGINS_PATH[\s\S]*?\/system\/browser-surface-origins\.json[\s\S]*?isSeedOncePublicRegistryStaticTarget[\s\S]*?isAppRegistryStaticTarget\(path\)[\s\S]*?isBrowserSurfaceOriginsStaticTarget\(path\)/,
  );
  expect(main).toMatch(
    /staticCertificationMutation[\s\S]*?assert \(not isSharedAppRoutePath\(key\)\)/,
  );
  expect(main).toMatch(
    /deleteStaticAssetCertification[\s\S]*?deleteAssetHash\(key\)[\s\S]*?if \(isSharedAppRoutePath\(key\)\) return;[\s\S]*?cert\.apply/,
  );
  expect(main).toMatch(
    /case\(#store_chunk\(x\)\)[\s\S]*?not isSharedAppRoutePath\(x\.key\)[\s\S]*?case\(#store\(\{key; val\}\)\)[\s\S]*?not isSharedAppRoutePath\(key\)/,
  );
  expect(main).toMatch(
    /markDispatched[\s\S]*?IC\.management\.install_code[\s\S]*?#call_error[\s\S]*?clearDispatchAfterCallError/,
  );
});

test("frontend app state is cleared only after the atomic install commit", async () => {
  const source = await readFile(
    new URL("../src/reducer/apps.ts", import.meta.url),
    "utf8",
  );
  const uninstallBody = source.slice(
    source.indexOf("async function uninstallAppsInternal"),
    source.indexOf("export async function install_app"),
  );
  const committedUninstallIndex = uninstallBody.indexOf(
    "await setCommittedAppsFromRuntime(",
  );
  expect(committedUninstallIndex).toBeGreaterThan(-1);
  expect(
    uninstallBody.indexOf("removeAppRuntimeState(appId, true)"),
  ).toBeGreaterThan(committedUninstallIndex);
  expect(uninstallBody.indexOf("resetNeutronCanBinding()")).toBeGreaterThan(
    committedUninstallIndex,
  );

  const installBody = source.slice(
    source.indexOf("async function installAppInternal"),
    source.indexOf("function removeAppRuntimeState"),
  );
  const setAppsIndex = installBody.indexOf(
    "await setCommittedAppsFromRuntime(",
  );
  const deployIndex = installBody.indexOf(
    "await deployPreparedPackages",
  );
  expect(deployIndex).toBeGreaterThan(-1);
  expect(setAppsIndex).toBeGreaterThan(-1);
  expect(setAppsIndex).toBeGreaterThan(deployIndex);
  expect(installBody).not.toContain("kernel_backend_reservations_apply");
  expect(
    installBody.indexOf("removeAppRuntimeState(id, false)"),
  ).toBeGreaterThan(setAppsIndex);
  expect(installBody.indexOf("resetNeutronCanBinding()")).toBeGreaterThan(
    setAppsIndex,
  );
});

test("frontend deployments signal sibling tabs at activation and commit", async () => {
  const source = await readFile(
    new URL("../src/reducer/apps.ts", import.meta.url),
    "utf8",
  );
  expect(source.match(/announceActivationStep\(/g)?.length).toBe(4);
  const activationHelper = source.slice(
    source.indexOf("function announceActivationStep"),
    source.indexOf("const delay ="),
  );
  expect(activationHelper).toContain('step !== "install-code"');
  expect(activationHelper).toContain('phase: "pending"');
  expect(source.match(/phase: "committed"/g)?.length).toBeGreaterThanOrEqual(4);

  const completionBodies = [
    source.slice(
      source.indexOf("export async function beginPackageInstallSession"),
      source.indexOf("function assertPackageSessionTargets"),
    ),
    source.slice(
      source.indexOf("async function uninstallAppsInternal"),
      source.indexOf("export async function install_app"),
    ),
    source.slice(
      source.indexOf("async function installAppInternal"),
      source.indexOf("function removeAppRuntimeState"),
    ),
    source.slice(
      source.indexOf("async function reconcileCompletedPendingInstall"),
      source.indexOf("export async function abortPendingInstallRecovery"),
    ),
  ];
  for (const body of completionBodies) {
    const verified = body.indexOf(
      body.includes("setCommittedAppsFromRuntime")
        ? "await setCommittedAppsFromRuntime("
        : "await getApps()",
    );
    const committedSignal = body.indexOf("announceRuntimeAuthorityChange({");
    expect(verified).toBeGreaterThan(-1);
    expect(committedSignal).toBeGreaterThan(verified);
  }
});

test("observed runtime replacement retires cached actors before registry reconciliation", async () => {
  const source = await readFile(
    new URL("../src/reducer/apps.ts", import.meta.url),
    "utf8",
  );
  const refresh = source.slice(
    source.indexOf("async function refreshRuntimeAuthorityInternal"),
    source.indexOf("export async function retainFrontendAuthorityAfterDeployFailure"),
  );
  const fence = refresh.indexOf("current.setRuntimeAuthorityFence");
  const reset = refresh.indexOf("await resetNeutronCanBinding()", fence);
  const reconcile = refresh.indexOf("await getApps()", reset);
  expect(fence).toBeGreaterThan(-1);
  expect(reset).toBeGreaterThan(fence);
  expect(reconcile).toBeGreaterThan(reset);
});

test("frontend authority commits reject stale continuations and legacy postflight", async () => {
  const source = await readFile(
    new URL("../src/reducer/apps.ts", import.meta.url),
    "utf8",
  );
  const snapshot = source.slice(
    source.indexOf("async function loadAppRegistrySnapshot"),
    source.indexOf("export type RuntimeAuthorityObservation"),
  );
  const snapshotRevision = snapshot.indexOf(
    "const authorityRevision = useAppsStore.getState().authorityRevision",
  );
  const snapshotGuard = snapshot.indexOf(
    "assertRuntimeAuthorityRevision(authorityRevision)",
  );
  const snapshotCommit = snapshot.indexOf(
    "useAppsStore.getState().setApps(apps",
  );
  const snapshotUnfence = snapshot.lastIndexOf(
    "setRuntimeAuthorityFence(null)",
  );
  expect(snapshotRevision).toBeGreaterThan(-1);
  expect(snapshotGuard).toBeGreaterThan(snapshotRevision);
  expect(snapshotCommit).toBeGreaterThan(snapshotGuard);
  expect(snapshotUnfence).toBeGreaterThan(snapshotCommit);

  const postflight = source.slice(
    source.indexOf("async function setCommittedAppsFromRuntime"),
    source.indexOf(
      "export function assertCurrentBrowserSurfaceOriginAssembler",
    ),
  );
  const postflightRevision = postflight.indexOf(
    "const authorityRevision = useAppsStore.getState().authorityRevision",
  );
  const assemblerCheck = postflight.indexOf(
    "assertCurrentBrowserSurfaceOriginAssembler(finalRuntime.assembler_id)",
  );
  const sidecarParse = postflight.indexOf(
    "parseBrowserSurfaceOriginAuthoritySnapshot(",
  );
  const postflightRetry = postflight.indexOf(
    "useAppsStore.getState().authorityRevision !== authorityRevision",
  );
  const postflightCommit = postflight.indexOf(
    "useAppsStore.getState().setApps(apps",
  );
  const postflightUnfence = postflight.lastIndexOf(
    "setRuntimeAuthorityFence(null)",
  );
  expect(postflightRevision).toBeGreaterThan(-1);
  expect(assemblerCheck).toBeGreaterThan(postflightRevision);
  expect(sidecarParse).toBeGreaterThan(assemblerCheck);
  expect(postflightRetry).toBeGreaterThan(sidecarParse);
  expect(postflightCommit).toBeGreaterThan(postflightRetry);
  expect(postflightUnfence).toBeGreaterThan(postflightCommit);
});

test("manual install and uninstall use a consistent checked deployment baseline", async () => {
  const [source, settingsSource, launcherSource] = await Promise.all([
    readFile(new URL("../src/reducer/apps.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/settings/KernelSettingsPage.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/workspace/Launcher.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const manualConsistentRead = source.slice(
    source.indexOf("async function readConsistentManualInstallBaseline"),
    source.indexOf("async function ensureInstallJournalSettled"),
  );
  expect(manualConsistentRead.match(/kernel_runtime_info\(\)/g)?.length).toBe(
    2,
  );
  expect(
    manualConsistentRead.match(/ensureInstallJournalSettled\(neutron,/g)
      ?.length,
  ).toBe(2);

  const uninstallBody = source.slice(
    source.indexOf("async function uninstallAppsInternal"),
    source.indexOf("export async function install_app"),
  );
  expect(uninstallBody).toContain("expectedDeploymentId");
  expect(uninstallBody).toMatch(
    /compileAppsUninstall\([\s\S]*?deployPreparedPackages\([\s\S]*?expectedDeploymentId/,
  );
  const compileIndex = uninstallBody.indexOf("await compileAppsUninstall");
  const buildRecordIndex = uninstallBody.indexOf(
    "prepareBrowserDeployment",
  );
  const reviewIndex = uninstallBody.indexOf("await requestAppUninstall");
  const cancelledIndex = uninstallBody.indexOf("if (!approved) return null");
  const reviewedBaselineIndex = uninstallBody.indexOf(
    "await readConsistentManualInstallBaseline(neutron)",
    cancelledIndex,
  );
  const revalidatedRemovalIndex = uninstallBody.indexOf(
    "const revalidatedDeployment = await prepareBrowserDeployment",
  );
  const stagingIndex = uninstallBody.indexOf('phase: "staging"');
  const provenanceIndex = uninstallBody.indexOf(
    "removeInstallProvenanceAssets",
  );
  const deployIndex = uninstallBody.indexOf("await deployPreparedPackages");
  expect(compileIndex).toBeGreaterThan(-1);
  expect(buildRecordIndex).toBeGreaterThan(compileIndex);
  expect(reviewIndex).toBeGreaterThan(buildRecordIndex);
  expect(cancelledIndex).toBeGreaterThan(reviewIndex);
  expect(reviewedBaselineIndex).toBeGreaterThan(cancelledIndex);
  expect(revalidatedRemovalIndex).toBeGreaterThan(reviewedBaselineIndex);
  expect(provenanceIndex).toBeGreaterThan(revalidatedRemovalIndex);
  expect(stagingIndex).toBeGreaterThan(provenanceIndex);
  expect(deployIndex).toBeGreaterThan(stagingIndex);
  expect(uninstallBody).not.toContain("await removeInstallProvenanceAssets");
  expect(uninstallBody).toContain("deployment.prepared.recordBytes");
  expect(uninstallBody).toContain(
    "currentBaseline.fingerprint !== baseline.fingerprint",
  );
  expect(uninstallBody).toContain(
    "deployment.prepared.record.warnings.destructive_memory_roots",
  );
  expect(settingsSource).not.toContain("requestAppUninstall");
  expect(launcherSource).not.toContain("requestAppUninstall");
  expect(
    source.match(/vetKeysEnvironment: runtimeCompilerEnvironment\(\)/g),
  ).toHaveLength(3);
  expect(source).toContain(
    'getRuntimeDeployment().target === "pocketic"',
  );

  const compileBody = source.slice(
    source.indexOf("export async function compile_app"),
    source.indexOf("type ManualInstallBaseline"),
  );
  const packageCompileIndex = compileBody.indexOf(
    "await compilePackageInstall",
  );
  const deploymentPrepareIndex = compileBody.indexOf(
    "await prepareBrowserDeployment",
  );
  const publishReviewIndex = compileBody.indexOf(
    "deploymentReview: deployment.review",
  );
  expect(packageCompileIndex).toBeGreaterThan(-1);
  expect(deploymentPrepareIndex).toBeGreaterThan(packageCompileIndex);
  expect(publishReviewIndex).toBeGreaterThan(deploymentPrepareIndex);

  const installBody = source.slice(
    source.indexOf("async function installAppInternal"),
    source.indexOf("function removeAppRuntimeState"),
  );
  expect(installBody).toContain(
    "expectedDeploymentId: currentBaseline.expectedDeploymentId",
  );
  expect(installBody).toContain(
    "deploymentBuildRecord: compileDetails.deployment.prepared.record",
  );
  const finalReviewIndex = installBody.indexOf("await Promise.all");
  const baselineRevalidationIndex = installBody.indexOf(
    "await readConsistentManualInstallBaseline(neutron)",
    finalReviewIndex,
  );
  const evidenceRevalidationIndex = installBody.indexOf(
    "const revalidatedDeployment = await prepareBrowserDeployment",
  );
  const manualStagingIndex = installBody.indexOf('phase: "staging"');
  const provenanceStageIndex = installBody.indexOf(
    "manualInstallProvenanceAssets",
  );
  const manualDeployIndex = installBody.indexOf(
    "await deployPreparedPackages",
  );
  expect(baselineRevalidationIndex).toBeGreaterThan(finalReviewIndex);
  expect(evidenceRevalidationIndex).toBeGreaterThan(
    baselineRevalidationIndex,
  );
  expect(provenanceStageIndex).toBeGreaterThan(evidenceRevalidationIndex);
  expect(manualStagingIndex).toBeGreaterThan(provenanceStageIndex);
  expect(manualDeployIndex).toBeGreaterThan(manualStagingIndex);
  expect(installBody).toContain(
    "compileDetails.deployment.prepared.recordBytes",
  );
  expect(source).toContain(
    "if (!state.compiled?.deploymentReview) return",
  );
});

test("an interrupted install keeps recovery in Settings without blocking the shell", async () => {
  const [appsSource, dialogsSource, settingsSource] = await Promise.all([
    readFile(new URL("../src/reducer/apps.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/AppDialogs.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/settings/KernelSettingsPage.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const getAppsBody = appsSource.slice(
    appsSource.indexOf("export async function getApps"),
    appsSource.indexOf("export async function compile_app"),
  );
  expect(getAppsBody).toContain("readConsistentAppRegistry(neutron)");
  const consistentRegistry = appsSource.slice(
    appsSource.indexOf("async function readConsistentAppRegistry"),
    appsSource.indexOf(
      "export function parseBrowserSurfaceOriginAuthoritySnapshot",
    ),
  );
  expect(consistentRegistry.match(/kernel_runtime_info\(\)/g)?.length).toBe(3);
  expect(consistentRegistry).toContain(
    "readKernelAssetJson<unknown>(BROWSER_SURFACE_ORIGINS_PATH)",
  );
  expect(consistentRegistry).toContain(
    "timeoutMs: PASSIVE_INSTALL_RECOVERY_TIMEOUT_MS",
  );
  expect(consistentRegistry).toContain("let pendingAfter = pendingBefore");
  expect(consistentRegistry).toContain("if (pendingBefore === null)");
  expect(consistentRegistry).toContain(
    "pendingAfter?.deploymentId === finalRuntime.deployment_id",
  );
  expect(appsSource).toContain(
    "kernel_install_abort({ deployment_id: deploymentId })",
  );
  expect(dialogsSource).not.toContain("<AppInstallRecovery");
  expect(settingsSource).toContain("<AppInstallRecoveryPanel />");
  expect(settingsSource).toContain("appMutationBlocked");
  expect(settingsSource).toContain(
    "isAuthorityPendingState(currentApps)",
  );
  expect(settingsSource).toContain(
    "Promise.resolve(currentApps.list)",
  );
  expect(appsSource).toContain(
    "Finish or discard the pending installation before changing installed apps",
  );

  const packageSession = appsSource.slice(
    appsSource.indexOf("export async function beginPackageInstallSession"),
    appsSource.indexOf("function assertPackageSessionTargets"),
  );
  expect(packageSession).toContain(
    "await retainFrontendAuthorityAfterDeployFailure(neutron)",
  );
  expect(packageSession).toContain(
    'kind: mode === "update" ? "update" : "install"',
  );
});

test("kernel local async chains suspend only at external calls", async () => {
  const [main, service, crypto, http, provider, wrapper, manifestText] =
    await Promise.all([
      readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
      readFile(
        new URL("../backend/connections/Service.mo", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../backend/connections/Crypto.mo", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../backend/connections/Http.mo", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../backend/connections/providers/Provider.mo",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
      readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText);

  expect(main).toContain("await* connections.begin");
  expect(main).toContain("await* connections.complete");
  expect(main).toContain("connections.configure(");
  expect(main).toContain("connections.commitConfiguration(");
  expect(service).toContain("declarationLease");
  expect(service).toContain("activeFlowLease");
  expect(service).toContain("lease.active()");
  expect(service).toContain("Memory.removeIncompatible");
  expect(service).toContain("await* Crypto.randomToken");
  expect(service).toContain("await* provider.adapter.exchange");
  expect(crypto).toContain("await IC.management.raw_rand()");
  expect(http).toMatch(/await\s+\(with cycles = OUTCALL_CYCLES\)/);
  expect(provider).toContain(
    "exchange : (Text, Text) -> async* Types.ExchangeResult",
  );
  expect(wrapper).toMatch(/await\*\s+NeutronKernel\.kernel_connections_begin/);
  expect(wrapper).toMatch(/NeutronKernel\.kernel_connections_list/);
  expect(wrapper).not.toMatch(
    /await\*\s+NeutronKernel\.kernel_connections_list/,
  );
  expect(manifest.func.kernel_connections_begin.async).toBe("async*");
  expect(manifest.func.kernel_connections_complete.async).toBe("async*");
  expect(manifest.func.kernel_connections_list).toEqual({
    type: "query",
    async: false,
    arg: ["caller"],
  });
  expect(manifest.func.kernel_connections_acquire.async).toBe("async*");
  expect(manifest.func.kernel_connections_disconnect.async).toBe("async*");
});

test("kernel settings snapshot is authenticated and reports bounded memory", async () => {
  const [service, types, management, main, wrapper, manifestText] =
    await Promise.all([
      readFile(
        new URL("../backend/settings/Service.mo", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../backend/settings/Types.mo", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../backend/aaa_interface.mo", import.meta.url), "utf8"),
      readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
      readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
      readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText);

  expect(service).toContain('import Cycles "mo:core/Cycles"');
  expect(service).toContain('import Prim "mo:prim"');
  expect(service).toContain("Cycles.balance()");
  expect(service).toContain("Prim.rts_memory_size()");
  expect(service).toContain("Prim.rts_heap_size()");
  expect(service).toContain("Prim.rts_stable_memory_size() * WASM_PAGE_BYTES");
  expect(service).toContain(
    "Prim.rts_logical_stable_memory_size() * WASM_PAGE_BYTES",
  );
  expect(types).toContain("stable_memory_bytes : Nat");
  expect(types).toContain("logical_stable_memory_bytes : Nat");
  expect(types).toContain("public type MemorySnapshot");
  expect(service).toContain("IC.management.canister_status");
  expect(service).toContain("status.settings.wasm_memory_limit");
  expect(service).toContain("status.memory_metrics.wasm_memory_size");
  expect(service).toContain("status.memory_metrics.stable_memory_size");
  expect(service).toContain("WASM64_HARD_LIMIT_BYTES : Nat = 6_442_450_944");
  expect(service).toMatch(
    /configuredWasmLimit == 0 or[\s\S]*?configuredWasmLimit > WASM64_HARD_LIMIT_BYTES/,
  );
  expect(service).toContain("canister_id = Principal.fromActor(self)");
  expect(service).toContain("536_870_912_000");
  expect(service).toContain(
    "stable_memory_limit_bytes = STABLE_MEMORY_LIMIT_BYTES",
  );
  expect(management).toContain("wasm_memory_limit : Nat");
  expect(management).toContain("memory_metrics : memory_metrics");
  expect(main).toMatch(
    /public func \/\*query\*\/kernel_settings_snapshot\(\(\)\)\s*:\s*SettingsTypes\.Snapshot/,
  );
  expect(main).toMatch(
    /public func \/\*update\*\/kernel_memory_snapshot[\s\S]*?:\s*async\* SettingsTypes\.MemorySnapshot/,
  );
  expect(main).toMatch(
    /kernel_memory_snapshot\([\s\S]*?\/\*this\*\/ self : actor \{\}[\s\S]*?await\* SettingsService\.memorySnapshot\(self\)/,
  );
  expect(wrapper).toMatch(
    /func kernel_settings_snapshot[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\);[\s\S]*?NeutronKernel\.kernel_settings_snapshot/,
  );
  expect(wrapper).toMatch(
    /func kernel_memory_snapshot[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\);[\s\S]*?await\* NeutronKernel\.kernel_memory_snapshot/,
  );
  expect(manifest.func.kernel_settings_snapshot).toEqual({
    type: "query",
    async: false,
  });
  expect(manifest.func.kernel_memory_snapshot).toEqual({
    type: "update",
    async: "async*",
    arg: ["this"],
  });
  expect(Object.keys(manifest.memory).sort()).toEqual([
    "kernel",
    "kernel_activation",
  ]);
  expect(manifest.memory.kernel.version).toBe(3);
  expect(manifest.memory.kernel.migrations).toBeUndefined();
  expect(manifest.memory.kernel_activation.version).toBe(1);
  expect(manifest.memory.kernel_activation.migrations).toEqual([]);
});

test("kernel access management preserves owner and self-controller recovery", async () => {
  const [access, management, main, wrapper, manifestText] = await Promise.all([
    readFile(new URL("../backend/settings/Access.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/aaa_interface.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  expect(access).toContain("let CONTROLLER_LIMIT : Nat = 10");
  expect(access).toContain("IC.management.canister_status");
  expect(access).toContain("IC.management.update_settings");
  expect(access).toContain("sender_canister_version = null");
  expect(access).not.toContain("Prim.canisterVersion");
  expect(access).toContain("Neutron must remain a controller of itself");
  expect(access).toContain("controllerMutationActive");
  expect(access).toContain("Principal.isAnonymous");
  expect(management).toMatch(
    /canister_status_result[\s\S]*?settings[\s\S]*?controllers\s*:\s*\[Principal\]/,
  );
  expect(management).toMatch(/canister_version\s*:\s*\?Nat64/);
  expect(management).toMatch(/version\s*:\s*\?Nat64/);
  expect(main).toMatch(
    /kernel_authorized_rem[\s\S]*?\/\*caller\*\/ caller[\s\S]*?assert\(not Principal\.equal\(id, caller\)\)/,
  );
  expect(main).toMatch(
    /kernel_authorized_add[\s\S]*?not SettingsAccess\.validPrincipal\(id\)[\s\S]*?Set\.remove\(mem\.core\.authorized, Principal\.compare, id\)/,
  );
  expect(access).toMatch(
    /authorizeFromController[\s\S]*?Principal\.isController\(caller\)[\s\S]*?Set\.add\(authorized, Principal\.compare, principal\)/,
  );
  const controllerRecovery = access.slice(
    access.indexOf("public func authorizeFromController"),
    access.indexOf("public func assertController"),
  );
  const activationControllerCheck = access.slice(
    access.indexOf("public func assertController"),
    access.indexOf("func addControllerUnlocked"),
  );
  expect(controllerRecovery).not.toContain("canister_status");
  expect(controllerRecovery).not.toContain("await");
  expect(activationControllerCheck).toContain("Principal.isController(caller)");
  expect(activationControllerCheck).not.toContain("canister_status");
  expect(activationControllerCheck).not.toContain("await");
  expect(wrapper).toMatch(
    /func kernel_authorized_recover[\s\S]*?NeutronKernel\.kernel_authorized_recover/,
  );
  const recoveryWrapper = wrapper.slice(
    wrapper.indexOf("func kernel_authorized_recover"),
    wrapper.indexOf("func kernel_activation"),
  );
  expect(recoveryWrapper).not.toContain("await*");
  expect(manifest.func.kernel_authorized_recover).toEqual({
    type: "update",
    async: false,
    arg: ["caller"],
    allow: "unauthorized",
  });
  expect(manifest.func.kernel_activation).toEqual({
    type: "update",
    async: false,
    arg: ["caller"],
    allow: "unauthorized",
  });
  for (const method of [
    "kernel_access_snapshot",
    "kernel_controller_add",
    "kernel_controller_rem",
  ]) {
    expect(wrapper).toMatch(
      new RegExp(
        `func ${method}[\\s\\S]*?assert\\(NeutronKernel\\.is_authorized\\(NeutronCaller\\)\\);[\\s\\S]*?await\\* NeutronKernel\\.${method}`,
      ),
    );
    expect(manifest.func[method].async).toBe("async*");
    expect(manifest.func[method].arg).toEqual(["this"]);
  }
});
