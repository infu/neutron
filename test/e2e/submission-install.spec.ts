import { Principal } from "@dfinity/principal";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  createKernelActor,
  localIdentityFromSeed,
} from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { signInWithLocalInternetIdentity } from "./local-ii.ts";

const configPath = "submission-install-local.ndeploy.json";

test("an owner reviews and installs Contacts and Calendar before Rendezvous from release files", async ({
  context,
  page,
}) => {
  test.setTimeout(720_000);
  const runtime = resolveLocalNeutronRuntime({ configPath });
  let principal: string | undefined;

  try {
    principal = await signInAndAuthorize(context, page, runtime);
    const actor = await developerActor(runtime);
    const before = await actor.kernel_runtime_info();
    expect(before.apps.some(({ scope }) => ["contacts", "calendar", "rendezvous"].includes(scope.app_id))).toBe(false);

    await installPackage(page, "apps/contacts/contacts.v0.3.1.neutron", "Contacts", "v0.3.1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openInstalledApp(page, "contacts", "contacts", "Contacts");
    await closeTile(page, "Contacts");

    await installPackage(page, "apps/calendar/calendar.v0.2.0.neutron", "Calendar", "v0.2.0");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openInstalledApp(page, "calendar", "main", "Calendar");
    await closeTile(page, "Calendar");

    await installPackage(page, "apps/rendezvous/rendezvous.v0.2.1.neutron", "Rendezvous", "v0.2.1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openInstalledApp(page, "calendar", "main", "Calendar");
    await closeTile(page, "Calendar");
    await openInstalledApp(page, "rendezvous", "main", "Rendezvous");

    const after = await actor.kernel_runtime_info();
    expect(after.apps.find(({ scope }) => scope.app_id === "contacts")?.version).toBe(301n);
    expect(after.apps.find(({ scope }) => scope.app_id === "calendar")?.version).toBe(200n);
    expect(after.apps.find(({ scope }) => scope.app_id === "rendezvous")?.version).toBe(201n);
  } finally {
    if (principal) {
      const actor = await developerActor(runtime);
      await actor.kernel_authorized_rem(Principal.fromText(principal));
    }
  }
});

type Runtime = ReturnType<typeof resolveLocalNeutronRuntime>;

async function installPackage(page: Page, path: string, appName: string, version: string): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  const dialog = page.locator('[data-tid="install-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Install application" })).toBeVisible();
  await expect(dialog).toContainText(appName);
  await expect(dialog).toContainText(version);
  await expect(page.locator('[data-tid="install-compiled"]')).toBeVisible({ timeout: 240_000 });
  await page.locator('[data-tid="install-accept"]').click();
  await expect(page.locator('[data-tid="install-progress"]')).toBeVisible();
  await expect(page.locator('[data-tid="install-progress"]')).not.toBeVisible({ timeout: 240_000 });
  await expect(page.locator('[data-tid="install-error"]')).not.toBeVisible();
}

async function openInstalledApp(page: Page, appId: "contacts" | "calendar" | "rendezvous", tileId: "contacts" | "main", name: string): Promise<void> {
  await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1_000);
  if ((await page.getByRole("region", { name }).count()) === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
    await page.locator(`[data-tid="launcher-tile-${appId}-${tileId}"]`).click();
  }
  const frame = page.frameLocator(`[data-app-id="${appId}"][data-tile-id="${tileId}"]`).last();
  const ready = appId === "contacts" ? frame.getByRole("button", { name: "Add contact" }) : frame.getByRole("heading", { name, exact: true });
  await expect(ready).toBeVisible({ timeout: 60_000 });
}

async function closeTile(page: Page, name: string): Promise<void> {
  const regions = page.getByRole("region", { name });
  for (let remaining = await regions.count(); remaining > 0; remaining -= 1) {
    await regions.last().getByRole("button", { name: "Close tile" }).click();
    await expect(regions).toHaveCount(remaining - 1);
  }
}

async function signInAndAuthorize(
  context: BrowserContext,
  page: Page,
  runtime: Runtime,
): Promise<string> {
  await context.credentials.install();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await signInWithLocalInternetIdentity({
    page,
    context,
    loginSelector: '[data-tid="login-button"]',
    localHost: runtime.gatewayUrl,
  });
  const principalNode = page.locator('[data-tid="principal"]');
  await expect(principalNode).toBeVisible();
  const principal = (await principalNode.textContent())?.trim();
  if (!principal) throw new Error("Internet Identity did not return a principal");
  const actor = await developerActor(runtime);
  await actor.kernel_authorized_recover(Principal.fromText(principal));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible();
  return principal;
}

function developerActor(runtime: Runtime) {
  return createKernelActor({
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    fetchRootKey: true,
  });
}
