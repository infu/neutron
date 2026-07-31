import { expect, test, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

test("Contacts CRUD is shared with Wallet destination discovery", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await page.goto(localKernelUrl());
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
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-contacts-contacts"]').click();
  const contactsFrame = page.locator(
    'iframe[data-app-id="contacts"][data-tile-id="contacts"]',
  );
  const contacts = page.frameLocator(
    'iframe[data-app-id="contacts"][data-tile-id="contacts"]',
  );
  await expect(contacts.getByRole("button", { name: "Add contact" })).toBeVisible();

  const name = `Contact ${Date.now()}`;
  await contacts.getByRole("button", { name: "Add contact" }).click();
  await contacts.getByRole("textbox", { name: "Name" }).fill(name);
  await contacts.getByRole("button", { name: "Add destination" }).click();
  await contacts
    .getByRole("textbox", { name: "Destination 1 ICRC account" })
    .fill(resolveCanisterId());
  await contacts.getByRole("button", { name: "Save" }).click();
  await expect(contacts.getByRole("heading", { name })).toBeVisible();

  await contactsFrame.evaluate((frame) => {
    frame.style.width = "590px";
    frame.style.right = "auto";
  });
  await expect
    .poll(() =>
      contacts.locator(".contacts-shell").evaluate((shell) => ({
        list: getComputedStyle(shell.querySelector(".contacts-list-pane")!).display,
        detail: getComputedStyle(shell.querySelector(".contacts-detail-pane")!).display,
      })),
    )
    .toEqual({ list: "none", detail: "flex" });

  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-wallet-wallet"]').click();
  const wallet = page.frameLocator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  const walletSetup = wallet.getByRole("searchbox", { name: "Find token ledger" });
  await expect(
    walletSetup.or(wallet.locator(".wallet-token").first()),
  ).toBeVisible();
  if (await walletSetup.isVisible().catch(() => false)) {
    await wallet
      .getByRole("checkbox", { name: /Internet Computer ICP/ })
      .check();
    await wallet.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator('[data-tid="backend-call-dialog"]')).toBeVisible();
    await page.locator('[data-tid="backend-call-approve"]').click();
    await expect(walletSetup).not.toBeVisible();
  }
  const destinationButton = wallet
    .getByRole("button", { name: /^Send / })
    .first();
  await expect(destinationButton).toBeVisible();
  await destinationButton.click();
  await expect(wallet.getByRole("searchbox", { name: "Search contact destinations" }))
    .toBeVisible();

  await wallet.getByRole("button", { name: "Add contact" }).click();
  await expect(page.locator('[data-tid="workspace-tile-dialog"]')).toHaveCount(0);
  await expect(contacts.getByText("New contact", { exact: true })).toBeVisible();
  await expect(contacts.getByText("Person", { exact: true })).toHaveCount(0);
  await expect(contacts.getByText("My addresses", { exact: true })).toHaveCount(0);
  await contacts.getByRole("button", { name: "Cancel" }).click();

  await wallet
    .getByRole("searchbox", { name: "Search contact destinations" })
    .fill(name);
  await expect(wallet.locator(".wallet-destination-row").filter({ hasText: name }))
    .toBeVisible();
  await wallet.getByRole("button", { name: `Send to ${name}` }).click();
  await wallet.getByRole("textbox", { name: "Transfer amount" }).fill("0.001");
  await wallet.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-tid="call-dialog"]')).toContainText(
    "wallet_transfer",
  );
  await page.locator('[data-tid="call-approve"]').click();
  await expect(wallet.getByText("Transfer sent")).toBeVisible();
  await wallet.getByRole("button", { name: "Done" }).click();

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(/\.png$/, "-contacts-wallet.png"),
    });
  }

  await contacts.locator(".contact-row").filter({ hasText: name }).click();
  await contacts.getByRole("button", { name: "Remove contact" }).click();
  await contacts.getByRole("button", { name: "Confirm remove contact" }).click();
  await expect(contacts.getByText(name, { exact: true })).toHaveCount(0);
});

function localKernelUrl(): string {
  const runtime = resolveLocalNeutronRuntime();
  return localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
}

async function openLauncher(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}
