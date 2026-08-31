import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import { serve } from "bun";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { filesInlineCryptoWorkerPlugin } from "../scripts/worker_bundle.ts";

const filesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test(
  "Files keeps navigation race-safe, fills the tile, and moves by drag",
  async () => {
    const built = await esbuild.build({
      absWorkingDir: filesRoot,
      stdin: {
        contents: browserHarnessSource(),
        loader: "ts",
        resolveDir: filesRoot,
        sourcefile: "files-ui-browser-harness.ts",
      },
      bundle: true,
      format: "iife",
      jsx: "automatic",
      minify: true,
      outdir: "browser-test-dist",
      platform: "browser",
      plugins: [filesInlineCryptoWorkerPlugin(filesRoot), sassPlugin()],
      write: false,
    });
    const bundle = built.outputFiles?.find((file) =>
      file.path.endsWith(".js")
    )?.text;
    const styles = built.outputFiles?.find((file) =>
      file.path.endsWith(".css")
    )?.text;
    if (!bundle) throw new Error("Files UI browser bundle is missing");
    if (!styles) throw new Error("Files UI browser styles are missing");

    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/bundle.js") {
          return new Response(bundle, {
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }
        if (path === "/bundle.css") {
          return new Response(styles, {
            headers: { "content-type": "text/css; charset=utf-8" },
          });
        }
        if (path === "/") {
          return new Response(
            '<!doctype html><html><head><meta charset="utf-8"><title>Files UI test</title><link rel="stylesheet" href="/bundle.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><script src="/bundle.js"></script></body></html>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        ...await chromiumOptions(),
      });
      const origin = `http://127.0.0.1:${server.port}`;

      const page = await browser.newPage();
      await page.goto(origin);
      const tree = page.getByRole("tree", { name: "Files" });
      await tree.locator('[data-path="/Workspace/workspace-note.txt"]')
        .waitFor();

      const roots = await tree.locator('[role="treeitem"][aria-level="1"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-path"))
        );
      expect(roots).toEqual(["/Shared", "/Vault", "/Workspace"]);
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.listCalls
        ),
      ).toEqual(["/Workspace"]);
      expect(await page.getByRole("button", { name: /Shared links/ }).count())
        .toBe(0);
      expect(await page.getByRole("button", { name: /^Share$/ }).count())
        .toBe(0);
      expect(await page.getByText("Move / rename", { exact: true }).count())
        .toBe(0);
      const workspaceRoot = tree.locator('[data-path="/Workspace"]');
      const workspaceNote = tree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      );
      expect(await workspaceNote.evaluate((node) =>
        Math.round(node.getBoundingClientRect().height)
      )).toBe(32);
      expect(await workspaceNote.locator(".files-v2-row-size").count()).toBe(0);
      expect(await workspaceNote.locator(".files-v2-tree-guide--branch").count())
        .toBe(1);
      expect(await workspaceRoot.getByRole("button", {
        name: "Collapse Workspace",
      }).count()).toBe(1);
      await workspaceRoot.getByRole("button", {
        name: "Collapse Workspace",
      }).click();
      await workspaceRoot.getByRole("button", {
        name: "Expand Workspace",
      }).click();
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path
        ),
      ).toBe("/Workspace");
      await tree.locator('[data-path="/Workspace/Projects"]').click();
      await page.getByRole("navigation", { name: "Current folder" })
        .getByText("Projects", { exact: true })
        .waitFor();
      const sharedRoot = tree.locator('[data-path="/Shared"]');
      await sharedRoot.focus();
      await sharedRoot.press("ArrowLeft");
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Projects");
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path
        ),
      ).toBe("/Shared");
      await tree.evaluate((node) => {
        node.style.flex = "0 0 96px";
        node.style.height = "96px";
        node.style.maxHeight = "96px";
      });
      await page.waitForTimeout(30);
      await sharedRoot.press("End");
      await page.waitForFunction(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path
          ?.startsWith("/Workspace/zz-fixture-")
      );
      const lastFocusedPath = await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path ?? null
      );
      expect(lastFocusedPath).not.toBeNull();
      await page.keyboard.press("Enter");
      expect(await tree.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path ?? null
        ),
      ).toBe(lastFocusedPath);
      await tree.evaluate((node) => {
        node.style.flex = "";
        node.style.height = "";
        node.style.maxHeight = "";
      });
      await page.keyboard.press("Home");
      await page.waitForFunction(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path ===
          "/Shared"
      );
      await workspaceRoot.click();
      await page.keyboard.press("ArrowDown");
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path
            ?.startsWith("/Workspace/")
        ),
      ).toBe(true);
      await workspaceRoot.click();
      const browserPanel = page.locator("#files-v2-browser");
      const initialBrowserWidth = (await browserPanel.boundingBox())?.width;
      if (!initialBrowserWidth) throw new Error("File tree is not visible");
      const separator = page.getByRole("separator", {
        name: "Resize file tree",
      });
      await separator.press("ArrowRight");
      const resizedBrowserWidth = (await browserPanel.boundingBox())?.width;
      expect(Math.round(resizedBrowserWidth ?? 0)).toBe(
        Math.round(initialBrowserWidth + 16),
      );
      await page.getByRole("button", { name: "Hide file tree" }).click();
      expect(await browserPanel.isHidden()).toBe(true);
      await page.getByRole("button", { name: "Show file tree" }).click();
      expect(Math.round((await browserPanel.boundingBox())?.width ?? 0)).toBe(
        Math.round(initialBrowserWidth + 16),
      );
      await page.setViewportSize({ width: 800, height: 720 });
      const responsiveWidth = (await browserPanel.boundingBox())?.width;
      const separatorBox = await separator.boundingBox();
      if (!responsiveWidth || !separatorBox) {
        throw new Error("Responsive file tree resizer is unavailable");
      }
      await page.mouse.move(
        separatorBox.x + separatorBox.width / 2,
        separatorBox.y + separatorBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        separatorBox.x + separatorBox.width / 2 + 24,
        separatorBox.y + separatorBox.height / 2,
      );
      await page.mouse.up();
      expect(Math.round((await browserPanel.boundingBox())?.width ?? 0)).toBe(
        Math.round(responsiveWidth + 24),
      );
      await separator.press("End");
      await page.setViewportSize({ width: 650, height: 720 });
      await page.waitForFunction(() => {
        const panel = document.querySelector<HTMLElement>("#files-v2-browser");
        return panel !== null && panel.getBoundingClientRect().width <= 370;
      });
      const narrowWidth = Math.round(
        (await browserPanel.boundingBox())?.width ?? 0,
      );
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(
        narrowWidth,
      );
      await separator.press("ArrowLeft");
      const keyboardNarrowWidth = Math.round(
        (await browserPanel.boundingBox())?.width ?? 0,
      );
      expect(keyboardNarrowWidth).toBe(narrowWidth - 16);
      expect(Number(await separator.getAttribute("aria-valuenow"))).toBe(
        keyboardNarrowWidth,
      );
      await separator.focus();
      await separator.press("Enter");
      expect(await browserPanel.isHidden()).toBe(true);
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.getAttribute(
            "aria-label",
          )
        ),
      ).toBe("Show file tree");
      await page.getByRole("button", { name: "Show file tree" }).click();
      await page.setViewportSize({ width: 1280, height: 720 });

      const projects = tree.locator('[data-path="/Workspace/Projects"]');
      await page.evaluate(() => {
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .beginDelayedStateRefresh();
      });
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedStatusPending
      );
      await projects.click();
      await tree.locator(
        '[data-path="/Workspace/Projects/nested.txt"]',
      ).waitFor();
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Projects");
      expect(await projects.getAttribute("aria-expanded")).toBe("true");
      expect(await projects.getAttribute("aria-selected")).toBe("true");
      expect(
        await projects.evaluate((node) => getComputedStyle(node).boxShadow),
      ).toBe("none");
      await page.evaluate(() => {
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .releaseDelayedStatus();
      });
      await page.waitForFunction(() =>
        !(globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedStatusPending
      );
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Projects");
      expect(await projects.getAttribute("aria-expanded")).toBe("true");

      const slowFolder = tree.locator('[data-path="/Workspace/Slow"]');
      const fastFolder = tree.locator('[data-path="/Workspace/Fast"]');
      await slowFolder.click();
      await fastFolder.click();
      await page.waitForTimeout(160);
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Fast");
      const folderRaceCalls = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.listCalls
      );
      expect(
        folderRaceCalls.filter((path) => path === "/Workspace/Slow").length,
      ).toBe(1);
      expect(
        folderRaceCalls.filter((path) => path === "/Workspace/Fast").length,
      ).toBe(1);

      await fastFolder.getByRole("button", { name: "Actions for Fast" })
        .click();
      await page.getByRole("menu", { name: "Actions for Fast" })
        .getByRole("menuitem", { name: "Rename" })
        .click();
      const openFolderRenameDialog = page.getByRole("dialog", {
        name: "Rename Fast",
      });
      await openFolderRenameDialog.getByRole("textbox", { name: "Name" })
        .fill("Renamed Fast");
      await openFolderRenameDialog.getByRole("button", { name: "Rename" })
        .click();
      const renamedFastFolder = tree.locator(
        '[data-path="/Workspace/Renamed Fast"]',
      );
      await renamedFastFolder.waitFor();
      expect(await fastFolder.count()).toBe(0);
      await tree.locator(
        '[data-path="/Workspace/Renamed Fast/fast-note.txt"]',
      ).waitFor();
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Renamed Fast");

      await page.getByRole("navigation", { name: "Current folder" })
        .getByText("Workspace", { exact: true })
        .click();
      const workspace = tree.locator('[data-path="/Workspace"]');
      await workspace.waitFor();
      await workspace.getByRole("button", {
        name: "Actions for Workspace",
      }).click();
      await page.getByRole("menu", { name: "Actions for Workspace" })
        .getByRole("menuitem", { name: "New folder" })
        .click();
      const recreateFolderDialog = page.getByRole("dialog", {
        name: "New folder",
      });
      await recreateFolderDialog.getByRole("textbox", { name: "Name" })
        .fill("Fast");
      await recreateFolderDialog.getByRole("button", {
        name: "Create folder",
      }).click();
      await recreateFolderDialog.waitFor({ state: "detached" });
      await workspace.focus();
      await workspace.press("End");
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path ?? null
        ),
      ).toBe("/Workspace/Fast");
      const recreatedFastFolder = tree.locator(
        '[data-path="/Workspace/Fast"]',
      );
      expect(await recreatedFastFolder.getAttribute("aria-expanded"))
        .toBe("false");
      expect(
        await tree.locator(
          '[data-path="/Workspace/Fast/fast-note.txt"]',
        ).count(),
      ).toBe(0);
      await recreatedFastFolder.press("Home");

      const pendingFolder = tree.locator(
        '[data-path="/Workspace/Pending"]',
      );
      await pendingFolder.getByRole("button", { name: "Expand Pending" })
        .click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedPendingFolderListPending
      );
      await pendingFolder.focus();
      await pendingFolder.press("Shift+F10");
      await page.getByRole("menu", { name: "Actions for Pending" })
        .getByRole("menuitem", { name: "Rename" })
        .click();
      const pendingRenameDialog = page.getByRole("dialog", {
        name: "Rename Pending",
      });
      await pendingRenameDialog.getByRole("textbox", { name: "Name" })
        .fill("Renamed Pending");
      await pendingRenameDialog.getByRole("button", { name: "Rename" })
        .click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.lastMove?.to ===
          "/Workspace/Renamed Pending"
      );
      await page.evaluate(() => {
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .releaseDelayedPendingFolderList();
      });
      await page.waitForFunction(() =>
        !(globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedPendingFolderListPending
      );
      await page.getByRole("navigation", { name: "Current folder" })
        .getByText("Workspace", { exact: true })
        .click();
      await workspace.waitFor();
      await workspace.getByRole("button", {
        name: "Actions for Workspace",
      }).click();
      await page.getByRole("menu", { name: "Actions for Workspace" })
        .getByRole("menuitem", { name: "New folder" })
        .click();
      const recreatePendingDialog = page.getByRole("dialog", {
        name: "New folder",
      });
      await recreatePendingDialog.getByRole("textbox", { name: "Name" })
        .fill("Pending");
      await recreatePendingDialog.getByRole("button", {
        name: "Create folder",
      }).click();
      await recreatePendingDialog.waitFor({ state: "detached" });
      await workspace.focus();
      await workspace.press("End");
      const recreatedPendingFolder = tree.locator(
        '[data-path="/Workspace/Pending"]',
      );
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path ?? null
        ),
      ).toBe("/Workspace/Pending");
      expect(await recreatedPendingFolder.getAttribute("aria-expanded"))
        .toBe("false");
      const pendingListCalls = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.listCalls
          .filter((path) => path === "/Workspace/Pending").length
      );
      await recreatedPendingFolder.getByRole("button", {
        name: "Expand Pending",
      }).click();
      await page.waitForFunction((baseline) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.listCalls
          .filter((path) => path === "/Workspace/Pending").length ===
            (baseline as number) + 1,
        pendingListCalls,
      );
      expect(
        await tree.locator(
          '[data-path="/Workspace/Pending/pending-note.txt"]',
        ).count(),
      ).toBe(0);
      await recreatedPendingFolder.press("Home");
      const slowImageFile = tree.locator(
        '[data-path="/Workspace/slow-photo.png"]',
      );
      await slowImageFile.click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.delayedImagePending
      );
      const imageFile = tree.locator('[data-path="/Workspace/photo.png"]');
      await imageFile.click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedImageAborted
      );
      const image = page.getByRole("img", { name: "photo.png" });
      await image.waitFor();
      await page.waitForFunction(() =>
        document.querySelector<HTMLImageElement>('img[alt="photo.png"]')
          ?.naturalWidth === 1
      );
      const previewUrl = await image.getAttribute("src");
      if (!previewUrl?.startsWith("blob:")) {
        throw new Error("Image preview did not use a Blob URL");
      }
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness
            .binaryReadRequests.slice(0, 2)
        ),
      ).toEqual([
        { path: "/Workspace/slow-photo.png", ifMatch: "a".repeat(64) },
        { path: "/Workspace/photo.png", ifMatch: "a".repeat(64) },
      ]);
      await page.evaluate(() => {
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .releaseDelayedImage();
      });
      await page.waitForFunction(() =>
        !(globalThis as BrowserHarnessGlobal).__filesHarness
          .delayedImagePending
      );
      expect(await page.getByRole("img", { name: "photo.png" })
        .getAttribute("src")).toBe(previewUrl);
      const readsBeforeVaultLock = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.binaryReadPaths
          .length
      );
      await page.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.setVaultLocked();
        harness.emitState();
      });
      await page.waitForFunction((minimum) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.binaryReadPaths
          .length > (minimum as number), readsBeforeVaultLock
      );
      await page.waitForFunction(() =>
        document.querySelector<HTMLImageElement>('img[alt="photo.png"]')
          ?.naturalWidth === 1
      );
      const reloadedPreviewUrl = await page.getByRole("img", {
        name: "photo.png",
      }).getAttribute("src");
      expect(reloadedPreviewUrl).not.toBe(previewUrl);
      await page.waitForFunction((url) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.revokedUrls
          .includes(url as string), previewUrl
      );
      const urlsBeforeBrokenPreview = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.createdUrls.length
      );
      await tree.locator('[data-path="/Workspace/broken.png"]').click();
      await page.waitForFunction((url) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.revokedUrls
          .includes(url as string), reloadedPreviewUrl
      );
      await page.getByRole("heading", { name: "Preview unavailable" })
        .waitFor();
      expect(
        await page.getByRole("button", { name: "Download", exact: true })
          .isEnabled(),
      ).toBe(true);
      await page.waitForFunction((baseline) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.createdUrls
          .length === (baseline as number) + 1,
        urlsBeforeBrokenPreview,
      );
      const brokenPreviewUrl = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.createdUrls.at(-1)
      );
      expect(brokenPreviewUrl?.startsWith("blob:")).toBe(true);
      await page.waitForFunction((url) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.revokedUrls
          .includes(url as string), brokenPreviewUrl
      );
      const binaryReadsBeforeLarge = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.binaryReadPaths
          .length
      );
      await tree.locator('[data-path="/Workspace/large.png"]').click();
      await page.getByRole("heading", {
        name: "Image is too large to preview",
      }).waitFor();
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.binaryReadPaths
            .length
        ),
      ).toBe(binaryReadsBeforeLarge);
      await workspace.click();
      const priorFile = tree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      );
      await priorFile.click();
      const editor = page.getByRole("textbox", {
        name: "Edit workspace-note.txt",
      });
      await editor.waitFor();
      await page.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit workspace-note.txt"]',
        )?.value === "hello"
      );

      const slowFile = tree.locator('[data-path="/Workspace/slow.txt"]');
      const fastFile = tree.locator('[data-path="/Workspace/fast.txt"]');
      await slowFile.click();
      const slowEditor = page.getByRole("textbox", {
        name: "Edit slow.txt",
      });
      expect(await slowEditor.inputValue()).toBe("");
      expect(await slowEditor.isDisabled()).toBe(true);
      await fastFile.click();
      const fastEditor = page.getByRole("textbox", {
        name: "Edit fast.txt",
      });
      await page.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit fast.txt"]',
        )?.value === "fast content"
      );
      await page.waitForTimeout(130);
      expect(await fastEditor.inputValue()).toBe("fast content");
      expect(await fastEditor.isDisabled()).toBe(false);
      expect(await fastFile.getAttribute("aria-selected")).toBe("true");
      expect(
        await fastFile.evaluate((node) => getComputedStyle(node).boxShadow),
      ).toBe("none");

      const readsBeforeArrow = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.readPaths.length
      );
      await fastFile.press("ArrowUp");
      await page.waitForFunction(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path ===
          "/Workspace/slow.txt"
      );
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.readPaths.length
        ),
      ).toBe(readsBeforeArrow);
      await fastFile.click();
      await fastFile.focus();
      await fastFile.press("Shift+F10");
      const keyboardMenu = page.getByRole("menu", {
        name: "Actions for fast.txt",
      });
      await keyboardMenu.waitFor();
      await page.keyboard.press("Escape");
      await keyboardMenu.waitFor({ state: "detached" });
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path
        ),
      ).toBe("/Workspace/fast.txt");
      await fastFile.press("Shift+F10");
      await keyboardMenu.waitFor();
      await tree.evaluate((node) => {
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await keyboardMenu.waitFor({ state: "detached" });
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.getAttribute("role")
        ),
      ).toBe("tree");
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path ===
          "/Workspace/slow.txt"
      );
      await fastFile.click();
      await fastEditor.fill("keep this buffer");
      const readsBeforeSameRow = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.readPaths.length
      );
      await fastFile.click();
      expect(await fastEditor.inputValue()).toBe("keep this buffer");
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.readPaths.length
        ),
      ).toBe(readsBeforeSameRow);
      const movesBeforeRename = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
      );
      await slowFile.getByRole("button", { name: "Actions for slow.txt" })
        .click();
      await page.getByRole("menu", { name: "Actions for slow.txt" })
        .getByRole("menuitem", { name: "Rename" })
        .click();
      const renameDialog = page.getByRole("dialog", {
        name: "Rename slow.txt",
      });
      await renameDialog.getByRole("textbox", { name: "Name" })
        .fill("renamed-slow.txt");
      await renameDialog.getByRole("button", { name: "Rename" }).click();
      await page.waitForFunction((baseline) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls ===
          (baseline as number) + 1,
        movesBeforeRename,
      );
      await page.waitForTimeout(100);
      expect(
        await page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path ?? null
        ),
      ).toBe("/Workspace/renamed-slow.txt");
      await page.getByRole("heading", { name: "fast.txt", level: 2 })
        .waitFor();
      expect(await fastEditor.inputValue()).toBe("keep this buffer");
      await page.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit fast.txt"]',
        )?.disabled === false
      );
      await fastEditor.fill("fast content");
      await tree.focus();
      await page.keyboard.press("Home");
      await page.waitForFunction(() =>
        (document.activeElement as HTMLElement | null)?.dataset.path ===
          "/Shared"
      );

      const detailBox = await page.locator(".files-v2-detail").boundingBox();
      const editorBox = await fastEditor.boundingBox();
      if (!detailBox || !editorBox) {
        throw new Error("Files detail layout is missing");
      }
      expect(Math.abs(
        detailBox.y + detailBox.height - (editorBox.y + editorBox.height),
      )).toBeLessThanOrEqual(1);

      const shared = tree.locator('[data-path="/Shared"]');
      await fastEditor.fill("pending save");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      page.once("dialog", (dialog) => void dialog.accept());
      await shared.click();
      await page.waitForTimeout(130);
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Shared");
      const publicFile = tree.locator('[data-path="/Shared/public.txt"]');
      await publicFile.waitFor();
      await workspace.click();
      expect(await page.getByRole("searchbox").count()).toBe(0);
      await publicFile.waitFor();
      await publicFile.click();
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Shared");
      expect(
        await page.getByRole("button", {
          name: "Get link",
          exact: true,
        }).isEnabled(),
      ).toBe(true);
      expect(
        await page.getByRole("dialog", { name: /Share this file/ }).count(),
      ).toBe(0);

      const workspaceFile = tree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      );
      const movesBeforeForgedDrop = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
      );
      await shared.evaluate((target) => {
        const transfer = new DataTransfer();
        transfer.setData(
          "application/x-neutron-files-entry",
          "/Vault/private.txt",
        );
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        target.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      });
      await page.waitForTimeout(30);
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
        ),
      ).toBe(movesBeforeForgedDrop);
      await workspaceFile.dragTo(shared);
      const moveDialog = page.getByRole("dialog", {
        name: "Change storage policy?",
      });
      await moveDialog.waitFor();
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
        ),
      ).toBe(movesBeforeForgedDrop);
      await moveDialog.getByRole("button", { name: "Cancel" }).click();
      await workspaceFile.dragTo(shared);
      await page.getByRole("dialog", { name: "Change storage policy?" })
        .getByRole("button", { name: "Move and change storage" })
        .click();
      await page.waitForFunction((baseline) =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls ===
          (baseline as number) + 1,
        movesBeforeForgedDrop,
      );
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.lastMove
        ),
      ).toEqual({
        from: "/Workspace/workspace-note.txt",
        to: "/Shared/workspace-note.txt",
        overwrite: false,
      });
      const moved = tree.locator('[data-path="/Shared/workspace-note.txt"]');
      await moved.waitFor();
      await moved.click();
      expect(
        await page.getByRole("button", {
          name: "Get link",
          exact: true,
        }).isEnabled(),
      ).toBe(true);

      const before = await page.locator(".files-v2-workspace")
        .boundingBox();
      await projects.evaluate(async (target) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(["dropped"], "dropped.txt", { type: "text/plain" }),
        );
        transfer.items.add(
          new File(["second"], "second.txt", { type: "text/plain" }),
        );
        transfer.items.add(
          new File(["invalid"], " bad ", { type: "text/plain" }),
        );
        target.dispatchEvent(
          new DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 30)
        );
        const overlay = document.querySelector<HTMLElement>(".files-v2-drop");
        if (!overlay || getComputedStyle(overlay).pointerEvents !== "none") {
          throw new Error(
            "OS drop overlay intercepts folder targets: " +
              (overlay ? getComputedStyle(overlay).pointerEvents : "missing"),
          );
        }
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ) as HTMLElement | null;
        if (hit?.closest('[data-path="/Workspace/Projects"]') !== target) {
          throw new Error("Folder is not the active OS drop target");
        }
        hit.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        hit.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      });
      const uploadDialog = page.getByRole("dialog", {
        name: "Upload files",
      });
      await uploadDialog.waitFor();
      expect(await uploadDialog.getByText(
        "/Workspace/Projects",
        { exact: true },
      ).count()).toBe(1);
      await uploadDialog.getByText(
        "Workspace stores regular files without a public link.",
        { exact: true },
      ).waitFor();
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.writePaths
            .includes("/Workspace/Projects/dropped.txt")
        ),
      ).toBe(false);
      await uploadDialog.getByText("Files cannot store this filename.")
        .waitFor();
      await uploadDialog.getByRole("button", { name: "Remove second.txt" })
        .click();
      await uploadDialog.getByRole("button", { name: /Remove bad/u })
        .click();
      await uploadDialog.getByRole("button", { name: "Upload 1" }).click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.writePaths
          .includes("/Workspace/Projects/dropped.txt")
      );
      await page.locator('[aria-label="File transfers"]').waitFor();
      const during = await page.locator(".files-v2-workspace")
        .boundingBox();
      expect(during).toEqual(before);
      await page.getByRole("button", { name: "Dismiss transfers" }).click();
      expect(await page.locator('[aria-label="File transfers"]').count())
        .toBe(0);
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles(
        Array.from({ length: 101 }, (_, index) => ({
          name: `limit-${index}.txt`,
          mimeType: "text/plain",
          buffer: Buffer.from("x"),
        })),
      );
      const limitDialog = page.getByRole("dialog", { name: "Upload files" });
      await limitDialog.getByRole("alert").filter({
        hasText: "1 additional file was not added",
      }).waitFor();
      await limitDialog.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "auto-dismiss.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("done"),
      });
      await page.getByRole("dialog", { name: "Upload files" })
        .getByRole("button", { name: "Upload 1" })
        .click();
      const autoDismissTransfer = page.locator(
        '[aria-label="File transfers"]',
      );
      await autoDismissTransfer.waitFor();
      await autoDismissTransfer.waitFor({
        state: "detached",
        timeout: 5_000,
      });

      await projects.click();
      const nestedFile = tree.locator(
        '[data-path="/Workspace/Projects/nested.txt"]',
      );
      await nestedFile.click();
      const nestedEditor = page.getByRole("textbox", {
        name: "Edit nested.txt",
      });
      await page.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit nested.txt"]',
        )?.value === "hello"
      );
      await nestedEditor.fill("unsaved");
      const movesBeforeDirtyFolderDrag = await page.evaluate(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
      );
      await projects.dragTo(shared);
      await page.waitForTimeout(30);
      expect(
        await page.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls
        ),
      ).toBe(movesBeforeDirtyFolderDrag);
      await page.getByRole("alert")
        .filter({ hasText: "Save or discard the open file" })
        .waitFor();
      await nestedEditor.fill("hello");
      await projects.click();
      await page.getByRole("heading", { name: "Projects", level: 2 })
        .waitFor();
      await projects.getByRole("button", { name: "Actions for Projects" })
        .click();
      await page.getByRole("menu", { name: "Actions for Projects" })
        .getByRole("menuitem", { name: "Delete folder" })
        .click();
      await page.getByRole("dialog", { name: "Delete Projects?" })
        .getByRole("button", { name: "Delete folder" })
        .click();
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.removePaths
          .includes("/Workspace/Projects")
      );
      expect(
        await page.getByRole("navigation", { name: "Current folder" })
          .innerText(),
      ).toContain("Workspace");
      expect(await tree.locator('[data-path="/Workspace/Projects"]').count())
        .toBe(0);
      await page.close();

      const vaultBoundary = await browser.newPage();
      await vaultBoundary.goto(origin);
      const vaultBoundaryTree = vaultBoundary.getByRole("tree", {
        name: "Files",
      });
      await vaultBoundaryTree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      ).waitFor();
      const vaultBoundaryRoot = vaultBoundaryTree.locator(
        '[data-path="/Vault"]',
      );
      await vaultBoundaryRoot.click();
      await vaultBoundaryTree.locator('[data-path="/Vault/secret.txt"]')
        .waitFor();
      await vaultBoundaryRoot.getByRole("button", {
        name: "Actions for Vault",
      }).click();
      await vaultBoundary.getByRole("menu", { name: "Actions for Vault" })
        .getByRole("menuitem", { name: "New text file" })
        .click();
      const privateCreateDialog = vaultBoundary.getByRole("dialog", {
        name: "New file",
      });
      await privateCreateDialog.getByText("/Vault", { exact: true }).waitFor();
      await vaultBoundary.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.setVaultLocked();
        harness.emitState();
      });
      await privateCreateDialog.waitFor({ state: "detached" });
      await vaultBoundary.getByRole("heading", { name: "Open Vault" })
        .waitFor();
      expect(await vaultBoundaryRoot.getAttribute("aria-expanded")).toBe(
        "false",
      );
      expect(
        await vaultBoundaryTree.locator(
          '[data-path="/Vault/secret.txt"]',
        ).count(),
      ).toBe(0);
      await vaultBoundary.close();

      const inactivityUnlock = await browser.newPage();
      await inactivityUnlock.goto(origin);
      const inactivityTree = inactivityUnlock.getByRole("tree", {
        name: "Files",
      });
      await inactivityTree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      ).waitFor();
      await inactivityTree.locator('[data-path="/Vault"]').click();
      const secret = inactivityTree.locator(
        '[data-path="/Vault/secret.txt"]',
      );
      await secret.waitFor();
      await secret.click();
      const secretEditor = inactivityUnlock.getByRole("textbox", {
        name: "Edit secret.txt",
      });
      await inactivityUnlock.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Edit secret.txt"]',
        )?.value === "hello"
      );
      await secretEditor.fill("unsaved Vault changes");
      await inactivityUnlock.getByText("Unsaved changes", {
        exact: false,
      }).waitFor();
      await inactivityUnlock.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.setVaultLockedForReconnect();
        harness.emitState();
      });
      const inactivityGate = inactivityUnlock.locator(".files-v2-gate");
      await inactivityGate.getByRole("heading", { name: "Open Vault" })
        .waitFor();
      expect(
        await inactivityUnlock.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls
        ),
      ).toBe(0);
      await inactivityGate.getByRole("button", {
        name: "Open Vault",
        exact: true,
      }).click();
      await inactivityUnlock.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls === 1
      );
      await expect(secretEditor.inputValue()).resolves.toBe(
        "unsaved Vault changes",
      );
      expect(
        await inactivityUnlock.getByRole("navigation", {
          name: "Current folder",
        }).innerText(),
      ).toContain("Vault");
      await inactivityUnlock.close();

      const locked = await browser.newPage();
      await locked.goto(`${origin}/?locked=1`);
      const lockedTree = locked.getByRole("tree", { name: "Files" });
      await lockedTree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      ).waitFor();
      expect(
        await locked.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls
        ),
      ).toBe(0);
      const lockedVault = lockedTree.locator('[data-path="/Vault"]');
      await lockedVault.click();
      const lockedGate = locked.locator(".files-v2-gate");
      await lockedGate.getByRole("heading", { name: "Open Vault" }).waitFor();
      expect(await lockedVault.getAttribute("aria-expanded")).toBe("false");
      expect(
        await locked.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls
        ),
      ).toBe(1);
      await lockedVault.focus();
      await lockedVault.press("Shift+F10");
      const lockedVaultMenu = locked.getByRole("menu", {
        name: "Actions for Vault",
      });
      await lockedVaultMenu.waitFor();
      expect(
        await locked.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.getAttribute("role")
        ),
      ).toBe("menu");
      await locked.keyboard.press("Escape");
      await lockedVaultMenu.waitFor({ state: "detached" });
      expect(
        await locked.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.dataset.path
        ),
      ).toBe("/Vault");
      await lockedVault.press("Shift+F10");
      await lockedVaultMenu.waitFor();
      await locked.keyboard.press("Tab");
      await lockedVaultMenu.waitFor({ state: "detached" });
      await locked.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.emitState();
        harness.emitState();
      });
      await locked.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.statusCalls >= 3
      );
      expect(
        await locked.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls
        ),
      ).toBe(1);
      await lockedGate.getByRole("button", {
        name: "Open Vault",
        exact: true,
      }).click();
      await locked.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls === 2
      );
      expect(
        await lockedTree.locator('[data-path="/Shared"]').count(),
      ).toBe(1);
      expect(
        await lockedTree.locator('[data-path="/Workspace"]').count(),
      ).toBe(1);
      await locked.close();

      const uninitialized = await browser.newPage();
      await uninitialized.goto(`${origin}/?uninitialized=1`);
      const uninitializedTree = uninitialized.getByRole("tree", {
        name: "Files",
      });
      const uninitializedProjects = uninitializedTree.locator(
        '[data-path="/Workspace/Projects"]',
      );
      await uninitializedProjects.waitFor();
      await uninitializedProjects.click();
      await uninitializedTree.locator(
        '[data-path="/Workspace/Projects/nested.txt"]',
      ).waitFor();
      await uninitialized.evaluate(() => {
        (globalThis as BrowserHarnessGlobal).__filesHarness.emitState();
      });
      await uninitialized.waitForTimeout(30);
      expect(
        await uninitialized.getByRole("navigation", {
          name: "Current folder",
        }).innerText(),
      ).toContain("Projects");
      expect(await uninitializedProjects.getAttribute("aria-expanded"))
        .toBe("true");
      await uninitialized.close();

      const uninitializedAuthority = await browser.newPage();
      await uninitializedAuthority.goto(`${origin}/?uninitialized=1`);
      const uninitializedAuthorityTree = uninitializedAuthority.getByRole(
        "tree",
        { name: "Files" },
      );
      await uninitializedAuthorityTree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      ).waitFor();
      await uninitializedAuthorityTree.locator('[data-path="/Vault"]')
        .click();
      await uninitializedAuthority.getByRole("heading", {
        name: "Set up Vault",
      }).waitFor();
      await uninitializedAuthority.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.setUninitializedAuthority();
        harness.emitState();
      });
      await uninitializedAuthority.waitForFunction(() =>
        document.querySelector(
          '[aria-label="Current folder"]',
        )?.textContent?.includes("Workspace") &&
        (globalThis as BrowserHarnessGlobal).__filesHarness.listCalls
          .filter((path) => path === "/Workspace").length >= 2
      );
      await uninitializedAuthorityTree.locator(
        '[data-path="/Workspace/workspace-note.txt"]',
      ).waitFor();
      expect(
        await uninitializedAuthority.getByRole("navigation", {
          name: "Current folder",
        }).innerText(),
      ).toContain("Workspace");
      await uninitializedAuthority.close();

      const transitioning = await browser.newPage();
      await transitioning.goto(origin);
      const transitioningTree = transitioning.getByRole("tree", {
        name: "Files",
      });
      const transitioningProjects = transitioningTree.locator(
        '[data-path="/Workspace/Projects"]',
      );
      await transitioningProjects.waitFor();
      await transitioningProjects.click();
      await transitioningTree.locator(
        '[data-path="/Workspace/Projects/nested.txt"]',
      ).waitFor();
      await transitioning.evaluate(() => {
        const harness =
          (globalThis as BrowserHarnessGlobal).__filesHarness;
        harness.setVaultUninitialized();
        harness.emitState();
      });
      await transitioning.waitForTimeout(30);
      expect(
        await transitioning.getByRole("navigation", {
          name: "Current folder",
        }).innerText(),
      ).toContain("Projects");
      expect(await transitioningProjects.getAttribute("aria-expanded"))
        .toBe("true");
      await transitioning.close();

      const rotating = await browser.newPage();
      await rotating.goto(`${origin}/?rotation=1`);
      await rotating.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness
          .residentRotateCalls === 1
      );
      expect(
        await rotating.getByText("Finish security update", {
          exact: true,
        }).count(),
      ).toBe(0);
      await rotating.close();

    } finally {
      await browser?.close();
      server.stop(true);
    }
  },
  60_000,
);

