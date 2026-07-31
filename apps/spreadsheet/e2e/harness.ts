import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { resolveLocalNeutronRuntime } from "neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";

const deploymentConfig =
  process.env.NEUTRON_NDEPLOY_CONFIG ??
  fileURLToPath(new URL("../../../local.ndeploy.json", import.meta.url));

export type SpreadsheetHarness = {
  page: Page;
  sheet: FrameLocator;
  frame: Locator;
};

export async function openFilesTile(page: Page): Promise<FrameLocator> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-files-files"]').click();
  const selector = 'iframe[data-app-id="files"][data-tile-id="files"]';
  const frame = page.locator(selector).last();
  const files = page.frameLocator(selector).last();
  await expect(frame).toBeVisible();
  await expect(files.getByRole("tree")).toBeVisible();
  return files;
}

export async function openSpreadsheet(page: Page): Promise<SpreadsheetHarness> {
  const runtime = resolveLocalNeutronRuntime({ configPath: deploymentConfig });
  await page.goto(kernelUrl(), { waitUntil: "domcontentloaded" });
  await page.evaluate(async (identitySeed) => {
    const login = (window as typeof window & {
      __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
    }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    await login(identitySeed);
  }, runtime.developerIdentitySeed);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await expect(page.locator('[data-tid="app-background-frame"][data-app-id="spreadsheet"]')).toHaveCount(1);
  await expect(page.locator('[data-tid="app-background-frame"][data-app-id="files"]')).toHaveCount(1);
  await page.frameLocator('[data-tid="app-background-frame"][data-app-id="spreadsheet"]').locator("body").waitFor({ state: "attached" });

  const status = await waitForWorkbookStatus(page);
  const reset = await callSpreadsheetTool(page, "workbook_session", {
    action: "new",
    expectedRevision: status.revision,
    commandId: commandId("reset"),
    discardDirty: true,
  }) as any;
  assertCleanReset(status, reset);
  const cleanStatus = await waitForWorkbookStatus(page);
  assertCleanReset(status, cleanStatus, reset);

  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-spreadsheet-workbook"]').click();
  const selector = 'iframe[data-app-id="spreadsheet"][data-tile-id="workbook"]';
  const frame = page.locator(selector).last();
  const sheet = page.frameLocator(selector).last();
  await expect(sheet.getByRole("grid", { name: "Spreadsheet grid" })).toBeVisible();
  await waitIdle(sheet);
  return { page, sheet, frame };
}

export async function workbookStatus(page: Page): Promise<any> {
  return callSpreadsheetTool(page, "workbook_status", {}) as Promise<any>;
}

/**
 * Mutate the resident directly as an external/system writer. This intentionally
 * does not model an agent invocation or kernel-routed actor provenance.
 */
export async function applySystemOperations(page: Page, operations: Array<Record<string, unknown>>): Promise<any> {
  const status = await workbookStatus(page);
  return callSpreadsheetTool(page, "workbook_apply", {
    action: "apply",
    expectedRevision: status.revision,
    commandId: commandId("apply"),
    operations,
  });
}

export async function callSpreadsheetTool(page: Page, name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  return page.evaluate(
    ({ name, args, timeoutMs }) => new Promise((resolve, reject) => {
      const frame = document.querySelector<HTMLIFrameElement>('[data-tid="app-background-frame"][data-app-id="spreadsheet"]');
      if (!frame?.contentWindow) { reject(new Error("Spreadsheet background frame is unavailable")); return; }
      const id = Date.now() + Math.floor(Math.random() * 100_000);
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error(`Spreadsheet tool ${name} timed out`));
      }, timeoutMs);
      function onMessage(event: MessageEvent): void {
        if (event.source !== frame!.contentWindow) return;
        const response = event.data as { type?: unknown; id?: unknown; ok?: unknown; error?: unknown };
        if (response.type !== "response" || response.id !== id) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (Object.hasOwn(response, "error")) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.ok);
      }
      window.addEventListener("message", onMessage);
      frame.contentWindow.postMessage({
        type: "exec",
        id,
        payload: { action: "__neutron_msgbus_tools_call", payload: { name, arguments: args } },
      }, "*");
    }),
    { name, args, timeoutMs },
  );
}

