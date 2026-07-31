import {
  expect,
  test,
  type APIRequestContext,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "../../packages/neutron-provision/src/local_session.ts";

type LiveEndpoint = {
  endpoint: string;
  role: string;
  connected: boolean;
};

type StorageTripwireState = {
  installed: string[];
  accesses: string[];
};

const STORAGE_APIS = [
  "caches",
  "indexedDB",
  "localStorage",
  "sessionStorage",
] as const;

test("Files auto-opens a nested Vault across reloads and purges authority-bound plaintext without browser storage", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(360_000);
  await installFilesStorageTripwires(page);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await assertCredentiallessFilesBackground(page);
  await openFiles(page);

  let files = filesFrame(page);
  await ensureFilesReady(page, files);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const folderName = `Private-${suffix}`;
  const folderPath = `/Vault/${folderName}`;
  const filename = `backend-persistence-${suffix}.txt`;
  const filePath = `${folderPath}/${filename}`;
  const privateText =
    `private authority sentinel ${suffix}\n` +
    "This must survive only in the encrypted Files backend.";

  await initializeVaultIfNeeded(page, files);
  await createFolder(files, "/Vault", folderName);
  await openFolder(files, folderPath);
  await createTextFile(files, folderPath, filename, privateText);
  expect(
    await callFilesTool(files.locator("body"), "stat", { path: filePath }),
  ).toEqual(
    expect.objectContaining({
      path: filePath,
      storageClass: "vault",
      publicUrl: null,
    }),
  );
  await assertFilesStorageTripwires(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await loginAsDeveloper(page, runtime);
  await assertCredentiallessFilesBackground(page);
  files = filesFrame(page);

  await expect(files.locator("body")).not.toContainText(filename);
  await expect(files.locator("body")).not.toContainText(privateText);
  await assertFilesStorageTripwires(page);

  await ensureFilesReady(page, files);
  await openVaultAutomatically(page, files);
  await openFolder(files, folderPath);
  const row = fileRow(files, filePath);
  await expect(row).toBeVisible();
  await row.click();
  const editor = files.getByRole("textbox", { name: `Edit ${filename}` });
  await expect(editor).toHaveValue(privateText);
  await assertFilesStorageTripwires(page);

  const unsavedText = `unsaved authority-bound buffer ${suffix}`;
  await editor.fill(unsavedText);
  const unauthorizedSeed = (runtime.developerIdentitySeed + 1) % 256;
  const authorityError = await switchToUnauthorizedIdentity(
    page,
    unauthorizedSeed,
  );
  expect(authorityError).toMatch(/is not authorized/u);
  await expect(page.locator('[data-tid="auth-error"]')).toBeVisible();
  await expect(page.locator(filesTileSelector())).toHaveCount(0);
  await expect(
    page.locator(
      'iframe[data-tid="app-background-frame"][data-app-id="files"]',
    ),
  ).toHaveCount(0);

  await loginAsDeveloper(page, runtime);
  await expect(page.locator('[data-tid="auth-error"]')).toHaveCount(0);
  await assertCredentiallessFilesBackground(page);
  await openFiles(page);
  files = filesFrame(page);
  await ensureFilesReady(page, files);
  await expect(files.locator("body")).not.toContainText(unsavedText);
  await expect(files.locator("body")).not.toContainText(privateText);
  await openVaultAutomatically(page, files);
  await openFolder(files, folderPath);
  await fileRow(files, filePath).click();
  await expect(
    files.getByRole("textbox", { name: `Edit ${filename}` }),
  ).toHaveValue(privateText);
  await assertFilesStorageTripwires(page);
});

test("nested Shared and Workspace folders inherit policy while drag-out revokes and drag-in republishes", async ({
  context,
  page,
}, testInfo) => {
  testInfo.setTimeout(360_000);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await assertCredentiallessFilesBackground(page);
  await openFiles(page);
  const files = filesFrame(page);
  await ensureFilesReady(page, files);

  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: new URL(page.url()).origin },
  );

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const workspaceFolderName = `Work-${suffix}`;
  const workspaceFolderPath = `/Workspace/${workspaceFolderName}`;
  const workspaceName = `private-${suffix}.txt`;
  const workspacePath = `${workspaceFolderPath}/${workspaceName}`;
  const workspaceText = `private Workspace note ${suffix}\n`;
  const sharedFolderName = `Public-${suffix}`;
  const sharedFolderPath = `/Shared/${sharedFolderName}`;
  const sharedName = `public-${suffix}.txt`;
  const sharedPath = `${sharedFolderPath}/${sharedName}`;
  const movedWorkspacePath = `${workspaceFolderPath}/${sharedName}`;
  const publicText = `automatically shared text ${suffix}\n`;

  await createFolder(files, "/Workspace", workspaceFolderName);
  await openFolder(files, workspaceFolderPath);
  await createTextFile(
    files,
    workspaceFolderPath,
    workspaceName,
    workspaceText,
  );
  await expect(
    files.getByRole("button", { name: "Get link", exact: true }),
  ).toHaveCount(0);
  expect(
    await callFilesTool(files.locator("body"), "stat", {
      path: workspacePath,
    }),
  ).toEqual(
    expect.objectContaining({
      path: workspacePath,
      storageClass: "workspace",
      publicUrl: null,
    }),
  );

  await openFolder(files, "/Shared");
  await createFolder(files, "/Shared", sharedFolderName);
  await openFolder(files, sharedFolderPath);
  await createTextFile(files, sharedFolderPath, sharedName, publicText);

  const getLink = files.getByRole("button", {
    name: "Get link",
    exact: true,
  });
  await expect(getLink).toBeEnabled({ timeout: 120_000 });
  await getLink.click();
  const shareUrl = await waitForPublicLink(page, sharedName);
  expect(
    await callFilesTool(files.locator("body"), "stat", {
      path: sharedPath,
    }),
  ).toEqual(
    expect.objectContaining({
      path: sharedPath,
      storageClass: "shared",
      publicUrl: expect.any(String),
    }),
  );
  const parsedShareUrl = new URL(shareUrl);
  expect(parsedShareUrl.origin).toBe(await filesTileOrigin(page));
  expect(parsedShareUrl.pathname).toMatch(
    new RegExp(
      `^/app/files/_route/shares/[0-9a-f]{64}/${escapeRegex(sharedName)}$`,
      "u",
    ),
  );

  const published = await context.request.get(shareUrl);
  expect(published.status()).toBe(200);
  expect(published.headers()["content-type"]).toContain(
    "text/plain; charset=utf-8",
  );
  expect(published.headers()["content-disposition"]).toBeUndefined();
  expect(await published.text()).toBe(publicText);

  const extensionProbeName = `extension-wins-${suffix}.bin`;
  const extensionProbePath = `${sharedFolderPath}/${extensionProbeName}`;
  const extensionProbeBody = Buffer.from(
    `valid UTF-8 whose .bin extension controls delivery ${suffix}\n`,
  );
  await files.locator('input[type="file"]').setInputFiles({
    name: extensionProbeName,
    mimeType: "text/plain",
    buffer: extensionProbeBody,
  });
  const extensionProbeRow = fileRow(files, extensionProbePath);
  await expect(extensionProbeRow).toBeVisible({ timeout: 120_000 });
  await extensionProbeRow.click();
  await expect(getLink).toBeEnabled({ timeout: 120_000 });
  await getLink.click();
  const extensionProbeUrl = await waitForPublicLink(
    page,
    extensionProbeName,
  );
  expect(
    await callFilesTool(files.locator("body"), "stat", {
      path: extensionProbePath,
    }),
  ).toEqual(
    expect.objectContaining({
      path: extensionProbePath,
      storageClass: "shared",
      contentKind: "binary",
      publicUrl: expect.any(String),
    }),
  );
  const extensionProbe = await context.request.get(extensionProbeUrl);
  expect(extensionProbe.status()).toBe(200);
  expect(extensionProbe.headers()["content-type"]).toContain(
    "application/octet-stream",
  );
  expect(extensionProbe.headers()["content-disposition"]).toMatch(
    /^attachment;/u,
  );
  expect(await extensionProbe.body()).toEqual(extensionProbeBody);

  await dispatchInternalFileDrag(
    fileRow(files, sharedPath),
    fileRow(files, workspaceFolderPath),
  );
  await expect(fileRow(files, sharedPath)).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(fileRow(files, movedWorkspacePath)).toBeVisible({
    timeout: 120_000,
  });
  await expectPublicLinkRevoked(context.request, shareUrl);

  await fileRow(files, movedWorkspacePath).click();
  await expect(
    files.getByRole("button", { name: "Get link", exact: true }),
  ).toHaveCount(0);
  await expect(
    files.getByRole("textbox", { name: `Edit ${sharedName}` }),
  ).toHaveValue(publicText);
  expect(
    await callFilesTool(files.locator("body"), "stat", {
      path: movedWorkspacePath,
    }),
  ).toEqual(
    expect.objectContaining({
      path: movedWorkspacePath,
      storageClass: "workspace",
      publicUrl: null,
    }),
  );

  await dispatchInternalFileDrag(
    fileRow(files, movedWorkspacePath),
    fileRow(files, sharedFolderPath),
  );
  await expect(fileRow(files, movedWorkspacePath)).toHaveCount(0, {
    timeout: 120_000,
  });
  const resharedRow = fileRow(files, sharedPath);
  await expect(resharedRow).toBeVisible({ timeout: 120_000 });
  await resharedRow.click();
  await expect(getLink).toBeEnabled({ timeout: 120_000 });
  await getLink.click();
  const resharedUrl = await waitForPublicLink(page, sharedName, shareUrl);
  expect(
    await callFilesTool(files.locator("body"), "stat", {
      path: sharedPath,
    }),
  ).toEqual(
    expect.objectContaining({
      path: sharedPath,
      storageClass: "shared",
      publicUrl: expect.any(String),
    }),
  );
  const reshared = await context.request.get(resharedUrl);
  expect(reshared.status()).toBe(200);
  expect(reshared.headers()["content-type"]).toContain(
    "text/plain; charset=utf-8",
  );
  expect(reshared.headers()["content-disposition"]).toBeUndefined();
  expect(await reshared.text()).toBe(publicText);
});

