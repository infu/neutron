import { execFile as callbackExecFile, spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpAgent, type Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { Secp256k1KeyIdentity } from "@icp-sdk/core/identity/secp256k1";
import { preparePackageInstall } from "neutron-compiler/src/install.js";
import {
  createKernelRuntimeConfig,
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  isolatedFrameOriginTemplate,
} from "neutron-tools/src/runtime_config.js";
import { compileMotokoWithCandid } from "neutron-scripts/src/compile_motoko.js";
import {
  prepareDeployment,
  sha256Hex,
  type PackageArtifact,
} from "neutron-provision/src/artifact.js";
import {
  assertStarterSelectionMatchesDeployment,
  loadStarterSelection,
  type StarterSelection,
} from "./starter.ts";
import {
  assertDispenserTargetSubnet,
  dispenserInstallArgsText,
  PRODUCTION_DISPENSER_TARGET_SUBNET,
} from "./deployment_target.ts";
import { stageStarterPayload, type StarterInfo } from "./starter_payload.ts";

const execFile = promisify(callbackExecFile);
const dispenserRoot = import.meta.dir;
const repositoryRoot = path.resolve(dispenserRoot, "../..");
const icpCliCanisterIdsPath = path.join(
  dispenserRoot,
  ".icp/data/mappings/ic.ids.json",
);
const backendWasmPath = path.join(
  dispenserRoot,
  ".icp/cache/dispenser-production.wasm",
);
const statePath = path.join(
  repositoryRoot,
  ".neutron/dispenser-production.json",
);
const runtimeCanisterMarker = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const defaultIdentityName = "dispenser-mainnet";

type ProductionCanisterIds = {
  backend: string;
  frontend: string;
};

type ProductionOptions = ProductionCanisterIds & {
  identityName: string;
  mode: "all" | "starter-only" | "frontend-only";
};

type CanisterStatus = {
  id: string;
  settings: {
    controllers: string[];
  };
  module_hash: string | null;
  cycles: string;
};

type ProductionReceipt = {
  schema: 1;
  backend_canister_id: string;
  backend_module_sha256: string;
  frontend_canister_id: string;
  frontend_module_sha256: string;
  controller: string;
  subnet: string;
  starter: {
    revision: string;
    deployment_id: string;
    app_ids: string[];
    wasm_bytes: string;
    wasm_sha256: string;
    files: string;
    file_chunks: string;
    backend_call_target_principals: string[];
    packages: PackageArtifact[];
  };
  updated_at: string;
};

const productionSubnet = PRODUCTION_DISPENSER_TARGET_SUBNET;

async function main(): Promise<void> {
  const options = await parseProductionArgs(process.argv.slice(2));
  const controller = await cliIdentityPrincipal(options.identityName);

  const statuses = await Promise.all([
    canisterStatus(options.backend, options.identityName),
    canisterStatus(options.frontend, options.identityName),
  ]);
  assertControlledBy(statuses[0], controller, "dispenser backend");
  assertControlledBy(statuses[1], controller, "dispenser frontend");

  if (options.mode === "frontend-only") {
    await deployFrontend(options);
    return;
  }

  const selection = await loadStarterSelection();
  const expectedArtifacts = await deriveStarterPackagePins(selection);
  console.log(
    `Preparing production SushiOS starter with ${selection.apps.length} apps: ${selection.apps
      .map(({ id }) => id)
      .join(", ")}`,
  );
  const deployment = await prepareDeployment(selection.packagePaths, {
    target: "production",
    expectedArtifacts,
  });
  assertStarterSelectionMatchesDeployment(selection, deployment);
  console.log(
    `Prepared starter deployment ${deployment.compiled.deploymentId} (${deployment.transportWasm.byteLength} compressed Wasm bytes)`,
  );

  let backendModuleSha256 = statuses[0].module_hash;
  if (options.mode === "all") {
    await mkdir(path.dirname(backendWasmPath), { recursive: true });
    console.log("Compiling the production dispenser backend");
    await compileMotokoWithCandid({
      sourcePath: "mo/main.mo",
      outputPath: path.relative(dispenserRoot, backendWasmPath),
      cwd: dispenserRoot,
    });
    const backendWasm = new Uint8Array(await readFile(backendWasmPath));
    backendModuleSha256 = sha256Hex(backendWasm);
    await installBackendIfNeeded({
      options,
      current: statuses[0],
      expectedModuleSha256: backendModuleSha256,
    });
  } else if (backendModuleSha256 === null) {
    throw new Error(
      "The production dispenser backend is empty; run production:deploy before production:starter:set",
    );
  }

  const identity = await loadCliIdentity(options.identityName);
  if (identity.getPrincipal().toText() !== controller) {
    throw new Error(
      "Exported CLI identity does not match its reported principal",
    );
  }
  const agent = await HttpAgent.create({
    host: IC_RUNTIME_GATEWAY,
    identity: identity as unknown as Identity,
    verifyQuerySignatures: true,
  });
  if ((await agent.getPrincipal()).toText() !== controller) {
    throw new Error("Production agent is not using the dispenser controller");
  }
  await assertDispenserTargetSubnet({
    agent,
    canisterId: options.backend,
    expectedTargetSubnet: productionSubnet,
  });

  const starter = await stageStarterPayload({
    agent,
    canisterId: options.backend,
    deployment,
    appIds: selection.packageIds,
    runtimeConfigTemplate: {
      segments: productionRuntimeConfigTemplateSegments(
        deployment.compiled.deploymentId,
      ),
    },
  });

  let frontendModuleSha256 = statuses[1].module_hash;
  if (options.mode === "all") {
    await deployFrontend(options);
    frontendModuleSha256 = (
      await canisterStatus(options.frontend, options.identityName)
    ).module_hash;
  }
  if (backendModuleSha256 === null || frontendModuleSha256 === null) {
    throw new Error("Production deployment did not install both canisters");
  }
  await writeProductionReceipt({
    options,
    controller,
    backendModuleSha256,
    frontendModuleSha256,
    starter,
    packages: deployment.packageArtifacts,
  });

  console.log("");
  console.log(`Dispenser backend:  ${options.backend}`);
  console.log(`Dispenser frontend: ${options.frontend}`);
  console.log(`Starter deployment: ${starter.deployment_id}`);
  console.log(`Open: https://${options.frontend}.icp0.io/`);
}

async function deriveStarterPackagePins(
  selection: StarterSelection,
): Promise<PackageArtifact[]> {
  const artifacts = await Promise.all(
    selection.packagePaths.map(async (packagePath, index) => {
      const archive = new Uint8Array(await readFile(packagePath));
      const prepared = preparePackageInstall(archive);
      const artifact: PackageArtifact = {
        path: path.resolve(packagePath),
        id: prepared.manifest.id,
        version: prepared.manifest.version,
        sha256: sha256Hex(archive),
        bytes: archive.byteLength,
      };
      if (artifact.id !== selection.packageIds[index]) {
        throw new Error(
          `Starter archive ${packagePath} contains ${artifact.id}, expected ${selection.packageIds[index]}`,
        );
      }
      return artifact;
    }),
  );
  console.log("Pinned rebuilt starter archives:");
  for (const artifact of artifacts) {
    console.log(
      `  ${artifact.id}@${artifact.version} ${artifact.sha256} (${artifact.bytes} bytes)`,
    );
  }
  return artifacts;
}

async function installBackendIfNeeded({
  options,
  current,
  expectedModuleSha256,
}: {
  options: ProductionOptions;
  current: CanisterStatus;
  expectedModuleSha256: string;
}): Promise<void> {
  if (current.module_hash === expectedModuleSha256) {
    console.log(
      `Production dispenser backend already has module ${expectedModuleSha256}`,
    );
    return;
  }
  if (current.module_hash !== null) {
    throw new Error(
      `Production dispenser backend has unexpected module ${current.module_hash}; refusing an implicit upgrade`,
    );
  }
  console.log(
    `Installing dispenser backend ${expectedModuleSha256} into ${options.backend}`,
  );
  await runCommand(
    "icp",
    [
      "canister",
      "install",
      "-n",
      "ic",
      "--identity",
      options.identityName,
      options.backend,
      "--mode",
      "install",
      "--wasm",
      backendWasmPath,
      "--args",
      dispenserInstallArgsText(productionSubnet),
      "--yes",
    ],
    { cwd: dispenserRoot },
  );
  const installed = await canisterStatus(options.backend, options.identityName);
  if (installed.module_hash !== expectedModuleSha256) {
    throw new Error(
      `Installed backend module ${installed.module_hash ?? "none"} does not match ${expectedModuleSha256}`,
    );
  }
}

async function deployFrontend(options: ProductionOptions): Promise<void> {
  const cliMapping = await loadIcpCliCanisterIds();
  if (
    cliMapping.backend !== options.backend ||
    cliMapping.frontend !== options.frontend
  ) {
    throw new Error(
      "The production options do not match .icp/data/mappings/ic.ids.json; refusing to let icp deploy target another canister",
    );
  }
  console.log(
    `Building and deploying dispenser UI ${options.frontend} for backend ${options.backend}`,
  );
  await runCommand(
    "icp",
    [
      "deploy",
      "frontend",
      "--environment",
      "ic",
      "--identity",
      options.identityName,
      "--yes",
    ],
    {
      cwd: dispenserRoot,
      env: {
        ...process.env,
        DISPENSER_CANISTER_ID: options.backend,
        LOCAL: "false",
      },
    },
  );
  const status = await canisterStatus(options.frontend, options.identityName);
  if (status.module_hash === null) {
    throw new Error("Dispenser UI canister is still empty after deployment");
  }
  await verifyFrontend(options);
}

async function verifyFrontend(options: ProductionOptions): Promise<void> {
  const origin = `https://${options.frontend}.icp0.io`;
  const response = await fetch(`${origin}/?deployment=${Date.now()}`, {
    redirect: "manual",
    cache: "no-store",
  });
  if (response.status !== 200) {
    throw new Error(
      `Production dispenser frontend returned HTTP ${response.status}`,
    );
  }
  const html = await response.text();
  if (!html.includes("<title>SushiOS")) {
    throw new Error(
      "Production dispenser frontend did not return its index page",
    );
  }
  const scriptPath = frontendScriptPath(html);
  const scriptResponse = await fetch(
    `${origin}${scriptPath}?deployment=${Date.now()}`,
    { cache: "no-store" },
  );
  if (!scriptResponse.ok) {
    throw new Error(
      `Production dispenser bundle returned HTTP ${scriptResponse.status}`,
    );
  }
  const script = await scriptResponse.text();
  if (!script.includes(options.backend)) {
    throw new Error(
      "Production dispenser bundle is not bound to the expected backend",
    );
  }
}

function frontendScriptPath(html: string): string {
  const match = html.match(
    /<script[^>]+src=["']([^"']+main\.js[^"']*)["'][^>]*>/iu,
  );
  if (match?.[1] === undefined) {
    throw new Error("Production dispenser index does not load main.js");
  }
  const url = new URL(match[1], "https://dispenser.invalid/");
  return url.pathname;
}

function productionRuntimeConfigTemplateSegments(
  deploymentId: string,
): string[] {
  const template = createKernelRuntimeConfig({
    target: "ic",
    gateway: IC_RUNTIME_GATEWAY,
    identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
    canister_id: runtimeCanisterMarker,
    deployment_id: deploymentId,
    root_key_policy: "mainnet",
    allow_loopback_http: false,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "ic",
      runtimeCanisterMarker,
    ),
    update_source_origin: null,
  });
  const segments = JSON.stringify(template).split(runtimeCanisterMarker);
  if (segments.length !== 3) {
    throw new Error(
      "IC runtime template did not contain exactly two canister bindings",
    );
  }
  return segments;
}

