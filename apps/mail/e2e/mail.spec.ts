import { fileURLToPath } from "node:url";
import {
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { resolveLocalNeutronRuntime } from "neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";

type MailSurface = {
  canisterId: string;
  frame: Locator;
  mail: FrameLocator;
};

test("installed Mail setup survives reload on the provisioned local Neutron", async ({
  page,
}) => {
  const first = await openProvisionedMail(page, true);
  await assertMailSurface(first);
  await ensurePrivateMailReady(page, first.mail);

  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = await openProvisionedMail(page, false);
  await assertMailSurface(reloaded);
  await expect(reloaded.mail.getByRole("button", {
    name: "Set up private Mail",
  })).toHaveCount(0);
  await expect(reloaded.mail.getByRole("button", {
    name: "Finish Mail setup",
    exact: true,
  })).toHaveCount(0);
});

async function openProvisionedMail(
  page: Page,
  navigate: boolean,
): Promise<MailSurface> {
  const runtime = resolveLocalNeutronRuntime({
    configPath:
      process.env.NEUTRON_NDEPLOY_CONFIG?.trim() ||
      fileURLToPath(new URL("../../../local.ndeploy.json", import.meta.url)),
  });
  const kernelUrl = localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
  if (navigate) await page.goto(kernelUrl, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => typeof (window as typeof window & {
    __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown;
  }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
  const principal = await page.evaluate(async (identitySeed) => {
    const login = (window as typeof window & {
      __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string>;
    }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Provisioned local Playwright login is unavailable");
    return login(identitySeed);
  }, runtime.developerIdentitySeed);
  if (principal !== runtime.developerIdentityPrincipal) {
    throw new Error("Provisioned local login did not select the configured developer identity");
  }
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator(
    '[data-tid="app-background-frame"][data-app-id="mail"]',
  )).toHaveCount(1);

  const selector = 'iframe[data-app-id="mail"][data-tile-id="mail"]';
  if (await page.locator(selector).count() === 0) {
    const launcher = page.locator('[data-tid="launcher"]');
    if (!await launcher.isVisible().catch(() => false)) {
      await page.locator('[data-tid="launcher-open"]').click();
      await expect(launcher).toBeVisible();
    }
    await page.locator('[data-tid="launcher-tile-mail-mail"]').click();
  }

  const candidate = page.locator(selector).last();
  await expect(candidate).toHaveCount(1);
  const instanceId = await candidate.getAttribute("data-instance-id");
  if (!instanceId || !/^[A-Za-z0-9_-]{1,256}$/u.test(instanceId)) {
    throw new Error("Mail frame has no valid stable instance id");
  }
  const exactSelector = `${selector}[data-instance-id="${instanceId}"]`;
  const frame = page.locator(exactSelector);
  const mail = page.frameLocator(exactSelector);
  await expect(frame).toBeVisible();
  await expect(mail.getByRole("main", { name: "Private Mail" })).toBeVisible();
  await expect(mail.getByRole("heading", { name: "Inbox" })).toBeVisible();
  return { canisterId: runtime.canisterId, frame, mail };
}

async function assertMailSurface(surface: MailSurface): Promise<void> {
  await expect(surface.frame).toBeVisible();
  await expect(surface.mail.getByRole("searchbox", {
    name: "Search this page's mail headers",
  })).toBeVisible();
  await expect(surface.mail.getByRole("button", {
    name: `Copy full Neutron canister address: ${surface.canisterId}`,
  })).toBeVisible();
  await expect(surface.mail.getByRole("button", {
    name: /^(?:Lock|Unlock)(?: private mail)?$/iu,
  })).toHaveCount(0);
}

async function ensurePrivateMailReady(
  page: Page,
  mail: FrameLocator,
): Promise<void> {
  const setup = mail.getByRole("button", { name: "Set up private Mail" }).first();
  const finish = mail.getByRole("button", {
    name: "Finish Mail setup",
    exact: true,
  }).first();
  const ready = mail.getByRole("searchbox", {
    name: "Search this page's mail headers",
  });
  const setupError = mail.getByText("Invalid Mail delivery access value", {
    exact: false,
  });

  await expect.poll(async () => {
    if (await setup.isVisible().catch(() => false)) return "setup";
    if (await finish.isVisible().catch(() => false)) return "finish";
    if (await ready.isVisible().catch(() => false)) return "ready";
    return "loading";
  }, {
    timeout: 45_000,
    message: "Mail reaches setup or ready state",
  }).not.toBe("loading");

  if (await setup.isVisible().catch(() => false)) {
    await setup.click();
    const lifecycle = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
    await expect(lifecycle).toBeVisible();
    await page.locator('[data-tid="vetkeys-lifecycle-approve"]').click();
    await expect(lifecycle).toHaveCount(0);
  } else if (await finish.isVisible().catch(() => false)) {
    await finish.click({ noWaitAfter: true });
  } else {
    return;
  }

  const backendAccess = page.locator('[data-tid="backend-call-dialog"]');
  const setupPending = mail.getByText(
    /^(?:Checking|Finishing) Mail delivery setup…$/u,
  );
  await expect.poll(async () => {
    if (await setupError.isVisible().catch(() => false)) return "error";
    if (await backendAccess.isVisible().catch(() => false)) return "approval";
    if (
      await ready.isVisible().catch(() => false) &&
      !await finish.isVisible().catch(() => false) &&
      !await setupPending.isVisible().catch(() => false)
    ) return "ready";
    return "pending";
  }, {
    timeout: 45_000,
    message: "Mail completes or requests delivery access",
  }).not.toBe("pending");

  if (await setupError.isVisible().catch(() => false)) {
    throw new Error(
      "Installed Mail setup failed: Invalid Mail delivery access value",
    );
  }
  if (await backendAccess.isVisible().catch(() => false)) {
    await page.locator('[data-tid="backend-call-approve"]').click();
    await expect(backendAccess).toHaveCount(0);
  }
  await expect(setupError).toHaveCount(0);
  await expect(finish).toHaveCount(0, { timeout: 45_000 });
  await expect(ready).toBeVisible();
}