test("Shared uploads and serves a binary larger than the old 16 MiB limit", async ({
  context,
  page,
}, testInfo) => {
  testInfo.setTimeout(360_000);
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await assertCredentiallessFilesBackground(page);
  await openFiles(page);
  const files = filesFrame(page);
  await ensureFilesReady(page, files);

  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: new URL(page.url()).origin },
  );

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const folderName = `Large-${suffix}`;
  const folderPath = `/Shared/${folderName}`;
  const filename = `over-16mib-${suffix}.bin`;
  const filePath = `${folderPath}/${filename}`;
  const payload = Buffer.alloc(17 * 1_024 * 1_024 + 17, 0x5a);
  const expectedHash = createHash("sha256").update(payload).digest("hex");

  await openFolder(files, "/Shared");
  await createFolder(files, "/Shared", folderName);
  await openFolder(files, folderPath);
  const workspace = files.locator(".files-v2-workspace");
  const workspaceBeforeTransfer = await workspace.boundingBox();
  expect(workspaceBeforeTransfer).not.toBeNull();
  await files.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: payload,
  });
  const transferToast = files.locator('[aria-label="File transfers"]');
  await expect(transferToast).toBeVisible({ timeout: 120_000 });
  expect(await workspace.boundingBox()).toEqual(workspaceBeforeTransfer);
  const row = fileRow(files, filePath);
  await expect(row).toBeVisible({ timeout: 300_000 });
  await row.click();
  const getLink = files.getByRole("button", {
    name: "Get link",
    exact: true,
  });
  await expect(getLink).toBeEnabled({ timeout: 300_000 });
  await getLink.click();
  const shareUrl = await waitForPublicLink(page, filename);
  expect(
    await callFilesTool(files.locator("body"), "stat", { path: filePath }),
  ).toEqual(
    expect.objectContaining({
      path: filePath,
      storageClass: "shared",
      publicUrl: expect.any(String),
    }),
  );
  const published = await context.request.get(shareUrl, {
    timeout: 300_000,
  });
  expect(published.status()).toBe(200);
  expect(published.headers()["content-type"]).toContain(
    "application/octet-stream",
  );
  expect(published.headers()["content-disposition"]).toMatch(/^attachment;/u);
  const publishedBody = await published.body();
  expect(publishedBody.byteLength).toBe(payload.byteLength);
  expect(
    createHash("sha256").update(publishedBody).digest("hex"),
  ).toBe(expectedHash);
  await expect(transferToast).toHaveCount(0, { timeout: 10_000 });

  await files.getByRole("button", { name: `Delete ${filename}` }).click();
  await files
    .getByRole("dialog", { name: `Delete ${filename}?` })
    .getByRole("button", { name: "Delete file" })
    .click();
  await expectPublicLinkRevoked(context.request, shareUrl);
});

