import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import {
  ICP_LEDGER,
  ICP_SWAP_AMOUNT_ATOMS,
  ICP_SWAP_AMOUNT_DISPLAY,
  NEUTRINITE_GOVERNANCE,
} from "../../apps/kitchensink/src/wallet_funding_demo.ts";
import { localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";

type IcrcAccount = {
  owner: Principal;
  subaccount: [] | [Uint8Array];
};

type IcpLedger = {
  icrc1_balance_of: ActorMethod<[IcrcAccount], bigint>;
  icrc1_fee: ActorMethod<[], bigint>;
  icrc2_allowance: ActorMethod<[
    { account: IcrcAccount; spender: IcrcAccount },
  ], { allowance: bigint; expires_at: [] | [bigint] }>;
};

type KernelDialogAudit = {
  seen: string[];
};

type WalletFundingKind = "direct" | "allowance";

const KERNEL_DIALOG_SELECTOR = [
  '[data-tid="frontend-tool-dialog"]',
  '[data-tid="call-dialog"]',
  '[data-tid="backend-call-dialog"]',
].join(", ");

test("Kitchen Sink funds governance with one Wallet decision and no Kernel dialog", async ({
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
  await expect(
    page.locator('[data-tid="app-background-frame"][data-app-id="wallet"]'),
  ).toHaveCount(1);

  await openKitchenSink(page);
  const kitchen = page.frameLocator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  );
  await expect(kitchen.locator('[data-tid="kitchen-tile-main"]')).toBeVisible();
  await kitchen.locator('[data-tid="kitchen-nav-wallet_funding"]').click();
  await expect(
    kitchen.locator('[data-tid="kitchen-demo-wallet_funding"]'),
  ).toBeVisible();

  const ledger = await createIcpLedgerActor();
  const fee = await ledger.icrc1_fee();
  const amount = BigInt(ICP_SWAP_AMOUNT_ATOMS);
  const source = account(runtime.canisterId);
  const governance = account(NEUTRINITE_GOVERNANCE);

  const rejectedDirectSource = await ledger.icrc1_balance_of(source);
  const rejectedDirectGovernance = await ledger.icrc1_balance_of(governance);
  await runWalletAction({
    page,
    kitchen,
    kind: "direct",
    buttonName: `Transfer ${ICP_SWAP_AMOUNT_DISPLAY}`,
    expectedStatus: "rejected",
    decision: "reject",
  });
  expect(await ledger.icrc1_balance_of(source)).toBe(rejectedDirectSource);
  expect(await ledger.icrc1_balance_of(governance)).toBe(
    rejectedDirectGovernance,
  );

  const directSourceBefore = await ledger.icrc1_balance_of(source);
  const directGovernanceBefore = await ledger.icrc1_balance_of(governance);
  await runWalletAction({
    page,
    kitchen,
    kind: "direct",
    buttonName: `Transfer ${ICP_SWAP_AMOUNT_DISPLAY}`,
    expectedStatus: "transferred",
  });
  expect(await ledger.icrc1_balance_of(source)).toBe(
    directSourceBefore - amount - fee,
  );
  expect(await ledger.icrc1_balance_of(governance)).toBe(
    directGovernanceBefore + amount,
  );

  const rejectedAllowanceSource = await ledger.icrc1_balance_of(source);
  const rejectedAllowanceGovernance = await ledger.icrc1_balance_of(governance);
  const rejectedAllowance = await ledger.icrc2_allowance({
    account: source,
    spender: governance,
  });
  await runWalletAction({
    page,
    kitchen,
    kind: "allowance",
    buttonName: `Approve ${ICP_SWAP_AMOUNT_DISPLAY} swap funding`,
    expectedStatus: "rejected",
    decision: "reject",
  });
  expect(await ledger.icrc1_balance_of(source)).toBe(rejectedAllowanceSource);
  expect(await ledger.icrc1_balance_of(governance)).toBe(
    rejectedAllowanceGovernance,
  );
  expect(
    await ledger.icrc2_allowance({ account: source, spender: governance }),
  ).toEqual(rejectedAllowance);

  const allowanceSourceBefore = await ledger.icrc1_balance_of(source);
  const allowanceGovernanceBefore = await ledger.icrc1_balance_of(governance);
  const allowanceStartedNs = BigInt(Date.now()) * 1_000_000n;
  await runWalletAction({
    page,
    kitchen,
    kind: "allowance",
    buttonName: `Approve ${ICP_SWAP_AMOUNT_DISPLAY} swap funding`,
    expectedStatus: "approved",
  });
  expect(await ledger.icrc1_balance_of(source)).toBe(
    allowanceSourceBefore - fee,
  );
  expect(await ledger.icrc1_balance_of(governance)).toBe(
    allowanceGovernanceBefore,
  );
  const allowance = await ledger.icrc2_allowance({
    account: source,
    spender: governance,
  });
  expect(allowance.allowance).toBe(amount + fee);
  expect(allowance.expires_at).toHaveLength(1);
  expect(allowance.expires_at[0]).toBeGreaterThan(allowanceStartedNs);
  expect(allowance.expires_at[0]).toBeLessThanOrEqual(
    allowanceStartedNs + 6n * 60_000_000_000n,
  );
});

async function runWalletAction({
  page,
  kitchen,
  kind,
  buttonName,
  expectedStatus,
  decision = "accept",
}: {
  page: Page;
  kitchen: FrameLocator;
  kind: WalletFundingKind;
  buttonName: string;
  expectedStatus: "transferred" | "approved" | "rejected";
  decision?: "accept" | "reject";
}): Promise<void> {
  await startKernelDialogAudit(page);
  const kitchenFrame = page.locator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  );
  await kitchenFrame.focus();
  await expect(kitchenFrame).toBeFocused();
  await kitchen.getByRole("button", { name: buttonName, exact: true }).click();

  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  await expect(
    page.locator('iframe[data-app-id="wallet"][data-tile-id="wallet"]'),
  ).toHaveCount(1);
  const wallet = page.frameLocator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  const dialog = wallet.locator('[data-tid="wallet-funding-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toContainText("Request from kitchensink");
  await expect(dialog).toContainText("Internet Computer");
  await expect(dialog).toContainText("ICP");
  await expect(dialog.getByText(ICP_LEDGER, { exact: true })).toHaveCount(1);
  await expect(
    dialog.getByText(NEUTRINITE_GOVERNANCE, { exact: true }),
  ).toHaveCount(1);
  await expect(dialog).toContainText(
    kind === "direct"
      ? `Send ${ICP_SWAP_AMOUNT_DISPLAY}`
      : `Approve ${ICP_SWAP_AMOUNT_DISPLAY} allowance`,
  );
  await expect(dialog).toContainText(kind === "direct" ? "Recipient" : "Spender");
  await expect(dialog).toContainText("Command ID");
  await expect(dialog).toContainText(`${ICP_SWAP_AMOUNT_ATOMS} atoms`);
  if (kind === "direct") {
    await expect(dialog).toContainText("Ledger fee");
    await expect(dialog).toContainText("Maximum debit");
  } else {
    for (const detail of [
      "Current allowance",
      "New allowance",
      "Approval fee",
      "Transfer-from fee",
      "Current expiration",
      "New expiration",
      "Maximum source debit",
    ]) {
      await expect(dialog).toContainText(detail);
    }
  }
  const accept = wallet.locator('[data-tid="wallet-funding-accept"]');
  await expect(accept).toHaveCount(1);
  await expect(accept).toHaveText(
    kind === "direct" ? "Send" : "Approve allowance",
  );
  const reject = wallet.locator('[data-tid="wallet-funding-reject"]');
  await expect(reject).toHaveText("Cancel");
  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  await (decision === "accept" ? accept : reject).click();

  await expect(
    kitchen.locator('[data-tid="wallet-funding-result"]'),
  ).toContainText(`"status": "${expectedStatus}"`, { timeout: 120_000 });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  expect((await stopKernelDialogAudit(page)).seen).toEqual([]);
}

async function openKitchenSink(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
}

async function createIcpLedgerActor(): Promise<ActorSubclass<IcpLedger>> {
  const runtime = resolveLocalNeutronRuntime();
  const agent = await HttpAgent.create({
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    verifyQuerySignatures: false,
  });
  await agent.fetchRootKey();
  return Actor.createActor<IcpLedger>(icpLedgerIdl, {
    agent,
    canisterId: ICP_LEDGER,
  });
}

function account(owner: string): IcrcAccount {
  return { owner: Principal.fromText(owner), subaccount: [] };
}

async function startKernelDialogAudit(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const scope = globalThis as typeof globalThis & {
      __NEUTRON_KERNEL_DIALOG_AUDIT__?: {
        observer: MutationObserver;
        seen: Set<string>;
      };
    };
    scope.__NEUTRON_KERNEL_DIALOG_AUDIT__?.observer.disconnect();
    const seen = new Set<string>();
    const observe = () => {
      document
        .querySelectorAll<HTMLElement>(selector)
        .forEach((dialog) => {
          seen.add(dialog.dataset.tid ?? "unlabelled");
        });
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.body, { childList: true, subtree: true });
    scope.__NEUTRON_KERNEL_DIALOG_AUDIT__ = { observer, seen };
    observe();
  }, KERNEL_DIALOG_SELECTOR);
}

