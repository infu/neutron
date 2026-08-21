import { Principal } from "@dfinity/principal";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  createKernelActor,
  localIdentityFromSeed,
} from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { signInWithLocalInternetIdentity } from "./local-ii.ts";

const configPath = "calendar-upgrade-local.ndeploy.json";

test("Calendar v0.1 upgrades in place to v0.2 and preserves owner data", async ({
  context,
  page,
}) => {
  test.setTimeout(360_000);
  const runtime = resolveLocalNeutronRuntime({ configPath });
  const title = `Preserved through upgrade ${Date.now()}`;
  let principal: string | undefined;

  try {
    principal = await signInAndAuthorize(context, page, runtime);
    const v1 = await openCalendar(page);
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setHours(11, 15, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000);
    await v1.getByLabel("Title").fill(title);
    await v1.getByLabel("Starts", { exact: true }).fill(localInput(start));
    await v1.getByLabel("Ends", { exact: true }).fill(localInput(end));
    await v1.getByRole("button", { name: "Add to calendar" }).click();
    await expect(v1.getByText(title)).toBeVisible({ timeout: 60_000 });

    await page
      .getByRole("region", { name: "Calendar" })
      .getByRole("button", { name: "Close tile" })
      .click();
    await upgradeCalendar(page);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible({
      timeout: 60_000,
    });
    const v2 = await openCalendar(page);
    await expect(
      v2.getByRole("region", { name: "Calendar views" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(v2.locator(".upcoming").getByText(title)).toBeVisible({
      timeout: 60_000,
    });

    const actor = await developerActor(runtime);
    const info = await actor.kernel_runtime_info();
    expect(
      info.apps.find(({ scope }) => scope.app_id === "calendar")?.version,
    ).toBe(200n);
    expect(
      info.memories.find(
        ({ id, owner }) => id === "calendar" && owner === "calendar",
      )?.version,
    ).toBe(2n);
  } finally {
    if (principal) {
      const actor = await developerActor(runtime);
      await actor.kernel_authorized_rem(
        Principal.fromText(principal),
      );
    }
  }
});

type Runtime = ReturnType<typeof resolveLocalNeutronRuntime>;

async function upgradeCalendar(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-tid="launcher-install-package"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles("apps/calendar/calendar.v0.2.0.neutron");
  const dialog = page.locator('[data-tid="install-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Update application" })).toBeVisible();
  await expect(dialog).toContainText("v0.2.0");
  await expect(page.locator('[data-tid="install-compiled"]')).toBeVisible({
    timeout: 180_000,
  });
  await page.locator('[data-tid="install-accept"]').click();
  await expect(page.locator('[data-tid="install-progress"]')).toBeVisible();
  await expect(page.locator('[data-tid="install-progress"]')).not.toBeVisible({
    timeout: 180_000,
  });
  await expect(page.locator('[data-tid="install-error"]')).not.toBeVisible();
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
  await actor.kernel_authorized_recover(
    Principal.fromText(principal),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible();
  return principal;
}

async function openCalendar(page: Page) {
  if ((await page.getByRole("region", { name: "Calendar" }).count()) === 0) {
    await page.locator('[data-tid="launcher-open"]').click();
    await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
    await page.locator('[data-tid="launcher-tile-calendar-main"]').click();
  }
  const frame = page
    .frameLocator('[data-app-id="calendar"][data-tile-id="main"]')
    .last();
  await expect(
    frame.getByRole("heading", { name: "Calendar", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(frame.getByText("Loading your calendar…")).toHaveCount(0, {
    timeout: 60_000,
  });
  return frame;
}

function developerActor(runtime: Runtime) {
  return createKernelActor({
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    fetchRootKey: true,
  });
}

function localInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
