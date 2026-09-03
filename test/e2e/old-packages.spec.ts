import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  preparePackageInstall,
  type AppRegistry,
} from "neutron-compiler/src/install.js";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
} from "@playwright/test";
import { Cbor, requestIdOf } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import {
  createKernelActor,
  localIdentityFromSeed,
} from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const OLD_PACKAGES_DIRECTORY = path.join(REPOSITORY_ROOT, "test", "old_packages");
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CHUNKED_INSTALL_METHODS = [
  "kernel_install_wasm_chunks_clear",
  "kernel_install_wasm_chunk",
  "kernel_install_code_chunked",
  "kernel_install_commit",
] as const;
type ChunkedInstallMethod = (typeof CHUNKED_INSTALL_METHODS)[number];
type LogicalUpdate = {
  argument: Uint8Array;
  paths: Set<string>;
  signedBodies: Set<string>;
};

const WASM_CHUNK_ARGUMENT = IDL.Record({
  deployment_id: IDL.Text,
  chunk: IDL.Vec(IDL.Nat8),
  sha256: IDL.Vec(IDL.Nat8),
});
const CHUNKED_INSTALL_ARGUMENT = IDL.Record({
  deployment_id: IDL.Text,
  chunk_hashes: IDL.Vec(IDL.Vec(IDL.Nat8)),
  wasm_module_hash: IDL.Vec(IDL.Nat8),
  wasm_memory_persistence: IDL.Variant({
    keep: IDL.Null,
    replace: IDL.Null,
  }),
});

const EXPECTED_ARCHIVES = [
  {
    filename: "cast_away.neutron",
    id: "cast_away",
    name: "Cast Away",
    version: 114,
    size: 254_230,
    sha256: "fc187bae36bc23467ca32683d1e7effbf766711ba1f0c1df6e3574df0da877ae",
  },
  {
    filename: "chipswap.neutron",
    id: "chipswap",
    name: "Chipswap",
    version: 127,
    size: 391_816,
    sha256: "05dc95f6f5a0bc6ad7a60c200af17e50c4cd1eb7e7dc59b348e5a2bb8ade4a4f",
  },
  {
    filename: "inspector_canister.neutron",
    id: "inspector",
    name: "Inspector Canister",
    version: 106,
    size: 284_012,
    sha256: "1bb90db9a0912e6e36049620bf4e1cd6919bab3b244aa5ec9e9a10b1e22009b6",
  },
  {
    filename: "principal_miner.neutron",
    id: "principalminer",
    name: "Principal Miner",
    version: 103,
    size: 299_877,
    sha256: "d2b96dd382c157305518a904554c905d33cf35c1356b59e8b1896720ec1c0766",
  },
] as const;

test.describe.configure({ retries: 0 });
test.skip(
  process.env.NEUTRON_E2E_OLD_PACKAGES !== "1" ||
    path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !==
      "local.ndeploy.json",
  "Old-package compatibility requires its fresh local fixture",
);

test("previously released packages install through the current Kernel", async ({
  page,
  request,
}) => {
  test.setTimeout(45 * 60_000);
  const runtime = resolveLocalNeutronRuntime();
  const kernelOrigin = localCanisterOrigin(
    runtime.canisterId,
    runtime.gatewayUrl,
  );
  const archives = await loadPinnedArchives();
  const observedUpdates = observeChunkedInstallUpdates(page);

  await page.goto(kernelOrigin);
  await loginAsDeveloper(page, runtime.developerIdentitySeed);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  for (const archive of archives) {
    await test.step(`install ${archive.expected.filename}`, async () => {
      const registryBefore = await readRegistry(request, kernelOrigin);
      expect(registryBefore[archive.expected.id]).toBeUndefined();
      observedUpdates.reset();

      await installArchive(page, archive.path, archive.expected);
      expectChunkedInstallObservation(observedUpdates);

      await expect
        .poll(async () => {
          const installed = (await readRegistry(request, kernelOrigin))[
            archive.expected.id
          ];
          return installed === undefined
            ? null
            : {
                format: installed.format,
                name: installed.name,
                version: installed.version,
              };
        })
        .toEqual({
          format: 3,
          name: archive.expected.name,
          version: archive.expected.version,
        });

      const manifestResponse = await request.get(
        new URL(
          `/app/${archive.expected.id}/pkg/neutron.json`,
          kernelOrigin,
        ).href,
      );
      expect(manifestResponse.ok()).toBe(true);
      expect(await manifestResponse.json()).toMatchObject({
        format: 3,
        id: archive.expected.id,
        name: archive.expected.name,
        version: archive.expected.version,
      });
    });
  }

  const actor = await createKernelActor({
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    fetchRootKey: true,
  });
  expect(await actor.kernel_install_status(null)).toEqual([]);
  const installedVersions = new Map(
    (await actor.kernel_runtime_info()).apps.map((app) => [
      app.scope.app_id,
      Number(app.version),
    ]),
  );
  for (const expected of EXPECTED_ARCHIVES) {
    expect(installedVersions.get(expected.id)).toBe(expected.version);
  }
});

