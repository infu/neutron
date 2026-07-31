import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import {
  trustedInstallationContextFromRootKey,
  trustedInstallationNetworkIdHex,
} from "neutron-compiler/src/installation_context.js";
import { SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 } from "neutron-tools/src/wasm_metadata.js";
import type { PreparedDeployment } from "../src/artifact.ts";
import {
  localDeploymentFingerprint,
  runLocalReinstall,
  type LocalDeploymentClient,
  type LocalReinstallDependencies,
  type LocalReinstallOptions,
} from "../src/local_deploy.ts";
import { startLocalServer } from "../src/local_server.ts";
import {
  createNeutronPocketIcInstanceConfig,
  pocketIcInstanceConfigDigest,
  summarizePocketIcTopology,
} from "../src/pocketic_rest.ts";
import {
  createPocketIcJournal,
  localDeploymentNodes,
  readSession,
  writeSession,
} from "../src/session.ts";
import { pocketIcTestTopology } from "./pocketic_test_fixture.ts";

const CONFIG_SHA256 = "c".repeat(64);
const UPDATE_SOURCE_ID = "r7inp-6aaaa-aaaaa-aaabq-cai";
const AUTHORIZED_PRINCIPAL =
  "pbwxr-uqxlv-aiwi3-omw2n-ptdex-kyifb-kdsn6-zdiyd-ggzpu-nrzik-rqe";
const NODE_LABELS = ["alpha", "bravo", "charlie"];

