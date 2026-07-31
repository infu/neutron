import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdoptOptions } from "../src/adopt.ts";
import { main, parseProvisionCli } from "../src/cli.ts";
import { normalizeHost, parseIcp } from "../src/config.ts";
import { parseBlastIdentityId } from "../src/identity.ts";
import type { LocalAuthorizeOptions } from "../src/local_authorize.ts";
import type { ProvisionOptions } from "../src/provision.ts";
import type { ReinstallOptions } from "../src/reinstall.ts";

const AUTHORIZED_PRINCIPAL =
  "pbwxr-uqxlv-aiwi3-omw2n-ptdex-kyifb-kdsn6-zdiyd-ggzpu-nrzik-rqe";
const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";

describe("provision CLI parsing and archive routing", () => {
  test("parses bounded scalar inputs", () => {
    expect(parseIcp("5")).toBe(500_000_000n);
    expect(parseIcp("0.00000001")).toBe(1n);
    expect(() => parseIcp("1.000000001")).toThrow();
    expect(parseBlastIdentityId("65535")).toBe(65_535);
    expect(() => parseBlastIdentityId("65536")).toThrow();
    expect(normalizeHost("https://icp-api.io/")).toBe("https://icp-api.io");
    expect(() => normalizeHost("http://icp-api.io")).toThrow();
  });

  test("accepts only the closed config-first command surface", () => {
    expect(parseProvisionCli(["deploy.ndeploy.json", "create"])).toEqual({
      help: false,
      configPath: path.resolve("deploy.ndeploy.json"),
      command: "create",
      execute: false,
      yes: false,
    });
    expect(
      parseProvisionCli([
        "deploy.ndeploy.json",
        "authorize",
        AUTHORIZED_PRINCIPAL,
      ]),
    ).toMatchObject({ command: "authorize", principal: AUTHORIZED_PRINCIPAL });
    expect(() =>
      parseProvisionCli(["deploy.ndeploy.json", "create", "--no-build"]),
    ).toThrow("Unknown option");
    expect(() =>
      parseProvisionCli(["deploy.ndeploy.json", "bootstrap"]),
    ).toThrow("Unknown provision command");
    expect(() =>
      parseProvisionCli([
        "deploy.ndeploy.json",
        "adopt",
        CANISTER,
        "--execute",
        "--yes",
      ]),
    ).toThrow("adopt does not accept --yes");
  });

  test("advertises only the current adoption flags", async () => {
    const output: string[] = [];
    await main(["--help"], {
      log: (value) => output.push(String(value)),
      error: () => {},
    });
    const help = output.join("\n");
    expect(help).toContain(
      "adopt CANISTER_ID [--execute]",
    );
    expect(help).not.toContain(
      "adopt CANISTER_ID [--execute] [--yes]",
    );
  });

  test("adoption never prepares or builds package archives", async () => {
    let seen: AdoptOptions | undefined;
    let prepares = 0;
    await main(
      ["deploy.ndeploy.json", "adopt", CANISTER, "--execute"],
      silentLogger,
      {
        loadConfig: async () => icConfig,
        prepareDeployment: async () => {
          prepares += 1;
          throw new Error("unexpected prepare");
        },
        createDeploymentEvidenceProvider: () =>
          fakeDeploymentEvidenceProvider,
        adopt: async (options) => {
          seen = options;
          return {} as never;
        },
      },
    );
    expect(prepares).toBe(0);
    expect(seen).toMatchObject({
      configSha256: icConfig.configSha256,
      canisterId: CANISTER,
      execute: true,
    });
  });

  test("create and IC reinstall receive the exact configured artifact pins", async () => {
    let created: ProvisionOptions | undefined;
    let reinstalled: ReinstallOptions | undefined;
    await main(["deploy.ndeploy.json", "create"], silentLogger, {
      loadConfig: async () => icConfig,
      createDeploymentEvidenceProvider: () =>
        fakeDeploymentEvidenceProvider,
      provision: async (options, dependencies) => {
        created = options;
        expect(dependencies?.prepare).toBeUndefined();
        return {} as never;
      },
    });
    await main(
      ["deploy.ndeploy.json", "reinstall", "--execute", "--yes"],
      silentLogger,
      {
        loadConfig: async () => icConfig,
        createDeploymentEvidenceProvider: () =>
          fakeDeploymentEvidenceProvider,
        reinstall: async (options, dependencies) => {
          reinstalled = options;
          expect(dependencies?.prepare).toBeUndefined();
          return {} as never;
        },
      },
    );
    expect(created?.expectedArtifacts).toEqual(packageArtifacts);
    expect(reinstalled?.expectedArtifacts).toEqual(packageArtifacts);
  });

  test("routes the ordered three-node local fleet without a build callback", async () => {
    let seen: unknown;
    await main(["wagyu-local.ndeploy.json", "reinstall"], silentLogger, {
      loadConfig: async () => localConfig,
      attachLocalConfig: async () => fakeDescriptor as never,
      localReinstall: async (options, dependencies) => {
        seen = options;
        expect(dependencies?.prepare).toBeFunction();
        return {} as never;
      },
    });
    expect(seen).toEqual({
      configSha256: localConfig.configSha256,
      sessionPath: localConfig.sessionPath,
      developerIdentitySeed: 2,
      nodeLabels: ["alpha", "bravo", "charlie"],
      authorizedPrincipals: [AUTHORIZED_PRINCIPAL],
      packagePaths: ["/repo/kernel.neutron", "/repo/wagyu.neutron"],
      repositoryRoot: "/repo",
      compileCacheDirectory: "/repo/.neutron/cache/compiled",
      profile: "full_protocol_fixtures",
    });
  });

  test("resolves path-only archives only for local reinstall and derives without caller pins", async () => {
    await withTempDirectory(async (root) => {
      const kernelPath = path.join(root, "kernel.neutron");
      const wagyuPath = path.join(root, "wagyu.neutron");
      await writeFile(kernelPath, "kernel");
      await writeFile(wagyuPath, "wagyu");
      const lazyLocalConfig = {
        ...localConfig,
        configPath: path.join(root, "wagyu-local.ndeploy.json"),
        sessionPath: path.join(root, "wagyu-local.ndeploy.session.json"),
        packageArtifacts: [],
        localPackagePaths: ["kernel.neutron", "wagyu.neutron"],
        target: {
          ...localConfig.target,
          stateDirectory: path.join(root, ".neutron", "pocketic"),
        },
      };
      let expectedArtifacts: unknown = "not-called";
      await main(
        [lazyLocalConfig.configPath, "reinstall"],
        silentLogger,
        {
          loadConfig: async () => lazyLocalConfig,
          attachLocalConfig: async () => fakeDescriptor as never,
          prepareDeployment: async (_paths, options) => {
            expectedArtifacts = options?.expectedArtifacts;
            return {} as never;
          },
          localReinstall: async (options, dependencies) => {
            expect(options.packagePaths).toEqual([kernelPath, wagyuPath]);
            await dependencies?.prepare?.(options.packagePaths, {
              target: "local",
            });
            return {} as never;
          },
        },
      );
      expect(expectedArtifacts).toBeUndefined();
    });
  });

  test("serve, status, and authorize never touch missing path-only archives", async () => {
    await withTempDirectory(async (root) => {
      const configPath = path.join(root, "lazy-local.ndeploy.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          format: 3,
          target: {
            kind: "pocketic",
            profile: "full_protocol_fixtures",
            gateway_port: 8000,
            developer_identity_seed: 2,
            authorized_principals: [AUTHORIZED_PRINCIPAL],
            nodes: ["alpha"],
          },
          artifacts: {
            kind: "inline",
            kernel: { path: "missing/kernel.neutron" },
            packages: [{ path: "missing/wagyu.neutron" }],
          },
        })}\n`,
      );
      let served = false;
      let statusRead = false;
      let authorized = false;
      await main([configPath, "serve"], silentLogger, {
        startLocalServer: async () => {
          served = true;
          return {} as never;
        },
        waitForServer: async () => {},
      });
      await main([configPath, "status"], silentLogger, {
        readLocalServerStatus: async () => {
          statusRead = true;
          return {
            healthy: true,
            descriptor: fakeDescriptor as never,
            session: { current: undefined } as never,
          };
        },
      });
      await main(
        [configPath, "authorize", AUTHORIZED_PRINCIPAL],
        silentLogger,
        {
          localAuthorize: async (options) => {
            authorized = true;
            return {
              canisterId: CANISTER,
              principal: options.principal,
              authorizedPrincipals: [options.principal],
              nodes: [],
            };
          },
        },
      );
      expect({ served, statusRead, authorized }).toEqual({
        served: true,
        statusRead: true,
        authorized: true,
      });
    });
  });

  test("routes authorization and read-only local status", async () => {
    let authorization: LocalAuthorizeOptions | undefined;
    await main(
      ["wagyu-local.ndeploy.json", "authorize", AUTHORIZED_PRINCIPAL],
      silentLogger,
      {
        loadConfig: async () => localConfig,
        localAuthorize: async (options) => {
          authorization = options;
          return {
            canisterId: CANISTER,
            principal: options.principal,
            authorizedPrincipals: [options.principal],
            nodes: [
              {
                label: "alpha",
                canisterId: CANISTER,
                authorizedPrincipals: [options.principal],
              },
            ],
          };
        },
      },
    );
    expect(authorization).toMatchObject({
      configSha256: localConfig.configSha256,
      principal: AUTHORIZED_PRINCIPAL,
    });

    await main(["wagyu-local.ndeploy.json", "status"], silentLogger, {
      loadConfig: async () => localConfig,
      readLocalServerStatus: async () => ({
        healthy: true,
        descriptor: fakeDescriptor as never,
        session: { current: undefined } as never,
      }),
    });
  });

});

async function withTempDirectory(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ndeploy-cli-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const packageArtifacts = [
  {
    path: "/repo/kernel.neutron",
    id: "kernel",
    version: 1,
    sha256: "1".repeat(64),
    bytes: 100,
  },
  {
    path: "/repo/wagyu.neutron",
    id: "wagyu",
    version: 1,
    sha256: "2".repeat(64),
    bytes: 200,
  },
];

const icConfig = {
  configPath: "/repo/deploy.ndeploy.json",
  configSha256: "a".repeat(64),
  sessionPath: "/repo/deploy.ndeploy.session.json",
  packageArtifacts,
  target: {
    kind: "ic" as const,
    host: "https://icp-api.io",
    identityId: 0,
    targetSubnet: CANISTER,
    amountE8s: 500_000_000n,
    controllers: [],
    deploymentEvidence: {
      source: "ic_registry_certified_v1" as const,
      registry_canister: "rwlgt-iiaaa-aaaaa-aaaaa-cai" as const,
      root_key_sha256:
        "737ba355e855bd4b61279056603e05501db5e5bad147c6eba7be8c2a13f4b6b3" as const,
      pricing_profile: "application_13_node" as const,
    },
  },
};

const localConfig = {
  configPath: "/repo/wagyu-local.ndeploy.json",
  configSha256: "b".repeat(64),
  sessionPath: "/repo/wagyu-local.ndeploy.session.json",
  packageArtifacts,
  target: {
    kind: "pocketic" as const,
    profile: "full_protocol_fixtures" as const,
    gatewayPort: 8000,
    developerIdentitySeed: 2,
    nodeLabels: ["alpha", "bravo", "charlie"],
    authorizedPrincipals: [AUTHORIZED_PRINCIPAL],
    stateDirectory: "/repo/.neutron/pocketic",
  },
};

const fakeDescriptor = {
  gateway: { url: "http://localhost:8000/" },
  instanceId: 0,
  serverVersion: "14.0.0",
};

const fakeDeploymentEvidenceProvider = {
  async observe() {
    throw new Error("unexpected deployment evidence observation");
  },
};

const silentLogger = { log() {}, error() {} };
