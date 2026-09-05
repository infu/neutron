import { expect, test, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const FIRST_CUSTOM_LEDGER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const SECOND_CUSTOM_LEDGER = "rwlgt-iiaaa-aaaaa-aaaaa-cai";

test("Wallet uses icon views and custom-ledger entry stays sandbox-safe", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  const sandboxErrors: string[] = [];
  page.on("console", (message) => {
    if (/Blocked form submission/i.test(message.text())) {
      sandboxErrors.push(message.text());
    }
  });

  await page.goto(
    localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl),
  );
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

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-wallet-wallet"]').click();
  const walletFrame = page.locator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  await expect(walletFrame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  await expect(walletFrame).toHaveAttribute("credentialless", "true");
  const wallet = page.frameLocator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  await expect(wallet.locator(".wallet-shell")).toBeVisible();
  const viewSwitch = wallet.locator(".wallet-view-switch");
  const viewButtons = viewSwitch.locator(".wallet-view-button");
  await expect(viewButtons).toHaveCount(3);
  expect(await viewButtons.allTextContents()).toEqual(["", "", ""]);
  for (const label of ["Assets", "Activity", "Approvals"]) {
    const button = viewSwitch.getByRole("button", { name: label, exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator("svg")).toBeVisible();
  }

  const setupSearch = wallet.getByRole("searchbox", {
    name: "Find token ledger",
  });
  if (!(await setupSearch.isVisible().catch(() => false))) {
    await wallet
      .getByRole("button", { name: "Choose token ledgers" })
      .click();
  }
  await expect(setupSearch).toBeVisible();

  await wallet
    .getByRole("button", { name: "Add custom ledger", exact: true })
    .click();
  const input = wallet.getByRole("textbox", {
    name: "Custom ledger canister ID",
  });
  await input.fill(FIRST_CUSTOM_LEDGER);
  await wallet.getByRole("button", { name: "Add", exact: true }).click();
  await expect(wallet.locator(`[title="${FIRST_CUSTOM_LEDGER}"]`)).toBeVisible();

  await wallet
    .getByRole("button", { name: "Add custom ledger", exact: true })
    .click();
  await input.fill(SECOND_CUSTOM_LEDGER);
  await input.press("Enter");
  await expect(wallet.locator(`[title="${SECOND_CUSTOM_LEDGER}"]`)).toBeVisible();
  expect(sandboxErrors).toEqual([]);
});

async function openLauncher(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}