describe("resumable local fleet deployment", () => {
  test("explicit minimal serve and reinstall skip optional chain services and fixture funding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-minimal-acceptance-"));
    const stateDirectory = path.join(root, ".neutron", "pocketic");
    const sessionPath = path.join(root, "minimal.ndeploy.session.json");
    const runtime = validRuntime(stateDirectory, "minimal");
    const { kind: _kind, ...descriptor } = runtime;
    const canisterId = localCanisterIds()[0]!;
    const state = new Map<string, string | null>();
    const events: string[] = [];
    let chainServiceStarts = 0;
    let fixtureFundingCalls = 0;
    let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    try {
      server = await startLocalServer(
        {
          profile: "minimal",
          configSha256: CONFIG_SHA256,
          sessionPath,
          stateDirectory,
        },
        {
          logger: { log() {} },
          ensureChainServices: async () => {
            chainServiceStarts += 1;
            throw new Error("minimal must not start optional chain services");
          },
          resolveBinary: async () => ({
            path: path.join(root, ".neutron", "cache", "bin", "pocket-ic"),
            version: descriptor.serverVersion,
            sha256: descriptor.binarySha256,
            artifactUrl: "https://example.invalid/pocket-ic.gz",
          }),
          serve: async (options) => {
            await options.publishDescriptor!(descriptor);
            return {
              descriptor,
              async wait() {},
              async stop() {},
            };
          },
          ensureFixtures: async () => ({
            internet_identity: "rdmx6-jaaaa-aaaaa-aaadq-cai",
          }),
          ensureUpdateSource: async (options) => {
            await options.recordCanisterId?.(UPDATE_SOURCE_ID);
            return UPDATE_SOURCE_ID;
          },
        },
      );

      const reinstallNow = new Date();
      const result = await runLocalReinstall(
        {
          ...localOptions(root, sessionPath),
          profile: "minimal",
          nodeLabels: ["alpha"],
        },
        localDependencies(
          mockClient({
            events,
            state,
            createCanister: () => canisterId,
          }),
          {
            now: () => reinstallNow,
            fundFixtures: async () => {
              fixtureFundingCalls += 1;
              throw new Error("minimal must not fund optional fixtures");
            },
          },
        ),
      );

      expect(result.nodes).toEqual([
        {
          label: "alpha",
          canisterId,
          url: `http://${canisterId}.localhost:8000/`,
        },
      ]);
      expect(events).toContain(`install:${canisterId}`);
      expect(events).toContain(`verify-auth:${canisterId}`);
      expect(chainServiceStarts).toBe(0);
      expect(fixtureFundingCalls).toBe(0);
      expect(await readSession(sessionPath)).toMatchObject({
        runtime: {
          profile: "minimal",
          fixtures: {
            internet_identity: "rdmx6-jaaaa-aaaaa-aaadq-cai",
            update_source: UPDATE_SOURCE_ID,
          },
        },
        current: { kind: "local" },
      });
    } finally {
      await server?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compiles once and installs the same actor on an ordered three-node fleet", async () => {
    await withLocalJournal(async ({ root, sessionPath, runtime }) => {
      const canisterIds = localCanisterIds();
      const state = new Map<string, string | null>();
      const events: string[] = [];
      let nextCanister = 0;
      let prepares = 0;
      const expectedContext = trustedInstallationContextFromRootKey(
        new Uint8Array(Buffer.from(runtime.rootKeyBase64, "base64")),
      );
      const expectedNetworkId =
        trustedInstallationNetworkIdHex(expectedContext);
      const client = mockClient({
        events,
        state,
        createCanister: () => canisterIds[nextCanister++]!,
      });

      const result = await runLocalReinstall(
        localOptions(root, sessionPath),
        localDependencies(client, {
          prepare: async (paths, options) => {
            prepares += 1;
            expect(paths).toEqual(["/cache/kernel.neutron"]);
            expect(options?.freshInstallationContext?.networkId).toEqual(
              expectedContext.networkId,
            );
            expect(
              options?.localCompileCache?.installationNetworkIdHex,
            ).toBe(expectedNetworkId);
            return deployment;
          },
          bindRuntimeConfig: ({ canisterId }) => {
            events.push(`bind:${canisterId}`);
            return {} as never;
          },
          seed: async ({ canisterId }) => {
            events.push(`seed:${canisterId}`);
          },
          fundFixtures: async ({ canisterId, fundNativeChains }) => {
            events.push(`fund:${canisterId}`);
            expect(fundNativeChains).toBe(canisterId === canisterIds[0]);
            return {} as never;
          },
          verify: async ({ canisterId }) => {
            events.push(`verify:${canisterId}`);
          },
        }),
      );

      expect(prepares).toBe(1);
      expect(result.nodes.map(({ label }) => label)).toEqual(NODE_LABELS);
      expect(result.nodes.map(({ canisterId }) => canisterId)).toEqual(
        canisterIds,
      );
      const session = await readSession(sessionPath);
      expect(session?.schema).toBe(3);
      expect(session?.active).toBeUndefined();
      expect(session?.current).toMatchObject({ kind: "local" });
      expect(session?.current).not.toHaveProperty("canisterId");
      expect(localDeploymentNodes(session!)).toEqual(
        NODE_LABELS.map((label, index) => ({
          label,
          canisterId: canisterIds[index]!,
        })),
      );
      for (const canisterId of canisterIds) {
        expect(events).toContain(`install:${canisterId}`);
        expect(events).toContain(`bind:${canisterId}`);
        expect(events).toContain(`seed:${canisterId}`);
        expect(events).toContain(`authorize:${canisterId}`);
        expect(events).toContain(`verify-auth:${canisterId}`);
        expect(events).toContain(`fund:${canisterId}`);
        expect(events).toContain(`verify:${canisterId}`);
      }
      expect(runtime.fixtures.update_source).toBe(UPDATE_SOURCE_ID);
    });
  });

  test("records per-node phases and resumes without reinstalling completed work", async () => {
    await withLocalJournal(async ({ root, sessionPath }) => {
      const canisterId = localCanisterIds()[0]!;
      const state = new Map<string, string | null>();
      const events: string[] = [];
      let failSeed = true;
      const client = mockClient({
        events,
        state,
        createCanister: () => canisterId,
      });
      const options = {
        ...localOptions(root, sessionPath),
        nodeLabels: ["alpha"],
      };
      const dependencies = localDependencies(client, {
        seed: async () => {
          events.push("seed");
          if (failSeed) {
            failSeed = false;
            throw new Error("seed interrupted");
          }
        },
      });

      await expect(
        runLocalReinstall(options, dependencies),
      ).rejects.toThrow("after phase installed");
      expect((await readSession(sessionPath))?.active).toMatchObject({
        kind: "local-reinstall",
        state: {
          desiredNodeCount: 1,
          nodes: [{ nodeIndex: 0, phase: "installed" }],
        },
      });

      await runLocalReinstall(options, dependencies);
      expect(events.filter((event) => event === `install:${canisterId}`)).toHaveLength(1);
      expect(events.filter((event) => event === "seed")).toHaveLength(2);
      expect((await readSession(sessionPath))?.active).toBeUndefined();
    });
  });

  test("reissues an ambiguous same-module reinstall so fresh state is guaranteed", async () => {
    await withLocalJournal(async ({ root, sessionPath }) => {
      const canisterId = localCanisterIds()[0]!;
      const state = new Map<string, string | null>();
      const events: string[] = [];
      const options = {
        ...localOptions(root, sessionPath),
        nodeLabels: ["alpha"],
      };
      await runLocalReinstall(
        options,
        localDependencies(
          mockClient({
            events,
            state,
            createCanister: () => canisterId,
          }),
        ),
      );

      let loseReply = true;
      const reinstallingClient = mockClient({
        events,
        state,
        createCanister: () => {
          throw new Error("completed fleet must reuse its canister");
        },
        installDeployment: async ({ canisterId: target, mode }) => {
          events.push(`${mode}:${target}`);
          state.set(target, deployment.transportWasmSha256);
          if (loseReply) {
            loseReply = false;
            throw new Error("reinstall reply lost after commit");
          }
        },
      });
      const dependencies = localDependencies(reinstallingClient);
      await expect(
        runLocalReinstall(options, dependencies),
      ).rejects.toThrow("after phase installing");
      await runLocalReinstall(options, dependencies);

      expect(
        events.filter((event) => event === `reinstall:${canisterId}`),
      ).toHaveLength(2);
      expect((await readSession(sessionPath))?.active).toBeUndefined();
    });
  });

  test("explicit local reinstall replaces a module changed by an in-app update", async () => {
    await withLocalJournal(async ({ root, sessionPath }) => {
      const canisterId = localCanisterIds()[0]!;
      const state = new Map<string, string | null>();
      const events: string[] = [];
      const options = {
        ...localOptions(root, sessionPath),
        nodeLabels: ["alpha"],
      };
      const client = mockClient({
        events,
        state,
        createCanister: () => canisterId,
      });
      const dependencies = localDependencies(client);

      await runLocalReinstall(options, dependencies);
      state.set(canisterId, "9".repeat(64));
      events.length = 0;

      await runLocalReinstall(options, dependencies);

      expect(events).toContain(`reinstall:${canisterId}`);
      expect(state.get(canisterId)).toBe(deployment.transportWasmSha256);
      expect((await readSession(sessionPath))?.active).toBeUndefined();
    });
  });

  test("leaves a clear partial-fleet receipt and safely resumes later nodes", async () => {
    await withLocalJournal(async ({ root, sessionPath }) => {
      const canisterIds = localCanisterIds();
      const state = new Map<string, string | null>();
      const events: string[] = [];
      let nextCanister = 0;
      let failBravo = true;
      const client = mockClient({
        events,
        state,
        createCanister: () => canisterIds[nextCanister++]!,
      });
      const dependencies = localDependencies(client, {
        verify: async ({ canisterId }) => {
          events.push(`verify:${canisterId}`);
          if (canisterId === canisterIds[1] && failBravo) {
            failBravo = false;
            throw new Error("bravo unavailable");
          }
        },
      });
      const options = localOptions(root, sessionPath);

      await expect(
        runLocalReinstall(options, dependencies),
      ).rejects.toThrow("stopped at bravo");
      expect((await readSession(sessionPath))?.active).toMatchObject({
        kind: "local-reinstall",
        state: {
          nodes: [
            { phase: "verified" },
            { phase: "funded" },
            { phase: "allocated" },
          ],
        },
      });

      await runLocalReinstall(options, dependencies);
      expect(
        events.filter((event) => event === `install:${canisterIds[0]}`),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event === `install:${canisterIds[1]}`),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event === `install:${canisterIds[2]}`),
      ).toHaveLength(1);
    });
  });

  test("fingerprint ignores checkout paths but binds labels and deployment bytes", () => {
    const firstRootNetworkId = trustedInstallationNetworkIdHex(
      trustedInstallationContextFromRootKey(new Uint8Array(32).fill(1)),
    );
    const first = localDeploymentFingerprint({
      configSha256: CONFIG_SHA256,
      deployment,
      nodeLabels: NODE_LABELS,
      installationNetworkIdHex: firstRootNetworkId,
      profile: "full_protocol_fixtures",
    });
    const moved = localDeploymentFingerprint({
      configSha256: CONFIG_SHA256,
      deployment: {
        ...deployment,
        packageArtifacts: deployment.packageArtifacts.map((artifact) => ({
          ...artifact,
          path: "/another/checkout/kernel.neutron",
        })),
      },
      nodeLabels: NODE_LABELS,
      installationNetworkIdHex: firstRootNetworkId,
      profile: "full_protocol_fixtures",
    });
    const relabeled = localDeploymentFingerprint({
      configSha256: CONFIG_SHA256,
      deployment,
      nodeLabels: ["one", "two", "three"],
      installationNetworkIdHex: firstRootNetworkId,
      profile: "full_protocol_fixtures",
    });
    const changedActor = localDeploymentFingerprint({
      configSha256: CONFIG_SHA256,
      deployment: {
        ...deployment,
        transportWasmSha256: "8".repeat(64),
      },
      nodeLabels: NODE_LABELS,
      installationNetworkIdHex: firstRootNetworkId,
      profile: "full_protocol_fixtures",
    });
    const differentRootNetworkId = trustedInstallationNetworkIdHex(
      trustedInstallationContextFromRootKey(new Uint8Array(32).fill(2)),
    );
    const differentRoot = localDeploymentFingerprint({
      configSha256: CONFIG_SHA256,
      deployment,
      nodeLabels: NODE_LABELS,
      installationNetworkIdHex: differentRootNetworkId,
      profile: "full_protocol_fixtures",
    });
    expect(moved).toBe(first);
    expect(relabeled).not.toBe(first);
    expect(changedActor).not.toBe(first);
    expect(differentRoot).not.toBe(first);
  });
});