export async function approveFilesTool(page: Page, tool: "readBinary" | "writeBinary"): Promise<void> {
  const dialog = page.locator('[data-tid="frontend-tool-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("spreadsheet/background");
  await expect(dialog).toContainText("app:files:background");
  await expect(dialog).toContainText(tool);
  await page.locator('[data-tid="frontend-tool-approve-session"]').click();
  await expect(dialog).toHaveCount(0);
}

async function waitForWorkbookStatus(page: Page): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { return await callSpreadsheetTool(page, "workbook_status", {}, 3_000); }
    catch (error) { lastError = error; await page.waitForTimeout(250); }
  }
  throw lastError instanceof Error ? lastError : new Error("Spreadsheet background did not become ready");
}

function assertCleanReset(previous: any, current: any, expected?: any): void {
  expect(current).toMatchObject({
    revision: previous.revision + 1,
    sheets: [{
      name: "Sheet1",
      usedRange: null,
      cellCount: 0,
      filter: null,
      hiddenRowCount: 0,
      columnWidths: {},
      rowHeights: {},
    }],
    canUndo: false,
    canRedo: false,
    undoHistoryId: null,
    redoHistoryId: null,
    history: { entries: 0, bytes: 0 },
    dirty: false,
    lastSavedRevision: null,
    nativeSource: null,
    importProvenance: null,
    recovery: {
      available: false,
      pending: false,
      savedAt: null,
      revision: null,
      degraded: false,
      error: null,
    },
    saving: false,
  });
  expect(current.sheets).toHaveLength(1);
  expect(current.workbookId).not.toBe(previous.workbookId);
  if (expected) {
    expect(current.workbookId).toBe(expected.workbookId);
    expect(current.revision).toBe(expected.revision);
  }
}

export async function editCell(harness: SpreadsheetHarness, address: string, value: string, commitKey = "Enter"): Promise<void> {
  const cell = harness.sheet.locator(`[data-address="${address}"]`);
  await cell.dblclick();
  const editor = harness.sheet.getByLabel(`Raw input for ${address}`);
  await editor.fill(value);
  await editor.press(commitKey);
  await waitIdle(harness.sheet);
}

export async function goTo(harness: SpreadsheetHarness, address: string): Promise<void> {
  const nameBox = harness.sheet.getByLabel("Go to cell address");
  await nameBox.fill(address);
  await nameBox.press("Enter");
  await waitIdle(harness.sheet);
  await expect(harness.sheet.locator(`[data-address="${address}"]`)).toBeFocused();
}

export async function selectRange(harness: SpreadsheetHarness, start: string, end: string): Promise<void> {
  const first = await harness.sheet.locator(`[data-address="${start}"]`).boundingBox();
  const last = await harness.sheet.locator(`[data-address="${end}"]`).boundingBox();
  if (!first || !last) throw new Error(`Range ${start}:${end} is not visible`);
  await harness.page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await harness.page.mouse.down();
  await harness.page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 4 });
  await harness.page.mouse.up();
  await expect(harness.sheet.locator(`[data-address="${end}"]`)).toHaveAttribute("aria-selected", "true");
}

export async function waitIdle(sheet: FrameLocator): Promise<void> {
  await sheet.locator("body").evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(sheet.locator(".busy-indicator")).toHaveCount(0);
}

export function uniquePath(extension: "nsheet" | "csv" | "xlsx"): string {
  return `/e2e/spreadsheet-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.${extension}`;
}

function commandId(prefix: string): string {
  return `e2e-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function kernelUrl(): string {
  const runtime = resolveLocalNeutronRuntime({ configPath: deploymentConfig });
  return localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
}

function resolveCanisterId(): string {
  return resolveLocalNeutronRuntime({ configPath: deploymentConfig }).canisterId;
}
