import { Actor, HttpAgent, type ActorMethod } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { expect, test, type Page, type Route } from "@playwright/test";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { localIdentityFromSeed } from "../../packages/neutron-provision/src/kernel.ts";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const TARGET = "eqsml-lyaaa-aaaaq-aacdq-cai";
const AMOUNT = 1n;
const KERNEL_DIALOG_SELECTOR = [
  '[data-tid="frontend-tool-dialog"]',
  '[data-tid="call-dialog"]',
  '[data-tid="backend-call-dialog"]',
  '[data-tid="workspace-tile-dialog"]',
].join(", ");

// The per-page bundle is a deterministic caller fixture. Kernel, Wallet, the
// Wallet backend, and the ICP ledger remain the installed artifacts under test;
// this spec does not claim that the intercepted Kitchen Sink JS is release
// evidence for Kitchen Sink itself.

type IcrcAccount = {
  owner: Principal;
  subaccount: [] | [Uint8Array];
};

type IcpLedger = {
  icrc1_balance_of: ActorMethod<[IcrcAccount], bigint>;
  icrc1_fee: ActorMethod<[], bigint>;
};

test.describe.configure({ retries: 0 });
test.skip(
  !process.env.NEUTRON_NDEPLOY_CONFIG?.endsWith("all-apps-local.ndeploy.json"),
  "Wallet root-agent funding mutates the full local ICP fixture",
);

test("only a direct root Agent funds through Wallet without UI", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await installHarnessRoute(page);
  const runtime = resolveLocalNeutronRuntime();
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await localLogin(page, runtime.developerIdentitySeed,
    runtime.developerIdentityPrincipal);
  for (const appId of ["wallet", "kitchensink"]) {
    await expect(page.locator(
      `[data-tid="app-background-frame"][data-app-id="${appId}"]`,
    )).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }

  await openKitchenSink(page);
  const kitchenFrame = page.locator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  );
  const kitchen = page.frameLocator(
    'iframe[data-app-id="kitchensink"][data-tile-id="main"]',
  );
  await expect(kitchen.locator('[data-tid="wallet-root-harness"]')).toBeVisible();
  await expect(
    page.locator('iframe[data-app-id="wallet"][data-tile-id="wallet"]'),
  ).toHaveCount(0);

  await kitchenFrame.focus();
  await kitchen.locator('[data-tid="agent-enable"]').click();
  const grant = page.locator('[data-tid="agent-grant-dialog"]');
  await expect(grant).toContainText("kitchensink");
  await expect(grant).toContainText("capability_agent_demo");
  await grant.locator('[data-tid="agent-grant-approve"]').click();
  await expect(page.locator('[data-tid="agent-mode-indicator"]')).toBeVisible();
  await expectHarnessResult(kitchen, "agent-enable", "success");

  const ledger = await createIcpLedger();
  const fee = await ledger.icrc1_fee();
  const source = account(runtime.canisterId);
  const target = account(TARGET);
  await startUiAudit(page);

  const humanSource = await ledger.icrc1_balance_of(source);
  const humanTarget = await ledger.icrc1_balance_of(target);
  await kitchenFrame.focus();
  await kitchen.locator('[data-tid="wallet-root-human"]').click();
  const humanError = await expectHarnessResult(
    kitchen,
    "wallet-root-human",
    "error",
  );
  expect(humanError).toContain("wallet_fund_root_v1");
  expect(await ledger.icrc1_balance_of(source)).toBe(humanSource);
  expect(await ledger.icrc1_balance_of(target)).toBe(humanTarget);

  const nestedSource = await ledger.icrc1_balance_of(source);
  const nestedTarget = await ledger.icrc1_balance_of(target);
  await kitchenFrame.focus();
  await kitchen.locator('[data-tid="wallet-root-nested"]').click();
  const nestedError = await expectHarnessResult(
    kitchen,
    "wallet-root-nested",
    "error",
  );
  expect(nestedError).toContain("wallet_fund_root_v1");
  expect(await ledger.icrc1_balance_of(source)).toBe(nestedSource);
  expect(await ledger.icrc1_balance_of(target)).toBe(nestedTarget);

  const directSource = await ledger.icrc1_balance_of(source);
  const directTarget = await ledger.icrc1_balance_of(target);
  await kitchenFrame.focus();
  await kitchen.locator('[data-tid="wallet-root-direct"]').click();
  const directResult = JSON.parse(await expectHarnessResult(
    kitchen,
    "wallet-root-direct",
    "success",
  )) as { status?: unknown };
  expect(directResult.status).toBe("transferred");
  await expect.poll(
    () => ledger.icrc1_balance_of(source),
    { timeout: 120_000 },
  ).toBe(directSource - AMOUNT - fee);
  await expect.poll(
    () => ledger.icrc1_balance_of(target),
    { timeout: 120_000 },
  ).toBe(directTarget + AMOUNT);

  expect(await stopUiAudit(page)).toEqual([]);
  await expect(page.locator(KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
  await expect(
    page.locator('iframe[data-app-id="wallet"][data-tile-id="wallet"]'),
  ).toHaveCount(0);
});

