import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
} from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import {
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  ICP_LEDGER,
  ICP_SWAP_AMOUNT_ATOMS,
  ICP_SWAP_AMOUNT_DISPLAY,
  NEUTRINITE_GOVERNANCE,
  type WalletFundingDemoKind,
} from "../../apps/kitchensink/src/wallet_funding_demo.ts";
import { formatTokenAmount } from "../../apps/wallet/src/format.ts";
import { defaultIcpAccountIdentifier } from "../../packages/neutron-provision/src/ic_client.ts";
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

type WalletFrameReuseAudit = {
  established: boolean;
  marker: string;
};

const KERNEL_DIALOG_SELECTOR = [
  '[data-tid="frontend-tool-dialog"]',
  '[data-tid="call-dialog"]',
  '[data-tid="backend-call-dialog"]',
  '[data-tid="workspace-tile-dialog"]',
].join(", ");

test.describe.configure({ retries: 0 });
test.skip(
  !process.env.NEUTRON_NDEPLOY_CONFIG?.endsWith("all-apps-local.ndeploy.json"),
  "Wallet funding mutates the full local ICP fixture",
);

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
  ).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  await expect(
    page.locator(
      '[data-tid="app-background-frame"][data-app-id="kitchensink"]',
    ),
  ).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });

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
  const walletReuse: WalletFrameReuseAudit = {
    established: false,
    marker: `wallet-reuse-${Date.now()}-${Math.random()}`,
  };

  const rejectedDirectSource = await ledger.icrc1_balance_of(source);
  const rejectedDirectGovernance = await ledger.icrc1_balance_of(governance);
  await runWalletAction({
    page,
    kitchen,
    kind: "direct",
    buttonName: `Transfer ${ICP_SWAP_AMOUNT_DISPLAY}`,
    expectedStatus: "rejected",
    decision: "reject",
    feeAtoms: fee,
    walletReuse,
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
    feeAtoms: fee,
    walletReuse,
  });
  expect(await ledger.icrc1_balance_of(source)).toBe(
    directSourceBefore - amount - fee,
  );
  expect(await ledger.icrc1_balance_of(governance)).toBe(
    directGovernanceBefore + amount,
  );

  // The direct checks may take most of the request lifetime. This deliberate,
  // warned action proves the fixture never rotates an unused allowance by time.
  await startKernelDialogAudit(page);
  const discardAllowance = kitchen.locator(
    '[data-tid="wallet-funding-discard-allowance"]',
  );
  await expect(discardAllowance).toBeEnabled();
  await discardAllowance.click();
  await expect(
    kitchen.locator('[data-tid="wallet-funding-result"]'),
  ).toContainText('"status": "replaced"');
  expect((await stopKernelDialogAudit(page)).seen).toEqual([]);

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
    feeAtoms: fee,
    currentAllowance: rejectedAllowance,
    walletReuse,
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
    feeAtoms: fee,
    currentAllowance: rejectedAllowance,
    walletReuse,
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
  await revokeGovernanceAllowance({
    page,
    kitchen,
    wallet: page.frameLocator(
      'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
    ),
    ledger,
    source,
    governance,
    fee,
    expectedExpirationNs: allowance.expires_at[0]!.toString(),
    walletReuse,
  });
});

