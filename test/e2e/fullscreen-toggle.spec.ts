import { expect, test } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

test("the topbar fullscreen control enters, exits, and follows browser state", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
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

  const toggle = page.locator('[data-tid="fullscreen-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-label", "Full screen");
  await expect(toggle).toHaveAttribute("title", "Enter full screen");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(
    await toggle.evaluate(
      (button) =>
        button.nextElementSibling?.classList.contains("app-tray") ?? false,
    ),
  ).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Exit full screen");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () => document.fullscreenElement === document.documentElement,
    ),
  ).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Enter full screen");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("title", "Exit full screen");
  await page.evaluate(() => document.exitFullscreen());
  await expect(toggle).toHaveAttribute("title", "Enter full screen");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
