import esbuild from "esbuild";
import { chromium } from "@playwright/test";
import { serve } from "bun";
import { constants } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFilesInlineWorkerBundle,
  filesInlineCryptoWorkerPlugin,
} from "./worker_bundle.ts";

export const FILES_WORKER_BROWSER_EVIDENCE_PATH =
  ".neutron-worker-browser-evidence.json";
export const FILES_WORKER_BROWSER_EVIDENCE_SCHEMA =
  "neutron.files.worker-browser-evidence.v2";

const thisFile = fileURLToPath(import.meta.url);
export const DEFAULT_BROWSER_FILES_ROOT = resolve(dirname(thisFile), "..");

export const FILES_WORKER_INITIAL_STATUS = Object.freeze({
  configured: false,
  currentGeneration: null,
  previousGeneration: null,
  unlocked: false,
  unlockedGeneration: null,
  pendingGeneration: null,
  inactivityExpiresAt: null,
  contentCipherCount: 0,
  retryFrameCount: 0,
});

export type FilesWorkerBrowserEvidence = Readonly<{
  schema: typeof FILES_WORKER_BROWSER_EVIDENCE_SCHEMA;
  engine: Readonly<{
    name: "chromium";
    version: string;
  }>;
  frame: Readonly<{
    credentialless: false;
    indexed_db: true;
    path: "/frame";
  }>;
  worker: Readonly<{
    sha256: string;
    source_bytes: number;
    initial_status: typeof FILES_WORKER_INITIAL_STATUS;
  }>;
  negative_control: Readonly<{
    credentialless_frame_rejected: true;
    reason: "persistent_resident_required";
  }>;
}>;

type BrowserResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function chromiumLaunchOptions(): Promise<{
  executablePath?: string;
  args?: string[];
}> {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
    await discoverNixPlaywrightChromium();
  const args =
    process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/u).filter(Boolean) ?? [];
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(args.length > 0 ? { args } : {}),
  };
}

async function discoverNixPlaywrightChromium(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = await readdir("/nix/store");
  } catch {
    return undefined;
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
      return candidate;
    } catch {
      // Continue to another exact Nix Playwright wrapper.
    }
  }
  return undefined;
}

export function assertFilesWorkerBrowserEvidence(
  value: unknown,
  expectedWorker: { sha256: string; sourceBytes: number },
): FilesWorkerBrowserEvidence {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Files worker browser evidence must be an object");
  }
  const evidence = value as Partial<FilesWorkerBrowserEvidence>;
  if (evidence.schema !== FILES_WORKER_BROWSER_EVIDENCE_SCHEMA) {
    throw new Error("Files worker browser evidence schema is unsupported");
  }
  if (
    evidence.engine?.name !== "chromium" ||
    typeof evidence.engine.version !== "string" ||
    evidence.engine.version.length === 0
  ) {
    throw new Error("Files worker browser evidence lacks Chromium identity");
  }
  if (
    evidence.frame?.credentialless !== false ||
    evidence.frame.indexed_db !== true ||
    evidence.frame.path !== "/frame"
  ) {
    throw new Error(
      "Files worker browser evidence lacks the persistent frame proof",
    );
  }
  if (
    evidence.worker?.sha256 !== expectedWorker.sha256 ||
    evidence.worker.source_bytes !== expectedWorker.sourceBytes ||
    !sameJson(
      evidence.worker.initial_status,
      FILES_WORKER_INITIAL_STATUS,
    )
  ) {
    throw new Error(
      "Files worker browser evidence does not bind the current worker runtime",
    );
  }
  if (
    evidence.negative_control?.credentialless_frame_rejected !== true ||
    evidence.negative_control.reason !== "persistent_resident_required"
  ) {
    throw new Error(
      "Files worker browser evidence lacks the credentialless negative control",
    );
  }
  return evidence as FilesWorkerBrowserEvidence;
}

