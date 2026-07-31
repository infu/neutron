import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { expect, test } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
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

test("expanded app settings stay readable and tray metrics stay fixed", async ({
  context,
  page,
}) => {
  test.skip(
    process.env.NEUTRON_E2E_WITH_II !== "1",
    "Set NEUTRON_E2E_WITH_II=1 to exercise the signed-in kernel UI.",
  );

  await page.setViewportSize({ width: 1280, height: 800 });
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

  const kitchenTrayButton = page.locator(
    '[data-tid="app-tray-button-kitchensink"]',
  );
  const kitchenTrayInstalled = await kitchenTrayButton
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  test.skip(
    !kitchenTrayInstalled,
    "The app-tray regressions require the full local Kitchen Sink install.",
  );
  await expect(kitchenTrayButton).toHaveAccessibleName(
    "Kitchen Sink Tray Demo, app kitchensink",
  );
  const kitchenTrayIcon = kitchenTrayButton.locator("img");
  await expect(kitchenTrayIcon).toBeVisible();
  expect(
    await kitchenTrayIcon.evaluate(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  ).toBe(true);
  await expect(kitchenTrayButton.locator(".app-tray-badge")).toHaveCount(0);

  const trayGap = await page.locator(".app-tray").evaluate((tray) => {
    const appGroup = tray.querySelector<HTMLElement>(".app-tray-apps");
    const appButtons = appGroup?.querySelectorAll<HTMLElement>(
      ":scope > .app-tray-item > .app-tray-button",
    );
    const lastAppButton = appButtons?.item((appButtons?.length ?? 0) - 1);
    const kernelButton = tray.querySelector<HTMLElement>(
      '[data-tid="kernel-tray-toggle"]',
    );
    if (!appGroup || !lastAppButton || !kernelButton) return null;
    return {
      actual:
        kernelButton.getBoundingClientRect().left -
        lastAppButton.getBoundingClientRect().right,
      expected: Number.parseFloat(getComputedStyle(appGroup).columnGap),
    };
  });
  expect(trayGap).not.toBeNull();
  expect(Math.abs(trayGap!.actual - trayGap!.expected)).toBeLessThanOrEqual(1);

  await kitchenTrayButton.click();
  const kitchenTray = page.locator(
    '[data-tid="app-tray-popover-kitchensink"]',
  );
  await expect(kitchenTray).toBeVisible();
  await expect(
    kitchenTray.locator(".app-tray-popover-header strong"),
  ).toHaveText("Kitchen Sink Tray Demo");
  const kitchenTrayFrame = page.frameLocator(
    'iframe[data-tid="app-tray-frame"][data-app-id="kitchensink"]',
  );
  await expect(kitchenTrayFrame.locator('[data-tid="kitchen-tray"]')).toBeVisible();
  await expect(kitchenTrayFrame.getByText("Tray demo ready")).toBeVisible();
  await expect(
    kitchenTrayFrame.locator('[data-tid="kitchen-tray-unread"]'),
  ).toHaveCount(0);
  await kitchenTray
    .getByRole("button", { name: "Close Kitchen Sink Tray Demo" })
    .click();

  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  const tray = page.locator('[data-tid="kernel-tray-popover"]');
  const memory = page.locator('[data-tid="kernel-tray-memory"]');
  await expect(tray).toBeVisible();
  await expect(memory).toContainText("Memory");
  await expect(memory).toHaveAttribute(
    "title",
    /^[\d,]+ bytes used of [\d,]+ bytes$/u,
  );
  await expect(memory.locator('[role="progressbar"]')).toBeVisible();
  await expect(memory.locator('[role="progressbar"]')).toHaveAttribute(
    "aria-valuetext",
    /of the .* limit/u,
  );
  await expect(
    page.locator('[data-tid="kernel-tray-memory-details"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-tid="kernel-tray-stable-memory"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-tid="kernel-tray-logical-stable-memory"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="kernel-tray-principal"]')).toHaveCount(0);
  await expect(memory).not.toContainText("Main memory");
  await expect(memory).not.toContainText("Heap occupied");
  await expect(memory).not.toContainText("Stable memory");

  const heightBeforeHover = await tray.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await memory.hover();
  const heightAfterHover = await tray.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(Math.abs(heightAfterHover - heightBeforeHover)).toBeLessThanOrEqual(1);

  await page.locator('[data-tid="kernel-tray-settings"]').click();
  const installedApps = page.locator('[data-tid="settings-installed-apps"]');
  await expect(installedApps).toBeVisible();
  await expect(
    page.locator('[data-tid="settings-app-usage-ranking"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-tid="app-updates"]')).toHaveCount(0);

  const table = installedApps.getByRole("table", { name: "Installed apps" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText([
    "App",
    "Cycles used",
    "Update",
    "Version",
    "Details",
    "Uninstall",
  ]);
  const installedAppCount = await page
    .locator('.settings-app-entry:not([data-app-id="kernel"])')
    .count();
  expect(installedAppCount).toBeGreaterThan(0);
  await expect(
    table.locator('[data-tid="settings-app-cycles-used"]'),
  ).toHaveCount(installedAppCount);
  const cycleTotals = await table
    .locator('[data-tid="settings-app-cycles-used"]')
    .allTextContents();
  expect(
    cycleTotals.every((value) => /^\d[\d,.]*\.\d{4}TC$/u.test(value.trim())),
  ).toBe(true);

  const kitchenToggle = page.locator(
    '[data-tid="settings-app-details-toggle-kitchensink"]',
  );
  test.skip(
    (await kitchenToggle.count()) === 0,
    "The dense settings regression requires the full local Kitchen Sink install.",
  );
  await kitchenToggle.click();

  const kitchenDetails = page.locator(
    '[data-tid="settings-app-details-kitchensink"]',
  );
  await expect(kitchenDetails).toBeVisible();
  const normalDetails = kitchenDetails.locator(
    '[data-tid="settings-app-normal-kitchensink"]',
  );
  await expect(normalDetails).toBeVisible();
  await expect(normalDetails).toContainText(
    "Neutron keeps this app in its own protected space",
  );
  await expect(kitchenDetails).not.toContainText("Capability plan");
  await expect(
    kitchenDetails.locator('[data-tid="settings-app-usage-kitchensink"]'),
  ).toHaveCount(0);
  const certifiedAssetsControls = kitchenDetails.locator(
    '[data-tid="settings-certified-assets-kitchensink"]',
  );
  await expect(certifiedAssetsControls).toHaveCount(0);

  await page.locator('[data-tid="settings-interface-toggle"]').click();
  const developerMode = page.locator(
    '[data-tid="settings-ui-mode-developer"]',
  );
  await developerMode.check();
  await expect(normalDetails).toHaveCount(0);
  await expect(kitchenDetails).toContainText("Capability plan");
  await expect(certifiedAssetsControls).toBeVisible();
  const usageDetails = kitchenDetails.locator(
    '[data-tid="settings-app-usage-kitchensink"]',
  );
  await expect(usageDetails).toBeVisible();
  await expect(usageDetails).toContainText("Raw 30-day and installation totals");
  await expect(usageDetails).toContainText("instructions");
  await expect(usageDetails).toContainText("executions");
  await expect(kitchenDetails.locator(".settings-app-usage-chart")).toHaveCount(
    0,
  );
  const layouts = await kitchenDetails
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
  expect(layouts.length).toBeGreaterThan(0);
  for (const layout of layouts) {
    expect(layout.mainWidth).toBeGreaterThanOrEqual(layout.rowWidth - 10);
    expect(layout.metaTop).toBeGreaterThanOrEqual(layout.mainBottom - 1);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(installedApps).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

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
  await actor.kernel_authorized_recover(Principal.fromText(principal));
  principalsToRevoke.add(principal);
}

async function readSignedInPrincipal(page: import("@playwright/test").Page) {
  const principal = page.locator('[data-tid="principal"]');
  await expect(principal).toBeVisible({
    timeout: 20_000,
  });
  const value = await principal.textContent();
  if (!value?.trim()) throw new Error("Signed-in principal is unavailable");
  return value.trim();
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
  await actor.kernel_authorized_rem(Principal.fromText(principal));
}

function localDeveloperIdentity() {
  return localIdentityFromSeed(
    resolveLocalNeutronRuntime().developerIdentitySeed,
  );
}
