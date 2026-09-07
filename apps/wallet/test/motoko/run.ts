import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import {
  getDependencies,
  parsePackageString,
  walkReplace,
  type DependencyCache,
  type HashFiles,
} from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const cwd = process.cwd();
const testRoot = path.resolve("test/motoko");
const compiledIcTests = [
  "transfer_journal_test.mo",
  "bridge_test.mo",
  "bridge_replacements_test.mo",
  "bridge_provider_test.mo",
  "bridge_activity_main_test.mo",
  "transfer_main_test.mo",
  "direct_withdrawal_main_test.mo",
  "funding_main_test.mo",
  "settlement_test.mo",
  "native_settlement_main_test.mo",
  "refund_test.mo",
  "erc20_refund_main_test.mo",
];
const availableTests = [
  "catalog_test.mo",
  "allowances_test.mo",
  "funding_test.mo",
  "history_test.mo",
  ...compiledIcTests,
];
const requestedTests = process.argv.slice(2);
const testFiles = requestedTests.length === 0 ? availableTests : requestedTests;
for (const testFile of testFiles) {
  if (!availableTests.includes(testFile)) {
    throw new Error(`Unknown Wallet Motoko test: ${testFile}`);
  }
}
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wallet-motoko-test-"),
);

try {
  const sourceOutput = await execute("mops", ["sources"], { cwd });
  const packages = parsePackageString(
    sourceOutput.stdout.replace(/\n/g, " ").trim(),
  );
  const wasmtime = await resolveWasmtime();
  for (const testFile of testFiles) {
    const mo = await loadMotoko();
    try {
      const hashfiles: HashFiles = {};
      const cache: DependencyCache = {};
      const dependencies = await getDependencies(
        null,
        path.join(testRoot, testFile),
        packages,
        hashfiles,
        cache,
      );
      const used: string[] = [];
      const [, entry] = walkReplace(dependencies, hashfiles, used, {
        allowDangerous: true,
      });
      for (const hash of new Set(used)) {
        await mo.write(`${hash}.mo`, hashfiles[hash]!.content);
      }
      // Async Candid calls require the compiled IC runtime: WASI has no send
      // capability and the Motoko interpreter does not implement to_candid.
      if (compiledIcTests.includes(testFile)) {
        const compiled = await mo.wasm(`${entry}.mo`, "ic");
        await runIcTest(compiled.wasm, temporary);
        console.log(`Motoko test passed: ${testFile}`);
        continue;
      }
      const compiled = await mo.wasm(`${entry}.mo`, "wasi");
      const wasmPath = path.join(temporary, testFile.replace(/\.mo$/, ".wasm"));
      await fs.writeFile(wasmPath, compiled.wasm);
      await execute(wasmtime, ["-W", "memory64=y", wasmPath]);
      console.log(`Motoko test passed: ${testFile}`);
    } finally {
      await disposeMotokoCompiler();
    }
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

async function runIcTest(wasm: Uint8Array, temporary: string): Promise<void> {
  const actorTemporary = await fs.mkdtemp(path.join(temporary, "ic-"));
  const [{ IDL }, { Principal }, binaryTools, { PocketIcRestClient, createNeutronPocketIcInstanceConfig }, { managementIdl }] = await Promise.all([
    import("@dfinity/candid"),
    import("@dfinity/principal"),
    import("../../../../packages/neutron-provision/src/pocketic_binary.ts"),
    import("../../../../packages/neutron-provision/src/pocketic_rest.ts"),
    import("../../../../packages/neutron-provision/src/idl.ts"),
  ]);
  const binary = await binaryTools.resolvePocketIcBinary({
    cacheDirectory: path.resolve("../../.neutron/cache/bin"),
  });
  const portFile = path.join(actorTemporary, "pocketic.port");
  const server = spawn(binary.path, binaryTools.pocketIcServerArguments(portFile, 60), {
    stdio: "ignore",
  });
  const stopped = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let startupError: Error | undefined;
  server.on("error", (error) => { startupError = error; });
  let client: InstanceType<typeof PocketIcRestClient> | undefined;
  let instanceId: number | undefined;
  try {
    const deadline = Date.now() + 30_000;
    let port = "";
    while (!port) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new Error("PocketIC test server exited during startup");
      if (Date.now() > deadline) throw new Error("PocketIC test server startup timed out");
      port = await fs.readFile(portFile, "utf8").then((value) => value.trim()).catch(() => "");
      if (!port) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const controlUrl = `http://127.0.0.1:${port}/`;
    client = new PocketIcRestClient(controlUrl);
    // This disposable test instance has no gateway and cannot affect the
    // workspace's persistent local deployment or any production canister.
    const config = createNeutronPocketIcInstanceConfig({ profile: "minimal", stateDirectory: path.join(actorTemporary, "state") });
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
    const responseText = await response.text();
    if (!response.ok) throw new Error(`PocketIC test instance creation failed: ${response.status} ${responseText}`);
    const created = JSON.parse(responseText) as {
      Created?: { instance_id: number; topology: { default_effective_canister_id: { canister_id: string } } };
    };
    if (!response.ok || !created.Created) throw new Error(`PocketIC test instance creation failed: ${JSON.stringify(created)}`);
    instanceId = created.Created.instance_id;
    const effectivePrincipal = { CanisterId: created.Created.topology.default_effective_canister_id.canister_id };
    const management = Principal.fromText("aaaaa-aa");
    const methods = new Map(managementIdl({ IDL })._fields);
    const call = async (canisterId: ReturnType<typeof Principal.fromText>, method: string, payload: Uint8Array, effective = effectivePrincipal) =>
      client!.awaitIngressMessage(instanceId!, await client!.submitIngressMessage(instanceId!, {
        sender: Principal.anonymous(), canisterId, method, payload, effectivePrincipal: effective,
      }));
    const createMethod = methods.get("provisional_create_canister_with_cycles")!;
    const createReply = await call(management, "provisional_create_canister_with_cycles", new Uint8Array(IDL.encode(createMethod.argTypes, [{
      amount: [1_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [],
    }])));
    const [canister] = IDL.decode(createMethod.retTypes, createReply) as unknown as [{ canister_id: ReturnType<typeof Principal.fromText> }];
    const effectiveCanister = { CanisterId: Buffer.from(canister.canister_id.toUint8Array()).toString("base64") };
    const installMethod = methods.get("install_code")!;
    await call(management, "install_code", new Uint8Array(IDL.encode(installMethod.argTypes, [{
      mode: { install: null }, canister_id: canister.canister_id, wasm_module: wasm,
      arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [],
    }])), effectiveCanister);
    const reply = await call(canister.canister_id, "run", new Uint8Array(IDL.encode([], [])), effectiveCanister);
    IDL.decode([], reply);
  } finally {
    try {
      if (client && instanceId !== undefined) await client.deleteInstance(instanceId);
    } finally {
      server.kill("SIGTERM");
      await stopped;
    }
  }
}

async function resolveWasmtime(): Promise<string> {
  const configured = process.env.WASMTIME;
  if (configured) {
    await fs.access(configured, fs.constants.X_OK);
    return configured;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "wasmtime");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  const entries = (await fs.readdir("/nix/store"))
    .filter((entry) => entry.includes("-wasmtime-"))
    .sort()
    .reverse();
  for (const entry of entries) {
    const candidate = path.join("/nix/store", entry, "bin", "wasmtime");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("wasmtime is required to execute Motoko unit tests");
}
