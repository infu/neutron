import { expect, test, type Locator, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "../../packages/neutron-provision/src/local_session.ts";

const WORKSPACE_STORAGE_KEY = "neutron-kernel-workspaces-v2";
const APPEARANCE_STORAGE_KEY = "neutron-kernel-appearance-v1";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.removeItem(storageKey);
  }, WORKSPACE_STORAGE_KEY);
});

test("app tray headers show each app title once", async ({ page }) => {
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  for (const [appId, title] of [
    ["mail", "Mail"],
    ["wallet", "Wallet"],
  ] as const) {
    await page.locator(`[data-tid="app-tray-button-${appId}"]`).click();
    const popover = page.locator(
      `[data-tid="app-tray-popover-${appId}"]`,
    );
    await expect(popover).toBeVisible();
    await expect(popover.locator(".app-tray-popover-identity")).toHaveText(
      title,
    );
    await popover.getByRole("button", { name: `Close ${title}` }).click();
  }
});

test("horizontal workspace previews expose color controls from the keyboard", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  const firstWorkspace = workspaceSwitch(page, 1);
  const secondWorkspace = workspaceSwitch(page, 2);
  await firstWorkspace.focus();
  await firstWorkspace.press("Tab");
  await expect(secondWorkspace).toBeFocused();

  await firstWorkspace.focus();
  await firstWorkspace.press("ArrowDown");
  await expect(
    page.locator('[data-tid="workspace-preview-color"]'),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(firstWorkspace).toBeFocused();
});

test("vertical workspace previews expose color controls from the keyboard", async ({
  page,
}) => {
  await initializeAppearance(page, "vertical", 8);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  const firstWorkspace = workspaceSwitch(page, 1);
  await firstWorkspace.focus();
  await firstWorkspace.press("ArrowRight");
  await expect(
    page.locator('[data-tid="workspace-preview-color"]'),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(firstWorkspace).toBeFocused();
});

test("vertical navigation uses the fixed mobile tile gap for rail alignment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await initializeAppearance(page, "vertical", 24);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await openLauncherTile(page, "hello", "main");

  const shellBox = await requiredBox(page.locator(".desktop-shell"), "shell");
  const tileBox = await requiredBox(page.locator(".tile-rect").first(), "tile");
  for (const [locator, label] of [
    [page.locator('[data-tid="launcher-open"]'), "launcher button"],
    [workspaceSwitch(page, 1), "workspace button"],
    [page.locator('[data-tid="kernel-tray-toggle"]'), "tray button"],
  ] as const) {
    const itemBox = await requiredBox(locator, label);
    expectNear(
      itemBox.x - shellBox.x,
      tileBox.x - (itemBox.x + itemBox.width),
    );
  }
});

test("vertical tray popovers retain their gap from translated controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await initializeAppearance(page, "vertical", 24);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  const trigger = page.locator('[data-tid="kernel-tray-toggle"]');
  await trigger.click();
  const triggerBox = await requiredBox(trigger, "kernel tray button");
  const popoverBox = await requiredBox(
    page.locator('[data-tid="kernel-tray-popover"]'),
    "kernel tray popover",
  );
  expectNear(popoverBox.x - (triggerBox.x + triggerBox.width), 6);
});

test("workspaces add one empty slot after every visible workspace is occupied", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  const workspaceSwitches = page.locator(
    '[data-tid^="workspace-switch-"]',
  );
  const workspaceOneSwitch = workspaceSwitch(page, 1);
  const workspaceTwoSwitch = workspaceSwitch(page, 2);
  const workspaceThreeSwitch = workspaceSwitch(page, 3);

  await expect(workspaceSwitches).toHaveCount(3);
  await expect(workspaceOneSwitch).toHaveClass(/active/u);
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceThreeSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceSwitch(page, 4)).toHaveCount(0);

  await openLauncherTile(page, "hello", "main");
  await expect(workspaceOneSwitch).toHaveAttribute("data-tile-count", "1");
  await expect(workspaceSwitches).toHaveCount(3);

  await workspaceTwoSwitch.click();
  await expect(workspaceTwoSwitch).toHaveClass(/active/u);
  await openLauncherTile(page, "hello", "main");
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "1");
  await expect(workspaceSwitches).toHaveCount(3);

  await workspaceThreeSwitch.click();
  await expect(workspaceThreeSwitch).toHaveClass(/active/u);
  await openLauncherTile(page, "hello", "main");
  await expect(workspaceThreeSwitch).toHaveAttribute("data-tile-count", "1");

  await expect(workspaceSwitches).toHaveCount(4);
  await expect(workspaceSwitch(page, 4)).toHaveAttribute(
    "data-tile-count",
    "0",
  );
  await expect(workspaceSwitch(page, 5)).toHaveCount(0);
});

