import { expect, test, type Page } from "@playwright/test";
import {
  appIndexUrl,
  localCanisterOrigin,
} from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";


const guidePages = [
  "overview",
  "public_ingress",
  "backend_calls",
  "https_outcalls",
  "randomness",
  "scheduled_tasks",
  "stable_store",
  "self_calls",
  "chain_key_signing",
  "vetkeys",
  "ethereum",
  "connections",
  "agent_entrypoints",
  "background_requests",
  "storage",
  "certified_reads",
  "certified_assets",
  "composition",
  "memory",
  "bus",
  "wallet_funding",
  "tray",
  "schemas",
  "data",
  "design",
] as const;

test("installed Kitchen Sink serves the design-system stylesheet", async ({
  request,
}) => {
  const cssUrl = new URL("/app/kitchensink/main.css", localKernelUrl()).href;
  const response = await request.get(cssUrl);

  expect(response.status(), `${cssUrl} must be installed`).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/css");

  const css = await response.text();
  expect(css).toContain(".nt-app");
  expect(css).toContain(".nt-button");
  expect(css).toContain(".nt-dialog");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/https?:\/\/|\/\/[^/\s]/i);
});

test("installed Kitchen Sink workbench works in narrow browser tiles", async ({
  page,
}) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (isRemoteRequest(request.url())) remoteRequests.push(request.url());
  });

  for (const viewport of [
    { width: 260, height: 220 },
    { width: 320, height: 320 },
    { width: 480, height: 360 },
    { width: 720, height: 520 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(kitchenSinkUrl("main", viewport.width), {
      waitUntil: "domcontentloaded",
    });

    await expect(page.locator('[data-tid="kitchen-tile-main"]')).toBeVisible();
    await expect(page.locator('link[rel="stylesheet"][href="./main.css"]')).toHaveCount(
      1
    );
    await page.locator('[data-tid="kitchen-nav-design"]').click();
    await expect(page.locator('[data-tid="kitchen-demo-design"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add tile" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Replace durable profile cache" })).toBeVisible();

    await assertNoDocumentOverflow(page);
    await assertControlsHaveNamesAndTargets(page);

    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Example settings row" })).toBeVisible();
    const disclosure = page.locator('[data-tid="kitchen-disclosure-toggle"]');
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#design-runtime-content")).toBeVisible();
    await assertNoDocumentOverflow(page);
  }

  expect(remoteRequests).toEqual([]);
});

test("installed Kitchen Sink data and schema views keep content contained", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto(kitchenSinkUrl("main", 320), {
    waitUntil: "domcontentloaded",
  });

  await page.locator('[data-tid="kitchen-nav-data"]').click();
  await expect(page.locator('[data-tid="kitchen-demo-data"]')).toBeVisible();
  await expect(page.getByLabel("Principal")).toBeVisible();
  await expect(page.locator('[data-tid="kitchen-json-fixture"]')).toBeVisible();

  await assertNoDocumentOverflow(page);

  await page.locator('[data-tid="kitchen-nav-schemas"]').click();
  await expect(page.locator('[data-tid="kitchen-demo-schemas"]')).toBeVisible();
  const schema = page.locator('[data-tid="kitchen-schema-read_profile"]');
  await expect(schema).toBeVisible();
  await expect(
    schema.evaluate(
      (element) => element.scrollWidth >= element.clientWidth
    )
  ).resolves.toBe(true);
  await assertNoDocumentOverflow(page);
});

test("every Kitchen Sink page explains its implementation and security boundary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto(kitchenSinkUrl("main", 960), {
    waitUntil: "domcontentloaded",
  });

  for (const id of guidePages) {
    await page.locator(`[data-tid="kitchen-nav-${id}"]`).click();
    const guide = page.locator(`[data-tid="kitchen-guide-${id}"]`);

    await expect(guide).toBeVisible();
    await expect(guide.getByRole("heading", { name: "Why use it" })).toBeVisible();
    await expect(guide.getByRole("heading", { name: "What really happens" })).toBeVisible();
    await expect(guide.locator(".ks-guide-flow li")).toHaveCount(3);
    await expect(guide.getByRole("heading", { name: "Security boundary" })).toBeVisible();
    await expect(guide.locator(".ks-guide-security dt")).toHaveText([
      "Kernel enforces",
      "Authority limit",
      "Who can see it",
    ]);
    await expect(guide.locator(".ks-code-example pre code")).not.toBeEmpty();
    await expect(guide.locator('[class^="ks-code-"]')).not.toHaveCount(0);
    await assertNoDocumentOverflow(page);
  }
});

function kitchenSinkUrl(tileId: string, width: number): string {
  return appIndexUrl({
    canisterId: resolveCanisterId(),
    appId: "kitchensink",
    tileId,
    instanceId: `e2e-${tileId}-${width}`,
    workspace: 1,
    // Kitchen Sink declares persistent browser storage, so production tiles
    // use the ordinary sandboxed Neutron origin rather than the deterministic
    // app-prefixed origin.
    unprefixed: true,
    local: true,
    localHost: localGatewayUrl(),
  });
}

function localKernelUrl(): string {
  return localCanisterOrigin(resolveCanisterId(), localGatewayUrl()) + "/";
}

function resolveCanisterId(): string {
  return resolveLocalNeutronRuntime().canisterId;
}

function localGatewayUrl(): string {
  return resolveLocalNeutronRuntime().gatewayUrl;
}

function isRemoteRequest(href: string): boolean {
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== "localhost" && !url.hostname.endsWith(".localhost");
}

async function assertNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));

  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

async function assertControlsHaveNamesAndTargets(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll("button, input, textarea, select")
    );

    const visibleControls = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    const unnamedButtons = visibleControls
      .filter((element) => element instanceof HTMLButtonElement)
      .filter((button) => {
        const label = button.getAttribute("aria-label") ?? button.textContent;
        return !label?.trim();
      }).length;

    const unlabeledFields = visibleControls
      .filter(
        (element) =>
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
      )
      .filter((element) => {
        const id = element.id;
        const hasLabel =
          !!element.getAttribute("aria-label") ||
          !!element.getAttribute("aria-labelledby") ||
          !!element.closest("label") ||
          (id
            ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`)
            : false);
        return !hasLabel;
      }).length;

    const undersizedControls = visibleControls
      .map((element) => {
        const target =
          element instanceof HTMLInputElement &&
          (element.type === "checkbox" || element.type === "radio") &&
          element.closest("label")
            ? element.closest("label")!
            : element;
        const rect = target.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          width: rect.width,
          height: rect.height,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim() ??
            "",
        };
      })
      .filter((control) => control.width < 28 || control.height < 28);

    return {
      unnamedButtons,
      unlabeledFields,
      undersizedControls,
    };
  });

  expect(result.unnamedButtons).toBe(0);
  expect(result.unlabeledFields).toBe(0);
  expect(result.undersizedControls).toEqual([]);
}
