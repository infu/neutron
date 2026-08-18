import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import {
  devices,
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  localCanisterOrigin,
} from "neutron-tools/src/runtime.js";
import {
  createKernelActor,
  localIdentityFromSeed,
} from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { signInWithLocalInternetIdentity } from "./local-ii.ts";

const principalsToRevoke = new Set<string>();

test.afterEach(async () => {
  const principals = [...principalsToRevoke];
  principalsToRevoke.clear();
  for (const principal of principals) await revokeTestPrincipal(principal);
});

test("local bootstrap serves login, registry, and app assets", async ({
  browser,
  page,
  request,
}) => {
  const kernelUrl = localKernelUrl();
  await page.goto(kernelUrl);
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    "content",
    "width=device-width, initial-scale=1"
  );

  const mobileContext = await browser.newContext({ ...devices["iPhone 13"] });
  try {
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(kernelUrl);
    const mobileViewport = await mobilePage.evaluate(() => ({
      innerWidth: window.innerWidth,
      compact: window.matchMedia("(max-width: 900px)").matches,
    }));
    expect(mobileViewport.innerWidth).toBeLessThanOrEqual(900);
    expect(mobileViewport.compact).toBe(true);
  } finally {
    await mobileContext.close();
  }

  const anonymousRegistry = await request.get(
    new URL("/system/apps.json", kernelUrl).href,
  );
  const anonymousMissing = await request.get(
    new URL("/system/definitely-missing.json", kernelUrl).href,
  );
  expect(anonymousRegistry.status()).toBe(200);
  expect(anonymousRegistry.headers()["content-type"]).toContain(
    "application/json",
  );
  expect((await anonymousRegistry.json()) as AppRegistry).toHaveProperty(
    "kernel",
  );
  expect(anonymousMissing.status()).toBe(404);

  const kernelManifestResponse = await request.get(
    new URL("/pkg/neutron.json", kernelUrl).href,
  );
  expect(kernelManifestResponse.status()).toBe(200);
  const kernelManifest = (await kernelManifestResponse.json()) as {
    entry: string;
  };
  const kernelModuleResponse = await request.get(
    new URL(`/mo/${kernelManifest.entry}.mo`, kernelUrl).href,
  );
  expect(kernelModuleResponse.status()).toBe(200);
  expect(kernelModuleResponse.headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  const candidResponse = await request.get(
    new URL("/pkg/neutron.did", kernelUrl).href,
  );
  expect(candidResponse.status()).toBe(200);

  const streamingKey = "/pkg/e2e-http-streaming.txt";
  const kernel = await createKernelActor({
    canisterId: resolveCanisterId(),
    host: localGatewayUrl(),
    identity: localDeveloperIdentity(),
    fetchRootKey: true,
  });
  await kernel.kernel_static({
    store: {
      key: streamingKey,
      val: {
        chunks: 2,
        content: new TextEncoder().encode("first chunk; "),
        content_encoding: "identity",
        content_type: "text/plain; charset=utf-8",
      },
    },
  });
  try {
    await kernel.kernel_static({
      store_chunk: {
        key: streamingKey,
        chunk_id: 1,
        content: new TextEncoder().encode("second chunk"),
      },
    });
    const streamedResponse = await request.get(
      new URL(streamingKey, kernelUrl).href,
    );
    expect(streamedResponse.status()).toBe(200);
    expect(await streamedResponse.text()).toBe("first chunk; second chunk");
  } finally {
    await kernel.kernel_static({ delete: { key: streamingKey } });
  }

  const registryJson = await readKernelRegistry();
  expect(registryJson.kernel).toMatchObject({
    link: "/",
    name: "Neutron",
    icon: "/static/icon.png",
  });
  const publicApp = Object.entries(registryJson).find(
    ([appId, entry]) => appId !== "kernel" && entry.tiles[0],
  );
  if (publicApp) {
    const [appId, entry] = publicApp;
    const publicAppAsset = await request.get(
      new URL(`/app/${appId}/${entry.tiles[0]!.path}`, kernelUrl).href,
    );
    expect(publicAppAsset.ok()).toBe(true);
  }
});