test("Files endpoints survive an equivalent registry refresh", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { __neutronConnectCount?: number };
    state.__neutronConnectCount = 0;
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type === "neutron:msgbus:connect") {
        state.__neutronConnectCount = (state.__neutronConnectCount ?? 0) + 1;
      }
    });
  });

  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await openFiles(page);

  const files = filesFrame(page);
  await ensureFilesReady(page, files);
  const body = files.locator("body");
  await waitForFilesEndpoints(body);
  const connectionsBefore = await body.evaluate(
    () =>
      (window as typeof window & { __neutronConnectCount?: number })
        .__neutronConnectCount ?? 0,
  );
  expect(connectionsBefore).toBe(1);

  await page.locator('[data-tid="kernel-tray-toggle"]').click();
  await page.locator('[data-tid="kernel-tray-settings"]').click();
  await expect(page.locator('[data-tid="kernel-settings"]')).toBeVisible();
  await expect(page.locator(".settings-refresh-time")).toContainText("Updated");
  await page.locator('[data-tid="settings-back"]').click();

  await waitForFilesEndpoints(body);
  expect(
    await body.evaluate(
      () =>
        (window as typeof window & { __neutronConnectCount?: number })
          .__neutronConnectCount ?? 0,
    ),
  ).toBe(connectionsBefore);

  const filename = `registry-refresh-${Date.now()}.txt`;
  await createTextFile(
    files,
    "/Workspace",
    filename,
    "registry refresh stayed live\n",
  );
  await expect(files.getByRole("alert")).toHaveCount(0);
});

