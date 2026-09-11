import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { loadMotoko, disposeMotokoCompiler } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import { resolvePocketIcBinary, pocketIcServerArguments } from "../../../../packages/neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, createNeutronPocketIcInstanceConfig } from "../../../../packages/neutron-provision/src/pocketic_rest.ts";
import { managementIdl } from "../../../../packages/neutron-provision/src/idl.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-repository-access-"));
try {
  const sources = await promisify(execFile)("mops", ["sources"]);
  const compiler = await loadMotoko();
  let wasm: Uint8Array;
  try {
    const prepared = await prepareMotokoProgram({
      compiler,
      sourcePath: path.join(import.meta.dir, "repository_access_service_test.mo"),
      packages: parsePackageString(sources.stdout.replace(/\n/g, " ").trim()),
      allowDangerous: true,
    });
    wasm = (await compiler.wasm(prepared.entryPath, "ic")).wasm;
  } finally {
    await disposeMotokoCompiler();
  }

  const binary = await resolvePocketIcBinary({
    cacheDirectory: path.resolve("../../.neutron/cache/bin"),
  });
  const portFile = path.join(temporary, "pocketic.port");
  const server = spawn(binary.path, pocketIcServerArguments(portFile, 60), {
    stdio: "ignore",
  });
  const stopped = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let startupError: Error | undefined;
  server.on("error", (error) => { startupError = error; });
  let client: PocketIcRestClient | undefined;
  let instanceId: number | undefined;
  try {
    const deadline = Date.now() + 30_000;
    let port = "";
    while (!port) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new Error("Repository access PocketIC exited during startup");
      if (Date.now() > deadline) throw new Error("Repository access PocketIC startup timed out");
      port = await fs.readFile(portFile, "utf8").then((value) => value.trim()).catch(() => "");
      if (!port) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const controlUrl = `http://127.0.0.1:${port}/`;
    client = new PocketIcRestClient(controlUrl);
    const config = createNeutronPocketIcInstanceConfig({ profile: "minimal", stateDirectory: path.join(temporary, "state") });
    const response = await fetch(new URL("instances", controlUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...config,
        subnet_config_set: { ...config.subnet_config_set, nns: null, ii: null, test_threshold_keys: null },
        http_gateway_config: null,
        icp_features: { ...config.icp_features, ii: null },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const created = await response.json() as {
      Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } };
    };
    if (!response.ok || !created.Created) throw new Error(`Repository access PocketIC creation failed: ${JSON.stringify(created)}`);
    instanceId = created.Created.instance_id;
    const defaultEffective = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
    const call = async (canisterId: Principal, method: string, payload: Uint8Array, effectivePrincipal = defaultEffective) =>
      client!.awaitIngressMessage(instanceId!, await client!.submitIngressMessage(instanceId!, {
        sender: Principal.anonymous(), canisterId, method, payload, effectivePrincipal,
      }));
    const management = Principal.fromText("aaaaa-aa");
    const methods = new Map(managementIdl({ IDL })._fields);
    const create = methods.get("provisional_create_canister_with_cycles")!;
    const creation = await call(management, "provisional_create_canister_with_cycles", new Uint8Array(IDL.encode(create.argTypes, [{
      amount: [1_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [],
    }])));
    const [canister] = IDL.decode(create.retTypes, creation) as unknown as [{ canister_id: Principal }];
    const effective = { CanisterId: Buffer.from(canister.canister_id.toUint8Array()).toString("base64") };
    const install = methods.get("install_code")!;
    await call(management, "install_code", new Uint8Array(IDL.encode(install.argTypes, [{
      mode: { install: null }, canister_id: canister.canister_id, wasm_module: wasm,
      arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [],
    }])), effective);
    const reply = await call(canister.canister_id, "run", new Uint8Array(IDL.encode([], [])), effective);
    IDL.decode([], reply);
    console.log("Repository access IC test passed");
  } finally {
    try {
      if (client && instanceId !== undefined) await client.deleteInstance(instanceId);
    } finally {
      server.kill("SIGTERM");
      await stopped;
    }
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