test("kernel settings preserves the workspace and shows reconciled system state", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 after local II passkey automation is stable in this environment."
  );

  const kernelUrl = localKernelUrl();
  await context.credentials.install();
  await page.goto(kernelUrl);
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });
  const principal = await readSignedInPrincipal(page);
  await authorizePrincipal(principal);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  if (await registryHasHello()) {
    await openLauncher(page);
    await page.locator('[data-tid="launcher-tile-hello-main"]').click();
    await expect(page.locator(".tile-rect").first()).toBeVisible();

    const topbarRhythm = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".desktop-topbar");
      const workspaceButton = document.querySelector<HTMLElement>(
        '[data-tid="workspace-switch-1"]'
      );
      const tile = document.querySelector<HTMLElement>(".tile-rect");
      if (!topbar || !workspaceButton || !tile) return null;

      const topbarRect = topbar.getBoundingClientRect();
      const buttonRect = workspaceButton.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      return {
        top: buttonRect.top - topbarRect.top,
        bottom: tileRect.top - buttonRect.bottom,
      };
    });
    expect(topbarRhythm).not.toBeNull();
    expect(Math.abs(topbarRhythm!.top - topbarRhythm!.bottom)).toBeLessThanOrEqual(
      1
    );
    if (process.env.NEUTRON_E2E_SCREENSHOT) {
      await page.screenshot({
        path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
          /\.png$/,
          "-workspace.png"
        ),
      });
    }
  }
  const tileFramesBefore = await page.locator(".tile-iframe").count();
  const residentFramesBefore = await registryBackgroundCount();
  await expect(
    page.locator('[data-tid="app-background-frame"]')
  ).toHaveCount(residentFramesBefore);

  await expect(page.locator('[data-tid="settings-open"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="auth-menu-toggle"]')).toHaveCount(0);
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await expect(page.locator('[data-tid="kernel-tray-popover"]')).toBeVisible();
  await expect(page.locator('[data-tid="kernel-tray-cycles"]')).toContainText(
    "cycles"
  );
  const memorySummary = page.locator('[data-tid="kernel-tray-memory"]');
  await expect(memorySummary).toContainText("Memory");
  await expect(memorySummary).toHaveAttribute(
    "title",
    /^[\d,]+ bytes used of [\d,]+ bytes$/u,
  );
  await expect(memorySummary.locator('[role="progressbar"]')).toBeVisible();
  await expect(
    memorySummary.locator('[role="progressbar"]'),
  ).toHaveAttribute("aria-valuetext", /of the .* limit/u);
  await expect(
    page.locator('[data-tid="kernel-tray-stable-memory"]')
  ).toHaveCount(0);
  await expect(
    page.locator('[data-tid="kernel-tray-logical-stable-memory"]')
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="kernel-tray-memory-details"]')).toHaveCount(0);
  const trayHeightBeforeHover = await page
    .locator('[data-tid="kernel-tray-popover"]')
    .evaluate((element) => element.getBoundingClientRect().height);
  await memorySummary.hover();
  const trayHeightAfterHover = await page
    .locator('[data-tid="kernel-tray-popover"]')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(trayHeightAfterHover - trayHeightBeforeHover)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-tid="kernel-tray-principal"]')).toHaveCount(0);
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
  const systemMetrics = page.locator('[data-tid="settings-system"]');
  await expect(systemMetrics).toContainText("Cycle balance");
  await expect(systemMetrics).toContainText("Memory");
  await expect(systemMetrics).not.toContainText("Wasm memory");
  await expect(systemMetrics).not.toContainText("Stable memory");
  await expect(systemMetrics).not.toContainText("Logical stable memory");

  const interfaceToggle = page.locator(
    '[data-tid="settings-interface-toggle"]'
  );
  await expect(interfaceToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-tid="settings-interface"]')).toBeHidden();
  await interfaceToggle.click();
  await expect(interfaceToggle).toHaveAttribute("aria-expanded", "true");
  const developerUiMode = page.locator(
    '[data-tid="settings-ui-mode-developer"]'
  );
  await expect(developerUiMode).toHaveAttribute("role", "switch");
  await expect(developerUiMode).toHaveAccessibleName("Enable developer mode");
  await expect(developerUiMode).not.toBeChecked();
  await developerUiMode.check();
  await expect(developerUiMode).toBeChecked();
  await expect(systemMetrics).toContainText("Stable memory");
  await expect(systemMetrics).toContainText("Logical stable memory");
  await expect(systemMetrics).not.toContainText("Wasm memory");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("neutron-kernel-ui-mode-v1")
    )
  ).toBe("developer");
  await expect(
    page.locator(".settings-section-heading h2"),
  ).toHaveText(["System", "Installed Apps"]);
  const installedApps = page.locator('[data-tid="settings-installed-apps"]');
  await expect(
    installedApps.getByRole("table", { name: "Installed apps" }),
  ).toBeVisible();
  await expect(
    installedApps.locator('[data-tid="app-updates-check"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="app-updates-status"]')).toContainText(
    "Update check complete:",
  );
  await expect(page.locator('[data-tid="app-updates"]')).toHaveCount(0);
  await expect(
    page.locator('[data-tid="settings-app-usage-ranking"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="settings-identity"]')).not.toContainText(
    principal
  );
  await expect(page.locator('[data-tid="settings-identity"]')).not.toContainText(
    "Owner"
  );
  await expect(page.locator('[data-tid="settings-app-kernel"]')).toBeVisible();
  await expect(page.locator('[data-tid="settings-uninstall-kernel"]')).toHaveCount(
    0
  );
  await expect(page.locator(".kernel-workspace-surface")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  expect(await page.locator(".tile-iframe").count()).toBe(tileFramesBefore);
  expect(
    await page.locator('[data-tid="app-background-frame"]').count()
  ).toBe(residentFramesBefore);

  const runtimeToggle = page.locator('[data-tid="settings-runtime-toggle"]');
  await expect(runtimeToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-tid="settings-runtime"]')).toBeHidden();
  await runtimeToggle.click();
  await expect(runtimeToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-tid="settings-runtime"]')).toBeVisible();

  await page.locator('[data-tid="settings-access-toggle"]').click();
  await expect(page.locator('[data-tid="settings-access"]')).toBeVisible();
  await expect(page.locator(".settings-principal-list").first()).toContainText(
    principal
  );
  await expect(
    page.locator(`[data-tid="settings-authorized-${principal}"]`)
  ).toContainText("(current)");
  await expect(page.locator(".settings-access-group").nth(1)).toContainText(
    /\d+\/10/
  );
  await expect(
    page.locator('[data-tid="settings-access-toggle"]')
  ).toHaveAttribute("aria-expanded", "true");

  const appDetailsToggle = page.locator(
    '[data-tid="settings-app-details-toggle-kernel"]'
  );
  const appDetails = page.locator('[data-tid="settings-app-details-kernel"]');
  await expect(appDetailsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(appDetails).toBeHidden();
  await appDetailsToggle.click();
  await expect(appDetailsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(appDetails).toBeVisible();
  await expect(appDetails).toContainText("Manifest");
  await expect(appDetails).toContainText("format 3");
  await expect(appDetails).toContainText("Backend functions");
  await expect(appDetails).toContainText("kernel_authorized_add");
  await expect(
    appDetails.locator(".settings-app-fact").filter({ hasText: "Memory roots" })
  ).toContainText("1");
  await expect(appDetails).toContainText("Active memory1");

  const denseAppToggle = page.locator(
    '[data-tid="settings-app-details-toggle-kitchensink"]',
  );
  if ((await denseAppToggle.count()) > 0) {
    await denseAppToggle.click();
    const denseAppDetails = page.locator(
      '[data-tid="settings-app-details-kitchensink"]',
    );
    await expect(denseAppDetails).toBeVisible();
    const expandedDetailLayouts = await denseAppDetails
      .locator(".settings-app-detail-item--expanded")
      .evaluateAll((rows) =>
        rows.map((row) => {
          const main = row.querySelector<HTMLElement>(
            ".settings-app-detail-item-main",
          );
          const meta = row.querySelector<HTMLElement>(
            ".settings-app-detail-item-meta",
          );
          const rowRect = row.getBoundingClientRect();
          const mainRect = main?.getBoundingClientRect();
          const metaRect = meta?.getBoundingClientRect();
          return {
            mainWidth: mainRect?.width ?? 0,
            metaTop: metaRect?.top ?? 0,
            mainBottom: mainRect?.bottom ?? 0,
            rowWidth: rowRect.width,
          };
        }),
      );
    expect(expandedDetailLayouts.length).toBeGreaterThan(0);
    for (const layout of expandedDetailLayouts) {
      expect(layout.mainWidth).toBeGreaterThanOrEqual(layout.rowWidth - 10);
      expect(layout.metaTop).toBeGreaterThanOrEqual(layout.mainBottom - 1);
    }
  }
  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-settings.png"
      ),
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const settingsFits = await page
    .locator('[data-tid="kernel-settings"]')
    .evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(settingsFits).toBe(true);
  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-settings-mobile.png"
      ),
    });
    await page.locator('[data-tid="kernel-settings"]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-settings-apps-mobile.png"
      ),
    });
  }

  await page.locator('[data-tid="settings-back"]').click();
  await expect(page.locator('[data-tid="kernel-settings"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="kernel-tray-toggle"]')).toBeFocused();
  expect(await page.locator(".tile-iframe").count()).toBe(tileFramesBefore);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="kernel-tray-toggle"]')).toBeVisible();
  await openKernelSettings(page);
  await expect(developerUiMode).toBeChecked();
  await normalUiMode.check();
  await expect(normalUiMode).toBeChecked();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("neutron-kernel-ui-mode-v1")
    )
  ).toBe("normal");
});

