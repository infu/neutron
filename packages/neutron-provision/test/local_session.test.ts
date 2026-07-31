import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 } from "neutron-tools/src/wasm_metadata.js";
import {
  ndeployConfigSha256,
  NDEPLOY_MAX_CONFIG_BYTES,
} from "../src/config.ts";
import {
  resolveLocalNeutronCanisterId,
  resolveLocalNeutronRuntime,
} from "../src/local_session.ts";
import {
  createNeutronPocketIcInstanceConfig,
  pocketIcInstanceConfigDigest,
  summarizePocketIcTopology,
} from "../src/pocketic_rest.ts";
import {
  completeLocalReinstall,
  createPocketIcJournal,
  recordLocalCanister,
  recordLocalNodePhase,
  startLocalReinstall,
  type ProvisionJournal,
} from "../src/session.ts";
import { pocketIcTestTopology } from "./pocketic_test_fixture.ts";

const roots: string[] = [];
const CANISTER_ID = Principal.selfAuthenticating(new Uint8Array(32).fill(7)).toText();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("reads the completed canister from the config's schema-3 local session", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  const configSource = localConfigSource();
  writeFileSync(configPath, configSource);
  writeJournal(
    path.join(root, "dev.ndeploy.session.json"),
    completedJournal(configSource, root),
  );

  expect(
    resolveLocalNeutronCanisterId({
      configPath,
    }),
  ).toBe(CANISTER_ID);
  expect(resolveLocalNeutronRuntime({ configPath })).toMatchObject({
    canisterId: CANISTER_ID,
    controlUrl: "http://127.0.0.1:41000/",
    developerIdentityPrincipal:
      "ugnk3-oybq3-qsesh-kfxvo-pl2rt-y2h2x-bbtku-g6n4j-7xkvx-7l2u3-kae",
    developerIdentitySeed: 2,
    gatewayUrl: "http://localhost:8000/",
    instanceId: 3,
    sessionPath: path.join(root, "dev.ndeploy.session.json"),
  });
});

test("selects any node from a config-bound local Neutron fleet", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "fleet.ndeploy.json");
  const configSource = localConfigSource(3);
  const canisterIds = [7, 8, 9].map((byte) =>
    Principal.selfAuthenticating(new Uint8Array(32).fill(byte)).toText(),
  );
  writeFileSync(configPath, configSource);
  const journal = completedJournal(configSource, root);
  journal.localFleet = {
    schema: 1,
    nodes: ["alpha", "bravo", "charlie"].map((label, index) => ({
      label,
      canisterId: canisterIds[index]!,
    })),
  };
  writeJournal(
    path.join(root, "fleet.ndeploy.session.json"),
    journal,
  );

  expect(resolveLocalNeutronRuntime({ configPath, nodeIndex: 2 })).toMatchObject({
    canisterId: canisterIds[2],
    canisterIds,
    nodeIndex: 2,
  });
  expect(() =>
    resolveLocalNeutronRuntime({ configPath, nodeIndex: 3 }),
  ).toThrow(/node index must be from 0 through 2/u);
});

test("rejects non-current or incomplete sessions", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  const sessionPath = path.join(root, "dev.ndeploy.session.json");
  const configSource = localConfigSource();
  writeFileSync(configPath, configSource);
  const old = completedJournal(configSource, root) as unknown as {
    schema: number;
  };
  old.schema = 2;
  writeJournal(sessionPath, old);
  expect(() =>
    resolveLocalNeutronCanisterId({ configPath }),
  ).toThrow("Unsupported provision journal schema");

  const incomplete = completedJournal(configSource, root);
  delete incomplete.current;
  delete incomplete.localFleet;
  writeJournal(sessionPath, incomplete);
  expect(() =>
    resolveLocalNeutronCanisterId({ configPath }),
  ).toThrow(/has no completed local deployment/u);
});

test("binds the local session to the exact selected config bytes", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  const sessionPath = path.join(root, "dev.ndeploy.session.json");
  const configSource = localConfigSource();
  writeFileSync(configPath, configSource);
  const journal = completedJournal(configSource, root);
  journal.configSha256 = "0".repeat(64);
  writeJournal(sessionPath, journal);

  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /does not match config/u,
  );
});

test("requires the selected config itself to be format-3 PocketIC", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  writeFileSync(configPath, `${JSON.stringify({
    format: 3,
    target: {
      kind: "ic",
      host: "https://icp-api.io",
      identity_id: 0,
      subnet: "subnet",
      payment_icp: "1",
      controllers: [],
      deployment_evidence: {
        source: "ic_registry_certified_v1",
        registry_canister: "rwlgt-iiaaa-aaaaa-aaaaa-cai",
        root_key_sha256:
          "737ba355e855bd4b61279056603e05501db5e5bad147c6eba7be8c2a13f4b6b3",
        pricing_profile: "application_13_node",
      },
    },
    artifacts: {
      kind: "inline",
      kernel: {
        path: "kernel.neutron",
        sha256: "1".repeat(64),
        bytes: 1,
        id: "kernel",
        version: 1,
      },
      packages: [],
    },
  })}\n`);
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /must target PocketIC/u,
  );

  writeFileSync(
    configPath,
    localConfigSource().replace('"format":3', '"format":1'),
  );
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /config format must be 3/u,
  );
});

