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
      await page.waitForTimeout(30);
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

      const workspace = tree.locator('[data-path="/Workspace"]');
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
      const search = page.getByRole("searchbox", {
        name: "Search this folder",
      });
      await search.fill("public");
      expect(await tree.locator('[data-path="/Shared/public.txt"]').count())
        .toBe(0);
      await search.fill("");
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
      await page.waitForFunction(() =>
        (globalThis as BrowserHarnessGlobal).__filesHarness.moveCalls === 1
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
      await page.locator('input[type="file"]').setInputFiles({
        name: "auto-dismiss.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("done"),
      });
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
      await page.getByRole("button", { name: "Delete Projects" }).click();
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
      await lockedTree.locator('[data-path="/Vault"]').click();
      const lockedGate = locked.locator(".files-v2-gate");
      await lockedGate.getByRole("heading", { name: "Open Vault" }).waitFor();
      expect(
        await locked.evaluate(() =>
          (globalThis as BrowserHarnessGlobal).__filesHarness.unlockCalls
        ),
      ).toBe(1);
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
  30_000,
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
    removePaths: string[];
    residentRotateCalls: number;
    statusCalls: number;
    unlockCalls: number;
    delayedStatusPending: boolean;
    beginDelayedStateRefresh(): void;
    releaseDelayedStatus(): void;
    emitState(): void;
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
        "/Workspace/workspace-note.txt",
        textEntry("/Workspace/workspace-note.txt"),
      ],
      ["/Workspace/slow.txt", textEntry("/Workspace/slow.txt")],
      ["/Workspace/fast.txt", textEntry("/Workspace/fast.txt")],
    ]);
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
    const removePaths = [];
    let moveCalls = 0;
    let residentRotateCalls = 0;
    let statusCalls = 0;
    let unlockCalls = 0;
    let failNextStatusForReconnect = false;
    let delayNextStatus = false;
    let delayedStatusResolve = null;
    let lastMove = null;
    const stateListeners = new Set();
    const children = (parent) =>
      [...nodes.values()].filter((entry) => {
        const at = entry.path.lastIndexOf("/");
        const entryParent = at <= 0 ? "/" : entry.path.slice(0, at);
        return entryParent === parent;
      });
    const client = {
      async list(input) {
        listCalls.push(input.path);
        if (input.path === "/Workspace/Slow") {
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        if (input.path === "/Workspace/Fast") {
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
        if (input.path.startsWith("/Vault") && status.vault !== "ready") {
          throw new Error("Vault is locked");
        }
        const entries = children(input.path);
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
        nodes.delete(from);
        const name = to.slice(to.lastIndexOf("/") + 1);
        nodes.set(to, {
          ...entry,
          path: to,
          name,
          publicUrl:
            entry.type === "file" && to.startsWith("/Shared/")
              ? publicBase + name
              : null,
        });
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
      async readBinary(path) {
        const entry = nodes.get(path);
        if (!entry) throw new Error("not found");
        return {
          entry,
          data: new TextEncoder().encode("hello").buffer,
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
      beginDelayedStateRefresh() {
        delayNextStatus = true;
        for (const listener of [...stateListeners]) listener();
      },
      releaseDelayedStatus() {
        delayedStatusResolve?.();
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
      setVaultLockedForReconnect() {
        status = {
          ...ready,
          vault: "locked",
          lockEpoch: "2",
          reason: "inactivity",
        };
        failNextStatusForReconnect = true;
      },
      setVaultUninitialized() {
        status = uninitialized;
      },
    };
  `;
}