test("kernel settings transactionally uninstalls a disposable app", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_SETTINGS_UNINSTALL !== "1",
    "Set NEUTRON_E2E_SETTINGS_UNINSTALL=1 only when the local Hello app may be removed."
  );

  const kernelUrl = localKernelUrl();
  test.skip(
    !(await registryHasHello()),
    "The disposable Hello app is not installed."
  );
  await context.credentials.install();
  await page.goto(kernelUrl);
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });
  const principal = await readSignedInPrincipal(page);
  await authorizePrincipal(principal);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openKernelSettings(page);

  const uninstall = page.locator('[data-tid="settings-uninstall-hello"]');
  await expect(uninstall).toBeEnabled();
  await uninstall.click();
  await expect(page.locator('[data-tid="uninstall-dialog"]')).toContainText(
    "hello"
  );
  await page.locator('[data-tid="uninstall-cancel"]').click();
  await expect(page.locator('[data-tid="settings-app-hello"]')).toBeVisible();

  await uninstall.click();
  await page.locator('[data-tid="uninstall-confirm"]').click();
  await expect(page.locator('[data-tid="install-progress"]')).toHaveAttribute(
    "data-operation-kind",
    "uninstall"
  );
  await expect(page.locator('[data-tid="settings-app-hello"]')).toHaveCount(0, {
    timeout: 120_000,
  });

  expect((await readKernelRegistry()).hello).toBeUndefined();
});

test("Files tile follows resident patches without losing a local draft", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 after local II passkey automation is stable in this environment."
  );

  await context.credentials.install();
  await page.goto(localKernelUrl());
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });
  const principal = await readSignedInPrincipal(page);
  await authorizePrincipal(principal);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-files-files"]').click();
  const filesFrame = page
    .locator('[data-app-id="files"][data-tile-id="files"]')
    .last();
  const files = page
    .frameLocator('[data-app-id="files"][data-tile-id="files"]')
    .last();
  await ensureFilesV2Ready(page, files);

  const filename = `patch-sync-${Date.now()}.txt`;
  await createFilesTextFile(
    files,
    filename,
    "Created through the deployed Files tile.\n",
  );
  const editor = files.getByRole("textbox", { name: `Edit ${filename}` });

  await callFilesToolFromTile(files, "patch", {
    path: `/${filename}`,
    oldText: "Created through the deployed Files tile.",
    newText: "Patched through the resident Files tool.",
  });
  await files.getByRole("button", { name: "Refresh folder" }).click();
  await filesRow(files, filename).click();
  await expect(editor).toHaveValue("Patched through the resident Files tool.\n");

  await editor.fill("Unsaved local draft.\n");
  await callFilesToolFromTile(files, "patch", {
    path: `/${filename}`,
    oldText: "Patched through the resident Files tool.",
    newText: "Latest resident patch.",
  });
  await files.getByRole("button", { name: "Refresh folder" }).click();
  await expect(files.getByRole("alert")).toContainText("backend file changed");
  await expect(editor).toHaveValue("Unsaved local draft.\n");
  await files.getByRole("button", { name: "Reload newer file" }).click();
  await expect(editor).toHaveValue("Latest resident patch.\n");

  const markdownFilename = `preview-${Date.now()}.md`;
  await createFilesTextFile(
    files,
    markdownFilename,
    `# Live preview

| App | Status |
| --- | --- |
| Files | ready |

- [x] GFM tables

<script>window.compromised = true</script>`,
  );
  let markdownEditor = files.getByRole("textbox", {
    name: `Edit ${markdownFilename}`,
  });
  await files.getByRole("button", { name: "Preview Markdown" }).click();
  const preview = files.getByTestId("markdown-preview");
  await expect(preview.getByRole("heading", { name: "Live preview" })).toBeVisible();
  await expect(preview.getByRole("table")).toContainText("Files");
  await expect(preview.locator("script")).toHaveCount(0);

  await files.getByRole("button", { name: "Edit", exact: true }).click();
  markdownEditor = files.getByRole("textbox", {
    name: `Edit ${markdownFilename}`,
  });
  await markdownEditor.fill(`# Live preview

| App | Status |
| --- | --- |
| Files | updated without saving |`);
  await files.getByRole("button", { name: "Preview Markdown" }).click();
  await expect(preview.getByRole("table")).toContainText("updated without saving");
  await expect(
    files.getByRole("button", { name: "Edit", exact: true })
  ).toBeVisible();

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await filesFrame.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-files-markdown.png"
      ),
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLayout = await files.locator(".files-v2-workspace").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns.split(" ").length,
      rows: style.gridTemplateRows.split(" ").length,
    };
  });
  expect(narrowLayout).toEqual({ columns: 1, rows: 2 });
  await expect(markdownEditor).toHaveCount(0);
  await expect(preview).toBeVisible();
  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await filesFrame.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-files-markdown-mobile.png"
      ),
    });
  }
  await files.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(markdownEditor).toBeVisible();
  await expect(preview).toHaveCount(0);
});