test("a persisted Files tile waits for its credentialless background on cold reload", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  await openAuthorizedKernel(page, runtime);
  await openFiles(page);
  let files = filesFrame(page);
  await ensureFilesReady(page, files);
  const filename = `cold-reload-${Date.now()}.txt`;
  const filePath = `/Workspace/${filename}`;
  const content = "backend state after a delayed resident\n";
  await createTextFile(files, "/Workspace", filename, content);

  let delayedBackground = false;
  await page.route("**/app/files/service.html*", async (route) => {
    if (!delayedBackground) {
      delayedBackground = true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    await route.continue();
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await loginAsDeveloper(page, runtime);
  files = filesFrame(page);
  await ensureFilesReady(page, files);
  await expect(fileRow(files, filePath)).toBeVisible({ timeout: 30_000 });
  await fileRow(files, filePath).click();
  await expect(
    files.getByRole("textbox", { name: `Edit ${filename}` }),
  ).toHaveValue(content);
  expect(delayedBackground).toBe(true);
  await expect(files.getByRole("alert")).toHaveCount(0);
});

test("the Files credentialless resident receives a blank storage partition in each top-level document", async ({
  context,
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  const sentinel = `files-storage-probe-${Date.now()}`;
  await openAuthorizedKernel(page, runtime);
  const firstBackground = await assertCredentiallessFilesBackground(page);
  await page.evaluate((key) => localStorage.setItem(key, "ordinary"), sentinel);

  const firstProbe = await firstBackground
    .contentFrame()
    .locator("body")
    .evaluate(async (_body, key) => {
      const databases = typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : [];
      const before = {
        credentialless: (
          window as typeof window & { credentialless?: unknown }
        ).credentialless,
        local: localStorage.getItem(key),
        cache: await caches.match(`./${key}`).then((value) =>
          value?.text() ?? null
        ),
        database: databases.some((database) => database.name === key),
      };
      localStorage.setItem(key, "ephemeral");
      const cache = await caches.open(key);
      await cache.put(`./${key}`, new Response("ephemeral"));
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(key, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      return before;
    }, sentinel);
  expect(firstProbe).toEqual({
    credentialless: true,
    local: null,
    cache: null,
    database: false,
  });

  const secondPage = await context.newPage();
  try {
    await openAuthorizedKernel(secondPage, runtime);
    const secondBackground =
      await assertCredentiallessFilesBackground(secondPage);
    expect(
      new URL((await firstBackground.getAttribute("src"))!).origin,
    ).toBe(new URL((await secondBackground.getAttribute("src"))!).origin);
    const secondProbe = await secondBackground
      .contentFrame()
      .locator("body")
      .evaluate(async (_body, key) => {
        const databases = typeof indexedDB.databases === "function"
          ? await indexedDB.databases()
          : [];
        return {
          credentialless: (
            window as typeof window & { credentialless?: unknown }
          ).credentialless,
          local: localStorage.getItem(key),
          cache: await caches.match(`./${key}`).then((value) =>
            value?.text() ?? null
          ),
          database: databases.some((database) => database.name === key),
        };
      }, sentinel);
    expect(secondProbe).toEqual({
      credentialless: true,
      local: null,
      cache: null,
      database: false,
    });
  } finally {
    await secondPage.close();
  }
});

async function installFilesStorageTripwires(page: Page): Promise<void> {
  await page.addInitScript((names) => {
    if (!location.pathname.startsWith("/app/files/")) return;
    const state: StorageTripwireState = { installed: [], accesses: [] };
    Object.defineProperty(window, "__NEUTRON_FILES_STORAGE_TRIPWIRE__", {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    for (const name of names) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: false,
          get() {
            state.accesses.push(name);
            throw new Error(`Files production source accessed ${name}`);
          },
        });
        state.installed.push(name);
      } catch {
        state.accesses.push(`instrumentation-failed:${name}`);
      }
    }
  }, [...STORAGE_APIS]);
}

async function assertFilesStorageTripwires(page: Page): Promise<void> {
  const frames = [
    filesFrame(page).locator("body"),
    page
      .frameLocator(
        'iframe[data-tid="app-background-frame"][data-app-id="files"]',
      )
      .locator("body"),
  ];
  for (const body of frames) {
    const state = await body.evaluate(() => (
      window as typeof window & {
        __NEUTRON_FILES_STORAGE_TRIPWIRE__?: StorageTripwireState;
      }
    ).__NEUTRON_FILES_STORAGE_TRIPWIRE__ ?? null);
    expect(state).toEqual({
      installed: [...STORAGE_APIS],
      accesses: [],
    });
  }
}

async function assertCredentiallessFilesBackground(
  page: Page,
): Promise<Locator> {
  const background = page.locator(
    'iframe[data-tid="app-background-frame"][data-app-id="files"]',
  );
  await expect(background).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  await expect(background).toHaveAttribute("credentialless", "true");
  await expect(background).toHaveAttribute(
    "data-resident-launch",
    "ready",
    { timeout: 120_000 },
  );
  await expect(background).not.toHaveAttribute(
    "data-resident-launch-error",
    /.+/u,
  );
  const source = await background.getAttribute("src");
  expect(source).not.toBeNull();
  const expectedOrigin = new URL(source!, page.url()).origin;
  await expect
    .poll(
      () =>
        background
          .contentFrame()
          .locator("body")
          .evaluate(() => location.origin),
      { timeout: 120_000 },
    )
    .toBe(expectedOrigin);
  expect(
    await background
      .contentFrame()
      .locator("body")
      .evaluate(
        () =>
          (window as typeof window & { credentialless?: unknown })
            .credentialless,
      ),
  ).toBe(true);
  return background;
}

async function ensureFilesReady(
  _page: Page,
  files: FrameLocator,
): Promise<void> {
  const tree = files.getByRole("tree", { name: "Files" });
  await expect(tree).toBeVisible({ timeout: 120_000 });
  for (const path of ["/Shared", "/Vault", "/Workspace"]) {
    await expect(fileRow(files, path)).toBeVisible({ timeout: 120_000 });
  }
  await expect(fileRow(files, "/Workspace")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    files
      .locator(".files-v2-header")
      .getByRole("button", { name: "Create text file" }),
  ).toBeEnabled({ timeout: 120_000 });
  await expect(files.getByRole("alert")).toHaveCount(0);
}

async function initializeVaultIfNeeded(
  page: Page,
  files: FrameLocator,
): Promise<void> {
  const vault = fileRow(files, "/Vault");
  await vault.click();
  const getStarted = files.getByRole("button", {
    name: "Get started",
    exact: true,
  });
  const tryAgain = files.getByRole("button", {
    name: "Try again",
    exact: true,
  });
  const createText = files
    .locator(".files-v2-header")
    .getByRole("button", { name: "Create text file" });
  const readState = async (): Promise<
    "ready" | "setup" | "retry" | "waiting"
  > => {
    if (
      await createText.isEnabled() &&
      (await vault.getAttribute("class"))?.includes(
        "files-v2-row--current",
      )
    ) {
      return "ready";
    }
    if (await getStarted.isVisible()) return "setup";
    if (await tryAgain.isVisible()) return "retry";
    return "waiting";
  };

  let observed = await readState();
  const deadline = Date.now() + 120_000;
  while (observed === "waiting" && Date.now() < deadline) {
    await page.waitForTimeout(100);
    observed = await readState();
  }
  if (observed === "ready") return;
  if (observed === "setup") {
    await getStarted.click();
    await completeVaultInitialization(page, files);
    await expect(vault).toHaveClass(/files-v2-row--current/u);
    await expect(createText).toBeEnabled({ timeout: 120_000 });
    return;
  }
  throw new Error(
    observed === "retry"
      ? "Vault required recovery instead of opening automatically"
      : "Vault did not auto-open or offer first-time setup",
  );
}

async function openVaultAutomatically(
  page: Page,
  files: FrameLocator,
): Promise<void> {
  const vault = fileRow(files, "/Vault");
  const getStarted = files.getByRole("button", {
    name: "Get started",
    exact: true,
  });
  const tryAgain = files.getByRole("button", {
    name: "Try again",
    exact: true,
  });
  const createText = files
    .locator(".files-v2-header")
    .getByRole("button", { name: "Create text file" });
  const lifecycleDialog = page.locator(
    '[data-tid="vetkeys-lifecycle-dialog"]',
  );

  await vault.click();
  const readState = async (): Promise<
    "ready" | "setup" | "retry" | "dialog" | "waiting"
  > => {
    if (await getStarted.isVisible()) return "setup";
    if (await tryAgain.isVisible()) return "retry";
    if (await lifecycleDialog.isVisible()) return "dialog";
    if (
      await createText.isEnabled() &&
      (await vault.getAttribute("class"))?.includes(
        "files-v2-row--current",
      )
    ) {
      return "ready";
    }
    return "waiting";
  };
  let observed = await readState();
  const deadline = Date.now() + 120_000;
  while (observed === "waiting" && Date.now() < deadline) {
    await page.waitForTimeout(100);
    observed = await readState();
  }
  if (observed !== "ready") {
    throw new Error(
      `initialized Vault did not auto-open without setup or recovery UI: ${observed}`,
    );
  }
}

async function completeVaultInitialization(
  page: Page,
  files: FrameLocator,
): Promise<void> {
  const dialog = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
  const createText = files
    .locator(".files-v2-header")
    .getByRole("button", { name: "Create text file" });
  const readState = async (): Promise<
    "ready" | "dialog" | "waiting"
  > =>
    await createText.isEnabled()
      ? "ready"
      : await dialog.isVisible()
        ? "dialog"
        : "waiting";
  for (let approvals = 0; approvals < 3; approvals += 1) {
    await expect
      .poll(readState, { timeout: 120_000 })
      .not.toBe("waiting");
    const outcome = await readState();
    if (outcome === "ready") return;
    const approve = dialog.locator('[data-tid="vetkeys-lifecycle-approve"]');
    await expect(approve).toBeEnabled();
    const previousTitle =
      (await dialog.locator(".title").textContent())?.trim() ?? "";
    await approve.click();
    await expect
      .poll(async () => {
        if (await createText.isEnabled()) return "ready";
        if (!(await dialog.isVisible())) return "hidden";
        return (await dialog.locator(".title").textContent())?.trim() ??
          "hidden";
      }, { timeout: 120_000 })
      .not.toBe(previousTitle);
  }
  throw new Error("Vault setup exceeded its lifecycle approvals");
}

async function openFolder(
  files: FrameLocator,
  path: string,
): Promise<void> {
  const row = fileRow(files, path);
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true", {
    timeout: 120_000,
  });
  await expect(
    files
      .getByRole("navigation", { name: "Current folder" })
      .getByRole("button", {
        name: new RegExp(
          `^/?${escapeRegex(path.slice(path.lastIndexOf("/") + 1))}$`,
          "u",
        ),
      }),
  ).toBeVisible({ timeout: 120_000 });
}

