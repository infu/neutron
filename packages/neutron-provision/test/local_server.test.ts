import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 } from "neutron-tools/src/wasm_metadata.js";
import {
  attachLocalConfigToRunningServer,
  localFixtureCacheDirectory,
  localRuntimePaths,
  readLocalServerStatus,
  startLocalServer,
} from "../src/local_server.ts";
import {
  createNeutronPocketIcInstanceConfig,
  pocketIcInstanceConfigDigest,
  summarizePocketIcTopology,
} from "../src/pocketic_rest.ts";
import {
  completeLocalReinstall,
  createPocketIcJournal,
  readSession,
  recordLocalCanister,
  recordLocalNodePhase,
  startLocalReinstall,
  writeSession,
} from "../src/session.ts";
import type {
  PocketIcRuntimeAttachment,
  PocketIcRuntimeDescriptor,
} from "../src/pocketic_supervisor.ts";
import { pocketIcTestTopology } from "./pocketic_test_fixture.ts";

const NOW = new Date("2026-07-22T12:30:00.000Z");
const NEUTRON_CANISTER_ID = "yuby6-qp777-77774-aaaaq-cai";

test("local server publishes its only descriptor into the config session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-server-"));
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const sessionPath = path.join(root, "local.ndeploy.session.json");
  const descriptor = validDescriptor(stateDirectory);
  const fixtures = { ckbtc_ledger: "mxzaz-hqaaa-aaaar-qaada-cai" };
  const updateSource = Principal.selfAuthenticating(
    new Uint8Array(32).fill(88),
  ).toText();
  let serveOptions: Record<string, unknown> | undefined;
  let fixtureOptions: Record<string, unknown> | undefined;
  let updateSourceOptions: Record<string, unknown> | undefined;
  let chainStateDirectory = "";
  const startupOrder: string[] = [];
  try {
    const handle = await startLocalServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: "a".repeat(64),
        sessionPath,
        stateDirectory,
      },
      {
        logger: { log() {} },
        ensureChainServices: async ({ stateDirectory: actual }) => {
          startupOrder.push("chains");
          chainStateDirectory = actual;
          return {
            bitcoin: {
              rpcUrl: "http://localhost:18443",
              p2pAddress: "127.0.0.1:18444",
              dataDirectory: "/bitcoin",
            },
            ethereum: {
              rpcUrl: "http://127.0.0.1:8545",
              chainId: 1,
              statePath: "/anvil/state.json",
            },
          };
        },
        resolveBinary: async (options) => {
          startupOrder.push("binary");
          return {
            path: path.join(options.cacheDirectory, "pocket-ic"),
            version: "14.0.0",
            sha256: descriptor.binarySha256,
            artifactUrl: "https://example.invalid/pocket-ic.gz",
          };
        },
        serve: async (options) => {
          startupOrder.push("pocketic");
          serveOptions = options as unknown as Record<string, unknown>;
          await options.publishDescriptor!(descriptor);
          return {
            descriptor,
            async wait() {},
            async stop() {},
          };
        },
        ensureFixtures: async (options) => {
          startupOrder.push("fixtures");
          fixtureOptions = options as unknown as Record<string, unknown>;
          return fixtures;
        },
        ensureUpdateSource: async (options) => {
          startupOrder.push("update-source");
          updateSourceOptions = options as unknown as Record<string, unknown>;
          await options.recordCanisterId?.(updateSource);
          return updateSource;
        },
      },
    );
    const expectedFixtures = { ...fixtures, update_source: updateSource };
    expect(handle.descriptor).toEqual({
      ...descriptor,
      fixtures: expectedFixtures,
    });
    expect(chainStateDirectory).toBe(stateDirectory);
    expect(startupOrder).toEqual([
      "chains",
      "binary",
      "pocketic",
      "fixtures",
      "update-source",
    ]);
    expect(serveOptions?.previousDescriptor).toBeUndefined();
    expect(serveOptions?.lockPath).toBe(
      path.join(root, ".neutron", "pocketic-supervisor.lock"),
    );
    expect(serveOptions?.ownerSessionPath).toBe(sessionPath);
    expect(fixtureOptions).toMatchObject({
      gatewayUrl: descriptor.gateway.url,
      expectedRootKeyBase64: descriptor.rootKeyBase64,
      cacheDirectory: path.join(root, ".neutron", "cache", "fixtures"),
    });
    expect(updateSourceOptions).toMatchObject({
      gatewayUrl: descriptor.gateway.url,
      expectedRootKeyBase64: descriptor.rootKeyBase64,
      defaultEffectiveCanisterIdBase64:
        descriptor.topology.defaultEffectiveCanisterId,
      cacheDirectory: path.join(root, ".neutron", "cache", "fixtures"),
    });
    expect(updateSourceOptions).not.toHaveProperty("existingCanisterId");
    expect(await readSession(sessionPath)).toMatchObject({
      schema: 3,
      configSha256: "a".repeat(64),
      runtime: {
        kind: "pocketic",
        instanceId: 0,
        fixtures: expectedFixtures,
      },
    });

    let reusedUpdateSource: string | undefined;
    const persistedDescriptor = { ...descriptor, fixtures: expectedFixtures };
    await startLocalServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: "b".repeat(64),
        sessionPath,
        stateDirectory,
      },
      {
        logger: { log() {} },
        ensureChainServices: async () => ({
          bitcoin: {
            rpcUrl: "http://localhost:18443",
            p2pAddress: "127.0.0.1:18444",
            dataDirectory: "/bitcoin",
          },
          ethereum: {
            rpcUrl: "http://127.0.0.1:8545",
            chainId: 1,
            statePath: "/anvil/state.json",
          },
        }),
        resolveBinary: async (options) => ({
          path: path.join(options.cacheDirectory, "pocket-ic"),
          version: "14.0.0",
          sha256: descriptor.binarySha256,
          artifactUrl: "https://example.invalid/pocket-ic.gz",
        }),
        serve: async (options) => {
          expect(options.previousDescriptor).toEqual(persistedDescriptor);
          return {
            descriptor: persistedDescriptor,
            async wait() {},
            async stop() {},
          };
        },
        ensureFixtures: async () => fixtures,
        ensureUpdateSource: async (options) => {
          reusedUpdateSource = options.existingCanisterId;
          return updateSource;
        },
      },
    );
    expect(reusedUpdateSource).toBe(updateSource);
    expect(await readSession(sessionPath)).toMatchObject({
      configSha256: "b".repeat(64),
      runtime: { fixtures: expectedFixtures },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another local config attaches through the live supervisor owner session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-attach-"));
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const ownerSessionPath = path.join(root, "owner.ndeploy.session.json");
  const attachedSessionPath = path.join(root, "app.ndeploy.session.json");
  const descriptor = validDescriptor(stateDirectory);
  try {
    const owner = completedLocalJournal(
      "a".repeat(64),
      descriptor,
      root,
    );
    (owner.current as unknown as Record<string, unknown>).canisterId =
      NEUTRON_CANISTER_ID;
    await writeFile(ownerSessionPath, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
    await expect(
      attachLocalConfigToRunningServer(
        {
          profile: "full_protocol_fixtures",
          configSha256: "b".repeat(64),
          sessionPath: attachedSessionPath,
          stateDirectory,
        },
        {
          readSupervisorOwner: async () => ({
            pid: 10,
            processIdentity: "linux:10:10",
            ownerSessionPath,
          }),
        },
      ),
    ).rejects.toThrow(/unknown field.*canisterId/u);
    delete (owner.current as unknown as Record<string, unknown>).canisterId;
    await writeFile(ownerSessionPath, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
    let verified = 0;
    const attached = await attachLocalConfigToRunningServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: "b".repeat(64),
        sessionPath: attachedSessionPath,
        stateDirectory,
      },
      {
        readSupervisorOwner: async () => ({
          pid: 10,
          processIdentity: "linux:10:10",
          ownerSessionPath,
        }),
        verifyRuntime: async (actual) => {
          expect(actual).toEqual(descriptor);
          verified += 1;
          return {} as PocketIcRuntimeAttachment;
        },
      },
    );
    expect(attached).toEqual(descriptor);
    expect(verified).toBe(1);
    expect(await readSession(attachedSessionPath)).toMatchObject({
      schema: 3,
      configSha256: "b".repeat(64),
      runtime: {
        kind: "pocketic",
        stateDirectory,
        instanceId: descriptor.instanceId,
        rootKeyBase64: descriptor.rootKeyBase64,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment does not bless an old deployment with a changed config hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-config-binding-"));
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const sessionPath = path.join(root, "local.ndeploy.session.json");
  const descriptor = validDescriptor(stateDirectory);
  const oldConfigSha256 = "a".repeat(64);
  const changedConfigSha256 = "b".repeat(64);
  try {
    await writeSession(
      sessionPath,
      completedLocalJournal(oldConfigSha256, descriptor, root),
      NOW,
    );
    await attachLocalConfigToRunningServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: changedConfigSha256,
        sessionPath,
        stateDirectory,
      },
      {
        readSupervisorOwner: async () => ({
          pid: descriptor.pid,
          processIdentity: descriptor.processIdentity,
          ownerSessionPath: sessionPath,
        }),
        verifyRuntime: async () => ({}) as PocketIcRuntimeAttachment,
      },
    );

    expect(await readSession(sessionPath)).toMatchObject({
      configSha256: oldConfigSha256,
      current: { kind: "local" },
      localFleet: {
        schema: 1,
        nodes: [{ label: "primary", canisterId: NEUTRON_CANISTER_ID }],
      },
    });
    await expect(
      readLocalServerStatus({
        profile: "full_protocol_fixtures",
        configSha256: changedConfigSha256,
        sessionPath,
      }),
    ).rejects.toThrow("does not match the selected deployment config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attachment clears deployment receipts when PocketIC state identity changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-state-binding-"));
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const ownerSessionPath = path.join(root, "owner.ndeploy.session.json");
  const attachedSessionPath = path.join(root, "attached.ndeploy.session.json");
  const oldDescriptor = validDescriptor(stateDirectory);
  const replacementDescriptor = {
    ...validDescriptor(stateDirectory),
    rootKeyBase64: "Ag==",
  };
  const changedConfigSha256 = "b".repeat(64);
  try {
    await writeSession(
      ownerSessionPath,
      createPocketIcJournal(
        "c".repeat(64),
        {
          kind: "pocketic",
          ...replacementDescriptor,
        },
        NOW,
      ),
      NOW,
    );
    await writeSession(
      attachedSessionPath,
      completedLocalJournal("a".repeat(64), oldDescriptor, root),
      NOW,
    );

    await attachLocalConfigToRunningServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: changedConfigSha256,
        sessionPath: attachedSessionPath,
        stateDirectory,
      },
      {
        readSupervisorOwner: async () => ({
          pid: replacementDescriptor.pid,
          processIdentity: replacementDescriptor.processIdentity,
          ownerSessionPath,
        }),
        verifyRuntime: async () => ({}) as PocketIcRuntimeAttachment,
      },
    );

    expect(await readSession(attachedSessionPath)).toMatchObject({
      configSha256: changedConfigSha256,
      runtime: { rootKeyBase64: "Ag==" },
    });
    expect((await readSession(attachedSessionPath))?.current).toBeUndefined();
    expect((await readSession(attachedSessionPath))?.active).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attaching to a live supervisor still ensures native chain services", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-local-attached-chains-"));
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const ownerSessionPath = path.join(root, "owner.ndeploy.session.json");
  const attachedSessionPath = path.join(root, "attached.ndeploy.session.json");
  const descriptor = validDescriptor(stateDirectory);
  let chainChecks = 0;
  try {
    await writeSession(
      ownerSessionPath,
      createPocketIcJournal(
        "a".repeat(64),
        {
          kind: "pocketic",
          ...descriptor,
        },
        NOW,
      ),
      NOW,
    );
    const handle = await startLocalServer(
      {
        profile: "full_protocol_fixtures",
        configSha256: "b".repeat(64),
        sessionPath: attachedSessionPath,
        stateDirectory,
      },
      {
        logger: { log() {} },
        readSupervisorOwner: async () => ({
          pid: descriptor.pid,
          processIdentity: descriptor.processIdentity,
          ownerSessionPath,
        }),
        verifyRuntime: async () => ({}) as PocketIcRuntimeAttachment,
        ensureChainServices: async ({ stateDirectory: actual }) => {
          expect(actual).toBe(stateDirectory);
          chainChecks += 1;
          return localChainServices();
        },
      },
    );
    expect(chainChecks).toBe(1);
    await handle.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime paths share one repository-local supervisor", () => {
  expect(localRuntimePaths("/repo/.neutron/pocketic")).toEqual({
    runtimeDirectory: "/repo/.neutron/runtime",
    binaryCacheDirectory: "/repo/.neutron/cache/bin",
    supervisorLockPath: "/repo/.neutron/pocketic-supervisor.lock",
  });
  expect(localFixtureCacheDirectory("/repo/.neutron/pocketic")).toBe(
    "/repo/.neutron/cache/fixtures",
  );
});