test("Chess tile plays revision-bound legal moves through its resident tools", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 after local II passkey automation is stable in this environment."
  );

  const kernelUrl = localKernelUrl();
  test.skip(
    !(await registryHasApp("chess")),
    "Chess is not installed."
  );
  test.skip(
    !(await registryHasApp("hello")),
    "Hello is required as the independent app caller."
  );
  await context.credentials.install();
  await page.goto(kernelUrl);
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });
  const principal = await readSignedInPrincipal(page);
  await authorizePrincipal(principal);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-chess-board"]').click();
  const chessFrame = page
    .locator('[data-app-id="chess"][data-tile-id="board"]')
    .last();
  const chess = page
    .frameLocator('[data-app-id="chess"][data-tile-id="board"]')
    .last();
  await chess.getByRole("radio", { name: /Local players/u }).check();
  await chess.getByRole("button", { name: "Start game" }).click();
  await expect(chess.locator(".chess-board")).toBeVisible();

  const residentTools = await execMessageBusFromFrame(
    chess.locator("body"),
    "tools.list",
    { target: "app:chess:background" }
  );
  expect(residentTools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "chess_local_games" }),
      expect.objectContaining({ name: "chess_position" }),
      expect.objectContaining({ name: "chess_move" }),
    ])
  );

  const listed = (await callBackgroundTool(
    page,
    "chess",
    "chess_local_games",
    {}
  )) as {
    games: Array<{ tileInstanceId: string; gameId: string; revision: string }>;
  };
  expect(listed.games).toHaveLength(1);
  const selectedGame = listed.games[0]!;
  const initialPosition = (await callBackgroundTool(
    page,
    "chess",
    "chess_position",
    {
      tileInstanceId: selectedGame.tileInstanceId,
      gameId: selectedGame.gameId,
    }
  )) as { revision: string; legalMoves: string[] };
  expect(initialPosition.legalMoves).toContain("e2e4");

  await expect(chess.locator('[data-square="e2"]')).toHaveAccessibleName(
    "e2, white pawn"
  );
  await callBackgroundTool(page, "chess", "chess_move", {
    tileInstanceId: selectedGame.tileInstanceId,
    gameId: selectedGame.gameId,
    revision: initialPosition.revision,
    from: "e2",
    to: "e4",
  });
  await expect(chess.locator('[data-square="e2"]')).toHaveAccessibleName(
    "e2, empty"
  );
  await expect(chess.locator('[data-square="e4"]')).toHaveAccessibleName(
    "e4, white pawn"
  );
  await expect(chess.locator(".chess-moves")).toContainText("e4");

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await chessFrame.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(/\.png$/, "-chess.png"),
    });
  }

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-hello-main"]').click();
  const independentCaller = page
    .frameLocator('[data-app-id="hello"][data-tile-id="main"]')
    .last()
    .locator("body");
  await expect(independentCaller).toBeVisible();
  await expect(
    independentCaller.locator('[data-tid="hello-call"]')
  ).toBeEnabled();

  const externalDiscovery = execMessageBusFromFrame(
    independentCaller,
    "tools.list",
    { target: "app:chess:background" }
  );
  const permissionDialog = page.locator('[data-tid="frontend-tool-dialog"]');
  await expect(permissionDialog).toBeVisible();
  await expect(permissionDialog).toContainText("app:chess:background");
  await permissionDialog
    .locator('[data-tid="frontend-tool-approve-session"]')
    .click();
  expect(await externalDiscovery).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "chess_move" }),
    ])
  );

  const externalView = (await execMessageBusFromFrame(
    independentCaller,
    "tools.call",
    {
      target: "app:chess:background",
      name: "chess_position",
      arguments: {
        tileInstanceId: selectedGame.tileInstanceId,
        gameId: selectedGame.gameId,
      },
    }
  )) as { revision: string; board: { rows: string[] }; legalMoves: string[] };
  expect(externalView.board.rows).toEqual(
    expect.arrayContaining(["....P..."])
  );
  expect(externalView.legalMoves).toContain("e7e5");

  await execMessageBusFromFrame(independentCaller, "tools.call", {
    target: "app:chess:background",
    name: "chess_move",
    arguments: {
      tileInstanceId: selectedGame.tileInstanceId,
      gameId: selectedGame.gameId,
      revision: externalView.revision,
      from: "e7",
      to: "e5",
    },
  });
  await expect(chess.locator('[data-square="e7"]')).toHaveAccessibleName(
    "e7, empty"
  );
  await expect(chess.locator('[data-square="e5"]')).toHaveAccessibleName(
    "e5, black pawn"
  );

  const secondPage = await context.newPage();
  await secondPage.goto(kernelUrl);
  await expect(secondPage.locator('[data-tid="desktop-topbar"]')).toBeVisible();
  await expect(
    secondPage.locator(
      '[data-tid="app-background-frame"][data-app-id="chess"]'
    )
  ).toHaveCount(1);
  const secondChess = secondPage
    .frameLocator('[data-app-id="chess"][data-tile-id="board"]')
    .last();
  await expect(secondChess.locator('[data-square="e4"]')).toHaveAccessibleName(
    "e4, white pawn"
  );
  await expect(secondChess.locator('[data-square="e5"]')).toHaveAccessibleName(
    "e5, black pawn"
  );
  const secondPosition = (await callBackgroundTool(
    secondPage,
    "chess",
    "chess_position",
    {
      tileInstanceId: selectedGame.tileInstanceId,
      gameId: selectedGame.gameId,
    }
  )) as { revision: string; legalMoves: string[] };
  expect(secondPosition.legalMoves).toContain("d2d4");
  await callBackgroundTool(page, "chess", "chess_move", {
    tileInstanceId: selectedGame.tileInstanceId,
    gameId: selectedGame.gameId,
    revision: secondPosition.revision,
    from: "d2",
    to: "d4",
  });
  await expect(chess.locator('[data-square="d2"]')).toHaveAccessibleName(
    "d2, empty"
  );
  await expect(chess.locator('[data-square="d4"]')).toHaveAccessibleName(
    "d4, white pawn"
  );
  await secondPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chess.locator(".chess-history")).toBeHidden();
  const boardBounds = await chess.locator(".chess-board").boundingBox();
  expect(boardBounds).not.toBeNull();
  expect(Math.abs(boardBounds!.width - boardBounds!.height)).toBeLessThanOrEqual(1);
  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await chessFrame.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-chess-mobile.png"
      ),
    });
  }

  await chess.getByRole("button", { name: "Undo last move" }).click();
  await expect(chess.locator('[data-square="d2"]')).toHaveAccessibleName(
    "d2, white pawn"
  );
  await chess.getByRole("button", { name: "Undo last move" }).click();
  await expect(chess.locator('[data-square="e7"]')).toHaveAccessibleName(
    "e7, black pawn"
  );
  await chess.getByRole("button", { name: "Undo last move" }).click();
  await expect(chess.locator('[data-square="e2"]')).toHaveAccessibleName(
    "e2, white pawn"
  );
});

