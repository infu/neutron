import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parseDeploymentBuildRecordJson } from "neutron-compiler/src/deployment_record.js";
import { formatAppVersionLabel } from "neutron-tools/src/version.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";
import {
  assertEvmInstalledPins, assertEvmUpgradeBuild, assertEvmUpgradePreserved,
  createEvmUpgradeReader, loadEvmLocalUpgradeDescriptor, upgradeEvidenceJson,
} from "./fixtures/evm-wallet-upgrade.ts";

// Explicit local-only action. No runtime mutation occurs during test discovery.
// A coordinator must provide an idle installation/financial window; retries are
// disabled because a failed assertion can follow a successfully committed step.
test.describe.configure({ retries: 0 });
test.skip(!process.env.NEUTRON_EVM_UPGRADE_DESCRIPTOR || path.basename(process.env.NEUTRON_NDEPLOY_CONFIG ?? "") !== "evm-wallet-local.ndeploy.json",
  "Requires the explicit candidate descriptor and dedicated local EVM installation");

test("candidate archives update through checked browser reviews while preserving installed identities and app records", async ({ page, request }, testInfo) => {
  test.setTimeout(90 * 60_000);
  page.setDefaultTimeout(30_000);
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const loaded = await loadEvmLocalUpgradeDescriptor(process.env.NEUTRON_EVM_UPGRADE_DESCRIPTOR!, repositoryRoot);
  const runtime = resolveLocalNeutronRuntime();
  const journalBefore = await readFile(runtime.sessionPath);
  const reader = await createEvmUpgradeReader(runtime, loaded.descriptor, request);
  await mkdir(loaded.evidenceDirectory, { recursive: true, mode: 0o700 });
  let before = await reader.capture();
  const initial = before;
  const expected = loaded.descriptor.expectedInstalled.map(pin => ({ ...pin }));
  assertEvmInstalledPins(before, expected);
  await writeFile(path.join(loaded.evidenceDirectory, "before.json"), upgradeEvidenceJson(before), { mode: 0o600, flag: "wx" });
  await page.goto(reader.origin);
  await login(page, runtime.developerIdentitySeed);
  await waitForInstalledResidents(page, expected.map(pin => pin.id));
  await enableDeveloperReview(page);
  const steps: unknown[] = [];
  for (let index = 0; index < loaded.candidates.length; index++) {
    const candidate = loaded.candidates[index]!;
    const { pin } = candidate;
    await test.step(`checked Update ${pin.id} to ${pin.version}`, async () => {
      assertEvmInstalledPins(before, expected);
      const launcher = page.locator('[data-tid="launcher"]');
      if (!(await launcher.isVisible())) await page.locator('[data-tid="launcher-open"]').click();
      await expect(launcher).toBeVisible();
      const choosing = page.waitForEvent("filechooser");
      await page.locator('[data-tid="launcher-install-package"]').click();
      const chooser = await choosing;
      expect(chooser.isMultiple()).toBe(false);
      // Supply the exact bytes checked above; later disk changes cannot change
      // the review or uploaded archive while this long test is in progress.
      await chooser.setFiles({ name: path.basename(pin.path), mimeType: "application/octet-stream", buffer: candidate.bytes });
      const dialog = page.locator('[data-tid="install-dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("h2").first()).toHaveText("Update application");
      await expect(dialog.locator(".consent-install-summary strong").first()).toHaveText(candidate.prepared.manifest.name);
      await expect(dialog.locator(".consent-install-summary span").first()).toHaveText(formatAppVersionLabel(pin.version));
      await expect(dialog).toContainText(pin.sha256);
      await expect(page.locator('[data-tid="install-compiled"]')).toBeVisible({ timeout: 15 * 60_000 });
      const buildDetails = dialog.getByText("Build and installation details", { exact: true });
      await buildDetails.click();
      const downloading = page.waitForEvent("download");
      await dialog.locator('[data-tid="deployment-build-review-download-record"]').click();
      const download = await downloading;
      const stream = await download.createReadStream();
      assert(stream);
      const parts: Buffer[] = [];
      for await (const part of stream) parts.push(Buffer.from(part));
      const reviewedBytes = Buffer.concat(parts);
      await writeFile(path.join(loaded.evidenceDirectory, `${index + 1}-${pin.id}-reviewed-build.json`), reviewedBytes, { mode: 0o600, flag: "wx" });
      const reviewed = parseDeploymentBuildRecordJson(reviewedBytes);
      assertEvmUpgradeBuild(reviewed, before, pin, runtime.canisterId, candidate.prepared);
      await expect(page.locator('[data-tid="install-accept"]')).toHaveText("Update");
      await expect(page.locator('[data-tid="install-accept"]')).toBeEnabled();
      await page.locator('[data-tid="install-accept"]').click();
      await expect.poll(async () => {
        const installed = await reader.kernel.kernel_runtime_info();
        if (await page.locator('[data-tid="install-error"]').isVisible()) throw new Error(await page.locator('[data-tid="install-error"]').textContent() ?? "Browser update failed");
        return installed.apps.find(app => app.scope.app_id === pin.id)?.version.toString();
      }, { timeout: 15 * 60_000, intervals: [500, 1000, 2000] }).toBe(String(pin.version));
      await expect.poll(() => reader.kernel.kernel_install_status(null), { timeout: 120_000 }).toEqual([]);
      await expect(page.locator('[data-tid="install-progress"]')).toBeHidden({ timeout: 120_000 });
      const after = await reader.capture();
      await writeFile(path.join(loaded.evidenceDirectory, `${index + 1}-${pin.id}-observed-after.json`), upgradeEvidenceJson(after), { mode: 0o600, flag: "wx" });
      const updated = expected.findIndex(app => app.id === pin.id);
      expected[updated] = { id: pin.id, version: pin.version, sha256: pin.sha256 };
      assertEvmInstalledPins(after, expected);
      await assertEvmUpgradePreserved(before, after, pin, reviewed, candidate.prepared);
      assert.deepEqual(await readFile(runtime.sessionPath), journalBefore, "Provisioning completion journal was modified");
      const step = { index: index + 1, candidate: pin, reviewedBuildSha256: createHash("sha256").update(reviewedBytes).digest("hex"), before, after };
      steps.push(step);
      await writeFile(path.join(loaded.evidenceDirectory, `${index + 1}-${pin.id}-committed.json`), upgradeEvidenceJson(step), { mode: 0o600, flag: "wx" });
      before = after;
      await page.reload({ waitUntil: "domcontentloaded" });
      await login(page, runtime.developerIdentitySeed);
      await waitForInstalledResidents(page, expected.map(pin => pin.id));
    });
  }
  const receipt = {
    schema: "neutron-evm-checked-browser-upgrade-v1", completedAt: new Date().toISOString(),
    descriptorSha256: loaded.descriptorSha256, canisterId: runtime.canisterId,
    initialDeploymentId: initial.runtime.deployment_id, finalDeploymentId: before.runtime.deployment_id,
    installed: expected, steps,
    provisioningJournal: { path: runtime.sessionPath, sha256: createHash("sha256").update(journalBefore).digest("hex"), unchanged: true },
    evidenceScope: "Actual per-archive browser Update, pre-acceptance exact build records, retained installation UIDs, unchanged existing memory schemas and declaration history, initialization only of new roots declared in the sealed candidate archive, and identical EVM wallet, IC bridge, Uniswap and profile query replies. IC Wallet snapshots permit only monotonic existing balance/native-refresh timestamps; all other decoded fields must remain identical. Kitchen counter changes must equal its scheduled-run count changes. Linear-memory persistence follows the existing compiler mode: classical replaces the heap and restores managed state from stable memory; enhanced keeps the heap. Runtime memory metadata does not expose physical root pointers. Canonical non-raw HTTP assets are verified by the pinned PocketIC14 gateway with response verification enabled; this harness does not independently repeat HTTP-v2 body verification.",
  };
  const receiptPath = path.join(loaded.evidenceDirectory, "checked-upgrade-receipt.json");
  await writeFile(receiptPath, upgradeEvidenceJson(receipt), { mode: 0o600, flag: "wx" });
  await testInfo.attach("checked-browser-upgrade-receipt", { path: receiptPath, contentType: "application/json" });
});

async function waitForInstalledResidents(page: Page, appIds: string[]): Promise<void> {
  for (const appId of appIds.filter(id => id !== "kernel")) {
    await expect(page.locator(`[data-tid="app-background-frame"][data-app-id="${appId}"]`)).toHaveAttribute("data-resident-launch", "ready", { timeout: 120_000 });
  }
}

async function login(page: Page, seed: number): Promise<void> {
  await expect.poll(async () => await page.locator('[data-tid="launcher-open"]').isVisible() || await page.locator('[data-tid="login-button"]').isVisible()).toBe(true);
  if (await page.locator('[data-tid="login-button"]').isVisible()) {
    await page.waitForFunction(() => typeof (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: unknown }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__ === "function");
    await page.evaluate(async value => {
      const fn = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
      if (!fn) throw new Error("Local test login is unavailable");
      await fn(value);
    }, seed);
  }
  await expect(page.locator('[data-tid="launcher-open"]')).toBeVisible();
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
}
async function enableDeveloperReview(page: Page): Promise<void> {
  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  const section = page.locator('[data-tid="settings-interface-toggle"]');
  if (await section.getAttribute("aria-expanded") !== "true") await section.click();
  await page.locator('[data-tid="settings-ui-mode-developer"]').check();
  await page.locator('[data-tid="settings-back"]').click();
}
