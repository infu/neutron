import { execFile as callbackExecFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createKernelRuntimeConfig,
  isolatedFrameOriginTemplate,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import {
  localCanisterOrigin,
  scopedLocalIdentityProvider,
} from "neutron-tools/src/runtime.js";
import { compileMotokoWithCandid } from "neutron-scripts/src/compile_motoko.js";
import {
  prepareDeployment,
  sha256Hex,
} from "neutron-provision/src/artifact.js";
import { localIdentityFromSeed } from "neutron-provision/src/kernel.js";
import { LocalProvisionClient } from "neutron-provision/src/local_client.js";
import {
  createLocalUpdateSourceClient,
  loadLocalUpdateSourceAssets,
  resolveLocalUpdateSourceWasm,
} from "neutron-provision/src/local_update_source.js";
import { trustedInstallationContextFromRootKey } from "neutron-compiler/src/installation_context.js";
import {
  assertStarterSelectionMatchesDeployment,
  loadStarterSelection,
} from "./starter.ts";
import {
  assertDispenserTargetSubnet,
  encodeDispenserInstallArgs,
} from "./deployment_target.ts";
import { stageStarterPayload } from "./starter_payload.ts";

const execFile = promisify(callbackExecFile);
const dispenserRoot = import.meta.dir;
const repositoryRoot = path.resolve(dispenserRoot, "../..");
const sessionPath = path.join(repositoryRoot, "local.ndeploy.session.json");
const stateDirectory = path.join(repositoryRoot, ".neutron");
const statePath = path.join(stateDirectory, "dispenser-local.json");
const backendWasmPath = path.join(
  dispenserRoot,
  ".icp/cache/dispenser-local.wasm",
);
const frontendBuildDirectory = path.join(dispenserRoot, "build");
const fixtureCacheDirectory = path.join(
  repositoryRoot,
  ".neutron/cache/fixtures",
);
const controllerIdentitySeed = 253;
const runtimeCanisterMarker = "rrkah-fqaaa-aaaaa-aaaaq-cai";

type PocketIcSession = {
  runtime: {
    kind: "pocketic";
    processIdentity: string;
    controlUrl: string;
    instanceId: number;
    rootKeyBase64: string;
    gateway: { url: string };
    topology: {
      defaultEffectiveCanisterId: string;
      subnetIds: { Application: string };
    };
    fixtures: {
      update_source: string;
    };
  };
};

type LocalDispenserState = {
  schema: 2;
  processIdentity: string;
  backendCanisterId?: string;
  backendModuleHash?: string;
  backendTargetSubnet?: string;
  frontendCanisterId?: string;
  deploymentId?: string;
  updatedAt: string;
};

async function main(): Promise<void> {
  const session = parseSession(
    JSON.parse(await readFile(sessionPath, "utf8")) as unknown,
  );
  const runtime = session.runtime;
  const connection = {
    gatewayUrl: runtime.gateway.url,
    controlUrl: runtime.controlUrl,
    instanceId: runtime.instanceId,
    expectedRootKeyBase64: runtime.rootKeyBase64,
    defaultEffectiveCanisterIdBase64:
      runtime.topology.defaultEffectiveCanisterId,
  };

  await mkdir(path.dirname(backendWasmPath), { recursive: true });
  console.log("Compiling the dispenser backend");
  await compileMotokoWithCandid({
    sourcePath: "mo/main.mo",
    outputPath: path.relative(dispenserRoot, backendWasmPath),
    cwd: dispenserRoot,
  });
  const backendWasm = new Uint8Array(await readFile(backendWasmPath));
  const backendModuleHash = sha256Hex(backendWasm);
  const backendTargetSubnet = runtime.topology.subnetIds.Application;

  const controllerIdentity = localIdentityFromSeed(controllerIdentitySeed);
  const provision = await LocalProvisionClient.create({
    ...connection,
    identity: controllerIdentity,
  });
  let state = await readCompatibleState(runtime.processIdentity);
  let backendCanisterId = await reusableBackendCanister({
    state,
    expectedModuleHash: backendModuleHash,
    expectedController: controllerIdentity.getPrincipal().toText(),
    expectedTargetSubnet: backendTargetSubnet,
    provision,
  });
  if (backendCanisterId === null) {
    backendCanisterId = await provision.createCanister();
    await provision.ensurePinnedModule({
      canisterId: backendCanisterId,
      wasm: backendWasm,
      arg: encodeDispenserInstallArgs(
        backendTargetSubnet,
      ),
      label: "local Neutron dispenser",
    });
    console.log(`Created local dispenser backend ${backendCanisterId}`);
  } else {
    console.log(`Reusing local dispenser backend ${backendCanisterId}`);
  }
  await assertDispenserTargetSubnet({
    agent: provision.agent,
    canisterId: backendCanisterId,
    expectedTargetSubnet: backendTargetSubnet,
  });
  state = {
    ...state,
    backendCanisterId,
    backendModuleHash,
    backendTargetSubnet,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);

  const deploymentId = await compileAndStageStarter({
    runtime,
    provision,
    backendCanisterId,
  });

  console.log("Building the local dispenser frontend");
  await execFile("bun", ["build.ts"], {
    cwd: dispenserRoot,
    env: {
      ...process.env,
      LOCAL: "true",
      ICP_LOCAL_HOST: POCKETIC_RUNTIME_GATEWAY,
      DISPENSER_CANISTER_ID: backendCanisterId,
    },
  });
  const [frontendWasm, frontendAssets] = await Promise.all([
    resolveLocalUpdateSourceWasm({
      cacheDirectory: fixtureCacheDirectory,
    }),
    loadLocalUpdateSourceAssets(frontendBuildDirectory),
  ]);
  const frontendClient = await createLocalUpdateSourceClient({
    gatewayUrl: runtime.gateway.url,
    expectedRootKeyBase64: runtime.rootKeyBase64,
    defaultEffectiveCanisterIdBase64:
      runtime.topology.defaultEffectiveCanisterId,
  });
  let frontendCanisterId = state.frontendCanisterId;
  if (frontendCanisterId === undefined) {
    frontendCanisterId = await frontendClient.createCanister();
    state = {
      ...state,
      frontendCanisterId,
      updatedAt: new Date().toISOString(),
    };
    await writeState(state);
    console.log(`Created local dispenser frontend ${frontendCanisterId}`);
  } else {
    console.log(`Reusing local dispenser frontend ${frontendCanisterId}`);
  }
  await frontendClient.ensureInstalled(frontendCanisterId, frontendWasm);
  await frontendClient.synchronizeAssets(frontendCanisterId, frontendAssets);

  const frontendUrl = `${localCanisterOrigin(
    frontendCanisterId,
    runtime.gateway.url,
  )}/`;
  const response = await fetch(frontendUrl, {
    redirect: "manual",
    cache: "no-store",
  });
  if (response.status !== 200) {
    throw new Error(
      `Local dispenser frontend returned HTTP ${response.status}`,
    );
  }
  const html = await response.text();
  if (!html.includes("<title>SushiOS")) {
    throw new Error("Local dispenser frontend did not return its index page");
  }

  state = {
    ...state,
    deploymentId,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);
  console.log("");
  console.log(`Dispenser backend:  ${backendCanisterId}`);
  console.log(`Dispenser frontend: ${frontendCanisterId}`);
  console.log(`Open: ${frontendUrl}`);
}

export async function setExistingLocalStarterPayload(): Promise<void> {
  const session = parseSession(
    JSON.parse(await readFile(sessionPath, "utf8")) as unknown,
  );
  const runtime = session.runtime;
  const state = await readCompatibleState(runtime.processIdentity);
  if (state.backendCanisterId === undefined) {
    throw new Error(
      "No local dispenser backend exists; run npm --workspace dispenser run local:deploy first",
    );
  }
  const controllerIdentity = localIdentityFromSeed(controllerIdentitySeed);
  const provision = await LocalProvisionClient.create({
    gatewayUrl: runtime.gateway.url,
    controlUrl: runtime.controlUrl,
    instanceId: runtime.instanceId,
    expectedRootKeyBase64: runtime.rootKeyBase64,
    defaultEffectiveCanisterIdBase64:
      runtime.topology.defaultEffectiveCanisterId,
    identity: controllerIdentity,
  });
  const operational = await provision.operationalState(state.backendCanisterId);
  if (
    !operational.controllers.includes(
      controllerIdentity.getPrincipal().toText(),
    )
  ) {
    throw new Error(
      "The configured local identity does not control the dispenser backend",
    );
  }

  const deploymentId = await compileAndStageStarter({
    runtime,
    provision,
    backendCanisterId: state.backendCanisterId,
  });
  await writeState({
    ...state,
    deploymentId,
    updatedAt: new Date().toISOString(),
  });
  console.log("");
  console.log(`Dispenser backend: ${state.backendCanisterId}`);
  console.log(`Starter deployment: ${deploymentId}`);
}

async function compileAndStageStarter({
  runtime,
  provision,
  backendCanisterId,
}: {
  runtime: PocketIcSession["runtime"];
  provision: LocalProvisionClient;
  backendCanisterId: string;
}): Promise<string> {
  const selection = await loadStarterSelection();
  console.log(
    `Compiling SushiOS starter with ${selection.apps.length} apps: ${selection.apps
      .map(({ id }) => id)
      .join(", ")}`,
  );
  const installationContext = trustedInstallationContextFromRootKey(
    new Uint8Array(Buffer.from(runtime.rootKeyBase64, "base64")),
  );
  const deployment = await prepareDeployment(selection.packagePaths, {
    target: "local",
    freshInstallationContext: installationContext,
  });
  assertStarterSelectionMatchesDeployment(selection, deployment);
  await stageStarterPayload({
    agent: provision.agent,
    canisterId: backendCanisterId,
    deployment,
    appIds: selection.packageIds,
    runtimeConfigTemplate: {
      segments: runtimeConfigTemplateSegments({
        deploymentId: deployment.compiled.deploymentId,
        updateSourceCanisterId: runtime.fixtures.update_source,
      }),
    },
  });
  return deployment.compiled.deploymentId;
}

function runtimeConfigTemplateSegments({
  deploymentId,
  updateSourceCanisterId,
}: {
  deploymentId: string;
  updateSourceCanisterId: string;
}): string[] {
  const template = createKernelRuntimeConfig({
    target: "pocketic",
    gateway: POCKETIC_RUNTIME_GATEWAY,
    identity_provider: scopedLocalIdentityProvider({
      neutronCanisterId: runtimeCanisterMarker,
      localHost: POCKETIC_RUNTIME_GATEWAY,
    }),
    canister_id: runtimeCanisterMarker,
    deployment_id: deploymentId,
    root_key_policy: "fetch",
    allow_loopback_http: true,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "pocketic",
      runtimeCanisterMarker,
    ),
    update_source_origin: runtimeUpdateSourceOrigin(
      "pocketic",
      updateSourceCanisterId,
    ),
  });
  const segments = JSON.stringify(template).split(runtimeCanisterMarker);
  if (segments.length !== 4) {
    throw new Error(
      "PocketIC runtime template did not contain exactly three canister bindings",
    );
  }
  return segments;
}