test("URL package source reaches the existing install review", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 after local II passkey automation is stable in this environment."
  );

  const packageUrl =
    "https://packages.test/vetkeys_fixture.v0.1.3.neutron";
  await page.route(packageUrl, async (route) => {
    await route.fulfill({
      contentType: "application/octet-stream",
      headers: { "access-control-allow-origin": "*" },
      path: "apps/vetkeys_fixture_test/vetkeys_fixture.v0.1.3.neutron",
    });
  });

  await context.credentials.install();
  await page.goto(localKernelUrl());
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });
  const principal = await readSignedInPrincipal(page);
  if (await page.locator('[data-tid="auth-error"]').isVisible()) {
    await authorizePrincipal(principal);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  await openLauncher(page);
  await page.locator('[data-tid="launcher-install-package-url"]').click();
  await page.locator('[data-tid="launcher-install-url-input"]').fill(packageUrl);
  await page.locator('[data-tid="launcher-install-url-submit"]').click();

  await expect(page.locator('[data-tid="install-dialog"]')).toBeVisible();
  await expect(page.locator('[data-tid="install-compiled"]')).toBeVisible({
    timeout: 120_000,
  });
  await page.locator('[data-tid="install-reject"]').click();
  await expect(page.locator('[data-tid="install-dialog"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
});

test("local II signs in, opens hello, and approves a typed call", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 after local II passkey automation is stable in this environment."
  );

  const kernelUrl = localKernelUrl();
  await context.credentials.install();
  await page.goto(kernelUrl);
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: localGatewayUrl(),
  });

  const principal = await readSignedInPrincipal(page);
  await expect(page.locator('[data-tid="auth-error"]')).toBeVisible();
  await expect(page.locator('[data-tid="auth-menu-toggle"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy current principal" })
  ).toBeVisible();
  await expect(page.locator('[data-tid="logout-button"]')).toBeVisible();
  await expect(page.locator('[data-tid="workspace"]')).toHaveCount(0);
  await authorizePrincipal(principal);

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedPrincipal = await readSignedInPrincipal(page);
  expect(reloadedPrincipal).toBe(principal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  const gemmaBackground = page.locator(
    '[data-tid="app-background-frame"][data-app-id="gemma"]'
  );
  await expect(page.locator('[data-tid="workspace-layer"]')).toHaveCount(1);
  await expect(
    page.locator('[data-tid="workspace-layer"][data-workspace-id="1"]')
  ).toHaveAttribute("data-active", "true");
  await expect(gemmaBackground).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin"
  );
  await expect(gemmaBackground).not.toHaveAttribute("credentialless", /.+/);
  const gemmaOrigin = await expectIsolatedLocalFrameSource(
    gemmaBackground,
    "gemma"
  );
  expect(
    await page
      .frameLocator('[data-tid="app-background-frame"][data-app-id="gemma"]')
      .locator("body")
      .evaluate(async () => {
        const cache = await caches.open("gemma-local-e2e");
        await cache.put("./cache-check", new Response("cached"));
        return (await cache.match("./cache-check"))?.text();
      })
  ).toBe("cached");

  const filesBackground = page.locator(
    '[data-tid="app-background-frame"][data-app-id="files"]'
  );
  await expect(filesBackground).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin"
  );
  await expect(filesBackground).toHaveAttribute("credentialless", "true");
  expect(
    await filesBackground
      .contentFrame()
      .locator("body")
      .evaluate(
        () =>
          (window as typeof window & { credentialless?: unknown })
            .credentialless,
      )
  ).toBe(true);
  const filesOrigin = await expectIsolatedLocalFrameSource(
    filesBackground,
    "files"
  );

  const agentBackground = page.locator(
    '[data-tid="app-background-frame"][data-app-id="agent"]'
  );
  await expect(agentBackground).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin"
  );
  await expect(agentBackground).not.toHaveAttribute("credentialless", /.+/);
  const agentOrigin = await expectIsolatedLocalFrameSource(
    agentBackground,
    "agent"
  );
  expect(new Set([gemmaOrigin, filesOrigin, agentOrigin]).size).toBe(3);

  if (await registryHasHello()) {
    await openLauncher(page);
    await page.locator('[data-tid="launcher-tile-hello-main"]').click();
  } else {
    await installHelloFromBrowser(page);
  }

  const hello = page.frameLocator('[data-app-id="hello"][data-tile-id="main"]').first();
  const callButton = hello.locator('[data-tid="hello-call"]');
  await expect(callButton).toBeEnabled();
  await callButton.click();

  await expect(page.locator('[data-tid="call-dialog"]')).toBeVisible();
  await page.locator('[data-tid="call-approve"]').click();
  await expect(hello.locator('[data-tid="hello-result"]')).toContainText(
    /"?(Neutron|John)"?/
  );

  const malformedResponse = await hello.locator("body").evaluate(() => {
    return new Promise<unknown>((resolve) => {
      const id = 97_531;
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ type: "timeout" });
      }, 5_000);

      function onMessage(event: MessageEvent): void {
        const data = event.data as { type?: string; id?: number };
        if (data?.type !== "response" || data.id !== id) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(data);
      }

      window.addEventListener("message", onMessage);
      window.parent.postMessage(
        {
          type: "exec",
          id,
          payload: {
            action: "call_dialog",
            payload: {
              canister: "not a canister",
              method: "hello_world",
              args: ["John"],
            },
          },
        },
        "*"
      );
    });
  });
  expect(malformedResponse).toMatchObject({
    type: "response",
    id: 97_531,
    error: {
      message: expect.stringContaining("Invalid payload"),
    },
  });
  await expect(page.locator('[data-tid="call-dialog"]')).not.toBeVisible();

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-hello-main"]').click();
  await expect(
    page.locator('[data-app-id="hello"][data-tile-id="main"]')
  ).toHaveCount(2);

  const helloFrames = page.locator(
    'iframe[data-app-id="hello"][data-tile-id="main"]'
  );
  const firstHelloInstance = await helloFrames
    .nth(0)
    .getAttribute("data-instance-id");
  const secondHelloInstance = await helloFrames
    .nth(1)
    .getAttribute("data-instance-id");
  expect(firstHelloInstance).toBeTruthy();
  expect(secondHelloInstance).toBeTruthy();
  const firstHelloTile = page.locator(
    `.workspace-tile:has(iframe[data-instance-id="${firstHelloInstance}"])`
  );
  const secondHelloTile = page.locator(
    `.workspace-tile:has(iframe[data-instance-id="${secondHelloInstance}"])`
  );
  const workspaceOneSwitch = page.locator('[data-tid="workspace-switch-1"]');
  const workspaceTwoSwitch = page.locator('[data-tid="workspace-switch-2"]');
  await expect(workspaceOneSwitch).toHaveAttribute("data-tile-count", "2");
  await expect(workspaceOneSwitch).toHaveAccessibleName(
    "Workspace 1, 2 open tiles"
  );
  await expect(workspaceOneSwitch.locator(".workspace-glyph-cell")).toHaveCount(2);
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceTwoSwitch.locator(".workspace-glyph-cell")).toHaveCount(0);
  const firstHelloFrame = page.locator(
    `iframe[data-instance-id="${firstHelloInstance}"]`
  );
  const secondHelloFrame = page.locator(
    `iframe[data-instance-id="${secondHelloInstance}"]`
  );

  await clickInsideFrame(page, firstHelloFrame);
  await expect.poll(() => activeTileInstance(page)).toBe(firstHelloInstance);
  await expect(firstHelloTile).toHaveClass(/workspace-tile--focused/);
  await expect(secondHelloTile).not.toHaveClass(/workspace-tile--focused/);
  await clickInsideFrame(page, secondHelloFrame);
  await expect.poll(() => activeTileInstance(page)).toBe(secondHelloInstance);
  await expect(secondHelloTile).toHaveClass(/workspace-tile--focused/);
  await expect(firstHelloTile).not.toHaveClass(/workspace-tile--focused/);

  expect(
    await page.locator(".desktop-content").evaluate((content) => {
      const backgrounds = document.querySelector(".app-background-frames");
      if (!backgrounds) return false;
      return Boolean(
        content.compareDocumentPosition(backgrounds) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);

  const firstHelloFrameIdentity = `hello-frame-${Date.now()}`;
  await firstHelloFrame.evaluate((frame, identity) => {
    (frame as HTMLIFrameElement & { __neutronIdentity?: string })
      .__neutronIdentity = identity;
  }, firstHelloFrameIdentity);
  await firstHelloFrame.contentFrame().locator("body").evaluate(
    (_body, identity) => {
      (window as Window & { __neutronIdentity?: string }).__neutronIdentity =
        identity;
    },
    firstHelloFrameIdentity
  );

  const firstHelloHeader = firstHelloTile.locator(".tile-header");
  const headerBounds = await firstHelloHeader.boundingBox();
  if (!headerBounds) throw new Error("Tile header has no visible bounds");
  const headerX = headerBounds.x + headerBounds.width / 2;
  const headerY = headerBounds.y + headerBounds.height / 2;

  await page.mouse.move(headerX, headerY);
  await page.mouse.down();
  await expect(page.locator(".tile-rect--preview")).toHaveCount(0);
  await page.mouse.move(headerX + 3, headerY + 3);
  await expect(page.locator(".tile-rect--preview")).toHaveCount(0);
  await page.mouse.up();

  await page.mouse.move(headerX, headerY);
  await page.mouse.down();
  await page.mouse.move(headerX + 12, headerY + 12, { steps: 4 });
  await page.waitForTimeout(50);
  await expect(page.locator(".tile-rect--preview")).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator(".tile-rect--preview")).toHaveCount(0);
  expect(
    await firstHelloFrame.evaluate(
      (frame) =>
        (frame as HTMLIFrameElement & { __neutronIdentity?: string })
          .__neutronIdentity
    )
  ).toBe(firstHelloFrameIdentity);
  expect(
    await firstHelloFrame
      .contentFrame()
      .locator("body")
      .evaluate(
        () =>
          (window as Window & { __neutronIdentity?: string })
            .__neutronIdentity
      )
  ).toBe(firstHelloFrameIdentity);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWorkspace = page.locator(".hyper-workspace--mobile");
  await expect(mobileWorkspace).toBeVisible();
  const mobileTiles = page.locator(".tile-rect--mobile");
  await expect(mobileTiles).toHaveCount(2);
  const mobileMetrics = await mobileWorkspace.evaluate((workspaceElement) => {
    const workspaceRect = workspaceElement.getBoundingClientRect();
    const tiles = Array.from(
      workspaceElement.querySelectorAll<HTMLElement>(".tile-rect--mobile")
    ).map((tile) => {
      const rect = tile.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
    });
    return {
      clientHeight: workspaceElement.clientHeight,
      scrollHeight: workspaceElement.scrollHeight,
      workspaceLeft: workspaceRect.left,
      workspaceRight: workspaceRect.right,
      tiles,
    };
  });
  expect(mobileMetrics.scrollHeight).toBeGreaterThan(
    mobileMetrics.clientHeight
  );
  expect(mobileMetrics.tiles).toHaveLength(2);
  expect(mobileMetrics.tiles[0]?.left).toBe(mobileMetrics.workspaceLeft + 8);
  expect(mobileMetrics.tiles[0]?.right).toBe(mobileMetrics.workspaceRight - 8);
  expect(mobileMetrics.tiles[1]?.top).toBeGreaterThanOrEqual(
    (mobileMetrics.tiles[0]?.bottom ?? 0) + 8
  );

  const mobileHeaderBounds = await firstHelloHeader.boundingBox();
  if (!mobileHeaderBounds) throw new Error("Mobile tile header has no visible bounds");
  await page.mouse.move(
    mobileHeaderBounds.x + mobileHeaderBounds.width / 2,
    mobileHeaderBounds.y + mobileHeaderBounds.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    mobileHeaderBounds.x + mobileHeaderBounds.width / 2 + 20,
    mobileHeaderBounds.y + mobileHeaderBounds.height / 2 + 20,
    { steps: 4 }
  );
  await expect(page.locator(".tile-rect--preview")).toHaveCount(0);
  await page.mouse.up();

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(
        /\.png$/,
        "-workspace-mobile.png"
      ),
    });
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".hyper-workspace--mobile")).toHaveCount(0);

  await page.locator('[data-tid="workspace-switch-1"]').focus();
  await page.keyboard.press("Meta+2");
  await expect(page.locator('[data-tid="workspace-switch-2"]')).toHaveClass(
    /active/
  );
  const workspaceOneLayer = page.locator(
    '[data-tid="workspace-layer"][data-workspace-id="1"]'
  );
  const workspaceTwoLayer = page.locator(
    '[data-tid="workspace-layer"][data-workspace-id="2"]'
  );
  await expect(page.locator('[data-tid="workspace-layer"]')).toHaveCount(2);
  await expect(workspaceOneLayer).toHaveAttribute("aria-hidden", "true");
  await expect(workspaceOneLayer).toHaveAttribute("inert", "");
  await expect(workspaceOneLayer).not.toHaveAttribute("data-active", /.+/);
  await expect(workspaceTwoLayer).toHaveAttribute("data-active", "true");
  await expect(workspaceTwoLayer).not.toHaveAttribute("aria-hidden", /.+/);
  await expect(workspaceTwoLayer).not.toHaveAttribute("inert", /.+/);
  await expect(
    workspaceTwoLayer.locator('[data-tid="workspace-empty"]')
  ).toBeVisible();
  expect(
    await firstHelloFrame.evaluate(
      (frame) =>
        (frame as HTMLIFrameElement & { __neutronIdentity?: string })
          .__neutronIdentity
    )
  ).toBe(firstHelloFrameIdentity);

  await page.keyboard.press("Meta+1");
  await expect(workspaceOneLayer).toHaveAttribute("data-active", "true");
  expect(
    await firstHelloFrame
      .contentFrame()
      .locator("body")
      .evaluate(
        () =>
          (window as Window & { __neutronIdentity?: string })
            .__neutronIdentity
      )
  ).toBe(firstHelloFrameIdentity);
  const resumedEndpoints = (await execMessageBusFromFrame(
    firstHelloFrame.contentFrame().locator("body"),
    "tools.call",
    { target: "kernel", name: "endpoints.list", arguments: {} }
  )) as {
    endpoints: Array<{ instanceId?: string; connected?: boolean }>;
  };
  expect(resumedEndpoints.endpoints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        instanceId: firstHelloInstance,
        connected: true,
      }),
    ])
  );
  await page.keyboard.press("Meta+2");
  await expect(workspaceTwoLayer).toHaveAttribute("data-active", "true");

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-files-files"]').click();
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "1");
  await expect(workspaceTwoSwitch.locator(".workspace-glyph-cell")).toHaveCount(1);
  const files = page
    .frameLocator('[data-app-id="files"][data-tile-id="files"]')
    .first();
  await ensureFilesV2Ready(page, files);
  const activeEndpoints = (await execMessageBusFromFrame(
    files.locator("body"),
    "tools.call",
    { target: "kernel", name: "endpoints.list", arguments: {} }
  )) as { endpoints: Array<{ instanceId?: string }> };
  expect(
    activeEndpoints.endpoints.some(
      (endpoint) =>
        endpoint.instanceId === firstHelloInstance ||
        endpoint.instanceId === secondHelloInstance
    )
  ).toBe(false);
  expect(
    await files.locator(".files-v2-app").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        rightGap: window.innerWidth - rect.right,
        bottomGap: window.innerHeight - rect.bottom,
      };
    })
  ).toEqual({
    left: 0,
    top: 0,
    rightGap: 0,
    bottomGap: 0,
  });

  const filename = `e2e-${Date.now()}.txt`;
  await createFilesTextFile(
    files,
    filename,
    "Created through the deployed Files tile.\n",
  );

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-agent-chat"]').click();
  const agentTileFrame = page.locator(
    'iframe[data-app-id="agent"][data-tile-id="chat"]'
  );
  await expect(agentTileFrame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(agentTileFrame).toHaveAttribute("credentialless", /.+/);
  const agentTile = page
    .frameLocator('iframe[data-app-id="agent"][data-tile-id="chat"]')
    .first();
  await expect(
    agentTile.getByRole("button", { name: "Connect to OpenRouter" })
  ).toBeVisible();
  await expect(agentTile.getByRole("heading")).toHaveCount(0);

  await agentTile
    .getByRole("button", { name: "Connect to OpenRouter" })
    .click();
  const connectionDialog = page.locator(".connection-dialog");
  await expect(connectionDialog).toContainText("Connect to OpenRouter");
  await expect(connectionDialog).toContainText("Agent");
  await expect(connectionDialog).toContainText("Resident process credential");
  await connectionDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(connectionDialog).toHaveCount(0);
  await expect(
    agentTile.getByRole("button", { name: "Connect to OpenRouter" })
  ).toBeEnabled();

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.NEUTRON_E2E_SCREENSHOT });
    const filesFrame = page
      .locator('[data-app-id="files"][data-tile-id="files"]')
      .first();
    const previousStyle = await filesFrame.getAttribute("style");
    await filesFrame.evaluate((element) => {
      element.setAttribute(
        "style",
        "position: fixed; inset: 0 auto auto 0; width: 374px; height: 700px; z-index: 1000"
      );
    });
    await expect
      .poll(() => files.locator("body").evaluate(() => window.innerWidth))
      .toBeLessThanOrEqual(374);
    await filesFrame.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(/\.png$/, "-mobile.png"),
    });
    await filesFrame.evaluate((element, style) => {
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    }, previousStyle);
  }

  await page.keyboard.press("Meta+1");
  await page.keyboard.press("Meta+2");
  await expect(filesRow(files, filename)).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(gemmaBackground).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin"
  );
  expect(
    await page
      .frameLocator('[data-tid="app-background-frame"][data-app-id="gemma"]')
      .locator("body")
      .evaluate(async () => {
        const cache = await caches.open("gemma-local-e2e");
        return (await cache.match("./cache-check"))?.text();
      })
  ).toBe("cached");
  const reloadedFiles = page
    .frameLocator('[data-app-id="files"][data-tile-id="files"]')
    .first();
  await ensureFilesV2Ready(page, reloadedFiles);
  await expect(filesRow(reloadedFiles, filename)).toBeVisible();
});