test("a tile can be pointer-dragged to an empty workspace without adding one", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);

  const workspaceSwitches = page.locator(
    '[data-tid^="workspace-switch-"]',
  );
  const workspaceOneSwitch = workspaceSwitch(page, 1);
  const workspaceTwoSwitch = workspaceSwitch(page, 2);
  const workspaceThreeSwitch = workspaceSwitch(page, 3);

  await expect(workspaceSwitches).toHaveCount(3);
  await expect(workspaceOneSwitch).toHaveClass(/active/u);
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceThreeSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceSwitch(page, 4)).toHaveCount(0);

  await openLauncherTile(page, "hello", "main");
  const helloFrame = page.locator(
    'iframe[data-app-id="hello"][data-tile-id="main"]',
  );
  await expect(helloFrame).toBeVisible();
  const instanceId = await helloFrame.getAttribute("data-instance-id");
  if (!instanceId) throw new Error("Hello tile has no instance id");

  await expect(workspaceSwitches).toHaveCount(3);
  await expect(workspaceTwoSwitch).toBeVisible();
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "0");

  const tile = page.locator(
    `.tile-rect:has(iframe[data-instance-id="${instanceId}"])`,
  );
  const header = tile.locator(".tile-header");
  const headerBounds = await header.boundingBox();
  const targetBounds = await workspaceTwoSwitch.boundingBox();
  if (!headerBounds || !targetBounds) {
    throw new Error("Tile header or workspace drop target has no bounds");
  }

  const headerX = headerBounds.x + headerBounds.width / 2;
  const headerY = headerBounds.y + headerBounds.height / 2;
  const targetX = targetBounds.x + targetBounds.width / 2;
  const targetY = targetBounds.y + targetBounds.height / 2;

  await page.mouse.move(headerX, headerY);
  await page.mouse.down();
  await page.mouse.move(headerX + 12, headerY + 12, { steps: 4 });
  await expect(page.locator(".tile-rect--preview")).toHaveCount(1);
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await expect(workspaceTwoSwitch).toHaveClass(/workspace-drop-target/u);
  await page.mouse.up();

  await expect(page.locator(".tile-rect--preview")).toHaveCount(0);
  await expect(workspaceTwoSwitch).toHaveClass(/active/u);
  await expect(workspaceTwoSwitch).toHaveAttribute("aria-current", "page");

  const workspaceOne = page.locator(
    '[data-tid="workspace-layer"][data-workspace-id="1"]',
  );
  const workspaceTwo = page.locator(
    '[data-tid="workspace-layer"][data-workspace-id="2"]',
  );
  await expect(workspaceOne).toHaveAttribute("aria-hidden", "true");
  await expect(
    workspaceOne.locator(`iframe[data-instance-id="${instanceId}"]`),
  ).toHaveCount(0);
  await expect(workspaceTwo).toHaveAttribute("data-active", "true");
  await expect(
    workspaceTwo.locator(`iframe[data-instance-id="${instanceId}"]`),
  ).toHaveCount(1);

  await expect(workspaceOneSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceTwoSwitch).toHaveAttribute("data-tile-count", "1");
  await expect(workspaceThreeSwitch).toHaveAttribute("data-tile-count", "0");
  await expect(workspaceSwitches).toHaveCount(3);
  await expect(workspaceSwitch(page, 4)).toHaveCount(0);
});