type BrowserHarnessGlobal = typeof globalThis & {
  __filesHarness: {
    listCalls: string[];
    moveCalls: number;
    lastMove: {
      from: string;
      to: string;
      overwrite: boolean;
    } | null;
    writePaths: string[];
    readPaths: string[];
    binaryReadPaths: string[];
    binaryReadRequests: Array<{ path: string; ifMatch: string | null }>;
    createdUrls: string[];
    revokedUrls: string[];
    removePaths: string[];
    residentRotateCalls: number;
    statusCalls: number;
    unlockCalls: number;
    delayedStatusPending: boolean;
    delayedImagePending: boolean;
    delayedImageAborted: boolean;
    delayedPendingFolderListPending: boolean;
    beginDelayedStateRefresh(): void;
    releaseDelayedStatus(): void;
    releaseDelayedImage(): void;
    releaseDelayedPendingFolderList(): void;
    emitState(): void;
    setVaultLocked(): void;
    setUninitializedAuthority(): void;
    setVaultLockedForReconnect(): void;
    setVaultUninitialized(): void;
  };
};

async function chromiumOptions(): Promise<{ executablePath?: string }> {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    };
  }
  if (process.platform !== "linux") return {};
  let entries: string[];
  try {
    entries = await readdir("/nix/store");
  } catch {
    return {};
  }
  for (const entry of entries
    .filter((name) => name.endsWith("-playwright-chromium"))
    .sort()) {
    const candidate = join(
      "/nix/store",
      entry,
      "chrome-linux64",
      "chrome",
    );
    try {
      await access(candidate, constants.X_OK);
      return { executablePath: candidate };
    } catch {
      // Try the next exact Playwright Chromium wrapper.
    }
  }
  return {};
}