async function installHarnessRoute(page: Page): Promise<void> {
  const fixture = fileURLToPath(
    new URL("./fixtures/wallet-root-agent-harness.ts", import.meta.url),
  );
  const build = await esbuild.build({
    absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
    bundle: true,
    entryPoints: [fixture],
    format: "esm",
    minify: true,
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const source = build.outputFiles?.[0]?.text;
  if (!source) throw new Error("Wallet root-agent E2E harness did not build");
  await page.route(
    /\/app\/kitchensink\/(?:main|service)\.js(?:\?.*)?$/u,
    (route: Route) => route.fulfill({
      body: source,
      contentType: "text/javascript; charset=utf-8",
      status: 200,
    }),
  );
}

async function localLogin(
  page: Page,
  identitySeed: number,
  expectedPrincipal: string,
): Promise<void> {
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await page.waitForFunction(
    () => typeof (
      window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function",
  );
  const principal = await page.evaluate(async (seed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    return login(seed);
  }, identitySeed);
  expect(principal).toBe(expectedPrincipal);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
}

async function openKitchenSink(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-kitchensink-main"]').click();
}

async function expectHarnessResult(
  kitchen: ReturnType<Page["frameLocator"]>,
  action: string,
  status: "success" | "error",
): Promise<string> {
  const result = kitchen.locator('[data-tid="wallet-root-result"]');
  await expect(result).toHaveAttribute("data-action", action, {
    timeout: 180_000,
  });
  await expect(result).toHaveAttribute("data-status", status, {
    timeout: 180_000,
  });
  return result.innerText();
}

async function createIcpLedger(): Promise<IcpLedger> {
  const runtime = resolveLocalNeutronRuntime();
  const agent = await HttpAgent.create({
    host: runtime.gatewayUrl,
    identity: localIdentityFromSeed(runtime.developerIdentitySeed),
    verifyQuerySignatures: false,
  });
  await agent.fetchRootKey();
  const accountType = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  return Actor.createActor<IcpLedger>(
    ({ IDL }) => IDL.Service({
      icrc1_balance_of: IDL.Func([accountType], [IDL.Nat], ["query"]),
      icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    }),
    { agent, canisterId: ICP_LEDGER },
  );
}

function account(owner: string): IcrcAccount {
  return { owner: Principal.fromText(owner), subaccount: [] };
}

async function startUiAudit(page: Page): Promise<void> {
  await page.evaluate((dialogSelector) => {
    const scope = globalThis as typeof globalThis & {
      __NEUTRON_WALLET_ROOT_UI_AUDIT__?: {
        observer: MutationObserver;
        record: (records?: MutationRecord[]) => void;
        seen: Set<string>;
      };
    };
    scope.__NEUTRON_WALLET_ROOT_UI_AUDIT__?.observer.disconnect();
    const seen = new Set<string>();
    const inspect = (value: Node): void => {
      if (!(value instanceof Element)) return;
      if (
        value.matches(dialogSelector) ||
        value.querySelector(dialogSelector)
      ) seen.add("kernel-dialog");
      const walletTile = 'iframe[data-app-id="wallet"][data-tile-id="wallet"]';
      if (value.matches(walletTile) || value.querySelector(walletTile)) {
        seen.add("wallet-tile");
      }
    };
    const record = (records: MutationRecord[] = []): void => {
      for (const mutation of records) {
        for (const added of mutation.addedNodes) inspect(added);
      }
      if (document.querySelector(dialogSelector)) seen.add("kernel-dialog");
      if (document.querySelector(
        'iframe[data-app-id="wallet"][data-tile-id="wallet"]',
      )) seen.add("wallet-tile");
    };
    const observer = new MutationObserver(record);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    record();
    scope.__NEUTRON_WALLET_ROOT_UI_AUDIT__ = { observer, record, seen };
  }, KERNEL_DIALOG_SELECTOR);
}

async function stopUiAudit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __NEUTRON_WALLET_ROOT_UI_AUDIT__?: {
        observer: MutationObserver;
        record: (records?: MutationRecord[]) => void;
        seen: Set<string>;
      };
    };
    const audit = scope.__NEUTRON_WALLET_ROOT_UI_AUDIT__;
    if (!audit) throw new Error("Wallet root-agent UI audit was not started");
    audit.record(audit.observer.takeRecords());
    audit.record();
    audit.observer.disconnect();
    delete scope.__NEUTRON_WALLET_ROOT_UI_AUDIT__;
    return [...audit.seen];
  });
}
