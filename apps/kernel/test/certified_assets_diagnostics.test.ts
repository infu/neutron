import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assemble } from "neutron-compiler/src/assemble.js";
import type { AssemblyManifest } from "neutron-compiler/src/assemble.js";

test("Certified Assets diagnostics is a Kernel-authorized query", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ) as AssemblyManifest;
  manifest.entry = "kernel";

  const diagnostics =
    manifest.func?.kernel_certified_assets_diagnostics;
  expect(diagnostics).toEqual({
    type: "query",
    async: false,
  });

  const wrapper = assemble([manifest]);
  const start = wrapper.indexOf(
    "func kernel_certified_assets_diagnostics",
  );
  expect(start).toBeGreaterThan(-1);
  const nextMethod = wrapper.indexOf("\n    public ", start + 1);
  const method = wrapper.slice(
    start,
    nextMethod === -1 ? wrapper.length : nextMethod,
  );

  expect(method).toContain(
    "assert(NeutronKernel.is_authorized(NeutronCaller));",
  );
  expect(method).toContain(
    "NeutronKernel.kernel_certified_assets_diagnostics(NeutronRequest )",
  );
});

test("Certified Assets diagnostics has a read-only aggregate facade", async () => {
  const [main, service] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(
      new URL("../backend/certified_assets/Service.mo", import.meta.url),
      "utf8",
    ),
  ]);

  expect(main).toMatch(
    /public func \/\*query\*\/kernel_certified_assets_diagnostics\([\s\S]*?certifiedAssets\.diagnostics\(\);/,
  );
  const diagnosticsStart = service.indexOf(
    "public func diagnostics() : Types.Diagnostics",
  );
  expect(diagnosticsStart).toBeGreaterThan(-1);
  const nextMethod = service.indexOf("\n        public func ", diagnosticsStart + 1);
  const method = service.slice(
    diagnosticsStart,
    nextMethod === -1 ? service.length : nextMethod,
  );
  expect(method).toContain("implementation_binding = {");
  expect(method).toContain(
    "mem.authenticated_forest.header.allocator_layout_fingerprint",
  );
  expect(method).toContain("CertV2.responsePolicyTableFingerprint()");
  expect(method).not.toMatch(/:=|Map\.(add|remove)|Allocator\.(allocate|free|write)/);
});