async function loadCliIdentity(
  identityName: string,
): Promise<Secp256k1KeyIdentity> {
  const { stdout } = await execFile("icp", [
    "identity",
    "export",
    identityName,
  ]);
  return Secp256k1KeyIdentity.fromSecretKey(pkcs8Secp256k1SecretKey(stdout));
}

export function pkcs8Secp256k1SecretKey(pem: string): Uint8Array {
  const match = pem
    .trim()
    .match(
      /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PRIVATE KEY-----$/u,
    );
  if (match?.[1] === undefined) {
    throw new Error("CLI identity must be an unencrypted PKCS#8 private key");
  }
  const bytes = new Uint8Array(
    Buffer.from(match[1].replace(/\s/gu, ""), "base64"),
  );
  const top = readDerNode(bytes, 0);
  if (top.tag !== 0x30 || top.end !== bytes.byteLength) {
    throw new Error("CLI identity PKCS#8 envelope is invalid");
  }
  const topChildren = readDerChildren(bytes, top);
  if (topChildren.length !== 3) {
    throw new Error("CLI identity PKCS#8 fields are invalid");
  }
  const algorithm = topChildren[1]!;
  if (algorithm.tag !== 0x30) {
    throw new Error("CLI identity algorithm is invalid");
  }
  const algorithmFields = readDerChildren(bytes, algorithm);
  if (
    algorithmFields.length !== 2 ||
    algorithmFields[0]!.tag !== 0x06 ||
    algorithmFields[1]!.tag !== 0x06 ||
    derContentHex(bytes, algorithmFields[0]!) !== "2a8648ce3d0201" ||
    derContentHex(bytes, algorithmFields[1]!) !== "2b8104000a"
  ) {
    throw new Error("CLI identity is not a secp256k1 private key");
  }
  const privateKeyWrapper = topChildren[2]!;
  if (privateKeyWrapper.tag !== 0x04) {
    throw new Error("CLI identity private-key wrapper is invalid");
  }
  const ecPrivateKey = readDerNode(bytes, privateKeyWrapper.contentStart);
  if (ecPrivateKey.tag !== 0x30 || ecPrivateKey.end !== privateKeyWrapper.end) {
    throw new Error("CLI identity EC private key is invalid");
  }
  const ecFields = readDerChildren(bytes, ecPrivateKey);
  const secret = ecFields[1];
  if (ecFields.length < 2 || secret?.tag !== 0x04) {
    throw new Error("CLI identity EC secret is missing");
  }
  const result = bytes.slice(secret.contentStart, secret.end);
  if (result.byteLength !== 32) {
    throw new Error("CLI identity secp256k1 secret must contain 32 bytes");
  }
  return result;
}