test("vertical navigation persists with workspaces above the tray", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuthorizedKernel(page, runtime);
  const shell = page.locator(".desktop-shell");
  await expect(shell).toHaveAttribute(
    "data-navigation-layout",
    "horizontal",
  );

  await openLauncherTile(page, "hello", "main");
  await expectHorizontalWorkspacePreviewGeometry(page);

  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await page.locator('[data-tid="settings-theme-toggle"]').click();

  const navigationToggle = page.locator(
    '[data-tid="settings-theme-navigation"]',
  );
  await expect(navigationToggle).not.toBeChecked();
  await navigationToggle.check();
  await expect(shell).toHaveAttribute(
    "data-navigation-layout",
    "vertical",
  );
  expect(
    await page.evaluate((storageKey) => {
      const stored = window.localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored).navigationLayout : null;
    }, APPEARANCE_STORAGE_KEY),
  ).toBe("vertical");

  await page.locator('[data-tid="settings-back"]').click();
  await expectVerticalNavigationGeometry(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await logInAuthorizedKernel(page, runtime);
  await expect(shell).toHaveAttribute(
    "data-navigation-layout",
    "vertical",
  );
  await expectVerticalNavigationGeometry(page);
  await openLauncherTile(page, "hello", "main");
  await expectVerticalWorkspacePreviewGeometry(page);
  await expectVerticalTrayPopoverGeometry(page);
});

test("spotlight preserves the live iframe and sibling layout, then restores", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuthorizedKernel(page, runtime);

  await openLauncherTile(page, "hello", "main");
  await openLauncherTile(page, "hello", "main");

  const helloFrames = page.locator(
    'iframe[data-app-id="hello"][data-tile-id="main"]',
  );
  await expect(helloFrames).toHaveCount(2);
  const siblingInstanceId = await helloFrames.nth(0).getAttribute(
    "data-instance-id",
  );
  const spotlightInstanceId = await helloFrames.nth(1).getAttribute(
    "data-instance-id",
  );
  if (!siblingInstanceId || !spotlightInstanceId) {
    throw new Error("Hello tiles have no instance ids");
  }

  const siblingTile = page.locator(
    `.tile-rect:has(iframe[data-instance-id="${siblingInstanceId}"])`,
  );
  const spotlightTile = page.locator(
    `.tile-rect:has(iframe[data-instance-id="${spotlightInstanceId}"])`,
  );
  const spotlightFrame = page.locator(
    `iframe[data-instance-id="${spotlightInstanceId}"]`,
  );
  const workspace = page.locator(
    '[data-tid="workspace"][data-workspace-id="1"]',
  );
  const marker = "workspace-dynamic-spotlight-frame";
  await spotlightFrame.evaluate((frame, value) => {
    (
      frame as HTMLIFrameElement & {
        __neutronSpotlightTestMarker?: string;
      }
    ).__neutronSpotlightTestMarker = value;
  }, marker);

  await waitForTileTransitions(page);
  const workspaceBox = await requiredBox(workspace, "workspace");
  const spotlightBoxBefore = await requiredBox(
    spotlightTile,
    "spotlight tile",
  );
  const siblingBoxBefore = await requiredBox(siblingTile, "sibling tile");
  const tiledAreaBefore = unionBoxes(spotlightBoxBefore, siblingBoxBefore);
  const spotlightToggle = spotlightTile.locator(
    '[data-tid="tile-spotlight-toggle"]',
  );
  const closeButton = spotlightTile.locator('[aria-label="Close tile"]');
  const toggleBox = await requiredBox(spotlightToggle, "spotlight control");
  const closeBox = await requiredBox(closeButton, "close control");
  expectNear(closeBox.x - (toggleBox.x + toggleBox.width), 5);
  await expect(spotlightToggle).toHaveCSS(
    "background-color",
    "rgb(48, 52, 55)",
  );

  await spotlightToggle.click();
  await expect(spotlightTile).toHaveClass(/tile-rect--spotlight/u);
  await expect(spotlightToggle).toHaveAttribute("aria-pressed", "true");

  await expectBoxToMatch(spotlightTile, tiledAreaBefore);
  await expectBoxToMatch(siblingTile, siblingBoxBefore);
  await expect(siblingTile).toHaveCSS("visibility", "hidden");
  expect(await spotlightFrameMarker(spotlightFrame)).toBe(marker);

  await spotlightToggle.click();
  await expect(spotlightTile).not.toHaveClass(/tile-rect--spotlight/u);
  await expectBoxToMatch(spotlightTile, spotlightBoxBefore);
  await expectBoxToMatch(siblingTile, siblingBoxBefore);
  await expect(siblingTile).toHaveCSS("visibility", "visible");
  expect(await spotlightFrameMarker(spotlightFrame)).toBe(marker);

  await spotlightToggle.click();
  await expect(spotlightTile).toHaveClass(/tile-rect--spotlight/u);
  await expect(
    page.locator('[data-tid="tile-spotlight-backdrop"]'),
  ).toBeVisible();
  await page.mouse.click(workspaceBox.x + 1, workspaceBox.y + 1);
  await expect(spotlightTile).not.toHaveClass(/tile-rect--spotlight/u);
  await expectBoxToMatch(spotlightTile, spotlightBoxBefore);
  await expectBoxToMatch(siblingTile, siblingBoxBefore);
  expect(await spotlightFrameMarker(spotlightFrame)).toBe(marker);
});

