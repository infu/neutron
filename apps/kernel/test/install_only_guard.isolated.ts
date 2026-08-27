// This file is launched by install_only_guard.test.ts in a separate Bun
// process. Bun module mocks are process-global and cannot be restored safely.
import { beforeEach, expect, mock, test } from "bun:test";
import type {
  KernelPackageState,
  PreparedPackageInstall,
} from "neutron-compiler/src/install.js";

const deploymentId = "authenticated-runtime-baseline";
let compilerState: KernelPackageState;
let compileCalls: Array<{
  existingConfigs: KernelPackageState["existingConfigs"];
  existingBrowserSurfaceOriginAppIds: readonly string[];
  connectionProviderSupport: KernelPackageState["connectionProviderSupport"];
  preparedPackage: PreparedPackageInstall;
  vetKeysEnvironment: "local" | "production";
}> = [];
let runtimeAssertions = 0;

mock.module("icblast", () => ({
  default: () => async () => ({}),
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    }),
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

mock.module("neutron-compiler/src/install.js", () => ({
  BROWSER_SURFACE_ORIGINS_PATH: "/system/browser-surface-origins.json",
  appDependencyImpact: () => ({ direct: [], transitive: [] }),
  assertPreparedPackageArchiveIdentity: () => undefined,
  assertKernelPackageBaselineMatchesRuntime: (
    state: KernelPackageState,
    runtime: { deployment_id: string },
  ) => {
    expect(state).toBe(compilerState);
    expect(runtime.deployment_id).toBe(deploymentId);
    runtimeAssertions += 1;
  },
  compileAppUninstall: () => {
    throw new Error("Unexpected uninstall compilation");
  },
  compilePackages: () => {
    throw new Error("Unexpected package-batch compilation");
  },
  compilePackageInstall: (input: {
    existingConfigs: KernelPackageState["existingConfigs"];
    existingBrowserSurfaceOriginAppIds: readonly string[];
    connectionProviderSupport: KernelPackageState["connectionProviderSupport"];
    preparedPackage: PreparedPackageInstall;
    vetKeysEnvironment: "local" | "production";
  }) => {
    compileCalls.push({
      existingConfigs: input.existingConfigs,
      existingBrowserSurfaceOriginAppIds:
        input.existingBrowserSurfaceOriginAppIds,
      connectionProviderSupport: input.connectionProviderSupport,
      preparedPackage: input.preparedPackage,
      vetKeysEnvironment: input.vetKeysEnvironment,
    });
    return {
      wasm: new Uint8Array([0]),
    };
  },
  createDeploymentNonce: () => new Uint8Array([1]),
  deployPreparedPackages: () => {
    throw new Error("Unexpected deployment");
  },
  normalizeAppRegistry: (registry: unknown) => registry,
  parseBrowserSurfaceOriginsSidecar: () => [],
  planAppRegistryDependencies: () => ({}),
  preparePackageInstall: () => {
    throw new Error("Unexpected package preparation");
  },
  recoverPendingInstall: async () => ({ status: "none" }),
  readKernelPackageState: async () => compilerState,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS: {},
}));

mock.module(
  new URL(
    "../src/install_review/prepare_browser_deployment.ts",
    import.meta.url,
  ).pathname,
  () => ({
    prepareBrowserDeployment: async ({ packages }: { packages: readonly PreparedPackageInstall[] }) => {
      const record = Object.freeze({ state: "complete" });
      return Object.freeze({
        prepared: Object.freeze({
          record,
          recordBytes: new Uint8Array([1]),
          transportWasm: new Uint8Array([2]),
        }),
        review: Object.freeze({ record, suppliedPackages: packages }),
      });
    },
  }),
);

mock.module(
  new URL(
    "../src/install_review/deployment_build_review.ts",
    import.meta.url,
  ).pathname,
  () => ({
    createDeploymentBuildReviewModel: () => Object.freeze({}),
  }),
);

const actor = {
  kernel_runtime_info: async () => ({
    deployment_id: deploymentId,
    compiler_id: "moc_classical_test",
    apps: [],
  }),
};

mock.module(
  new URL("../src/reducer/auth.ts", import.meta.url).pathname,
  () => ({
    getNeutronCan: async () => actor,
    readKernelAssetJson: async () => undefined,
    readKernelAssetTextIfExists: async () => undefined,
    resetNeutronCan: () => undefined,
  }),
);

mock.module(
  new URL("../src/runtime_deployment.ts", import.meta.url).pathname,
  () => ({
    getRuntimeDeployment: () => ({ target: "pocketic" }),
  }),
);

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: {
      href: "http://aaaaa-aa.localhost:8000/",
    },
  },
});

const { compile_app } = await import("../src/reducer/apps.ts");

function packageFor(
  id: string,
  options: { isKernel?: boolean } = {},
): PreparedPackageInstall {
  return {
    isKernel: options.isKernel ?? false,
    manifest: { id },
  } as PreparedPackageInstall;
}

function baseline(
  installed: KernelPackageState["existingConfigs"] = {},
): KernelPackageState {
  return {
    registry: {},
    apps: {},
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: installed,
    existingModules: [],
    previousStable: null,
    connectionProviderSupport: {
      schema: "neutron.connection-provider-support.v1",
      providers: [{ provider: "openrouter", scopes: [] }],
    },
  };
}

beforeEach(() => {
  compilerState = baseline();
  compileCalls = [];
  runtimeAssertions = 0;
});

test("an offered Kernel package is rejected after baseline authentication", async () => {
  await expect(
    compile_app({
      preparedPackage: packageFor("replacement", { isKernel: true }),
      installOnly: true,
    }),
  ).rejects.toThrow(
    "App install offers can install only a new non-Kernel application",
  );

  expect(runtimeAssertions).toBe(1);
  expect(compileCalls).toEqual([]);
});

test("an offered installed app is rejected from compiler state, not UI state", async () => {
  const installedConfig = { id: "mail" };
  compilerState = baseline({
    mail: installedConfig,
  } as unknown as KernelPackageState["existingConfigs"]);

  await expect(
    compile_app({
      preparedPackage: packageFor("mail"),
      installOnly: true,
    }),
  ).rejects.toThrow(
    "App install offers can install only a new non-Kernel application",
  );

  expect(runtimeAssertions).toBe(1);
  expect(compileCalls).toEqual([]);
});

test("ordinary owner-entered updates remain permitted", async () => {
  const installedConfig = { id: "mail" };
  compilerState = baseline({
    mail: installedConfig,
  } as unknown as KernelPackageState["existingConfigs"]);
  const preparedPackage = packageFor("mail");

  await expect(compile_app({ preparedPackage })).resolves.toMatchObject({
    expectedDeploymentId: deploymentId,
    state: compilerState,
  });

  expect(runtimeAssertions).toBe(1);
  expect(compileCalls).toEqual([
    {
      existingConfigs: compilerState.existingConfigs,
      existingBrowserSurfaceOriginAppIds:
        compilerState.browserSurfaceOriginAppIds,
      connectionProviderSupport: compilerState.connectionProviderSupport,
      preparedPackage,
      vetKeysEnvironment: "local",
    },
  ]);
});