async function loadPinnedArchives() {
  const entries = await readdir(OLD_PACKAGES_DIRECTORY, {
    withFileTypes: true,
  });
  const archiveEntries = entries
    .filter((entry) => entry.name.endsWith(".neutron"))
    .sort((left, right) => left.name.localeCompare(right.name));
  expect(archiveEntries.map((entry) => entry.name)).toEqual(
    EXPECTED_ARCHIVES.map(({ filename }) => filename),
  );
  expect(archiveEntries.every((entry) => entry.isFile())).toBe(true);

  return await Promise.all(
    EXPECTED_ARCHIVES.map(async (expected) => {
      const archivePath = path.join(OLD_PACKAGES_DIRECTORY, expected.filename);
      const bytes = new Uint8Array(await readFile(archivePath));
      const prepared = preparePackageInstall(bytes, {
        expectedIdentity: expected,
      });
      expect(prepared.manifest).toMatchObject({
        format: 3,
        id: expected.id,
        name: expected.name,
        version: expected.version,
      });
      return { expected, path: archivePath };
    }),
  );
}

function observeChunkedInstallUpdates(page: Page) {
  const calls = new Map<
    ChunkedInstallMethod,
    Map<string, LogicalUpdate>
  >();
  const v3Posts: string[] = [];
  const decodeErrors: string[] = [];

  const listener = (request: Request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    const route = pathname.match(
      /^\/api\/(v[23])\/canister\/[^/]+\/call$/,
    );
    if (!route) return;
    const body = request.postDataBuffer();
    const bodyDigest = body
      ? createHash("sha256").update(body).digest("hex")
      : "missing-body";
    if (route[1] === "v3") v3Posts.push(`${pathname}:${bodyDigest}`);
    if (!body) {
      decodeErrors.push(`${pathname}: missing signed request body`);
      return;
    }
    try {
      const envelope = Cbor.decode<{
        content?: Record<string, unknown>;
      }>(body);
      const content = envelope.content;
      if (!content) throw new Error("signed request content is missing");
      const methodName = content.method_name;
      const argument = content.arg;
      if (
        typeof methodName === "string" &&
        CHUNKED_INSTALL_METHODS.includes(methodName as ChunkedInstallMethod)
      ) {
        if (!(argument instanceof Uint8Array)) {
          throw new Error("signed request Candid argument is missing");
        }
        const method = methodName as ChunkedInstallMethod;
        const requestId = Buffer.from(requestIdOf(content)).toString("hex");
        let byRequestId = calls.get(method);
        if (!byRequestId) calls.set(method, (byRequestId = new Map()));
        let logical = byRequestId.get(requestId);
        if (!logical) {
          logical = {
            // @dfinity/candid currently ignores a Uint8Array view's byteOffset.
            // Detach the Candid argument from its enclosing CBOR buffer before
            // decoding it after the request callback has returned.
            argument: Uint8Array.from(argument),
            paths: new Set(),
            signedBodies: new Set(),
          };
          byRequestId.set(requestId, logical);
        }
        logical.paths.add(pathname);
        logical.signedBodies.add(bodyDigest);
      }
    } catch (error) {
      decodeErrors.push(`${pathname}: ${String(error)}`);
    }
  };
  page.on("request", listener);
  return {
    calls,
    decodeErrors,
    reset() {
      calls.clear();
      decodeErrors.length = 0;
      v3Posts.length = 0;
    },
    v3Posts,
  };
}