test("translucent Settings confirmations stay above the navigation", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuthorizedKernel(page, runtime);

  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await page.locator('[data-tid="settings-theme-toggle"]').click();
  await page.locator('[data-tid="settings-theme-opacity"]').fill("70");
  await expect(page.locator('[data-tid="kernel-settings"]')).toHaveCSS(
    "opacity",
    "0.7",
  );

  await page.locator('[data-tid="settings-access-toggle"]').click();
  const controllerInput = page.getByLabel("Add controller principal");
  await expect(controllerInput).toBeEnabled();
  await controllerInput.fill("ryjl3-tyaaa-aaaaa-aaaba-cai");
  await page.getByLabel("Add controller", { exact: true }).click();
  await expect(
    page.locator('[data-tid="settings-access-controller-add-dialog"]'),
  ).toBeVisible();

  const navigationButton = page.locator('[data-tid="launcher-open"]');
  const navigationBox = await requiredBox(
    navigationButton,
    "navigation button",
  );
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.classList.contains("backdrop") ??
        false,
      {
        x: navigationBox.x + navigationBox.width / 2,
        y: navigationBox.y + navigationBox.height / 2,
      },
    ),
  ).toBe(true);
  await page.mouse.click(
    navigationBox.x + navigationBox.width / 2,
    navigationBox.y + navigationBox.height / 2,
  );
  await expect(
    page.locator('[data-tid="settings-access-controller-add-dialog"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
});

test("clicking the navigation outside Settings returns to the workspace", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAuthorizedKernel(page, runtime);

  await openLauncherTile(page, "hello", "main");
  const tile = page.locator(
    '.tile-rect:has(iframe[data-app-id="hello"][data-tile-id="main"])',
  );
  await expect(tile).toBeVisible();

  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
  await expect(tile).toHaveCSS("visibility", "hidden");

  const navigation = page.locator('[data-tid="desktop-topbar"]');
  const navigationBox = await requiredBox(navigation, "navigation");
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-tid"),
      {
        x: navigationBox.x + navigationBox.width / 2,
        y: navigationBox.y + navigationBox.height / 2,
      },
    ),
  ).toBe("desktop-topbar");
  await page.mouse.click(
    navigationBox.x + navigationBox.width / 2,
    navigationBox.y + navigationBox.height / 2,
  );

  await expect(page.locator('[data-tid="kernel-settings"]')).toHaveCount(0);
  await expect(
    page.locator('[data-tid="workspace-layer"][data-active="true"]'),
  ).toBeVisible();
  await expect(tile).toHaveCSS("visibility", "visible");
});

function workspaceSwitch(page: Page, workspaceId: number) {
  return page.locator(`[data-tid="workspace-switch-${workspaceId}"]`);
}

async function openAuthorizedKernel(
  page: Page,
  runtime: LocalNeutronRuntime,
): Promise<void> {
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await logInAuthorizedKernel(page, runtime);
}

