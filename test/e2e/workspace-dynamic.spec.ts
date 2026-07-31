import { expect, test, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "../../packages/neutron-provision/src/local_session.ts";

const WORKSPACE_STORAGE_KEY = "neutron-kernel-workspaces-v2";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.removeItem(storageKey);
  }, WORKSPACE_STORAGE_KEY);
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

function workspaceSwitch(page: Page, workspaceId: number) {
  return page.locator(`[data-tid="workspace-switch-${workspaceId}"]`);
}

async function openAuthorizedKernel(
  page: Page,
  runtime: LocalNeutronRuntime,
): Promise<void> {
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
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