async function ensureFilesV2Ready(
  page: Page,
  files: FrameLocator,
): Promise<void> {
  const badge = files.locator(".files-v2-vault-badge");
  await expect(badge).toBeVisible({ timeout: 120_000 });
  await expect(badge).not.toHaveText("Loading", { timeout: 120_000 });
  const state = (await badge.textContent())?.trim() ?? "";
  if (state === "Not initialized") {
    await files
      .getByRole("button", { name: "Create encrypted vault" })
      .click();
    await completeFilesV2Initialization(page, files);
  } else if (state === "Locked") {
    await files
      .getByRole("button", { name: "Unlock private Files" })
      .click();
  } else if (!state.startsWith("Unlocked")) {
    throw new Error(`Files cannot enter a private workspace from '${state}'`);
  }
  await expect(
    files.getByRole("button", { name: "Create text file" }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(badge).toContainText("Unlocked");
  await expect(files.getByRole("alert")).toHaveCount(0);
}

async function completeFilesV2Initialization(
  page: Page,
  files: FrameLocator,
): Promise<void> {
  const dialog = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
  const title = dialog.locator(".title");
  const workspaceButton = files.getByRole("button", {
    name: "Create text file",
  });
  for (let approvals = 0; approvals < 3; approvals += 1) {
    const outcome = await Promise.race([
      workspaceButton
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => "ready" as const),
      dialog
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => "dialog" as const),
    ]);
    if (outcome === "ready") return;
    await expect(dialog).toContainText("Files (files)");
    await expect(dialog).toContainText("files_vault");
    const previousTitle = (await title.textContent())?.trim() ?? "";
    expect(previousTitle).toMatch(
      /^(Activate private-key slot|Enable private-key recovery)$/u,
    );
    await dialog
      .locator('[data-tid="vetkeys-lifecycle-approve"]')
      .click();
    await expect
      .poll(async () => {
        if (await workspaceButton.isVisible()) return "ready";
        if (!(await dialog.isVisible())) return "hidden";
        return (await title.textContent())?.trim() ?? "hidden";
      })
      .not.toBe(previousTitle);
  }
  throw new Error("Files initialization exceeded its two lifecycle approvals");
}