function expectChunkedInstallObservation(
  observation: ReturnType<typeof observeChunkedInstallUpdates>,
): void {
  expect(observation.decodeErrors).toEqual([]);
  expect(observation.v3Posts, "v3 update submissions").toEqual([]);
  expectLogicalUpdateCount(
    observation,
    "kernel_install_wasm_chunks_clear",
    2,
  );
  expectLogicalUpdateCount(
    observation,
    "kernel_install_code_chunked",
    1,
  );
  expectLogicalUpdateCount(observation, "kernel_install_commit", 1);

  const uploadedHashes = [
    ...(observation.calls.get("kernel_install_wasm_chunk")?.values() ?? []),
  ].map(({ argument }) => {
    const [decoded] = IDL.decode([WASM_CHUNK_ARGUMENT], argument) as [{
      sha256: Uint8Array;
    }];
    return Buffer.from(decoded.sha256).toString("hex");
  });
  const activation = [
    ...(observation.calls.get("kernel_install_code_chunked")?.values() ?? []),
  ][0];
  if (!activation) throw new Error("chunked activation was not observed");
  const [decodedActivation] = IDL.decode(
    [CHUNKED_INSTALL_ARGUMENT],
    activation.argument,
  ) as [{ chunk_hashes: Uint8Array[] }];
  expect(uploadedHashes, "exact logical chunk upload sequence").toEqual(
    decodedActivation.chunk_hashes.map((hash) =>
      Buffer.from(hash).toString("hex")
    ),
  );

  for (const logicalCalls of observation.calls.values()) {
    for (const logical of logicalCalls.values()) {
      expect([...logical.paths].every((path) => path.startsWith("/api/v2/")))
        .toBe(true);
      expect(logical.signedBodies.size, "signed bodies per request ID").toBe(1);
    }
  }
}

function expectLogicalUpdateCount(
  observation: ReturnType<typeof observeChunkedInstallUpdates>,
  method: ChunkedInstallMethod,
  expected: number,
): void {
  expect(
    observation.calls.get(method)?.size ?? 0,
    `${method} distinct request IDs`,
  ).toBe(expected);
}

async function loginAsDeveloper(page: Page, identitySeed: number): Promise<void> {
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (
        window as typeof window & {
          __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown;
        }
      ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
  );
  await page.evaluate(async (seed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    await login(seed);
  }, identitySeed);
}

async function installArchive(
  page: Page,
  archivePath: string,
  expected: (typeof EXPECTED_ARCHIVES)[number],
): Promise<void> {
  const launcher = page.locator('[data-tid="launcher"]');
  if (!(await launcher.isVisible())) {
    await page.locator('[data-tid="launcher-open"]').click();
    await launcher.waitFor({ state: "visible" });
  }

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(archivePath);

  const dialog = page.locator('[data-tid="install-dialog"]');
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await expect(dialog.locator("h2")).toHaveText("Install application");
  await expect(dialog.locator(".consent-install-summary strong")).toHaveText(
    expected.name,
  );
  await expect(dialog.locator(".consent-install-summary span")).toHaveText(
    formatAppVersionLabel(expected.version),
  );
  await expect(dialog).toContainText(expected.sha256);
  await page.locator('[data-tid="install-compiled"]').waitFor({
    state: "visible",
    timeout: INSTALL_TIMEOUT_MS,
  });

  const accept = page.locator('[data-tid="install-accept"]');
  await expect(accept).toHaveText("Install");
  await accept.click();
  await waitForInstall(page, expected.name);
}

async function waitForInstall(page: Page, appName: string): Promise<void> {
  const progress = page.locator('[data-tid="install-progress"]');
  const installError = page.locator('[data-tid="install-error"]');
  const firstVisible = await Promise.race([
    progress
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "progress" as const),
    installError
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "error" as const),
  ]);
  if (firstVisible === "error") {
    throw new Error(
      `${appName} install failed: ${(await installError.textContent()) ?? "unknown error"}`,
    );
  }
  await expect(progress).toHaveAttribute("data-operation-kind", "install");
  await progress.waitFor({
    state: "hidden",
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (await installError.isVisible()) {
    throw new Error(
      `${appName} install failed: ${(await installError.textContent()) ?? "unknown error"}`,
    );
  }
}

async function readRegistry(
  request: APIRequestContext,
  kernelOrigin: string,
): Promise<AppRegistry> {
  const response = await request.get(
    new URL("/system/apps.json", kernelOrigin).href,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as AppRegistry;
}
