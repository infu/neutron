import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("kernel package assets use the HTTP asset reader", async () => {
  const [auth, apps, expose, backend, wrapper, manifestText] =
    await Promise.all([
      readFile(new URL("../src/reducer/auth.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/reducer/apps.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/expose.ts", import.meta.url), "utf8"),
      readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
      readFile(new URL("../backend/_neutron.mo", import.meta.url), "utf8"),
      readFile(new URL("../neutron.json", import.meta.url), "utf8"),
    ]);
  const manifest = JSON.parse(manifestText) as {
    func: Record<string, { allow?: string }>;
  };

  expect(auth).toContain("async function fetchKernelAsset(key: string)");
  expect(auth).toContain("const response = await fetch(key)");
  expect(auth).toContain('readKernelAssetText("/pkg/neutron.did")');
  expect(auth).not.toContain("createCertifiedAssetReader");
  expect(apps).toContain(
    'readKernelAssetJson<AppRegistry>("/system/apps.json")',
  );
  expect(apps).toContain("readInstallProvenance()");
  expect(apps).toContain("fetchText: async (path)");
  expect(apps).toContain("value = await readKernelAssetText(path)");
  expect(expose).not.toContain('readKernelAssetText("/pkg/neutron.did")');
  expect(expose).toMatch(
    /function getNeutronJsonCanister[\s\S]*?return getNeutronDynamicCan\(\)/,
  );
  expect(auth).toMatch(
    /function getLegacyExternalDynamicCan[\s\S]*?const ownerIdentity = activeIdentity[\s\S]*?createExternalIcblastClient\(\{[\s\S]*?identity: ownerIdentity[\s\S]*?assertAuthority[\s\S]*?allowNumberedPrincipals: true[\s\S]*?\}\)\(canister\)/,
  );
  expect(auth).not.toContain("legacyAuthorityAssertions");
  expect(auth).not.toContain("function getIC");
  expect(auth).toMatch(
    /function getStrictExternalDynamicCan[\s\S]*?getStrictExternalDiscoveryCan[\s\S]*?identity: ownerIdentity[\s\S]*?allowNumberedPrincipals: false/,
  );
  expect(auth).toMatch(
    /function getStrictExternalDiscoveryCan[\s\S]*?allowNumberedPrincipals: false/,
  );
  expect(auth).toMatch(
    /const underlyingFetch = browserFetch\.bind\(globalThis\)[\s\S]*?function checkedFetch[\s\S]*?assertAuthority\(\);[\s\S]*?underlyingFetch\(\.\.\.args\)/,
  );
  expect(expose).not.toContain("getIC()(canister)");
  expect(expose).toMatch(
    /function prepareLegacyExternalCall[\s\S]*?assertValidCall\(target, method, args\)[\s\S]*?requireLegacyIcblastActorMethod/,
  );
  expect(expose).toMatch(
    /function prepareStrictExternalCall[\s\S]*?EXTERNAL_ICBLAST_JSON_OPTIONS[\s\S]*?requireStrictIcblastActorMethod[\s\S]*?targetMethod\.prepare\(\.\.\.args\)[\s\S]*?reviewArgs[\s\S]*?prepared\.invoke\(\)/,
  );
  expect(expose).toMatch(
    /strictExternalCanisterPolicy[\s\S]*?loadSchemaTarget: loadStrictExternalDiscoveryTarget[\s\S]*?loadCallTarget: loadStrictExternalTarget/,
  );
  expect(expose).toMatch(
    /validateMethodInput\(target, method, args, options\)/,
  );
  expect(expose).toMatch(
    /explainMethodSchema\(target, method, EXTERNAL_ICBLAST_JSON_OPTIONS\)/,
  );
  expect(expose).toMatch(
    /defineCanisterSchemaTool\("canister\.schema", legacyExternalCanisterPolicy\)[\s\S]*?defineCanisterSchemaTool\("canister\.schema_v2", strictExternalCanisterPolicy\)/,
  );
  expect(expose).toMatch(
    /defineCanisterCallDialogTool\([\s\S]*?"canister\.call_dialog",[\s\S]*?legacyExternalCanisterPolicy[\s\S]*?defineCanisterCallDialogTool\([\s\S]*?"canister\.call_dialog_v2",[\s\S]*?strictExternalCanisterPolicy/,
  );
  expect(expose.match(/kind: "signed_canister_call"/gu)).toHaveLength(1);
  expect(backend).toContain("supportedHttpCertificationVersion(");
  expect(backend).toContain("cbFunc = self.http_request_streaming_callback");
  expect(backend).toContain(
    "/*query:unauthorized*/http_request_streaming_callback(",
  );
  expect(manifest.func.http_request_streaming_callback?.allow).toBe(
    "unauthorized",
  );
  expect(wrapper).toMatch(
    /func http_request_streaming_callback[\s\S]*?NeutronKernel\.http_request_streaming_callback\(NeutronRequest \)/,
  );
  expect(wrapper).toMatch(
    /func kernel_runtime_info[\s\S]*?assert\(NeutronKernel\.is_authorized\(NeutronCaller\)\)/,
  );

  expect(manifest.func.kernel_static_read).toBeUndefined();
  for (const source of [auth, apps, expose, backend, wrapper, manifestText]) {
    expect(source).not.toContain("kernel_static_read");
  }
});