async function reusableBackendCanister({
  state,
  expectedModuleHash,
  expectedController,
  expectedTargetSubnet,
  provision,
}: {
  state: LocalDispenserState;
  expectedModuleHash: string;
  expectedController: string;
  expectedTargetSubnet: string;
  provision: LocalProvisionClient;
}): Promise<string | null> {
  const canisterId = state.backendCanisterId;
  if (
    canisterId === undefined ||
    state.backendModuleHash !== expectedModuleHash ||
    state.backendTargetSubnet !== expectedTargetSubnet
  ) {
    return null;
  }
  try {
    const operational = await provision.operationalState(canisterId);
    return operational.moduleHash === expectedModuleHash &&
      operational.controllers.includes(expectedController)
      ? canisterId
      : null;
  } catch {
    return null;
  }
}

async function readCompatibleState(
  processIdentity: string,
): Promise<LocalDispenserState> {
  try {
    const value = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as Partial<LocalDispenserState>;
    if (
      value.schema === 2 &&
      value.processIdentity === processIdentity &&
      typeof value.updatedAt === "string"
    ) {
      return value as LocalDispenserState;
    }
  } catch (cause) {
    if (!isFileNotFound(cause)) throw cause;
  }
  return {
    schema: 2,
    processIdentity,
    updatedAt: new Date().toISOString(),
  };
}