async function createFolder(
  files: FrameLocator,
  parentPath: string,
  folderName: string,
): Promise<void> {
  await files
    .locator(".files-v2-header")
    .getByRole("button", { name: "Create folder" })
    .click();
  const form = files.locator(".files-v2-create");
  await form
    .getByRole("textbox", { name: "New folder name" })
    .fill(folderName);
  await form.getByRole("button", { name: "Create folder" }).click();
  await expect(fileRow(files, `${parentPath}/${folderName}`)).toBeVisible({
    timeout: 120_000,
  });
}

async function createTextFile(
  files: FrameLocator,
  parentPath: string,
  filename: string,
  content: string,
): Promise<void> {
  await files
    .locator(".files-v2-header")
    .getByRole("button", { name: "Create text file" })
    .click();
  const form = files.locator(".files-v2-create");
  await form
    .getByRole("textbox", { name: "New file name" })
    .fill(filename);
  await form.getByRole("button", { name: "Create file" }).click();
  const row = fileRow(files, `${parentPath}/${filename}`);
  await expect(row).toBeVisible({ timeout: 120_000 });
  await row.click();
  const editor = files.getByRole("textbox", { name: `Edit ${filename}` });
  await expect(editor).toBeEnabled({ timeout: 120_000 });
  await editor.fill(content);
  const details = files.locator(".files-v2-detail-header");
  await expect(details).toContainText("Unsaved changes");
  const save = files.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(details).not.toContainText("Unsaved changes", {
    timeout: 120_000,
  });
  await expect(save).toBeDisabled({ timeout: 120_000 });
  await expect(editor).toHaveValue(content);
}