type DerNode = {
  tag: number;
  contentStart: number;
  end: number;
};

function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset + 2 > bytes.length
  ) {
    throw new Error("CLI identity contains truncated DER");
  }
  const tag = bytes[offset]!;
  const firstLength = bytes[offset + 1]!;
  let contentStart = offset + 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes < 1 ||
      lengthBytes > 4 ||
      contentStart + lengthBytes > bytes.length
    ) {
      throw new Error("CLI identity contains an invalid DER length");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[contentStart + index]!;
    }
    contentStart += lengthBytes;
  }
  const end = contentStart + length;
  if (end > bytes.length) {
    throw new Error("CLI identity contains a truncated DER value");
  }
  return { tag, contentStart, end };
}

function readDerChildren(bytes: Uint8Array, parent: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerNode(bytes, offset);
    if (child.end > parent.end) {
      throw new Error("CLI identity contains an out-of-bounds DER child");
    }
    children.push(child);
    offset = child.end;
  }
  return children;
}

function derContentHex(bytes: Uint8Array, node: DerNode): string {
  return Buffer.from(bytes.slice(node.contentStart, node.end)).toString("hex");
}

async function cliIdentityPrincipal(identityName: string): Promise<string> {
  const { stdout } = await execFile("icp", [
    "identity",
    "principal",
    "--identity",
    identityName,
  ]);
  return Principal.fromText(stdout.trim()).toText();
}

