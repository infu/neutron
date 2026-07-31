import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { readFile } from "node:fs/promises";
import {
  assertDispenserTargetSubnet,
  dispenserInstallArgsText,
  encodeDispenserInstallArgs,
  PRODUCTION_DISPENSER_TARGET_SUBNET,
} from "../deployment_target.ts";

test("ICP build uses the shared vendored-Wasm compiler and preserves its output path", async () => {
  const [recipe, compiler] = await Promise.all([
    readFile(new URL("../icp.yaml", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../../packages/neutron-scripts/src/compile_motoko.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  expect(recipe).toContain(
    'bun ../../packages/neutron-scripts/src/compile_motoko.ts --source mo/main.mo --output "$ICP_WASM_OUTPUT_PATH"',
  );
  expect(recipe).not.toMatch(/toolchain\s+bin\s+moc|--fallback/);
  expect(compiler).toContain('loadMotoko');
  expect(compiler).toContain('run("mops", ["sources"]');
  expect(compiler).not.toMatch(/toolchain\s+bin\s+moc|process\.env\.MOC/);
});

test("deployment supplies the child target subnet as the backend install argument", async () => {
  const [backend, localDeployment, productionDeployment] = await Promise.all([
    readFile(new URL("../mo/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../local_deploy.ts", import.meta.url), "utf8"),
    readFile(new URL("../production_deploy.ts", import.meta.url), "utf8"),
  ]);

  const [decoded] = IDL.decode(
    [IDL.Principal],
    encodeDispenserInstallArgs(PRODUCTION_DISPENSER_TARGET_SUBNET),
  );
  expect((decoded as unknown as Principal).toText()).toBe(
    PRODUCTION_DISPENSER_TARGET_SUBNET,
  );
  expect(
    dispenserInstallArgsText(PRODUCTION_DISPENSER_TARGET_SUBNET),
  ).toBe(`(principal "${PRODUCTION_DISPENSER_TARGET_SUBNET}")`);

  expect(backend).toContain(
    "persistent actor class Self<system>(installTargetSubnet : Principal)",
  );
  expect(backend).toContain(
    "private let targetSubnet : Principal = do",
  );
  expect(backend).toContain(
    "assert(not Principal.isAnonymous(installTargetSubnet))",
  );
  expect(backend).toContain(
    "public query func dispenser_target_subnet() : async Principal",
  );
  expect(backend).toContain(
    "subnet_selection = ?#Subnet({ subnet = targetSubnet })",
  );
  expect(backend).not.toContain(PRODUCTION_DISPENSER_TARGET_SUBNET);
  expect(localDeployment).toContain(
    "runtime.topology.subnetIds.Application",
  );
  expect(localDeployment).toContain("assertDispenserTargetSubnet");
  expect(productionDeployment).toContain(
    "PRODUCTION_DISPENSER_TARGET_SUBNET",
  );
  expect(productionDeployment).toContain("assertDispenserTargetSubnet");
  expect(typeof assertDispenserTargetSubnet).toBe("function");
});