function browserHarnessSource(): string {
  return String.raw`
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import { App } from "./src/index.tsx";

    const etag = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const publicBase =
      "/app/files/_route/shares/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/";
    const textEntry = (path, publicUrl = null) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      type: "file",
      contentKind: "text",
      byteLength: 5,
      mediaType: "text/plain;charset=utf-8",
      etag,
      createdAtNs: "1",
      modifiedAtNs: "2",
      revision: "1",
      publicUrl,
    });
    const pngBytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const binaryEntry = (path, mediaType, byteLength) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      type: "file",
      contentKind: "binary",
      byteLength,
      mediaType,
      etag,
      createdAtNs: "1",
      modifiedAtNs: "2",
      revision: "1",
      publicUrl: null,
    });
    const folderEntry = (path) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      type: "folder",
      contentKind: null,
      byteLength: null,
      mediaType: null,
      etag: null,
      createdAtNs: "1",
      modifiedAtNs: "1",
      revision: "1",
      publicUrl: null,
    });
    const nodes = new Map([
      [
        "/Shared/public.txt",
        textEntry("/Shared/public.txt", publicBase + "public.txt"),
      ],
      ["/Vault/secret.txt", textEntry("/Vault/secret.txt")],
      ["/Workspace/Projects", folderEntry("/Workspace/Projects")],
      ["/Workspace/Slow", folderEntry("/Workspace/Slow")],
      ["/Workspace/Fast", folderEntry("/Workspace/Fast")],
      ["/Workspace/Pending", folderEntry("/Workspace/Pending")],
      [
        "/Workspace/Projects/nested.txt",
        textEntry("/Workspace/Projects/nested.txt"),
      ],
      [
        "/Workspace/Slow/slow-note.txt",
        textEntry("/Workspace/Slow/slow-note.txt"),
      ],
      [
        "/Workspace/Fast/fast-note.txt",
        textEntry("/Workspace/Fast/fast-note.txt"),
      ],
      [
        "/Workspace/Pending/pending-note.txt",
        textEntry("/Workspace/Pending/pending-note.txt"),
      ],
      [
        "/Workspace/workspace-note.txt",
        textEntry("/Workspace/workspace-note.txt"),
      ],
      ["/Workspace/slow.txt", textEntry("/Workspace/slow.txt")],
      ["/Workspace/fast.txt", textEntry("/Workspace/fast.txt")],
      [
        "/Workspace/broken.png",
        binaryEntry("/Workspace/broken.png", "image/png", 5),
      ],
      [
        "/Workspace/photo.png",
        binaryEntry("/Workspace/photo.png", "image/png", pngBytes.byteLength),
      ],
      [
        "/Workspace/slow-photo.png",
        binaryEntry(
          "/Workspace/slow-photo.png",
          "image/png",
          pngBytes.byteLength,
        ),
      ],
      [
        "/Workspace/large.png",
        binaryEntry("/Workspace/large.png", "image/png", 16 * 1024 * 1024 + 1),
      ],
    ]);
    for (let index = 0; index < 30; index += 1) {
      const path = "/Workspace/zz-fixture-" +
        String(index).padStart(2, "0") + ".txt";
      nodes.set(path, textEntry(path));
    }
    const counters = {
      liveEntries: "0",
      occupiedEntrySlots: "0",
      committedBodyBytes: "0",
      reservedCommittedBodyBytes: "0",
      reservedEntrySlots: "0",
      allocatedBodyBytes: "0",
      chargedMetadataBytes: "0",
      acceptedStagedBytes: "0",
      reservedStagedBytes: "0",
      detachedChargedBytes: "0",
      activeStages: "0",
      receiptLanes: "0",
      generalReceiptLanes: "0",
      reservedGeneralReceiptLanes: "0",
      reservedRevocationLanes: "0",
      filledRevocationLanes: "0",
      receiptNonceIndexes: "0",
      receiptExpiryIndexes: "0",
      cleanupJobs: "0",
    };
    const limits = {
      entries: "768",
      committedBytes: "201326592",
      objectBytes: "67108864",
      stagedBytes: "67108864",
      pendingStages: "1",
      batchOperations: "1",
      batchBytes: "67108864",
      generalReceipts: "2048",
      revocationLanes: "768",
    };
    const ready = {
      vault: "ready",
      lockEpoch: "1",
      currentGeneration: "1",
      previousGeneration: null,
      rotationRequired: false,
      reason: null,
      quota: {
        nodes: "5",
        plaintextBytes: "20",
        ciphertextBytes: "21",
        physicalBytes: "21",
        cleanupJobs: 0,
      },
      publicUsage: {
        current: counters,
        manifestLimits: limits,
        effectiveLimits: limits,
      },
      transfers: [],
    };
    const locked = {
      ...ready,
      vault: "locked",
      reason: "inactivity",
    };
    const uninitialized = {
      ...ready,
      vault: "uninitialized",
      currentGeneration: null,
    };
    let status =
      new URL(location.href).searchParams.get("locked") === "1"
        ? locked
        : new URL(location.href).searchParams.get("uninitialized") === "1"
          ? uninitialized
          : ready;
    if (new URL(location.href).searchParams.get("rotation") === "1") {
      status = {
        ...ready,
        currentGeneration: "2",
        previousGeneration: "1",
        rotationRequired: true,
      };
    }
    const listCalls = [];
    const writePaths = [];
    const readPaths = [];
    const binaryReadPaths = [];
    const binaryReadRequests = [];
    const removePaths = [];
    let moveCalls = 0;
    let residentRotateCalls = 0;
    let statusCalls = 0;
    let unlockCalls = 0;
    let failNextStatusForReconnect = false;
    let delayNextStatus = false;
    let delayedStatusResolve = null;
    let delayedImageResolve = null;
    let delayedImageSignal = null;
    let delayedPendingFolderListResolve = null;
    let delayPendingFolderList = true;
    let lastMove = null;
    const stateListeners = new Set();
    const lockVault = () => {
      status = {
        ...ready,
        vault: "locked",
        lockEpoch: "2",
        reason: "inactivity",
      };
    };
    const children = (parent) =>
      [...nodes.values()].filter((entry) => {
        const at = entry.path.lastIndexOf("/");
        const entryParent = at <= 0 ? "/" : entry.path.slice(0, at);
        return entryParent === parent;
      });
    const client = {
      async list(input) {
        listCalls.push(input.path);
        const entries = children(input.path);
        if (input.path === "/Workspace/Slow") {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        if (input.path === "/Workspace/Fast") {
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        if (input.path === "/Workspace/Pending" && delayPendingFolderList) {
          delayPendingFolderList = false;
          await new Promise((resolve) => {
            delayedPendingFolderListResolve = resolve;
          });
          delayedPendingFolderListResolve = null;
        }
        if (input.path.startsWith("/Vault") && status.vault !== "ready") {
          throw new Error("Vault is locked");
        }
        return {
          path: input.path,
          revision: "1",
          entries,
          loaded: entries.length,
          total: entries.length,
          hasMore: false,
          cursor: null,
        };
      },
      async stat(path) {
        const entry = nodes.get(path);
        if (!entry) throw new Error("not found");
        return entry;
      },
      async read(path) {
        readPaths.push(path);
        if (path === "/Workspace/slow.txt") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (path === "/Workspace/fast.txt") {
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        const entry = nodes.get(path);
        if (!entry) throw new Error("not found");
        return {
          entry,
          content:
            path === "/Workspace/slow.txt"
              ? "slow content"
              : path === "/Workspace/fast.txt"
                ? "fast content"
                : "hello",
        };
      },
      async write(input) {
        writePaths.push(input.path);
        if (
          input.path === "/Workspace/fast.txt" &&
          input.content === "pending save"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const publicUrl = input.path.startsWith("/Shared/")
          ? publicBase + input.path.slice(input.path.lastIndexOf("/") + 1)
          : null;
        const entry = {
          ...textEntry(input.path, publicUrl),
          byteLength: new TextEncoder().encode(input.content).byteLength,
        };
        nodes.set(input.path, entry);
        return entry;
      },
      async mkdir(path) {
        nodes.set(path, folderEntry(path));
      },
      async move(from, to, overwrite) {
        moveCalls += 1;
        lastMove = { from, to, overwrite };
        const entry = nodes.get(from);
        if (!entry) throw new Error("not found");
        const moved = [...nodes.entries()].filter(([path]) =>
          path === from || path.startsWith(from + "/")
        );
        for (const [path] of moved) nodes.delete(path);
        for (const [path, movedEntry] of moved) {
          const nextPath = to + path.slice(from.length);
          const name = nextPath.slice(nextPath.lastIndexOf("/") + 1);
          nodes.set(nextPath, {
            ...movedEntry,
            path: nextPath,
            name,
            publicUrl:
              movedEntry.type === "file" && nextPath.startsWith("/Shared/")
                ? publicBase + name
                : null,
          });
        }
      },
      async remove(path, recursive) {
        removePaths.push(path);
        for (const candidate of [...nodes.keys()]) {
          if (
            candidate === path ||
            (recursive && candidate.startsWith(path + "/"))
          ) {
            nodes.delete(candidate);
          }
        }
      },
      async readBinary(path, options) {
        binaryReadPaths.push(path);
        binaryReadRequests.push({
          path,
          ifMatch: options?.ifMatch ?? null,
        });
        if (options?.ifMatch !== etag) {
          throw new Error("readBinary requires the exact reviewed etag");
        }
        if (path === "/Workspace/slow-photo.png") {
          delayedImageSignal = options.signal;
          await new Promise((resolve) => {
            delayedImageResolve = resolve;
          });
          delayedImageResolve = null;
        }
        const entry = nodes.get(path);
        if (!entry) throw new Error("not found");
        const data = path === "/Workspace/photo.png"
          ? pngBytes.slice().buffer
          : new TextEncoder().encode("hello").buffer;
        return {
          entry,
          data,
          mediaType: entry.mediaType,
        };
      },
      async downloadChunk(input) {
        const entry = nodes.get(input.path);
        if (!entry || entry.type !== "file" || entry.etag !== input.etag) {
          throw new Error("not found");
        }
        const data = new TextEncoder().encode("hello").buffer;
        return {
          transferId: input.transferId,
          path: input.path,
          ordinal: input.ordinal,
          etag: input.etag,
          totalBytes: data.byteLength,
          processedBytes: data.byteLength,
          final: true,
          entry,
          data,
          mediaType: "application/octet-stream",
        };
      },
      async writeBinary(input) {
        const entry = textEntry(input.path);
        nodes.set(input.path, entry);
        return entry;
      },
      async beginUpload(input) {
        return { transferId: input.transferId, chunkBytes: 1889984 };
      },
      async uploadChunk(input) {
        return {
          phase: input.pass === "hash" ? "hashing" : "committed",
          processedBytes: input.totalBytes,
          committed: input.pass === "encrypt",
          readyForUpload: input.pass === "hash",
          entry: null,
        };
      },
      async ui(action) {
        if (action.action === "status") {
          statusCalls += 1;
          if (failNextStatusForReconnect) {
            failNextStatusForReconnect = false;
            throw new Error("Message bus disconnected");
          }
          if (delayNextStatus) {
            delayNextStatus = false;
            await new Promise((resolve) => {
              delayedStatusResolve = resolve;
            });
            delayedStatusResolve = null;
          }
          return status;
        }
        if (action.action === "unlock") {
          unlockCalls += 1;
          if (new URL(location.href).searchParams.get("locked") === "1") {
            throw new Error("Vault stayed locked");
          }
          status = {
            ...ready,
            lockEpoch: status.lockEpoch,
          };
        }
        if (action.action === "initialize" || action.action === "rotate") {
          if (action.action === "rotate") residentRotateCalls += 1;
          status = ready;
        }
        return status;
      },
      async prepareVault() {},
      async rotateVault() {},
      async spreadsheetInstalled() {
        return false;
      },
    };
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const revokedUrls = [];
    const createdUrls = [];
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = createObjectURL(blob);
      createdUrls.push(url);
      return url;
    };
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      revokedUrls.push(url);
      revokeObjectURL(url);
    };
    createRoot(root).render(createElement(App, {
      client,
      subscribeStateChange(_topic, listener) {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
    }));
    globalThis.__filesHarness = {
      get listCalls() {
        return [...listCalls];
      },
      get moveCalls() {
        return moveCalls;
      },
      get lastMove() {
        return lastMove;
      },
      get writePaths() {
        return [...writePaths];
      },
      get readPaths() {
        return [...readPaths];
      },
      get binaryReadPaths() {
        return [...binaryReadPaths];
      },
      get binaryReadRequests() {
        return binaryReadRequests.map((request) => ({ ...request }));
      },
      get revokedUrls() {
        return [...revokedUrls];
      },
      get createdUrls() {
        return [...createdUrls];
      },
      get removePaths() {
        return [...removePaths];
      },
      get residentRotateCalls() {
        return residentRotateCalls;
      },
      get statusCalls() {
        return statusCalls;
      },
      get unlockCalls() {
        return unlockCalls;
      },
      get delayedStatusPending() {
        return delayedStatusResolve !== null;
      },
      get delayedImagePending() {
        return delayedImageResolve !== null;
      },
      get delayedImageAborted() {
        return delayedImageSignal?.aborted === true;
      },
      get delayedPendingFolderListPending() {
        return delayedPendingFolderListResolve !== null;
      },
      beginDelayedStateRefresh() {
        delayNextStatus = true;
        for (const listener of [...stateListeners]) listener();
      },
      releaseDelayedStatus() {
        delayedStatusResolve?.();
      },
      releaseDelayedImage() {
        delayedImageResolve?.();
      },
      releaseDelayedPendingFolderList() {
        delayedPendingFolderListResolve?.();
      },
      emitState() {
        for (const listener of [...stateListeners]) listener();
      },
      setUninitializedAuthority() {
        status = {
          ...uninitialized,
          lockEpoch: "2",
        };
      },
      setVaultLocked() {
        lockVault();
      },
      setVaultLockedForReconnect() {
        lockVault();
        failNextStatusForReconnect = true;
      },
      setVaultUninitialized() {
        status = uninitialized;
      },
    };
  `;
}
