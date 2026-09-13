/**
 * Real Candid-only repository negotiation against disposable PocketIC actors.
 *
 * NEUTRON_RUN_REPOSITORY_CHANNEL_LEGACY_POCKETIC=1 \
 * NEUTRON_POCKETIC_BIN=.neutron/cache/bin/pocket-ic-14.0.0-linux-x64/pocket-ic \
 * bun test apps/kernel/test/repository_channel_legacy.pocketic.test.ts
 *
 * Compiles the existing repository main.mo and CertifiedStore.mo unchanged,
 * with a temporary immutable resource module containing the released Hello201
 * archive. No Kernel package is built. Raw queries verify PocketIC's signed
 * rejections with its local root key. The setup uses the existing explicit local
 * deployment policy; all repository bytes still need their real certificates.
 */
import { expect, test } from "bun:test";
import { AnonymousIdentity, Cbor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";
import {
  repositoryInfoPath,
  repositoryManifestPath,
  repositoryPackagePath,
  serializeRepositoryInfo,
  serializeRepositoryManifest,
} from "neutron-tools/repository";
import { repositoryChannelsPath } from "neutron-tools/src/release_channels.js";
import { scopedLocalIdentityProvider } from "neutron-tools/src/runtime.js";
import {
  createKernelRuntimeConfig,
  encodeKernelRuntimeConfig,
  isolatedFrameOriginTemplate,
  POCKETIC_RUNTIME_GATEWAY,
  runtimeUpdateSourceOrigin,
} from "neutron-tools/src/runtime_config.js";
import { loadRuntimeDeployment } from "../src/runtime_deployment.ts";
import {
  createAnonymousRepositorySource,
  verifyRepositorySetupBytes,
} from "../src/repository/client.ts";
import { markRepositoryReleaseChannelsSupported } from "../src/repository/channels.ts";
import { createRepositoryChannelMetadataReader } from "../src/repository/channel_metadata.ts";
import { managementIdl } from "../../../packages/neutron-provision/src/idl.ts";
type DirectPocketIcClient = {
  deleteInstance(instanceId: number): Promise<void>;
  submitIngressMessage(instanceId: number, call: {
    sender: Principal;
    canisterId: Principal;
    method: string;
    payload: Uint8Array;
    effectivePrincipal?: { CanisterId: string };
  }): Promise<unknown>;
  awaitIngressMessage(instanceId: number, message: unknown): Promise<Uint8Array>;
};

type LegacyRepositoryHarness = {
  DirectPocketIcCalls: new (client: DirectPocketIcClient, instanceId: number) => {
    createCanister(owner: Principal, effectiveCanisterId: string): Promise<Principal>;
  };
  createApplicationInstance(controlUrl: string, stateDirectory: string): Promise<{
    instanceId: number;
    defaultEffectiveCanisterId: string;
  }>;
  launchPocketIc(binary: string, temporaryRoot: string): Promise<{
    server: ChildProcessWithoutNullStreams;
    controlUrl: string;
  }>;
  loadProvisionHarness(): Promise<{
    PocketIcRestClient: new (controlUrl: string, options: { requestTimeoutMs: number }) => DirectPocketIcClient;
  }>;
  requiredPocketIcBinary(): string;
  stopPocketIc(server: ChildProcessWithoutNullStreams): Promise<void>;
};

// The fixture is another workspace's test program, not a Kernel build input.
// Load it at runtime while keeping this project's consumed fixture API typed.
const legacyHarnessUrl = new URL(
  "../../../packages/neutron-compiler/test/legacy_kernel_upgrade.pocketic.test.ts",
  import.meta.url,
).href;
const {
  DirectPocketIcCalls,
  createApplicationInstance,
  launchPocketIc,
  loadProvisionHarness,
  requiredPocketIcBinary,
  stopPocketIc,
} = await import(legacyHarnessUrl) as LegacyRepositoryHarness;

const qualify = process.env.NEUTRON_RUN_REPOSITORY_CHANNEL_LEGACY_POCKETIC === "1"
  ? test : test.skip;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const root = path.resolve(import.meta.dir, "../../..");

qualify("legacy Candid repository supplies certified setup bytes only before channel participation is known", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "neutron-legacy-repository-"));
  let server: ChildProcessWithoutNullStreams | undefined;
  let client: DirectPocketIcClient | undefined;
  let instanceId: number | undefined;
  try {
    const packageBytes = new Uint8Array(await readFile(path.join(root, "apps/hello/hello.v0.2.1.neutron")));
    const packageDigest = digest(packageBytes);
    expect(packageDigest).toBe("82613cc3882c7404e51e09308e27a4885062f5f622663becf18cca0a046b8c27");
    const manifestBytes = serializeRepositoryManifest({
      protocol: "neutron-repo-v1", id: "hello", revision: 1, name: "Legacy Hello",
      packages: [{ id: "hello", version: 201, sha256: packageDigest, size: packageBytes.byteLength }],
    });
    const infoBytes = serializeRepositoryInfo({
      protocol: "neutron-repo-v1", name: "Legacy Candid repository",
      provider: { name: "Local qualification fixture" },
    });
    const resources = [
      [repositoryInfoPath(), infoBytes],
      [repositoryManifestPath("hello"), manifestBytes],
      [repositoryPackagePath(packageDigest), packageBytes],
    ] as const;
    await Promise.all([
      copyFile(path.join(root, "support/repository/mo/main.mo"), path.join(temporary, "main.mo")),
      copyFile(path.join(root, "support/repository/mo/CertifiedStore.mo"), path.join(temporary, "CertifiedStore.mo")),
      writeFile(path.join(temporary, "GeneratedRepository.mo"), `module {
        public type Resource = { path : Text; sha256 : Blob; chunks : [Blob] };
        public let resources : [Resource] = [${resources.map(([key, bytes]) =>
          `{ path = ${JSON.stringify(key)}; sha256 = ${motokoBlob(Buffer.from(digest(bytes), "hex"))}; chunks = [${motokoBlob(bytes)}] }`,
        ).join(",")}];
      };`),
    ]);
    const packages = await promisify(execFile)("mops", ["sources"], { cwd: path.join(root, "support/repository") });
    const compiler = await loadMotoko();
    let wasm: Uint8Array;
    try {
      const prepared = await prepareMotokoProgram({
        compiler, sourcePath: path.join(temporary, "main.mo"),
        packages: Object.fromEntries(Object.entries(
          parsePackageString(packages.stdout.replace(/\n/g, " ").trim()),
        ).map(([name, directory]) => [name, path.resolve(root, "support/repository", directory)])),
        allowDangerous: true,
      });
      wasm = (await compiler.wasm(prepared.entryPath, "ic")).wasm;
    } finally {
      await disposeMotokoCompiler();
    }
    const binary = requiredPocketIcBinary();
    expect(digest(new Uint8Array(await readFile(binary)))).toBe(
      "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
    );
    const launched = await launchPocketIc(binary, temporary);
    server = launched.server;
    const provision = await loadProvisionHarness();
    client = new provision.PocketIcRestClient(launched.controlUrl, { requestTimeoutMs: 60_000 });
    const created = await createApplicationInstance(launched.controlUrl, path.join(temporary, "state"));
    instanceId = created.instanceId;
    const direct = new DirectPocketIcCalls(client, instanceId);
    const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(173));
    const canister = await direct.createCanister(owner, created.defaultEffectiveCanisterId);
    const install = new Map(managementIdl({ IDL })._fields).get("install_code")!;
    const message = await client.submitIngressMessage(instanceId, {
      sender: owner, canisterId: Principal.fromText("aaaaa-aa"), method: "install_code",
      payload: new Uint8Array(IDL.encode(install.argTypes, [{
        mode: { install: null }, canister_id: canister, wasm_module: wasm,
        arg: IDL.encode([], []), sender_canister_version: [],
      }])),
      effectivePrincipal: { CanisterId: Buffer.from(canister.toUint8Array()).toString("base64") },
    });
    await client.awaitIngressMessage(instanceId, message);

    // PocketIC's instance-scoped replica endpoint will be selected here. The
    // local fetch adapter changes only the host/route, preserving the raw CBOR
    // response that HttpAgent passes to the production metadata reader.
    const replicaHost = new URL(`instances/${instanceId}/`, launched.controlUrl).href;
    const queries: string[] = [];
    const localFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== POCKETIC_RUNTIME_GATEWAY) throw new Error("Unexpected repository fixture origin");
      if (url.pathname.endsWith("/query") && init?.body) {
        const envelope = Cbor.decode(new Uint8Array(init.body as ArrayBuffer)) as { content: { method_name: string } };
        queries.push(envelope.content.method_name);
      }
      return fetch(new URL(url.pathname.slice(1), replicaHost), init);
    }) as unknown as typeof fetch;
    const agent = await HttpAgent.create({ host: POCKETIC_RUNTIME_GATEWAY,
      fetch: localFetch, identity: new AnonymousIdentity() });
    await agent.fetchRootKey();
    expect(agent.rootKey).not.toBeNull();
    const canisterId = canister.toText();
    const missing = await agent.query(canisterId, {
      methodName: "repo_channel_metadata",
      arg: IDL.encode([IDL.Record({ path: IDL.Text, index: IDL.Nat })], [{ path: repositoryChannelsPath(), index: 0n }]),
    });
    expect(missing).toMatchObject({ status: "rejected", reject_code: 5, error_code: "IC0536" });
    expect((missing.signatures ?? []).length).toBeGreaterThan(0);
    expect(await agent.query(canisterId, { methodName: "http_request", arg: IDL.encode([], []) }))
      .toMatchObject({ status: "rejected", reject_code: 5, error_code: "IC0536" });
    const productionReader = createRepositoryChannelMetadataReader({
      canisterId, agent, rootKey: agent.rootKey!,
    });
    expect(await productionReader(repositoryChannelsPath())).toBeUndefined();

    await loadLocalRuntimeFixture(canisterId);
    const source = await createAnonymousRepositorySource(canisterId, { fetch: localFetch });
    const reference = { repo: canisterId, manifest: "hello", digest: digest(manifestBytes) };
    queries.length = 0;
    const setup = await verifyRepositorySetupBytes(reference, source);
    expect(setup.info.name).toBe("Legacy Candid repository");
    expect(setup.manifestBytes).toEqual(manifestBytes);
    expect(setup.packages).toHaveLength(1);
    expect(setup.packages[0]!.bytes).toEqual(packageBytes);
    expect(setup.packages[0]!.releaseChannel).toBe("stable");
    expect(setup.releaseSelection.selection).toBeNull();
    expect(queries).toEqual(["repo_info", "repo_manifest", "repo_channel_metadata", "repo_package"]);
    await setup.revalidateReleaseSelection();
    const optedIn = await verifyRepositorySetupBytes(reference, source, undefined, undefined, { betaEnabled: true });
    expect(optedIn.packages[0]!.releaseChannel).toBe("stable");

    markRepositoryReleaseChannelsSupported(canisterId);
    queries.length = 0;
    await expect(verifyRepositorySetupBytes(reference, source)).rejects.toThrow("descriptor disappeared");
    expect(queries).toEqual(["repo_info", "repo_manifest", "repo_channel_metadata"]);
    await expect(setup.revalidateReleaseSelection()).rejects.toThrow("descriptor disappeared");
    console.log("Legacy repository: real IC0536 rejection, certified Candid setup, and sticky channel participation passed");
  } finally {
    if (client && instanceId !== undefined) await client.deleteInstance(instanceId).catch(() => undefined);
    if (server) await stopPocketIc(server);
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);

function motokoBlob(bytes: Uint8Array): string {
  return `"${Array.from(bytes, (byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("")}"`;
}

async function loadLocalRuntimeFixture(canisterId: string) {
  const config = createKernelRuntimeConfig({
    target: "pocketic", gateway: POCKETIC_RUNTIME_GATEWAY,
    identity_provider: scopedLocalIdentityProvider({ neutronCanisterId: canisterId, localHost: POCKETIC_RUNTIME_GATEWAY }),
    canister_id: canisterId, deployment_id: "17".repeat(16),
    root_key_policy: "fetch", allow_loopback_http: true,
    isolated_frame_origin_template: isolatedFrameOriginTemplate("pocketic", canisterId),
    update_source_origin: runtimeUpdateSourceOrigin("pocketic", canisterId),
  });
  await loadRuntimeDeployment((async () => new Response(encodeKernelRuntimeConfig(config) as unknown as BodyInit, {
    headers: {
      "content-type": "application/json",
      "ic-certificate": "certificate=:AA==:, tree=:AA==:, expr_path=:AA==:, version=2",
      "ic-certificateexpression": "default_certification(ValidationArgs{certification: Certification{}})",
    },
  })) as unknown as typeof fetch, `http://${canisterId}.localhost:8000/`);
}