async function stopKernelDialogAudit(page: Page): Promise<KernelDialogAudit> {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __NEUTRON_KERNEL_DIALOG_AUDIT__?: {
        observer: MutationObserver;
        seen: Set<string>;
      };
    };
    const audit = scope.__NEUTRON_KERNEL_DIALOG_AUDIT__;
    if (!audit) throw new Error("Kernel dialog audit was not started");
    audit.observer.disconnect();
    delete scope.__NEUTRON_KERNEL_DIALOG_AUDIT__;
    return { seen: Array.from(audit.seen) };
  });
}

const icpLedgerIdl: IDL.InterfaceFactory = ({ IDL: FactoryIDL }) => {
  const accountType = FactoryIDL.Record({
    owner: FactoryIDL.Principal,
    subaccount: FactoryIDL.Opt(FactoryIDL.Vec(FactoryIDL.Nat8)),
  });
  return FactoryIDL.Service({
    icrc1_balance_of: FactoryIDL.Func(
      [accountType],
      [FactoryIDL.Nat],
      ["query"],
    ),
    icrc1_fee: FactoryIDL.Func([], [FactoryIDL.Nat], ["query"]),
    icrc2_allowance: FactoryIDL.Func(
      [FactoryIDL.Record({ account: accountType, spender: accountType })],
      [FactoryIDL.Record({
        allowance: FactoryIDL.Nat,
        expires_at: FactoryIDL.Opt(FactoryIDL.Nat64),
      })],
      ["query"],
    ),
  });
};