export async function verifyFilesWorkerInChromium(
  filesRoot = DEFAULT_BROWSER_FILES_ROOT,
): Promise<FilesWorkerBrowserEvidence> {
  const worker = await buildFilesInlineWorkerBundle(filesRoot);
  const harness = await esbuild.build({
    absWorkingDir: filesRoot,
    stdin: {
      contents: `
        import { FilesCryptoWorkerClient } from "./src/crypto/worker_client.ts";
        globalThis.runFilesWorker = async () => {
          const client = new FilesCryptoWorkerClient();
          try {
            return await client.status();
          } finally {
            client.close();
          }
        };
      `,
      resolveDir: filesRoot,
      sourcefile: "files-worker-browser-release.ts",
      loader: "ts",
    },
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    write: false,
    plugins: [filesInlineCryptoWorkerPlugin(filesRoot)],
  });
  const bundle = harness.outputFiles?.[0]?.text;
  if (!bundle || !bundle.includes(worker.marker)) {
    throw new Error(
      "Files Chromium release harness does not contain the current inline worker",
    );
  }

  const rootHtml = `<!doctype html>
    <meta charset="utf-8">
    <iframe data-mode="persistent" src="/frame"></iframe>
    <iframe data-mode="credentialless" credentialless src="/frame"></iframe>`;
  const frameHtml = `<!doctype html>
    <meta charset="utf-8">
    <script src="/bundle.js"></script>
    <script>
      window.resultPromise = window.runFilesWorker().then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error: String(error?.stack || error) }),
      );
    </script>`;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") {
        return new Response(bundle, {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      if (path === "/frame") {
        return new Response(frameHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/") {
        return new Response(rootHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      ...await chromiumLaunchOptions(),
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`, {
      waitUntil: "load",
    });

    const iframe = await page.waitForSelector(
      'iframe[data-mode="persistent"]',
      {
        state: "attached",
        timeout: 20_000,
      },
    );
    const frame = await iframe.contentFrame();
    if (!frame) throw new Error("Files persistent iframe did not load");
    await frame.waitForLoadState("load");
    const credentialless = await frame.evaluate(
      () => (globalThis as typeof globalThis & {
        credentialless?: unknown;
      }).credentialless,
    );
    if (credentialless === true) {
      throw new Error("Chromium created an opaque Files Window");
    }
    const indexedDbAvailable = await frame.evaluate(
      () => new Promise<boolean>((resolve) => {
        try {
          const request = indexedDB.open(
            "neutron-files-release-persistence-probe",
            1,
          );
          request.onerror = () => resolve(false);
          request.onupgradeneeded = () => {
            request.result.createObjectStore("probe");
          };
          request.onsuccess = () => {
            request.result.close();
            indexedDB.deleteDatabase(
              "neutron-files-release-persistence-probe",
            );
            resolve(true);
          };
        } catch {
          resolve(false);
        }
      }),
    );
    if (!indexedDbAvailable) {
      throw new Error("Chromium persistent Files Window lacks IndexedDB");
    }
    const result = await frame.evaluate(
      () => (globalThis as typeof globalThis & {
        resultPromise: Promise<BrowserResult>;
      }).resultPromise,
    );
    if (
      !result.ok ||
      typeof result.value !== "object" ||
      result.value === null ||
      (result.value as { type?: unknown }).type !== "status" ||
      !sameJson(
        (result.value as { status?: unknown }).status,
        FILES_WORKER_INITIAL_STATUS,
      )
    ) {
      throw new Error(
        `Files inline worker failed in Chromium: ${
          result.ok ? JSON.stringify(result.value) : result.error
        }`,
      );
    }

    const credentiallessIframe = await page.waitForSelector(
      'iframe[data-mode="credentialless"]',
      {
        state: "attached",
        timeout: 20_000,
      },
    );
    const credentiallessFrame = await credentiallessIframe.contentFrame();
    if (!credentiallessFrame) {
      throw new Error(
        "Files credentialless negative-control iframe did not load",
      );
    }
    await credentiallessFrame.waitForLoadState("load");
    const negativeResult = await credentiallessFrame.evaluate(
      () => (globalThis as typeof globalThis & {
        resultPromise: Promise<BrowserResult>;
      }).resultPromise,
    );
    if (
      negativeResult.ok ||
      !negativeResult.error.includes(
        "persistent dedicated resident origin",
      )
    ) {
      throw new Error(
        "Files worker did not reject the credentialless Window",
      );
    }

    return Object.freeze({
      schema: FILES_WORKER_BROWSER_EVIDENCE_SCHEMA,
      engine: Object.freeze({
        name: "chromium",
        version: browser.version(),
      }),
      frame: Object.freeze({
        credentialless: false,
        indexed_db: true,
        path: "/frame",
      }),
      worker: Object.freeze({
        sha256: worker.sha256,
        source_bytes: worker.source.length,
        initial_status: FILES_WORKER_INITIAL_STATUS,
      }),
      negative_control: Object.freeze({
        credentialless_frame_rejected: true,
        reason: "persistent_resident_required",
      }),
    });
  } finally {
    await browser?.close();
    await server.stop(true);
  }
}

export async function writeFilesWorkerBrowserEvidence(
  filesRoot = DEFAULT_BROWSER_FILES_ROOT,
): Promise<FilesWorkerBrowserEvidence> {
  const evidence = await verifyFilesWorkerInChromium(filesRoot);
  const dist = join(filesRoot, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(
    join(dist, FILES_WORKER_BROWSER_EVIDENCE_PATH),
    canonicalJson(evidence),
    "utf8",
  );
  return evidence;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const operation = write
    ? writeFilesWorkerBrowserEvidence()
    : verifyFilesWorkerInChromium();
  operation.then(
    (evidence) => {
      console.log(canonicalJson(evidence).trimEnd());
    },
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