async function logInAuthorizedKernel(
  page: Page,
  runtime: LocalNeutronRuntime,
): Promise<void> {
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (
        window as typeof window & {
          __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown;
        }
      ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
  );
  const principal = await page.evaluate(async (identitySeed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    return login(identitySeed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
}

async function openLauncherTile(
  page: Page,
  appId: string,
  tileId: string,
): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator(`[data-tid="launcher-tile-${appId}-${tileId}"]`).click();
}

async function initializeAppearance(
  page: Page,
  navigationLayout: "horizontal" | "vertical",
  tileGap: number,
): Promise<void> {
  await page.addInitScript(
    ({ storageKey, navigationLayout, tileGap }) => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          navigationLayout,
          tileOpacity: 1,
          tileGap,
          workspaceColors: {},
        }),
      );
    },
    {
      storageKey: APPEARANCE_STORAGE_KEY,
      navigationLayout,
      tileGap,
    },
  );
}

async function expectVerticalNavigationGeometry(page: Page): Promise<void> {
  const shell = page.locator(".desktop-shell");
  const shellBox = await requiredBox(shell, "shell");
  const railBox = await requiredBox(
    page.locator('[data-tid="desktop-topbar"]'),
    "navigation rail",
  );
  const contentBox = await requiredBox(
    page.locator(".desktop-content"),
    "desktop content",
  );
  const launcherBox = await requiredBox(
    page.locator('[data-tid="launcher-open"]'),
    "launcher button",
  );
  const workspaceBox = await requiredBox(
    workspaceSwitch(page, 1),
    "workspace button",
  );
  const trayBox = await requiredBox(
    page.locator('[data-tid="kernel-tray-toggle"]'),
    "kernel tray button",
  );
  const tileGap = await shell.evaluate((element) =>
    Number.parseFloat(
      getComputedStyle(element).getPropertyValue(
        "--desktop-effective-tile-gap",
      ),
    ),
  );
  const tileLeft = contentBox.x + tileGap;

  expect(railBox.height).toBeGreaterThan(railBox.width);
  expectNear(railBox.width, 40);
  expectNear(railBox.x, shellBox.x);
  expectNear(railBox.y, shellBox.y);
  expectNear(railBox.height, shellBox.height);
  expectNear(contentBox.x, railBox.x + railBox.width);
  expectNear(contentBox.y, shellBox.y);
  expectNear(contentBox.x + contentBox.width, shellBox.x + shellBox.width);
  expectNear(contentBox.height, shellBox.height);
  expect(workspaceBox.y).toBeGreaterThanOrEqual(
    launcherBox.y + launcherBox.height,
  );
  expect(trayBox.y).toBeGreaterThan(workspaceBox.y);
  expect(railBox.y + railBox.height - trayBox.y - trayBox.height).toBeLessThan(
    railBox.width,
  );
  for (const item of [launcherBox, workspaceBox, trayBox]) {
    const center = item.x + item.width / 2;
    expect(center).toBeGreaterThanOrEqual(railBox.x);
    expect(center).toBeLessThanOrEqual(railBox.x + railBox.width);
    expectNear(
      item.x - shellBox.x,
      tileLeft - (item.x + item.width),
    );
  }
}

async function expectVerticalTrayPopoverGeometry(page: Page): Promise<void> {
  const trigger = page.locator('[data-tid="kernel-tray-toggle"]');
  await trigger.click();
  const popover = page.locator('[data-tid="kernel-tray-popover"]');
  await expect(popover).toBeVisible();

  const shellBox = await requiredBox(page.locator(".desktop-shell"), "shell");
  const triggerBox = await requiredBox(trigger, "kernel tray button");
  const popoverBox = await requiredBox(popover, "kernel tray popover");
  expect(popoverBox.x).toBeGreaterThanOrEqual(
    triggerBox.x + triggerBox.width - 1,
  );
  expect(popoverBox.x).toBeGreaterThanOrEqual(shellBox.x);
  expect(popoverBox.y).toBeGreaterThanOrEqual(shellBox.y);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
    shellBox.x + shellBox.width,
  );
  expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
    shellBox.y + shellBox.height,
  );
}