async function canisterStatus(
  canisterId: string,
  identityName: string,
): Promise<CanisterStatus> {
  const { stdout } = await execFile("icp", [
    "canister",
    "status",
    "-n",
    "ic",
    "--identity",
    identityName,
    canisterId,
    "--json",
  ]);
  const value = JSON.parse(stdout) as unknown;
  if (
    !isRecord(value) ||
    value.id !== canisterId ||
    !isRecord(value.settings) ||
    !Array.isArray(value.settings.controllers) ||
    !value.settings.controllers.every(
      (controller) => typeof controller === "string",
    ) ||
    (value.module_hash !== null && typeof value.module_hash !== "string") ||
    typeof value.cycles !== "string"
  ) {
    throw new Error(`Canister status for ${canisterId} is invalid`);
  }
  const status = value as CanisterStatus;
  return {
    ...status,
    module_hash: normalizeModuleHash(status.module_hash, canisterId),
  };
}

function normalizeModuleHash(
  value: string | null,
  canisterId: string,
): string | null {
  if (value === null) return null;
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Canister ${canisterId} returned an invalid module hash`);
  }
  return normalized;
}

function assertControlledBy(
  status: CanisterStatus,
  controller: string,
  label: string,
): void {
  if (!status.settings.controllers.includes(controller)) {
    throw new Error(
      `The selected identity ${controller} does not control ${label} ${status.id}`,
    );
  }
}

async function parseProductionArgs(
  args: readonly string[],
): Promise<ProductionOptions> {
  const mapped = await loadMappedCanisterIds();
  let backend = mapped.backend;
  let frontend = mapped.frontend;
  let identityName = defaultIdentityName;
  let mode: ProductionOptions["mode"] = "all";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--starter-only" || argument === "--frontend-only") {
      if (mode !== "all") {
        throw new Error("Only one production deployment mode can be selected");
      }
      mode = argument === "--starter-only" ? "starter-only" : "frontend-only";
      continue;
    }
    if (
      argument === "--backend" ||
      argument === "--frontend" ||
      argument === "--identity"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--backend") backend = principalText(value, argument);
      else if (argument === "--frontend") {
        frontend = principalText(value, argument);
      } else {
        identityName = value;
      }
      continue;
    }
    throw new Error(
      "Usage: bun production_deploy.ts [--starter-only|--frontend-only] [--backend CANISTER] [--frontend CANISTER] [--identity NAME]",
    );
  }
  return { backend, frontend, identityName, mode };
}

async function loadMappedCanisterIds(): Promise<ProductionCanisterIds> {
  return loadIcpCliCanisterIds();
}

function loadIcpCliCanisterIds(): Promise<ProductionCanisterIds> {
  return parseCanisterIdMapping(icpCliCanisterIdsPath);
}

async function parseCanisterIdMapping(
  filename: string,
): Promise<ProductionCanisterIds> {
  const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
  return parseProductionCanisterIdMapping(value, filename);
}

export function parseProductionCanisterIdMapping(
  value: unknown,
  label = "production canister ID mapping",
): ProductionCanisterIds {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "dispenser" ||
    keys[1] !== "frontend"
  ) {
    throw new Error(`${label} must contain exactly dispenser and frontend`);
  }
  if (
    typeof value.dispenser !== "string" ||
    typeof value.frontend !== "string"
  ) {
    throw new Error(`${label} must contain production canister principals`);
  }
  const mapping = {
    backend: principalText(value.dispenser, `${label} dispenser`),
    frontend: principalText(value.frontend, `${label} frontend`),
  };
  if (mapping.backend === mapping.frontend) {
    throw new Error(`${label} must identify two distinct canisters`);
  }
  return mapping;
}

function principalText(value: string, label: string): string {
  try {
    const principal = Principal.fromText(value);
    const canonical = principal.toText();
    if (
      canonical !== value ||
      principal.isAnonymous() ||
      canonical === Principal.managementCanister().toText()
    ) {
      throw new Error("principal is not a canonical canister ID");
    }
    return canonical;
  } catch (cause) {
    throw new Error(`${label} must be a canonical canister principal`, {
      cause,
    });
  }
}

async function writeProductionReceipt({
  options,
  controller,
  backendModuleSha256,
  frontendModuleSha256,
  starter,
  packages,
}: {
  options: ProductionOptions;
  controller: string;
  backendModuleSha256: string;
  frontendModuleSha256: string;
  starter: StarterInfo;
  packages: PackageArtifact[];
}): Promise<void> {
  const receipt: ProductionReceipt = {
    schema: 1,
    backend_canister_id: options.backend,
    backend_module_sha256: backendModuleSha256,
    frontend_canister_id: options.frontend,
    frontend_module_sha256: frontendModuleSha256,
    controller,
    subnet: productionSubnet,
    starter: {
      revision: starter.revision.toString(),
      deployment_id: starter.deployment_id,
      app_ids: starter.app_ids,
      wasm_bytes: starter.wasm_bytes.toString(),
      wasm_sha256: Buffer.from(starter.wasm_sha256).toString("hex"),
      files: starter.files.toString(),
      file_chunks: starter.file_chunks.toString(),
      backend_call_target_principals:
        starter.backend_call_target_principals.map((principal) =>
          principal.toText(),
        ),
      packages,
    },
    updated_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
}

function runCommand(
  command: string,
  args: string[],
  { cwd, env = process.env }: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
          ),
        );
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