const NOW = new Date("2026-07-22T12:00:00.000Z");

const deployment = {
  packages: [
    {
      manifest: {
        format: 3,
        id: "kernel",
        name: "Kernel",
        version: 100,
        entry: "a".repeat(64),
      },
      capabilityPlan: {
        format: 1,
        app: { id: "kernel", version: 100 },
        entries: [],
      },
    },
  ],
  packageArchives: [new Uint8Array([1])],
  packageArtifacts: [
    {
      path: "/cache/kernel.neutron",
      id: "kernel",
      version: 1,
      sha256: "1".repeat(64),
      bytes: 1,
    },
  ],
  compiled: {
    wasm: new Uint8Array([0]),
    candid: "service : {}",
    stable: "type Neutron = {}",
    deploymentId: "deployment-local",
    compilerId: "moc-test",
  },
  wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  transportWasm: new Uint8Array([1]),
  rawWasmSha256: "2".repeat(64),
  transportWasmSha256: "3".repeat(64),
  candidSha256: "4".repeat(64),
  stableSha256: "5".repeat(64),
  chunks: [],
} as unknown as PreparedDeployment;

function localCanisterIds(): string[] {
  return [11, 12, 13].map((byte) =>
    Principal.selfAuthenticating(new Uint8Array(32).fill(byte)).toText(),
  );
}

