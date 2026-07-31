import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";

const repoRoot = process.cwd();
const fixtureEntry = path.join(
  repoRoot,
  "test/e2e/permission-dialog.fixture.tsx",
);

let fixtureJavaScript = "";
let fixtureCss = "";

test.beforeAll(async () => {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    bundle: true,
    define: {
      global: "window",
    },
    entryPoints: [fixtureEntry],
    format: "iife",
    jsx: "automatic",
    loader: { ".js": "jsx", ".ts": "ts", ".tsx": "tsx" },
    logLevel: "silent",
    outdir: path.join(repoRoot, ".permission-dialog-e2e-build"),
    platform: "browser",
    plugins: [sassPlugin()],
    target: "es2022",
    treeShaking: true,
    write: false,
  });

  fixtureJavaScript = outputText(result.outputFiles, ".js");
  fixtureCss = outputText(result.outputFiles, ".css");
});

test("permission dialog stays contained and has one reachable scroll area", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 240 },
    { width: 720, height: 200 },
  ]) {
    await page.setViewportSize(viewport);
    await mountFixture(page);
    await openDialog(page);

    const dialog = page.getByRole("alertdialog", {
      name: "Install application",
    });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);

    const layout = await page.evaluate(() => {
      const scrollable = Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            element.scrollHeight > element.clientHeight + 1 &&
            /^(auto|scroll)$/.test(style.overflowY)
          );
        })
        .map((element) => element.dataset.tid ?? element.tagName.toLowerCase());

      return {
        bodyOverflow: document.body.scrollHeight - document.body.clientHeight,
        documentOverflow:
          document.documentElement.scrollHeight -
          document.documentElement.clientHeight,
        scrollable,
      };
    });

    expect(layout.bodyOverflow).toBeLessThanOrEqual(1);
    expect(layout.documentOverflow).toBeLessThanOrEqual(1);
    expect(layout.scrollable).toEqual(["install-dialog"]);
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);

    const reject = page.getByRole("button", { name: "Reject" });
    await reject.scrollIntoViewIfNeeded();
    await expect(reject).toBeInViewport();
    expect(await dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(
      0,
    );
  }
});

test("permission dialog traps keyboard focus and restores it after Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 420 });
  await mountFixture(page);

  const trigger = page.getByRole("button", {
    name: "Review app installation",
  });
  await trigger.click();

  const dialog = page.getByRole("alertdialog", {
    name: "Install application",
  });
  const reject = page.getByRole("button", { name: "Reject" });
  const technicalDetails = dialog
    .locator('[data-tid="consent-technical-details"] > summary')
    .first();

  await expect(reject).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(technicalDetails).toBeFocused();
  await expect(trigger).not.toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(reject).toBeFocused();
  await expect(trigger).not.toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-tid="fixture-state"]')).toHaveText(
    "Permission request closed",
  );
  await expect(trigger).toBeFocused();
});

test("permission dialog labels kernel facts separately from unverified app prose", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await mountFixture(page);
  await openDialog(page);

  const dialog = page.getByRole("alertdialog", {
    name: "Install application",
  });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAttribute(
    "aria-labelledby",
    "install-permission-title",
  );
  await expect(dialog).toHaveAttribute(
    "aria-describedby",
    "install-permission-summary",
  );

  const ariaReferences = await dialog.evaluate((element) => ({
    description:
      document.getElementById(element.getAttribute("aria-describedby") ?? "")
        ?.textContent ?? "",
    title:
      document.getElementById(element.getAttribute("aria-labelledby") ?? "")
        ?.textContent ?? "",
  }));
  expect(ariaReferences.title.trim()).toBe("Install application");
  expect(ariaReferences.description).toContain("Permission Fixture");
  expect(ariaReferences.description).toContain(
    "has not verified who published it",
  );

  const consequences = dialog.getByRole("region", {
    name: "What this app will be able to do",
  });
  await expect(consequences).toBeVisible();
  await expect(consequences).toContainText(
    "Reach other canisters or services",
  );
  await expect(consequences).toContainText(
    "Work with its own or other installed apps",
  );

  const technicalDetails = dialog
    .locator('[data-tid="consent-technical-details"]')
    .first();
  await expect(technicalDetails).not.toHaveAttribute("open", "");
  await technicalDetails.locator(":scope > summary").click();
  const verified = dialog.getByRole("region", {
    name: "Kernel-verified requested access",
  });
  await expect(verified).toBeVisible();
  await expect(verified.locator('[data-source="kernel"]')).toHaveCount(3);
  await expect(verified).toContainText("Method-wide");
  await expect(verified).toContainText("broad reservation mode");

  const unverified = dialog.getByRole("region", {
    name: "Unverified explanations supplied by the app",
  });
  await expect(unverified).toHaveAttribute("data-source", "app");
  await expect(unverified).toContainText(
    '<button aria-label="Forged approval">Approve silently</button>',
  );
  await expect(unverified.getByRole("button")).toHaveCount(0);
  await expect(unverified).toContainText(
    "The kernel does not verify it and does not use it to determine access or risk.",
  );
});