function fileRow(files: FrameLocator, path: string): Locator {
  return files
    .getByRole("tree", { name: "Files" })
    .locator(`[data-path="${escapeCssAttribute(path)}"]`);
}

async function dispatchInternalFileDrag(
  source: Locator,
  target: Locator,
): Promise<void> {
  await expect(source).toBeVisible({ timeout: 120_000 });
  await expect(target).toBeVisible({ timeout: 120_000 });
  const targetHandle = await target.elementHandle();
  if (!targetHandle) {
    throw new Error("Files drag target detached before dispatch");
  }
  try {
    await source.evaluate((sourceElement, targetElement) => {
      const transfer = new DataTransfer();
      const dispatch = (
        element: Element,
        type: "dragstart" | "dragenter" | "dragover" | "drop" | "dragend",
      ): void => {
        element.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      };
      dispatch(sourceElement, "dragstart");
      dispatch(targetElement, "dragenter");
      dispatch(targetElement, "dragover");
      dispatch(targetElement, "drop");
      dispatch(sourceElement, "dragend");
    }, targetHandle);
  } finally {
    await targetHandle.dispose();
  }
}

function escapeCssAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function callFilesTool(
  frameBody: Locator,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  return execMessageBusFromFrame(frameBody, "tools.call", {
    target: "app:files:background",
    name,
    arguments: argumentsValue,
  });
}

