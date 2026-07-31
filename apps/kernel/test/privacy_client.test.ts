import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("kernel package assets use the HTTP asset reader", async () => {
  const [auth, apps, expose, backend, wrapper, manifestText] = await Promise.all([
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
    /function getJsonCanister[\s\S]*?return getNeutronDynamicCan\(\)/,
  );
  expect(expose).toMatch(
    /function getJsonCanister[\s\S]*?return getIC\(\)\(canister\)/,
  );
  expect(expose).toMatch(
    /const target = await getJsonCanister\(canister\);[\s\S]*?assertValidCall\(target, logicalMethod, methodArgs\)/,
  );
  expect(expose).toContain("validateMethodInput(target, method, args)");
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