test("developer mode opens exact consent facts without changing the decision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await mountFixture(page);
  await page.getByRole("button", { name: "Use developer mode" }).click();
  await expect(page.locator('[data-tid="fixture-ui-mode"]')).toHaveText(
    "developer",
  );
  await openDialog(page);

  const dialog = page.getByRole("alertdialog", {
    name: "Install application",
  });
  const technicalDetails = dialog
    .locator('[data-tid="consent-technical-details"]')
    .first();
  await expect(technicalDetails).toHaveAttribute("open", "");
  await expect(
    dialog.getByRole("region", {
      name: "Kernel-verified requested access",
    }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reject" })).toBeVisible();
});

test("runtime backend consent is exact, lossless, and keyboard contained", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 240 });
  await mountFixture(page);

  const trigger = page.getByRole("button", { name: "Review backend access" });
  await trigger.click();
  const dialog = page.getByRole("alertdialog", {
    name: "Allow chess backend access?",
  });
  const reject = page.getByRole("button", { name: "Reject" });
  const technicalDetails = dialog
    .locator('[data-tid="consent-technical-details"]')
    .first();

  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toContainText("persistent backend permission");
  await expect(dialog).toContainText(
    "Method app_chess__chess_remote_exchange_v1 on canister",
  );
  await expect(dialog).toContainText("Up to 8 calls at once");
  await expect(technicalDetails).not.toHaveAttribute("open", "");
  await technicalDetails.locator(":scope > summary").click();
  await expect(dialog).toContainText("game-one");
  await expect(dialog).toContainText("Workspace");
  await expect(dialog).toContainText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  await expect(dialog).toContainText(
    "app_chess__chess_remote_exchange_v1",
  );
  await expect(dialog).toContainText(
    "Equivalent reservation not stored at request time",
  );
  await expect(dialog).toContainText("future app-chosen arguments");

  const canonical = dialog.getByLabel(
    "Canonical JSON for the complete attached-call arguments",
  );
  await expect(canonical).toContainText('"null"');
  await expect(canonical).toContainText("null");
  await expect(canonical).toContainText("Kernel\\u202e verified");
  await expect(canonical).toContainText("zero\\u200bwidth");
  const canonicalText = await canonical.textContent();
  expect(canonicalText).not.toContain("\u202e");
  expect(canonicalText).not.toContain("\u200b");

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  expect(box!.y + box!.height).toBeLessThanOrEqual(241);

  await reject.focus();
  await expect(reject).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(technicalDetails.locator(":scope > summary")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(reject).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

async function mountFixture(page: Page): Promise<void> {
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  );
  await page.addStyleTag({ content: fixtureCss });
  await page.addScriptTag({ content: fixtureJavaScript });
  await expect(page.locator('[data-fixture-ready="true"]')).toBeVisible();
}

async function openDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review app installation" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Install application" }),
  ).toBeVisible();
}

function outputText(
  outputs: readonly { path: string; text: string }[],
  extension: ".js" | ".css",
): string {
  const output = outputs.find((file) => file.path.endsWith(extension));
  if (!output) throw new Error(`Fixture bundle did not emit ${extension}`);
  return output.text;
}