function localOptions(
  root: string,
  sessionPath: string,
): LocalReinstallOptions {
  return {
    configSha256: CONFIG_SHA256,
    sessionPath,
    developerIdentitySeed: 2,
    nodeLabels: NODE_LABELS,
    authorizedPrincipals: [AUTHORIZED_PRINCIPAL],
    packagePaths: ["/cache/kernel.neutron"],
    repositoryRoot: root,
    compileCacheDirectory: path.join(root, ".neutron", "cache", "compiled"),
    profile: "full_protocol_fixtures",
  };
}

function localDependencies(
  client: LocalDeploymentClient,
  overrides: Partial<LocalReinstallDependencies> = {},
): LocalReinstallDependencies {
  return {
    compilerFingerprint: async () => "a".repeat(64),
    prepare: async () => deployment,
    verifyRuntime: async () => ({}) as never,
    createClient: async () => client,
    bindRuntimeConfig: () => ({}) as never,
    seed: async () => {},
    fundFixtures: async () => ({}) as never,
    verify: async () => {},
    now: () => NOW,
    logger: { log() {} },
    ...overrides,
  };
}

function mockClient({
  events,
  state,
  createCanister,
  installDeployment,
}: {
  events: string[];
  state: Map<string, string | null>;
  createCanister: () => string;
  installDeployment?: LocalDeploymentClient["installDeployment"];
}): LocalDeploymentClient {
  return {
    async createCanister() {
      const canisterId = createCanister();
      state.set(canisterId, null);
      events.push(`create:${canisterId}`);
      return canisterId;
    },
    async operationalState(canisterId) {
      events.push(`status:${canisterId}`);
      return {
        moduleHash: state.get(canisterId) ?? null,
        controllers: [],
        status: "running",
      };
    },
    async ensureSelfController(canisterId) {
      events.push(`controller:${canisterId}`);
    },
    async installDeployment(input) {
      if (installDeployment !== undefined) {
        await installDeployment(input);
        return;
      }
      const { canisterId, mode } = input;
      events.push(`${mode}:${canisterId}`);
      state.set(canisterId, deployment.transportWasmSha256);
    },
    kernelActor() {
      return {} as never;
    },
    async authorizeFreshPrincipals(canisterId) {
      events.push(`authorize:${canisterId}`);
      return ["developer-principal", AUTHORIZED_PRINCIPAL].sort();
    },
    async verifyAuthorizedPrincipals(canisterId) {
      events.push(`verify-auth:${canisterId}`);
      return ["developer-principal", AUTHORIZED_PRINCIPAL].sort();
    },
  };
}