async function runWalletAction({
  page,
  kitchen,
  kind,
  buttonName,
  expectedStatus,
  decision = "accept",
  feeAtoms,
  currentAllowance,
  walletReuse,
}: {
  page: Page;
  kitchen: FrameLocator;
  kind: WalletFundingDemoKind;
  buttonName: string;
  expectedStatus: "transferred" | "approved" | "rejected";
  decision?: "accept" | "reject";
  feeAtoms: bigint;
  currentAllowance?: { allowance: bigint; expires_at: [] | [bigint] };
  walletReuse: WalletFrameReuseAudit;
}): Promise<void> {
  await startKernelDialogAudit(page);
  const kitchenFrame = page.locator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  );
  const walletFrame = page.locator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  if (walletReuse.established) {
    await expect(walletFrame).toHaveCount(1);
    await expect(walletFrame).toHaveAttribute(
      "data-wallet-reuse-marker",
      walletReuse.marker,
    );
  } else if (await walletFrame.count() === 1) {
    await walletFrame.evaluate((frame, marker) => {
      frame.dataset.walletReuseMarker = marker;
    }, walletReuse.marker);
    walletReuse.established = true;
  }
  await kitchen.getByRole("button", { name: buttonName, exact: true }).click();

  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  await expect(walletFrame).toHaveCount(1);
  await expect(walletFrame).toBeFocused();
  if (!walletReuse.established) {
    await walletFrame.evaluate((frame, marker) => {
      frame.dataset.walletReuseMarker = marker;
    }, walletReuse.marker);
    walletReuse.established = true;
  }
  await expect(walletFrame).toHaveAttribute(
    "data-wallet-reuse-marker",
    walletReuse.marker,
  );
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
    await expectFundingRow(dialog, "Ledger fee", feeAtoms);
    await expectFundingRow(
      dialog,
      "Maximum debit",
      BigInt(ICP_SWAP_AMOUNT_ATOMS) + feeAtoms,
    );
  } else {
    if (!currentAllowance) {
      throw new Error("Allowance review requires the live current allowance");
    }
    for (const detail of [
      "Requested amount",
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
    await expectFundingRow(
      dialog,
      "Requested amount",
      BigInt(ICP_SWAP_AMOUNT_ATOMS),
    );
    await expectFundingRow(
      dialog,
      "Current allowance",
      currentAllowance.allowance,
    );
    await expectFundingRow(
      dialog,
      "New allowance",
      BigInt(ICP_SWAP_AMOUNT_ATOMS) + feeAtoms,
    );
    await expectFundingRow(dialog, "Approval fee", feeAtoms);
    await expectFundingRow(dialog, "Transfer-from fee", feeAtoms);
    await expectFundingRow(
      dialog,
      "Maximum source debit",
      BigInt(ICP_SWAP_AMOUNT_ATOMS) + feeAtoms * 2n,
    );
    if (currentAllowance.expires_at.length === 0) {
      await expect(fundingRow(dialog, "Current expiration")).toHaveText(
        "No expiration",
      );
    } else {
      await expect(fundingRow(dialog, "Current expiration")).not.toHaveText(
        "No expiration",
      );
    }
    await expect(fundingRow(dialog, "New expiration")).not.toHaveText(
      "No expiration",
    );
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
  await expect(walletFrame).not.toBeFocused();
  await expect(kitchenFrame).not.toBeFocused();
  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  expect((await stopKernelDialogAudit(page)).seen).toEqual([]);
}

function fundingRow(dialog: Locator, label: string): Locator {
  return dialog
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::dd");
}

async function expectFundingRow(
  dialog: Locator,
  label: string,
  atoms: bigint,
): Promise<void> {
  const row = fundingRow(dialog, label);
  await expect(row).toContainText(`${formatTokenAmount(atoms.toString(), 8)} ICP`);
  await expect(row.locator("small")).toHaveText(`${atoms} atoms`);
}

async function revokeGovernanceAllowance({
  page,
  kitchen,
  wallet,
  ledger,
  source,
  governance,
  fee,
  expectedExpirationNs,
  walletReuse,
}: {
  page: Page;
  kitchen: FrameLocator;
  wallet: FrameLocator;
  ledger: ActorSubclass<IcpLedger>;
  source: IcrcAccount;
  governance: IcrcAccount;
  fee: bigint;
  expectedExpirationNs: string;
  walletReuse: WalletFrameReuseAudit;
}): Promise<void> {
  const walletFrame = page.locator(
    'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
  );
  await expect(walletFrame).toHaveCount(1);
  await expect(walletFrame).toHaveAttribute(
    "data-wallet-reuse-marker",
    walletReuse.marker,
  );
  const setupSearch = wallet.getByRole("searchbox", {
    name: "Find token ledger",
  });
  if (!(await setupSearch.isVisible().catch(() => false))) {
    await wallet.getByRole("button", { name: "Choose token ledgers" }).click();
  }
  await expect(setupSearch).toBeVisible();
  const icp = wallet.getByRole("checkbox", { name: /Internet Computer ICP/u });
  await expect(icp).toBeVisible();
  if (await icp.isChecked()) {
    await wallet.getByRole("button", { name: "Cancel", exact: true }).click();
  } else {
    await icp.check();
    await wallet.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page.locator('[data-tid="backend-call-dialog"]')).toBeVisible();
    await page.locator('[data-tid="backend-call-approve"]').click();
    await expect(setupSearch).not.toBeVisible();
  }

  await startKernelDialogAudit(page);
  await page.locator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  ).focus();
  await kitchen.getByRole("button", { name: "Open Wallet approvals" }).click();
  await expect(walletFrame).toBeFocused();
  await expect(walletFrame).toHaveAttribute(
    "data-wallet-reuse-marker",
    walletReuse.marker,
  );
  const approvals = wallet.getByRole("region", { name: "Token approvals" });
  await expect(approvals).toBeVisible();
  const spenderIdentifier = defaultIcpAccountIdentifier(
    Principal.fromText(NEUTRINITE_GOVERNANCE),
  );
  const entry = approvals.locator(".wallet-approval-entry").filter({
    has: wallet.locator(`[title="${spenderIdentifier}"]`),
  });
  await expect(entry).toHaveCount(1, { timeout: 120_000 });
  await expect(
    approvals.locator('[aria-label="Loading approvals"]'),
  ).toHaveCount(0, { timeout: 120_000 });
  await expect(
    approvals.locator(".wallet-activity-state").filter({
      hasText: "Refreshing live approvals",
    }),
  ).toHaveCount(0, { timeout: 120_000 });
  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  expect((await stopKernelDialogAudit(page)).seen).toEqual([]);
  await expect(entry.locator(".wallet-activity-value strong")).toHaveText(
    formatTokenAmount(
      (BigInt(ICP_SWAP_AMOUNT_ATOMS) + fee).toString(),
      8,
    ),
  );
  await entry.locator(".wallet-activity-row").click();
  await expect(fundingRow(entry, "Allowance atoms")).toHaveText(
    (BigInt(ICP_SWAP_AMOUNT_ATOMS) + fee).toString(),
  );
  await expect(fundingRow(entry, "Expiration (ns)")).toHaveText(
    expectedExpirationNs,
  );
  await expect(fundingRow(entry, "Revoke fee")).toHaveText(
    `${formatTokenAmount(fee.toString(), 8)} ICP (${fee} atoms)`,
  );

  const sourceBeforeRevoke = await ledger.icrc1_balance_of(source);
  const governanceBeforeRevoke = await ledger.icrc1_balance_of(governance);
  await startKernelDialogAudit(page);
  await entry.getByRole("button", { name: "Revoke ICP approval" }).click();
  await expect.poll(async () => (await ledger.icrc2_allowance({
    account: source,
    spender: governance,
  })).allowance, { timeout: 120_000 }).toBe(0n);
  await expect.poll(
    () => ledger.icrc1_balance_of(source),
    { timeout: 120_000 },
  ).toBe(sourceBeforeRevoke - fee);
  await expect.poll(
    () => ledger.icrc1_balance_of(governance),
    { timeout: 120_000 },
  ).toBe(governanceBeforeRevoke);
  await expect(entry).toHaveCount(0);
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
        selector: string;
      };
    };
    scope.__NEUTRON_KERNEL_DIALOG_AUDIT__?.observer.disconnect();
    const seen = new Set<string>();
    const record = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) {
        seen.add((node as HTMLElement).dataset.tid ?? "unlabelled");
      }
      node.querySelectorAll<HTMLElement>(selector).forEach((dialog) => {
        seen.add(dialog.dataset.tid ?? "unlabelled");
      });
    };
    const observer = new MutationObserver((records) => {
      records.forEach((mutation) => mutation.addedNodes.forEach(record));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scope.__NEUTRON_KERNEL_DIALOG_AUDIT__ = { observer, seen, selector };
    document.querySelectorAll<HTMLElement>(selector).forEach((dialog) => {
      seen.add(dialog.dataset.tid ?? "unlabelled");
    });
  }, KERNEL_DIALOG_SELECTOR);
}

async function stopKernelDialogAudit(page: Page): Promise<KernelDialogAudit> {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __NEUTRON_KERNEL_DIALOG_AUDIT__?: {
        observer: MutationObserver;
        seen: Set<string>;
        selector: string;
      };
    };
    const audit = scope.__NEUTRON_KERNEL_DIALOG_AUDIT__;
    if (!audit) throw new Error("Kernel dialog audit was not started");
    audit.observer.takeRecords().forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches(audit.selector)) {
          audit.seen.add(
            (node as HTMLElement).dataset.tid ?? "unlabelled",
          );
        }
        node.querySelectorAll<HTMLElement>(audit.selector).forEach((dialog) => {
          audit.seen.add(dialog.dataset.tid ?? "unlabelled");
        });
      });
    });
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