async function createFilesTextFile(
  files: FrameLocator,
  filename: string,
  content: string,
): Promise<void> {
  await files.getByRole("button", { name: "Create text file" }).click();
  await files
    .getByRole("textbox", { name: "New file name" })
    .fill(filename);
  await files.getByRole("button", { name: "Create file" }).click();
  const row = filesRow(files, filename);
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.click();
  const editor = files.getByRole("textbox", { name: `Edit ${filename}` });
  await editor.fill(content);
  const save = files.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(save).toBeDisabled({ timeout: 120_000 });
  await expect(editor).toHaveValue(content);
}

function filesRow(files: FrameLocator, filename: string): Locator {
  return files
    .getByRole("option")
    .filter({ hasText: new RegExp(`^${escapeRegex(filename)}(?:\\s|$)`, "u") });
}

async function callFilesToolFromTile(
  files: FrameLocator,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  return execMessageBusFromFrame(files.locator("body"), "tools.call", {
    target: "app:files:background",
    name,
    arguments: argumentsValue,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function clickInsideFrame(page: Page, frame: Locator): Promise<void> {
  const bounds = await frame.boundingBox();
  if (!bounds) throw new Error("Tile iframe has no visible bounds");
  await page.mouse.click(bounds.x + 12, bounds.y + 12);
}

async function execMessageBusFromFrame(
  frameBody: Locator,
  action: string,
  payload: unknown
): Promise<unknown> {
  const id = Math.floor(Date.now() + Math.random() * 100_000);
  return frameBody.evaluate(
    (_element, { action, payload, id }) =>
      new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error(`Message bus action ${action} timed out`));
        }, 60_000);
        function onMessage(event: MessageEvent): void {
          const data = event.data as {
            type?: string;
            id?: number;
            ok?: unknown;
            error?: unknown;
          };
          if (data?.type !== "response" || data.id !== id) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          if (Object.hasOwn(data, "error")) reject(data.error);
          else resolve(data.ok);
        }
        window.addEventListener("message", onMessage);
        window.parent.postMessage(
          { type: "exec", id, payload: { action, payload } },
          "*"
        );
      }),
    { action, payload, id }
  );
}