function validRuntime(
  stateDirectory: string,
  profile: "minimal" | "full_protocol_fixtures" = "full_protocol_fixtures",
) {
  const rawTopology = pocketIcTestTopology();
  if (profile === "minimal") {
    rawTopology.subnet_configs = Object.fromEntries(
      Object.entries(rawTopology.subnet_configs).filter(([, subnet]) =>
        ["Application", "NNS", "II", "TestThresholdKeys"].includes(
          subnet.subnet_kind,
        ),
      ),
    );
  }
  const topology = summarizePocketIcTopology(rawTopology, profile).summary;
  return {
    kind: "pocketic" as const,
    profile,
    serverVersion: "14.0.0" as const,
    binarySha256:
      "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
    pid: 100,
    processIdentity: "linux:100:1000",
    startedAt: NOW.toISOString(),
    idleTtlSeconds: 2_592_000 as const,
    controlUrl: "http://127.0.0.1:8080/",
    instanceId: 0,
    instanceConfigDigest: pocketIcInstanceConfigDigest(
      createNeutronPocketIcInstanceConfig({
        stateDirectory,
        profile,
      }),
    ),
    stateDirectory,
    gateway: {
      id: 0,
      url: "http://localhost:8000/" as const,
      bind: "127.0.0.1" as const,
      port: 8000 as const,
    },
    rootKeyBase64: Buffer.alloc(32, 1).toString("base64"),
    topology,
    fixtures: { update_source: UPDATE_SOURCE_ID },
  };
}

async function withLocalJournal(
  run: (input: {
    root: string;
    sessionPath: string;
    runtime: ReturnType<typeof validRuntime>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-deploy-"));
  const sessionPath = path.join(root, "local.ndeploy.session.json");
  const runtime = validRuntime(path.join(root, ".neutron", "pocketic"));
  try {
    await writeSession(
      sessionPath,
      createPocketIcJournal(CONFIG_SHA256, runtime, NOW),
      NOW,
    );
    await run({ root, sessionPath, runtime });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
