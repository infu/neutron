import {
  expect,
  type BrowserContext,
  type Dialog,
  type Page,
} from "@playwright/test";
import {
  canisterIdFromUrl,
  DEFAULT_LOCAL_HOST,
  scopedLocalIdentityProvider,
} from "neutron-tools/src/runtime.js";

let nextSeedIndex =
  Number(process.env.NEUTRON_E2E_II_SEED_INDEX) ||
  Math.floor(Math.random() * 1_000_000) + 1;

export async function signInWithLocalInternetIdentity({
  page,
  context,
  loginSelector,
  localHost = DEFAULT_LOCAL_HOST,
}: {
  page: Page;
  context: BrowserContext;
  loginSelector: string;
  localHost?: string;
}): Promise<void> {
  const popupPromise = context.waitForEvent("page");
  await page.locator(loginSelector).click();
  const popup = await popupPromise;
  const neutronCanisterId = canisterIdFromUrl(page.url());
  if (!neutronCanisterId) {
    throw new Error("Local Neutron URL does not contain a canister id");
  }
  const expectedIdentityProvider = scopedLocalIdentityProvider({
    neutronCanisterId,
    localHost,
  });
  await expect.poll(() => new URL(popup.url()).origin).toBe(
    new URL(expectedIdentityProvider).origin
  );

  await popup
    .getByRole("button", { name: "Continue with passkey", exact: true })
    .click();
  await popup
    .getByRole("button", { name: "Create new identity", exact: true })
    .click();
  await popup
    .getByPlaceholder("Identity name")
    .fill(`Test ${nextSeedIndex}`);

  const closePromise = popup.waitForEvent("close", { timeout: 30_000 });
  const seedDialogPromise = handleLocalIiSeedDialog({
    popup,
    expectedOrigin: new URL(expectedIdentityProvider).origin,
    seedIndex: String(nextSeedIndex++),
  });
  await popup
    .getByRole("button", { name: "Create identity", exact: true })
    .click();

  await Promise.race([seedDialogPromise, closePromise.then(() => null)]);
  if (!popup.isClosed()) {
    const continueButton = popup.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    const nextStep = await Promise.race([
      closePromise.then(() => "closed" as const),
      continueButton
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "continue" as const),
    ]);
    if (nextStep === "continue") await continueButton.click();
  }
  await closePromise;
}

function handleLocalIiSeedDialog({
  popup,
  expectedOrigin,
  seedIndex,
}: {
  popup: Page;
  expectedOrigin: string;
  seedIndex: string;
}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      popup.off("dialog", onDialog);
      resolve(false);
    }, 5_000);

    async function onDialog(dialog: Dialog): Promise<void> {
      clearTimeout(timeout);
      try {
        expect(new URL(popup.url()).origin).toBe(expectedOrigin);
        expect(dialog.type()).toBe("prompt");
        expect(dialog.message()).toBe("Enter seed index");
        await dialog.accept(seedIndex);
        resolve(true);
      } catch (error) {
        reject(error);
      }
    }

    popup.once("dialog", onDialog);
  });
}
