import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1 } from "neutron-tools/src/wasm_metadata.js";
import {
  runLocalAuthorize,
  type LocalAuthorizeDependencies,
} from "../src/local_authorize.ts";
import { localIdentityFromSeed } from "../src/kernel.ts";
import {
  createNeutronPocketIcInstanceConfig,
  pocketIcInstanceConfigDigest,
  summarizePocketIcTopology,
} from "../src/pocketic_rest.ts";
import {
  createPocketIcJournal,
  writeSession,
  type ProvisionJournal,
} from "../src/session.ts";
import { pocketIcTestTopology } from "./pocketic_test_fixture.ts";

const CONFIG_SHA256 = "a".repeat(64);
const MODULE_SHA256 = "b".repeat(64);
const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const UPDATE_SOURCE_ID = "r7inp-6aaaa-aaaaa-aaabq-cai";
const TARGET_PRINCIPAL =
  "pbwxr-uqxlv-aiwi3-omw2n-ptdex-kyifb-kdsn6-zdiyd-ggzpu-nrzik-rqe";
const NOW = new Date("2026-07-22T12:00:00.000Z");

describe("local principal authorization", () => {
  test("uses the configured controller and leaves the deployment journal unchanged", async () => {
    await withCompletedJournal(async ({ sessionPath, journal }) => {
      const original = await readFile(sessionPath, "utf8");
      const developer = localIdentityFromSeed(2).getPrincipal().toText();
      const events: string[] = [];
      const result = await runLocalAuthorize(
        {
          configSha256: CONFIG_SHA256,
          sessionPath,
          developerIdentitySeed: 2,
          principal: TARGET_PRINCIPAL,
        },
        {
          verifyRuntime: async (descriptor) => {
            expect(descriptor.gateway.url).toBe("http://localhost:8000/");
            events.push("verify-runtime");
          },
          createClient: async (input) => {
            expect(input.identity.getPrincipal().toText()).toBe(developer);
            expect(input.expectedRootKeyBase64).toBe("AQ==");
            return {
              async operationalState(canisterId) {
                expect(canisterId).toBe(CANISTER_ID);
                events.push("module");
                return {
                  moduleHash: MODULE_SHA256,
                  controllers: [developer, CANISTER_ID],
                  status: "running" as const,
                };
              },
              async authorizePrincipal(canisterId, principal) {
                expect(canisterId).toBe(CANISTER_ID);
                expect(principal).toBe(TARGET_PRINCIPAL);
                events.push("authorize");
                return [developer, TARGET_PRINCIPAL].sort();
              },
            };
          },
          logger: { log: (message) => events.push(message) },
        },
      );

      expect(result).toEqual({
        canisterId: CANISTER_ID,
        principal: TARGET_PRINCIPAL,
        authorizedPrincipals: [developer, TARGET_PRINCIPAL].sort(),
        nodes: [
          {
            label: "alpha",
            canisterId: CANISTER_ID,
            authorizedPrincipals: [developer, TARGET_PRINCIPAL].sort(),
          },
        ],
      });
      expect(events).toEqual([
        "verify-runtime",
        "module",
        "authorize",
        `Authorized ${TARGET_PRINCIPAL} on alpha (${CANISTER_ID})`,
      ]);
      expect(await readFile(sessionPath, "utf8")).toBe(original);
      expect(journal.current?.transportWasmSha256).toBe(MODULE_SHA256);
    });
  });

  test("rejects stale config, active reinstall, and module drift before mutation", async () => {
    await withCompletedJournal(async ({ sessionPath, journal }) => {
      const dependencies = noMutationDependencies();
      await expect(
        runLocalAuthorize(
          {
            configSha256: "c".repeat(64),
            sessionPath,
            developerIdentitySeed: 2,
            principal: TARGET_PRINCIPAL,
          },
          dependencies,
        ),
      ).rejects.toThrow("does not match");

      journal.active = {
        kind: "local-reinstall",
        state: {
          startedAt: NOW.toISOString(),
          inputFingerprint: "d".repeat(64),
          desiredNodeCount: 1,
          nodes: [
            {
              nodeIndex: 0,
              phase: "pending",
              updatedAt: NOW.toISOString(),
            },
          ],
        },
      };
      await writeSession(sessionPath, journal, NOW);
      await expect(
        runLocalAuthorize(localOptions(sessionPath), dependencies),
      ).rejects.toThrow("reinstall is active");

      delete journal.active;
      await writeSession(sessionPath, journal, NOW);
      await expect(
        runLocalAuthorize(localOptions(sessionPath), {
          verifyRuntime: async () => {},
          createClient: async () => ({
            async operationalState() {
              return {
                moduleHash: "e".repeat(64),
                controllers: [],
                status: "running" as const,
              };
            },
            async authorizePrincipal() {
              throw new Error("must not authorize drifted module");
            },
          }),
          logger: silentLogger,
        }),
      ).rejects.toThrow("module drift");

      await expect(
        runLocalAuthorize(localOptions(sessionPath), {
          verifyRuntime: async () => {},
          createClient: async () => ({
            async operationalState() {
              return {
                moduleHash: MODULE_SHA256,
                controllers: [],
                status: "running" as const,
              };
            },
            async authorizePrincipal() {
              throw new Error("must not authorize drifted controllers");
            },
          }),
          logger: silentLogger,
        }),
      ).rejects.toThrow("controller drift");
    });
  });

  test("preflights and authorizes every fleet node in canonical order", async () => {
    await withCompletedJournal(async ({ sessionPath, journal }) => {
      const canisterIds = [
        CANISTER_ID,
        Principal.selfAuthenticating(new Uint8Array(32).fill(21)).toText(),
        Principal.selfAuthenticating(new Uint8Array(32).fill(22)).toText(),
      ];
      journal.localFleet = {
        schema: 1,
        nodes: ["alpha", "bravo", "charlie"].map((label, index) => ({
          label,
          canisterId: canisterIds[index]!,
        })),
      };
      await writeSession(sessionPath, journal, NOW);
      const events: string[] = [];
      const developer = localIdentityFromSeed(2).getPrincipal().toText();

      const result = await runLocalAuthorize(localOptions(sessionPath), {
        verifyRuntime: async () => {},
        createClient: async () => ({
          async operationalState(canisterId) {
            events.push(`preflight:${canisterId}`);
            return {
              moduleHash: MODULE_SHA256,
              controllers: [developer, canisterId],
              status: "running" as const,
            };
          },
          async authorizePrincipal(canisterId, principal) {
            events.push(`authorize:${canisterId}`);
            return [developer, principal].sort();
          },
        }),
        logger: silentLogger,
      });

      expect(result.nodes.map(({ canisterId }) => canisterId)).toEqual(
        canisterIds,
      );
      expect(events).toEqual([
        ...canisterIds.map((canisterId) => `preflight:${canisterId}`),
        ...canisterIds.map((canisterId) => `authorize:${canisterId}`),
      ]);
    });
  });

  test("rejects anonymous authorization before reading local state", async () => {
    await expect(
      runLocalAuthorize({
        configSha256: CONFIG_SHA256,
        sessionPath: "/does/not/exist",
        developerIdentitySeed: 2,
        principal: "2vxsx-fae",
      }),
    ).rejects.toThrow("must not be the anonymous principal");
  });
});