async function openAuthorizedKernel(
  page: Page,
  runtime: LocalNeutronRuntime,
): Promise<void> {
  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  await loginAsDeveloper(page, runtime);
}

async function loginAsDeveloper(
  page: Page,
  runtime: LocalNeutronRuntime,
): Promise<void> {
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
}

async function switchToUnauthorizedIdentity(
  page: Page,
  identitySeed: number,
): Promise<string> {
  return page.evaluate(async (seed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    try {
      const principal = await login(seed);
      return `Unexpectedly authorized local Playwright principal ${principal}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, identitySeed);
}

async function openFiles(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
  await page.locator('[data-tid="launcher-tile-files-files"]').click();
}

function filesFrame(page: Page): FrameLocator {
  return page.frameLocator(filesTileSelector()).last();
}

async function filesTileOrigin(page: Page): Promise<string> {
  const source = await page
    .locator(filesTileSelector())
    .last()
    .getAttribute("src");
  if (!source) throw new Error("Files tile does not have a source URL");
  return new URL(source).origin;
}

async function waitForPublicLink(
  page: Page,
  filename: string,
  previousUrl?: string,
): Promise<string> {
  const expectedOrigin = await filesTileOrigin(page);
  const expectedPath = new RegExp(
    `^/app/files/_route/shares/[0-9a-f]{64}/${escapeRegex(filename)}$`,
    "u",
  );
  await expect
    .poll(
      async () => {
        const candidate = await page.evaluate(() =>
          navigator.clipboard.readText()
        );
        if (!candidate || candidate === previousUrl) return false;
        try {
          const parsed = new URL(candidate);
          return (
            parsed.origin === expectedOrigin &&
            expectedPath.test(parsed.pathname)
          );
        } catch {
          return false;
        }
      },
      {
        message: `clipboard did not receive the public link for ${filename}`,
        timeout: 120_000,
      },
    )
    .toBe(true);
  return page.evaluate(() => navigator.clipboard.readText());
}

async function expectPublicLinkRevoked(
  request: APIRequestContext,
  url: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.head(url, {
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const status = response.status();
      await response.dispose();
      return status;
    }, { timeout: 120_000 })
    .toBe(404);

  const response = await request.get(url, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  expect(response.status()).toBe(404);
  await response.dispose();
}

async function listEndpoints(frameBody: Locator): Promise<LiveEndpoint[]> {
  const response = (await execMessageBusFromFrame(frameBody, "tools.call", {
    target: "kernel",
    name: "endpoints.list",
    arguments: {},
  })) as { endpoints?: LiveEndpoint[] };
  if (!Array.isArray(response.endpoints)) {
    throw new Error("Kernel returned an invalid endpoint list");
  }
  return response.endpoints;
}

async function waitForFilesEndpoints(frameBody: Locator): Promise<void> {
  await expect
    .poll(() => listEndpoints(frameBody))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "app:files:background",
          role: "background",
          connected: true,
        }),
        expect.objectContaining({
          endpoint: expect.stringMatching(/^app:files:tile:/u),
          role: "tile",
          connected: true,
        }),
      ]),
    );
}

async function execMessageBusFromFrame(
  frameBody: Locator,
  action: string,
  payload: unknown,
): Promise<unknown> {
  const id = Math.floor(Date.now() + Math.random() * 100_000);
  return frameBody.evaluate(
    (_element, request) =>
      new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          reject(new Error(`Message bus action ${request.action} timed out`));
        }, 60_000);
        function onMessage(event: MessageEvent): void {
          const data = event.data as {
            type?: string;
            id?: number;
            ok?: unknown;
            error?: unknown;
          };
          if (data?.type !== "response" || data.id !== request.id) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", onMessage);
          if (Object.hasOwn(data, "error")) reject(data.error);
          else resolve(data.ok);
        }
        window.addEventListener("message", onMessage);
        window.parent.postMessage(
          {
            type: "exec",
            id: request.id,
            payload: { action: request.action, payload: request.payload },
          },
          "*",
        );
      }),
    { action, payload, id },
  );
}

function filesTileSelector(): string {
  return 'iframe[data-app-id="files"][data-tile-id="files"]';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
