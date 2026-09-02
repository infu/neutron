import { expect, test, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const PRINCIPAL_ONLY_IC_ACCOUNT = "togwv-zqaaa-aaaal-qr7aa-cai";
const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
// Canonical ICRC text for the same owner with a 32-byte subaccount containing
// 31 zero bytes followed by 0xff.
const SUBACCOUNT_IC_ACCOUNT = "togwv-zqaaa-aaaal-qr7aa-cai-dzl4y5q.ff";

test.describe.configure({ retries: 0 });
test.skip(
  !process.env.NEUTRON_NDEPLOY_CONFIG?.endsWith("all-apps-local.ndeploy.json"),
  "Contacts and Wallet value mutations require the full local fixture",
);

test("Contacts CRUD is shared with Wallet destination discovery", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const runtime = resolveLocalNeutronRuntime();
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
  const editedName = `${name} edited`;
  await contacts.getByRole("button", { name: "Add contact" }).click();
  await contacts.getByRole("textbox", { name: "Name" }).fill(name);
  await contacts.getByRole("button", { name: "Add destination" }).click();
  await contacts
    .getByRole("textbox", { name: "Destination 1 ICRC account" })
    .fill(PRINCIPAL_ONLY_IC_ACCOUNT);
  await contacts.getByRole("button", { name: "Save" }).click();
  await expect(contacts.getByRole("heading", { name })).toBeVisible();

  const contactsDocument = await contactsFrame.elementHandle().then((element) =>
    element?.contentFrame(),
  );
  if (!contactsDocument) throw new Error("Contacts frame is unavailable");
  await contactsDocument.goto(contactsDocument.url());
  await expect(contacts.getByRole("button", { name: "Add contact" })).toBeVisible();
  await contacts.locator(".contact-row").filter({ hasText: name }).click();
  await expect(contacts.getByRole("heading", { name })).toBeVisible();
  await expect(contacts.getByTitle(PRINCIPAL_ONLY_IC_ACCOUNT)).toBeVisible();

  await contacts.getByRole("button", { name: "Edit contact" }).click();
  await contacts.getByRole("textbox", { name: "Name" }).fill(editedName);
  const accountEditor = contacts.getByRole("textbox", {
    name: "Destination 1 ICRC account",
  });
  await expect(accountEditor).toHaveValue(PRINCIPAL_ONLY_IC_ACCOUNT);
  await accountEditor.fill(SUBACCOUNT_IC_ACCOUNT);
  await contacts.getByRole("button", { name: "Save" }).click();
  await expect(contacts.getByRole("heading", { name: editedName })).toBeVisible();
  await expect(contacts.getByTitle(SUBACCOUNT_IC_ACCOUNT)).toBeVisible();

  await contactsDocument.goto(contactsDocument.url());
  await expect(contacts.getByRole("button", { name: "Add contact" })).toBeVisible();
  await contacts.locator(".contact-row").filter({ hasText: editedName }).click();
  await expect(contacts.getByRole("heading", { name: editedName })).toBeVisible();
  await expect(contacts.getByTitle(SUBACCOUNT_IC_ACCOUNT)).toBeVisible();
  await contacts.getByRole("button", { name: "Edit contact" }).click();
  await expect(
    contacts.getByRole("textbox", { name: "Destination 1 ICRC account" }),
  ).toHaveValue(SUBACCOUNT_IC_ACCOUNT);
  await contacts.getByRole("button", { name: "Cancel" }).click();

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
  const icpToken = wallet.locator(
    `article.wallet-token[data-ledger="${ICP_LEDGER}"]`,
  );
  const icpDetails = icpToken.locator(".wallet-token-balance");
  const icpBalance = icpDetails.locator("strong");
  await expect(icpToken).toBeVisible();
  await wallet
    .getByRole("button", { name: "Refresh token metadata" })
    .click();
  await expect(icpDetails).toHaveAttribute("title", /Fee /, {
    timeout: 120_000,
  });
  await wallet.getByRole("button", { name: "Refresh balances" }).click();
  await expect(icpBalance).not.toHaveText("-", { timeout: 120_000 });
  await expect(
    page.locator('[data-tid="backend-call-dialog"]'),
  ).toHaveCount(0);
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
    .fill(editedName);
  const walletDestination = wallet
    .locator(".wallet-destination-row")
    .filter({ hasText: editedName });
  await expect(walletDestination).toBeVisible();
  await expect(walletDestination.getByTitle(SUBACCOUNT_IC_ACCOUNT)).toBeVisible();
  await wallet.getByRole("button", { name: `Send to ${editedName}` }).click();
  await wallet.getByRole("textbox", { name: "Transfer amount" }).fill("0.001");
  await wallet.getByRole("button", { name: "Send", exact: true }).click();
  await expect(wallet.getByText("Transfer sent")).toBeVisible();
  await expect(page.locator('[data-tid="call-dialog"]')).toHaveCount(0);
  await wallet.getByRole("button", { name: "Done" }).click();

  if (process.env.NEUTRON_E2E_SCREENSHOT) {
    await page.screenshot({
      path: process.env.NEUTRON_E2E_SCREENSHOT.replace(/\.png$/, "-contacts-wallet.png"),
    });
  }

  await contacts.locator(".contact-row").filter({ hasText: editedName }).click();
  await contacts.getByRole("button", { name: "Remove contact" }).click();
  await contacts.getByRole("button", { name: "Confirm remove contact" }).click();
  await expect(contacts.getByText(editedName, { exact: true })).toHaveCount(0);
  await contactsDocument.goto(contactsDocument.url());
  await expect(contacts.getByRole("button", { name: "Add contact" })).toBeVisible();
  await contacts.getByRole("searchbox", { name: "Search contacts" }).fill(editedName);
  await expect(
    contacts.locator(".contact-row").filter({ hasText: editedName }),
  ).toHaveCount(0);
});

async function openLauncher(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}