async function expectVerticalWorkspacePreviewGeometry(
  page: Page,
): Promise<void> {
  const occupiedWorkspace = workspaceSwitch(page, 1);
  await occupiedWorkspace.hover();
  const preview = page.locator('[data-tid="workspace-preview"]');
  await expect(preview).toHaveAttribute("data-workspace-id", "1");

  const glyphBox = await requiredBox(
    occupiedWorkspace.locator(".workspace-glyph"),
    "workspace glyph",
  );
  const previewBox = await requiredBox(preview, "workspace preview");
  await expect(preview.locator(".workspace-preview-app img").first()).toBeVisible();
  const appIconBox = await requiredBox(
    preview.locator(".workspace-preview-app img").first(),
    "workspace preview app icon",
  );
  const colorSwatchBox = await requiredBox(
    preview.locator(".workspace-preview-color-swatch"),
    "workspace color swatch",
  );
  expectNear(
    appIconBox.y + appIconBox.height / 2,
    glyphBox.y + glyphBox.height / 2,
  );
  expectNear(previewBox.x, glyphBox.x + glyphBox.width + 6);
  expectNear(colorSwatchBox.x, appIconBox.x);
  expectNear(colorSwatchBox.y - (appIconBox.y + appIconBox.height), 3);

  await workspaceSwitch(page, 2).hover();
  await expect(preview).toHaveAttribute("data-workspace-id", "2");
  await expect(preview.locator(".workspace-preview-app")).toHaveCount(0);
  await expect(preview).not.toContainText("Empty workspace");
  await expect(
    preview.locator('[data-tid="workspace-preview-color"]'),
  ).toBeVisible();
}

async function expectHorizontalWorkspacePreviewGeometry(
  page: Page,
): Promise<void> {
  const occupiedWorkspace = workspaceSwitch(page, 1);
  await occupiedWorkspace.hover();
  const preview = page.locator('[data-tid="workspace-preview"]');
  await expect(preview).toHaveAttribute("data-workspace-id", "1");

  const glyphBox = await requiredBox(
    occupiedWorkspace.locator(".workspace-glyph"),
    "workspace glyph",
  );
  const previewBox = await requiredBox(preview, "workspace preview");
  const appIconBox = await requiredBox(
    preview.locator(".workspace-preview-app img").first(),
    "workspace preview app icon",
  );
  const colorSwatchBox = await requiredBox(
    preview.locator(".workspace-preview-color-swatch"),
    "workspace color swatch",
  );
  expectNear(previewBox.y, glyphBox.y + glyphBox.height + 6);
  expectNear(appIconBox.x, glyphBox.x);
  expectNear(colorSwatchBox.x, appIconBox.x);
  expectNear(colorSwatchBox.y - (appIconBox.y + appIconBox.height), 3);
}

async function requiredBox(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} has no bounds`);
  return box;
}

function expectNear(actual: number, expected: number, tolerance = 1): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function expectBoxToMatch(
  locator: Locator,
  expected: Readonly<{ x: number; y: number; width: number; height: number }>,
): Promise<void> {
  await expect
    .poll(async () => boxDelta(await requiredBox(locator, "tile"), expected))
    .toBeLessThanOrEqual(1);
}

async function waitForTileTransitions(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator(".tile-rect").evaluateAll((tiles) =>
        tiles.reduce(
          (count, tile) =>
            count +
            tile
              .getAnimations()
              .filter((animation) => animation.playState === "running").length,
          0,
        ),
      ),
    )
    .toBe(0);
}

function boxDelta(
  actual: Readonly<{ x: number; y: number; width: number; height: number }>,
  expected: Readonly<{ x: number; y: number; width: number; height: number }>,
): number {
  return Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height),
  );
}

function unionBoxes(
  first: Readonly<{ x: number; y: number; width: number; height: number }>,
  second: Readonly<{ x: number; y: number; width: number; height: number }>,
) {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: right - x, height: bottom - y };
}

async function spotlightFrameMarker(frame: Locator): Promise<string | null> {
  return frame.evaluate(
    (element) =>
      (
        element as HTMLIFrameElement & {
          __neutronSpotlightTestMarker?: string;
        }
      ).__neutronSpotlightTestMarker ?? null,
  );
}