async function withCompletedJournal(
  run: (input: {
    sessionPath: string;
    journal: ProvisionJournal;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-authorize-"));
  const sessionPath = path.join(root, "local.ndeploy.session.json");
  const stateDirectory = path.join(root, ".neutron", "pocketic");
  const journal = createPocketIcJournal(
    CONFIG_SHA256,
    validRuntime(stateDirectory),
    NOW,
  );
  journal.current = {
    kind: "local",
    completedAt: NOW.toISOString(),
    planFingerprint: "f".repeat(64),
    deploymentId: "deployment-local",
    wasmMetadata: SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
    transportWasmSha256: MODULE_SHA256,
    packages: [
      {
        path: path.join(root, "kernel.neutron"),
        id: "kernel",
        version: 1,
        sha256: "1".repeat(64),
        bytes: 1,
      },
    ],
  };
  journal.localFleet = {
    schema: 1,
    nodes: [{ label: "alpha", canisterId: CANISTER_ID }],
  };
  await writeSession(sessionPath, journal, NOW);
  try {
    await run({ sessionPath, journal });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validRuntime(stateDirectory: string) {
  return {
    kind: "pocketic" as const,
    profile: "full_protocol_fixtures" as const,
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
        profile: "full_protocol_fixtures",
        stateDirectory,
      }),
    ),
    stateDirectory,
    gateway: {
      id: 0,
      url: "http://localhost:8000/" as const,
      bind: "127.0.0.1" as const,
      port: 8000 as const,
    },
    rootKeyBase64: "AQ==",
    topology: summarizePocketIcTopology(
      pocketIcTestTopology(),
      "full_protocol_fixtures",
    ).summary,
    fixtures: { update_source: UPDATE_SOURCE_ID },
  };
}

function localOptions(sessionPath: string) {
  return {
    configSha256: CONFIG_SHA256,
    sessionPath,
    developerIdentitySeed: 2,
    principal: TARGET_PRINCIPAL,
  };
}

function noMutationDependencies(): LocalAuthorizeDependencies {
  return {
    verifyRuntime: async () => {
      throw new Error("must not verify runtime");
    },
    createClient: async () => {
      throw new Error("must not create client");
    },
    logger: silentLogger,
  };
}

const silentLogger = { log() {} };