async function expectIsolatedLocalFrameSource(
  frame: Locator,
  appId: string
): Promise<string> {
  const source = await frame.getAttribute("src");
  expect(source).not.toBeNull();
  const url = new URL(source!);
  const hostnameSuffix = `--${resolveCanisterId()}.localhost`;
  expect(url.protocol).toBe("http:");
  expect(url.port).toBe("8000");
  expect(url.hostname.endsWith(hostnameSuffix)).toBe(true);
  expect(url.hostname.slice(0, -hostnameSuffix.length)).toMatch(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
  );
  expect(url.pathname.startsWith(`/app/${appId}/`)).toBe(true);
  return url.origin;
}

async function callBackgroundTool(
  page: Page,
  appId: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return page.evaluate(
    ({ appId, name, args }) =>
      new Promise((resolve, reject) => {
        const frame = document.querySelector<HTMLIFrameElement>(
          `[data-tid="app-background-frame"][data-app-id="${appId}"]`
        );
        if (!frame?.contentWindow) {
          reject(new Error(`Background frame is unavailable for ${appId}`));
          return;
        }

        const id = Date.now();
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error(`Background tool ${name} timed out`));
        }, 10_000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          const response = event.data as {
            type?: unknown;
            id?: unknown;
            ok?: unknown;
            error?: unknown;
          };
          if (response.type !== "response" || response.id !== id) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          if (Object.hasOwn(response, "error")) {
            reject(new Error(JSON.stringify(response.error)));
          } else {
            resolve(response.ok);
          }
        };
        window.addEventListener("message", onMessage);
        frame.contentWindow.postMessage(
          {
            type: "exec",
            id,
            payload: {
              action: "__neutron_msgbus_tools_call",
              payload: { name, arguments: args },
            },
          },
          "*"
        );
      }),
    { appId, name, args }
  );
}

async function activeTileInstance(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLIFrameElement &&
      activeElement.classList.contains("tile-iframe")
      ? activeElement.dataset.instanceId ?? null
      : null;
  });
}

function localKernelUrl(): string {
  return localCanisterOrigin(resolveCanisterId(), localGatewayUrl());
}

function resolveCanisterId(): string {
  return resolveLocalNeutronRuntime().canisterId;
}

function localGatewayUrl(): string {
  return resolveLocalNeutronRuntime().gatewayUrl;
}

async function authorizePrincipal(principal: string): Promise<void> {
  const actor = await createKernelActor({
    canisterId: resolveCanisterId(),
    host: localGatewayUrl(),
    identity: localDeveloperIdentity(),
    fetchRootKey: true,
  });
  await retryCanisterSettingsRace(() =>
    actor.kernel_authorized_recover(Principal.fromText(principal))
  );
  principalsToRevoke.add(principal);
}

async function revokeTestPrincipal(principal: string): Promise<void> {
  type AuthorizationActor = {
    kernel_authorized_rem: ActorMethod<[Principal], null>;
  };
  const agent = await HttpAgent.create({
    host: localGatewayUrl(),
    identity: localDeveloperIdentity(),
  });
  await agent.fetchRootKey();
  const actor = Actor.createActor<AuthorizationActor>(
    ({ IDL }) =>
      IDL.Service({
        kernel_authorized_rem: IDL.Func([IDL.Principal], [IDL.Null], []),
      }),
    { agent, canisterId: resolveCanisterId() },
  );
  await retryCanisterSettingsRace(() =>
    actor.kernel_authorized_rem(Principal.fromText(principal))
  );
}

function localDeveloperIdentity() {
  return localIdentityFromSeed(
    resolveLocalNeutronRuntime().developerIdentitySeed,
  );
}

async function retryCanisterSettingsRace<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !String(error).includes("IC0406")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function readSignedInPrincipal(page: Page): Promise<string> {
  const shellControl = page.locator(
    '[data-tid="principal"], [data-tid="kernel-tray-toggle"]'
  );
  await expect(shellControl.first()).toBeVisible({ timeout: 20_000 });

  const unauthorizedPrincipal = page.locator('[data-tid="principal"]');
  if (await unauthorizedPrincipal.isVisible()) {
    const principal = await unauthorizedPrincipal.textContent();
    expect(principal).toBeTruthy();
    return principal!.trim();
  }

  const kernelTrayToggle = page.locator('[data-tid="kernel-tray-toggle"]');
  if (await kernelTrayToggle.isVisible()) {
    await openKernelSettings(page);
    await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
    const accessToggle = page.locator('[data-tid="settings-access-toggle"]');
    if ((await accessToggle.getAttribute("aria-expanded")) !== "true") {
      await accessToggle.click();
    }
    const currentRow = page.locator(
      '[data-tid="settings-access"] .settings-principal-row:has(.settings-principal-current)'
    );
    await expect(currentRow).toBeVisible();
    const principal = await currentRow.getAttribute("data-principal");
    await page.locator('[data-tid="settings-back"]').click();
    await expect(page.locator('[data-tid="kernel-settings"]')).toHaveCount(0);
    expect(principal).toBeTruthy();
    return principal!;
  }

  throw new Error("Signed-in principal is unavailable");
}

async function openKernelSettings(page: Page): Promise<void> {
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await expect(page.locator('[data-tid="kernel-tray-popover"]')).toBeVisible();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
}

async function installHelloFromBrowser(page: Page): Promise<void> {
  await openLauncher(page);
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles("apps/hello/hello.v0.2.4.neutron");

  await expect(page.locator('[data-tid="install-dialog"]')).toBeVisible();
  await expect(page.locator('[data-tid="install-compiled"]')).toBeVisible({
    timeout: 120_000,
  });
  await page.locator('[data-tid="install-accept"]').click();
  await expect(page.locator('[data-tid="install-progress"]')).toBeVisible();
  await expect(page.locator('[data-tid="install-progress"]')).not.toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator('[data-tid="install-error"]')).not.toBeVisible();
  await expect(
    page
      .frameLocator('[data-app-id="hello"][data-tile-id="main"]')
      .getByRole("heading", { name: "Hello tile workspace test" })
  ).toBeVisible();
}

async function openLauncher(page: Page): Promise<void> {
  await expect(page.locator('[data-tid="appdrawer-open"]')).toHaveCount(0);
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}

async function registryHasHello(): Promise<boolean> {
  return registryHasApp("hello");
}

async function registryBackgroundCount(): Promise<number> {
  const apps = await readKernelRegistry();
  return Object.values(apps).filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      Boolean((entry as { background?: unknown }).background)
  ).length;
}

async function registryHasApp(appId: string): Promise<boolean> {
  const apps = await readKernelRegistry();
  return Boolean(apps[appId]);
}

async function readKernelRegistry(): Promise<AppRegistry> {
  const response = await fetch(
    new URL("/system/apps.json", localKernelUrl()),
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as AppRegistry;
}
