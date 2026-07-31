import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { expect, test, type Page, type Request } from "@playwright/test";
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

test.skip(
  process.env.NEUTRON_E2E_WITH_II !== "1",
  "Set NEUTRON_E2E_WITH_II=1 to exercise signed-in package update Settings.",
);

test.afterEach(async () => {
  const principals = [...principalsToRevoke];
  principalsToRevoke.clear();
  for (const principal of principals) await revokeTestPrincipal(principal);
});

test("Settings load and refresh check app updates without a separate control", async ({
  context,
  page,
}) => {
  const updateRequests: string[] = [];
  const observeRequest = (request: Request) => {
    if (isUpdateSourceRequest(request.url())) updateRequests.push(request.url());
  };
  context.on("request", observeRequest);

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

  expect(updateRequests).toEqual([]);
  await openKernelSettings(page);
  const installedApps = page.locator('[data-tid="settings-installed-apps"]');
  await expect(installedApps).toBeVisible();
  await expect(page.locator('[data-tid="app-updates"]')).toHaveCount(0);
  await expect(
    installedApps.locator('[data-tid="app-updates-check"]'),
  ).toHaveCount(0);
  const updateStatus = page.locator('[data-tid="app-updates-status"]');
  await expect(updateStatus).toContainText("Update check complete:", {
    timeout: 20_000,
  });
  await expect(updateStatus).toHaveAttribute("data-checked-at", /^\d+$/u);
  const firstCheckedAt = await updateStatus.getAttribute("data-checked-at");
  expect(firstCheckedAt).toBeTruthy();

  const rows = installedApps.locator("tbody.settings-app-entry");
  expect(await rows.count()).toBeGreaterThan(0);
  const statuses = await rows
    .locator(".settings-app-cell--update")
    .allTextContents();
  expect(statuses.every((status) => status.trim().endsWith("Manual")))
    .toBe(true);
  const versions = await rows
    .locator(".settings-app-cell--version > span:last-child")
    .allTextContents();
  expect(versions.every((version) => /^v\d+\.\d+\.\d+$/u.test(version.trim())))
    .toBe(true);
  await expect(
    installedApps.getByRole("button", { name: "Update All", exact: true }),
  ).toHaveCount(0);
  expect(updateRequests).toEqual([]);

  const settingsRefresh = page.locator('[data-tid="settings-refresh"]');
  await settingsRefresh.focus();
  await expect(settingsRefresh).toBeFocused();
  await settingsRefresh.press("Enter");
  await expect(settingsRefresh).toBeDisabled();
  await expect(updateStatus).not.toHaveAttribute(
    "data-checked-at",
    firstCheckedAt!,
    { timeout: 20_000 },
  );
  await expect(updateStatus).toHaveAttribute("data-checked-at", /^\d+$/u, {
    timeout: 20_000,
  });
  expect(await updateStatus.getAttribute("data-checked-at")).not.toBe(
    firstCheckedAt,
  );
  await expect(settingsRefresh).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(installedApps).toBeVisible();
  const overflow = await installedApps.evaluate((element) => ({
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    section: element.scrollWidth - element.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.section).toBeLessThanOrEqual(1);

  context.off("request", observeRequest);
});

function isUpdateSourceRequest(value: string): boolean {
  const path = new URL(value).pathname;
  return (
    path.startsWith("/repo/v1/releases/") ||
    path.startsWith("/repo/v1/packages/")
  );
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
  await actor.kernel_authorized_recover(Principal.fromText(principal));
  principalsToRevoke.add(principal);
}

async function readSignedInPrincipal(page: Page): Promise<string> {
  const shellControl = page.locator(
    '[data-tid="principal"], [data-tid="kernel-tray-toggle"]',
  );
  await expect(shellControl.first()).toBeVisible({ timeout: 20_000 });

  const unauthorizedPrincipal = page.locator('[data-tid="principal"]');
  if (await unauthorizedPrincipal.isVisible()) {
    const principal = await unauthorizedPrincipal.textContent();
    if (!principal?.trim()) throw new Error("Signed-in principal is unavailable");
    return principal.trim();
  }

  const kernelTrayToggle = page.locator('[data-tid="kernel-tray-toggle"]');
  if (await kernelTrayToggle.isVisible()) {
    await openKernelSettings(page);
    const accessToggle = page.locator('[data-tid="settings-access-toggle"]');
    if ((await accessToggle.getAttribute("aria-expanded")) !== "true") {
      await accessToggle.click();
    }
    const currentRow = page.locator(
      '[data-tid="settings-access"] .settings-principal-row:has(.settings-principal-current)',
    );
    await expect(currentRow).toBeVisible();
    const principal = await currentRow.getAttribute("data-principal");
    await page.locator('[data-tid="settings-back"]').click();
    await expect(page.locator('[data-tid="kernel-settings"]')).toHaveCount(0);
    if (!principal) throw new Error("Signed-in principal is unavailable");
    return principal;
  }

  throw new Error("Signed-in principal is unavailable");
}

async function openKernelSettings(page: Page): Promise<void> {
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await expect(page.locator('[data-tid="kernel-tray-popover"]')).toBeVisible();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
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
