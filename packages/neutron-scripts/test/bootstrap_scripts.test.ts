import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readJson = async <T>(relativePath: string): Promise<T> =>
  JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8")) as T;

const rootPackage = await readJson<{ scripts: Record<string, string> }>(
  "package.json",
);
const kernelPackage = await readJson<{ scripts: Record<string, string> }>(
  "apps/kernel/package.json",
);
const localConfig = await readJson<{
  target: {
    kind: string;
    profile: string;
    gateway_port: number;
    developer_identity_seed: number;
    authorized_principals: string[];
    nodes: string[];
  };
  artifacts: {
    kind: "inline";
    kernel: { path: string };
    packages: Array<{ path: string }>;
  };
}>("local.ndeploy.json");

test("root local commands delegate only to neutron-provision", () => {
  expect(rootPackage.scripts.provision).toBe(
    "bun packages/neutron-provision/src/index.ts",
  );
  expect(rootPackage.scripts["local:start"]).toBe(
    "bun packages/neutron-provision/src/index.ts local.ndeploy.json serve",
  );
  expect(rootPackage.scripts["local:deploy"]).toBe(
    "bun packages/neutron-provision/src/index.ts local.ndeploy.json reinstall",
  );
  expect(rootPackage.scripts["local:status"]).toBe(
    "bun packages/neutron-provision/src/index.ts local.ndeploy.json status",
  );

  for (const removed of [
    "local:package",
    "local:bootstrap:kernel",
    "local:bootstrap",
    "local:update-source",
    "local:services",
    "local:ledgers",
    "local:setup",
    "local:dispenser",
    "local:repository:links",
    "icp:build",
  ]) {
    expect(rootPackage.scripts).not.toHaveProperty(removed);
  }
  expect(Object.keys(kernelPackage.scripts).some((name) => name.startsWith("icp:"))).toBe(false);
  expect(kernelPackage.scripts).not.toHaveProperty("boot");
  expect(kernelPackage.scripts).not.toHaveProperty("build:boot");
  expect(kernelPackage.scripts).not.toHaveProperty("dispenser:local");
});

test("one PocketIC config describes the complete local app set", () => {
  expect(localConfig.target).toEqual({
    kind: "pocketic",
    profile: "minimal",
    gateway_port: 8000,
    developer_identity_seed: 2,
    authorized_principals: [
      "pbwxr-uqxlv-aiwi3-omw2n-ptdex-kyifb-kdsn6-zdiyd-ggzpu-nrzik-rqe",
    ],
    nodes: ["local"],
  });
  expect(localConfig.artifacts.kind).toBe("inline");
  expect(localConfig.artifacts.kernel).toEqual({
    path: "apps/kernel/kernel.v0.3.6.neutron",
  });
  const paths = localConfig.artifacts.packages.map(({ path }) => path);
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toContain("apps/vfs/files.v0.4.5.neutron");
  expect(paths).toContain("apps/spreadsheet/spreadsheet.v0.3.1.neutron");
  expect(paths).toContain("apps/hullshift/hullshift.v0.2.1.neutron");
  expect(paths).toContain("apps/mysubnet/mysubnet.v0.3.1.neutron");
});

test("root validation and packaging cover every locally selected app", async () => {
  const archivePaths = [
    localConfig.artifacts.kernel.path,
    ...localConfig.artifacts.packages.map(({ path: archivePath }) => archivePath),
  ];
  for (const archivePath of archivePaths) {
    const workspace = await readJson<{
      name: string;
      scripts: Record<string, string>;
    }>(path.join(path.dirname(archivePath), "package.json"));
    expect(workspace.scripts.validate).toBeDefined();
    expect(workspace.scripts.package).toBeDefined();
    expect(rootPackage.scripts.validate).toContain(
      `npm --workspace ${workspace.name} run validate`,
    );
    expect(rootPackage.scripts.package).toContain(
      `npm --workspace ${workspace.name} run package`,
    );
  }
});