function validDescriptor(stateDirectory: string): PocketIcRuntimeDescriptor {
  return {
    profile: "full_protocol_fixtures",
    serverVersion: "14.0.0",
    binarySha256:
      "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
    pid: 100,
    processIdentity: "linux:100:1000",
    startedAt: "2026-07-22T12:00:00.000Z",
    idleTtlSeconds: 2_592_000,
    controlUrl: "http://127.0.0.1:8080/",
    instanceId: 0,
    instanceConfigDigest: pocketIcInstanceConfigDigest(
      createNeutronPocketIcInstanceConfig({
        stateDirectory,
        profile: "full_protocol_fixtures",
      }),
    ),
    stateDirectory,
    gateway: {
      id: 0,
      url: "http://localhost:8000/",
      bind: "127.0.0.1",
      port: 8000,
    },
    rootKeyBase64: "AQ==",
    topology: summarizePocketIcTopology(
      pocketIcTestTopology(),
      "full_protocol_fixtures",
    ).summary,
    fixtures: {},
  };
}

function completedLocalJournal(
  configSha256: string,
  descriptor: PocketIcRuntimeDescriptor,
  root: string,
) {
  const journal = createPocketIcJournal(
    configSha256,
    { kind: "pocketic", ...descriptor },
    NOW,
  );
  const planFingerprint = "d".repeat(64);
  startLocalReinstall(journal, planFingerprint, ["primary"], NOW);
  recordLocalCanister(
    journal,
    "primary",
    NEUTRON_CANISTER_ID,
    NOW,
  );
  for (const phase of [
    "installed",
    "seeded",
    "authorized",
    "funded",
    "verified",
  ] as const) {
    recordLocalNodePhase(journal, 0, phase, NOW);
  }
  completeLocalReinstall(
    journal,
    {
      planFingerprint,
      deploymentId: "local-deployment",
      wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
      transportWasmSha256: "e".repeat(64),
      packages: [
        {
          path: path.join(root, "kernel.v0.1.1.neutron"),
          id: "kernel",
          version: 100_000,
          sha256: "f".repeat(64),
          bytes: 1,
        },
      ],
    },
    NOW,
  );
  return journal;
}

function localChainServices() {
  return {
    bitcoin: {
      rpcUrl: "http://localhost:18443",
      p2pAddress: "127.0.0.1:18444",
      dataDirectory: "/bitcoin",
    },
    ethereum: {
      rpcUrl: "http://127.0.0.1:8545" as const,
      chainId: 1 as const,
      statePath: "/anvil/state.json",
    },
  };
}