async function writeState(state: LocalDispenserState): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function parseSession(value: unknown): PocketIcSession {
  if (!isRecord(value) || !isRecord(value.runtime)) {
    throw new Error("Local provision session is missing its runtime");
  }
  const runtime = value.runtime;
  if (
    runtime.kind !== "pocketic" ||
    typeof runtime.processIdentity !== "string" ||
    typeof runtime.controlUrl !== "string" ||
    !Number.isInteger(runtime.instanceId) ||
    typeof runtime.rootKeyBase64 !== "string" ||
    !isRecord(runtime.gateway) ||
    typeof runtime.gateway.url !== "string" ||
    !isRecord(runtime.topology) ||
    typeof runtime.topology.defaultEffectiveCanisterId !== "string" ||
    !isRecord(runtime.topology.subnetIds) ||
    typeof runtime.topology.subnetIds.Application !== "string" ||
    !isRecord(runtime.fixtures) ||
    typeof runtime.fixtures.update_source !== "string"
  ) {
    throw new Error("Local provision session has an invalid PocketIC runtime");
  }
  return value as PocketIcSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(cause: unknown): boolean {
  return (
    isRecord(cause) &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await main();
  } else if (args.length === 1 && args[0] === "--starter-only") {
    await setExistingLocalStarterPayload();
  } else {
    throw new Error("Usage: bun local_deploy.ts [--starter-only]");
  }
}