test("rejects an oversized selected config before reading its session", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  const source = localConfigSource();
  writeFileSync(
    configPath,
    source + " ".repeat(NDEPLOY_MAX_CONFIG_BYTES - Buffer.byteLength(source) + 1),
  );
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /exceeds the 1048576-byte limit/u,
  );
});

test("uses the journal's closed, private, no-symlink read boundary", () => {
  const root = temporaryRoot();
  const configPath = path.join(root, "dev.ndeploy.json");
  const sessionPath = path.join(root, "dev.ndeploy.session.json");
  const targetPath = path.join(root, "actual-session.json");
  const configSource = localConfigSource();
  writeFileSync(configPath, configSource);

  const withUnknown = completedJournal(configSource, root) as ProvisionJournal & {
    unexpected?: boolean;
  };
  withUnknown.unexpected = true;
  writeJournal(sessionPath, withUnknown);
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /unknown field\(s\): unexpected/u,
  );

  writeJournal(sessionPath, completedJournal(configSource, root));
  chmodSync(sessionPath, 0o644);
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /mode 0600 or stricter/u,
  );

  rmSync(sessionPath);
  writeJournal(targetPath, completedJournal(configSource, root));
  symlinkSync(targetPath, sessionPath);
  expect(() => resolveLocalNeutronRuntime({ configPath })).toThrow(
    /Refusing symlink provision journal/u,
  );
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "neutron-local-session-"));
  roots.push(root);
  return root;
}

function localConfigSource(neutronCount = 1): string {
  const labels = ["alpha", "bravo", "charlie"].slice(0, neutronCount);
  return `${JSON.stringify({
    format: 3,
    target: {
      kind: "pocketic",
      profile: "full_protocol_fixtures",
      gateway_port: 8000,
      developer_identity_seed: 2,
      authorized_principals: [],
      nodes: labels,
    },
    artifacts: inlineArtifacts(),
  })}\n`;
}

function inlineArtifacts() {
  return {
    kind: "inline",
    kernel: {
      path: "kernel.neutron",
    },
    packages: [],
  };
}

function completedJournal(configSource: string, root: string): ProvisionJournal {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const journal = createPocketIcJournal(
    ndeployConfigSha256(configSource),
    {
      kind: "pocketic",
      profile: "full_protocol_fixtures",
      serverVersion: "14.0.0",
      binarySha256:
        "f5009e61bcbff297435a67a8ef9fc02178ebb9ab3ee1ec3ac81f4fc3d49319c4",
      pid: 100,
      processIdentity: "linux:100:1000",
      startedAt: now.toISOString(),
      idleTtlSeconds: 2_592_000,
      controlUrl: "http://127.0.0.1:41000/",
      instanceId: 3,
      instanceConfigDigest: pocketIcInstanceConfigDigest(
        createNeutronPocketIcInstanceConfig({
          stateDirectory,
          profile: "full_protocol_fixtures",
        }),
      ),
      stateDirectory,
      gateway: {
        id: 3,
        url: "http://localhost:8000/",
        bind: "127.0.0.1",
        port: 8000,
      },
      rootKeyBase64: "AQ==",
      topology: summarizePocketIcTopology(
        pocketIcTestTopology(),
        "full_protocol_fixtures",
      ).summary,
      fixtures: { update_source: "r7inp-6aaaa-aaaaa-aaabq-cai" },
    },
    now,
  );
  const planFingerprint = "9".repeat(64);
  startLocalReinstall(journal, planFingerprint, ["alpha"], now);
  recordLocalCanister(journal, "alpha", CANISTER_ID, now);
  for (const phase of [
    "installed",
    "seeded",
    "authorized",
    "funded",
    "verified",
  ] as const) {
    recordLocalNodePhase(journal, 0, phase, now);
  }
  completeLocalReinstall(
    journal,
    {
      planFingerprint,
      deploymentId: "deployment-local",
      wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
      transportWasmSha256: "3".repeat(64),
      packages: [
        {
          path: "/cache/kernel.neutron",
          id: "kernel",
          version: 1,
          sha256: "1".repeat(64),
          bytes: 1,
        },
      ],
    },
    now,
  );
  return journal;
}

function writeJournal(filename: string, journal: unknown): void {
  writeFileSync(filename, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
}
