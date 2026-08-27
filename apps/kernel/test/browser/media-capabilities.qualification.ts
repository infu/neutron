import { serve } from "bun";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ORIGINFUL_APP_FRAME_SANDBOX,
  tileBrowserPermissionAllow,
} from "../../src/app_frame_security.ts";
import { registryApp } from "../app_registry_fixture.ts";

const chromiumExecutable = findChromiumExecutable();
const appId = "browser_media_qualification";
const mediaApp = registryApp({
  id: appId,
  name: "Browser Media Qualification",
  tiles: [{ id: "call", title: "Call" }],
  capabilities: {
    browser_permissions: {
      api: 1,
      tiles: [{ id: "call", features: ["microphone", "camera"] }],
    },
  },
});

async function qualifyMediaCapabilities(): Promise<void> {
  if (!chromiumExecutable) {
    throw new Error(
      "Browser media qualification requires a runnable Chromium. Run it in `nix develop` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.",
    );
  }
  const child = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const denied = new URL(request.url).searchParams.has(
        "qualification-denied",
      );
      return new Response(childDocument(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "permissions-policy": denied
            ? "camera=(), geolocation=(), microphone=()"
            : "camera=(self), geolocation=(), microphone=(self)",
        },
      });
    },
  });
  const childOrigin = `http://127.0.0.1:${child.port}`;
  const delegatedAllow = tileBrowserPermissionAllow(
    mediaApp,
    "call",
    childOrigin,
  );
  if (!delegatedAllow) {
    throw new Error("Media qualification fixture has no browser delegation");
  }
  const parent = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const allow = url.searchParams.has("delegated")
        ? delegatedAllow
        : undefined;
      const childUrl = url.searchParams.has("child-denied")
        ? `${childOrigin}/?qualification-denied`
        : childOrigin;
      return new Response(parentDocument(childUrl, allow), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "permissions-policy": "camera=*, geolocation=(), microphone=*",
        },
      });
    },
  });
  const parentOrigin = `http://127.0.0.1:${parent.port}`;
  assert.notEqual(childOrigin, parentOrigin);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: chromiumExecutable,
      headless: true,
      timeout: 30_000,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    });
    const context = await browser.newContext();
    await context.grantPermissions(["camera", "microphone"], {
      origin: childOrigin,
    });
    const page = await context.newPage();

    const delegated = await runCase(
      page,
      `${parentOrigin}/?delegated`,
      delegatedAllow,
    );
    assert.deepEqual(delegated, {
      ok: true,
      origin: childOrigin,
      secureContext: true,
      cameraPolicy: true,
      microphonePolicy: true,
      audioTracks: 1,
      videoTracks: 1,
    });

    const denied = await runCase(page, parentOrigin, null);
    assert.deepEqual(denied, {
      ok: false,
      origin: childOrigin,
      secureContext: true,
      cameraPolicy: false,
      microphonePolicy: false,
      errorName: "NotAllowedError",
    });

    const deniedByChild = await runCase(
      page,
      `${parentOrigin}/?delegated&child-denied`,
      delegatedAllow,
    );
    assert.deepEqual(deniedByChild, {
      ok: false,
      origin: childOrigin,
      secureContext: true,
      cameraPolicy: false,
      microphonePolicy: false,
      errorName: "NotAllowedError",
    });
  } finally {
    await browser?.close();
    parent.stop(true);
    child.stop(true);
  }
}

await qualifyMediaCapabilities();
await qualifyKernelFrameAncestors();
await qualifyPassivePackageResponses();
console.log(
  "Browser qualification passed: explicit media delegation, document boundaries, and passive package replay held.",
);

async function qualifyKernelFrameAncestors(): Promise<void> {
  if (!chromiumExecutable) {
    throw new Error(
      "Kernel frame-ancestor qualification requires a runnable Chromium.",
    );
  }
  let appOrigin = "";
  let kernelOrigin = "";
  let protectedRequests = 0;
  let controlRequests = 0;
  const kernel = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/shell") {
        const target = url.searchParams.has("control")
          ? `${kernelOrigin}/framed-control`
          : `${kernelOrigin}/framed-kernel`;
        return new Response(
          kernelParentDocument(
            `${appOrigin}/?target=${encodeURIComponent(target)}`,
            kernelOrigin,
            url.searchParams.get("profile") !== "persistent",
          ),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "frame-ancestors 'none'",
            },
          },
        );
      }
      if (url.pathname === "/framed-control") {
        controlRequests += 1;
        return new Response(kernelTargetDocument(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/framed-kernel") {
        protectedRequests += 1;
        return new Response(kernelTargetDocument(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "frame-ancestors 'none'",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  kernelOrigin = `http://127.0.0.1:${kernel.port}`;
  const app = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new Response(appNavigationDocument(new URL(request.url)), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `sandbox allow-scripts allow-same-origin; frame-ancestors ${kernelOrigin}`,
        },
      });
    },
  });
  appOrigin = `http://127.0.0.1:${app.port}`;
  assert.notEqual(appOrigin, kernelOrigin);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: chromiumExecutable,
      headless: true,
      timeout: 30_000,
    });
    const page = await browser.newPage();

    // This control proves that the sandboxed app may self-navigate and that
    // target script would execute without the ancestor restriction.
    await page.goto(`${kernelOrigin}/shell?control&profile=ordinary`);
    await page.waitForFunction(
      () => globalThis.__kernelTargetExecuted === true,
    );
    assert.equal(controlRequests, 1);

    // The production policy blocks both credentialless ordinary frames and
    // non-credentialless persistent frames before any Kernel script gains the
    // Kernel document's origin or storage authority.
    for (const [index, profile] of [
      { name: "ordinary", credentialless: true },
      { name: "persistent", credentialless: false },
    ].entries()) {
      const blocked = page.waitForEvent("console", {
        predicate: (message) =>
          message.text().includes("frame-ancestors 'none'"),
      });
      await page.goto(`${kernelOrigin}/shell?profile=${profile.name}`);
      await waitForRequest(() => protectedRequests === index + 1);
      await blocked;
      assert.equal(
        await page
          .locator("iframe")
          .evaluate(
            (element) =>
              (element as HTMLIFrameElement & { credentialless: boolean })
                .credentialless,
          ),
        profile.credentialless,
      );
      assert.equal(
        await page.evaluate(() => globalThis.__kernelTargetExecuted),
        false,
      );
    }
  } finally {
    await browser?.close();
    app.stop(true);
    kernel.stop(true);
  }
}

async function qualifyPassivePackageResponses(): Promise<void> {
  if (!chromiumExecutable) {
    throw new Error(
      "Passive package qualification requires a runnable Chromium.",
    );
  }
  let scriptRequests = 0;
  let metadataRequests = 0;
  let serviceWorkerRequests = 0;
  let serviceWorkerExecutions = 0;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/app/example/pkg/replay.js") {
        scriptRequests += 1;
        return passivePackageResponse(
          "globalThis.__packageReplayScriptExecuted = true;",
        );
      }
      if (url.pathname === "/app/example/pkg/neutron.json") {
        metadataRequests += 1;
        return passivePackageResponse('{"id":"example"}');
      }
      if (url.pathname === "/app/example/pkg/replay-worker.js") {
        serviceWorkerRequests += 1;
        return passivePackageResponse(
          'fetch("/package-worker-executed", { method: "POST" });',
        );
      }
      if (url.pathname === "/package-worker-executed") {
        serviceWorkerExecutions += 1;
        return new Response(null, { status: 204 });
      }
      return new Response(passivePackageReplayDocument(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      executablePath: chromiumExecutable,
      headless: true,
      timeout: 30_000,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(globalThis.__packageReplayResult));
    assert.deepEqual(
      await page.evaluate(() => globalThis.__packageReplayResult),
      {
        scriptEvent: "error",
        scriptExecuted: false,
        metadataId: "example",
        serviceWorkerRegistered: false,
        serviceWorkerError: "SecurityError",
      },
    );
    await page.waitForTimeout(250);
    assert.equal(scriptRequests, 1);
    assert.equal(metadataRequests, 1);
    assert.equal(serviceWorkerRequests, 1);
    assert.equal(serviceWorkerExecutions, 0);
    assert.equal(context.serviceWorkers().length, 0);
  } finally {
    await browser?.close();
    server.stop(true);
  }
}

function passivePackageResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-security-policy": "sandbox allow-scripts",
      "x-content-type-options": "nosniff",
    },
  });
}

function passivePackageReplayDocument(): string {
  return `<!doctype html>
    <meta charset="utf-8">
    <script>
      globalThis.__packageReplayScriptExecuted = false;
      globalThis.__packageReplayResult = undefined;
      (async () => {
        const metadata = await fetch("/app/example/pkg/neutron.json")
          .then((response) => response.json());
        const scriptEvent = await new Promise((resolve) => {
          const script = document.createElement("script");
          script.src = "/app/example/pkg/replay.js";
          script.onload = () => resolve("load");
          script.onerror = () => resolve("error");
          document.head.append(script);
        });
        let serviceWorkerRegistered = false;
        let serviceWorkerError = null;
        try {
          const registration = await navigator.serviceWorker.register(
            "/app/example/pkg/replay-worker.js",
          );
          serviceWorkerRegistered = true;
          await registration.unregister();
        } catch (error) {
          serviceWorkerError = error.name;
        }
        globalThis.__packageReplayResult = {
          scriptEvent,
          scriptExecuted: globalThis.__packageReplayScriptExecuted,
          metadataId: metadata.id,
          serviceWorkerRegistered,
          serviceWorkerError,
        };
      })();
    </script>`;
}

function kernelParentDocument(
  childUrl: string,
  kernelOrigin: string,
  credentialless: boolean,
): string {
  return `<!doctype html>
    <meta charset="utf-8">
    <script>
      globalThis.__kernelTargetExecuted = false;
      addEventListener("message", (event) => {
        if (
          event.origin === ${JSON.stringify(kernelOrigin)} &&
          event.data === "kernel-target-executed"
        ) globalThis.__kernelTargetExecuted = true;
      });
    </script>
    <iframe
      src=${JSON.stringify(childUrl)}
      sandbox=${JSON.stringify(ORIGINFUL_APP_FRAME_SANDBOX)}
      ${credentialless ? "credentialless" : ""}
    ></iframe>`;
}

function appNavigationDocument(url: URL): string {
  const target = url.searchParams.get("target");
  if (!target) throw new Error("Frame-boundary fixture has no target");
  return `<!doctype html>
    <meta charset="utf-8">
    <script>location.replace(${JSON.stringify(target)});</script>`;
}

function kernelTargetDocument(): string {
  return `<!doctype html>
    <meta charset="utf-8">
    <script>parent.postMessage("kernel-target-executed", "*");</script>`;
}

async function waitForRequest(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the self-navigation request");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runCase(
  page: import("@playwright/test").Page,
  url: string,
  expectedAllow: string | null,
): Promise<MediaResult> {
  await page.goto(url);
  const iframe = page.locator("iframe");
  assert.equal(
    await iframe.getAttribute("sandbox"),
    ORIGINFUL_APP_FRAME_SANDBOX,
  );
  assert.equal(await iframe.getAttribute("allow"), expectedAllow);
  assert.deepEqual(
    await iframe.evaluate((element) => ({
      supported: "credentialless" in element,
      enabled: (element as HTMLIFrameElement & { credentialless: boolean })
        .credentialless,
    })),
    { supported: true, enabled: true },
  );
  await page.waitForFunction(() => Boolean(globalThis.__mediaResult));
  return await page.evaluate(() => globalThis.__mediaResult!);
}

function parentDocument(childUrl: string, delegation?: string): string {
  const childOrigin = new URL(childUrl).origin;
  const allow = delegation ? ` allow=${JSON.stringify(delegation)}` : "";
  return `<!doctype html>
    <meta charset="utf-8">
    <script>
      globalThis.__mediaResult = undefined;
      addEventListener("message", (event) => {
        if (event.origin === ${JSON.stringify(childOrigin)}) {
          globalThis.__mediaResult = event.data;
        }
      });
    </script>
    <iframe
      src=${JSON.stringify(childUrl)}
      sandbox=${JSON.stringify(ORIGINFUL_APP_FRAME_SANDBOX)}
      credentialless${allow}
    ></iframe>`;
}

function childDocument(): string {
  return `<!doctype html>
    <meta charset="utf-8">
    <script>
      const policy = document.permissionsPolicy ?? document.featurePolicy;
      const result = {
        origin: location.origin,
        secureContext: isSecureContext,
        cameraPolicy: policy?.allowsFeature("camera") ?? false,
        microphonePolicy: policy?.allowsFeature("microphone") ?? false,
      };
      navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then((stream) => {
          Object.assign(result, {
            ok: true,
            audioTracks: stream.getAudioTracks().length,
            videoTracks: stream.getVideoTracks().length,
          });
          stream.getTracks().forEach((track) => track.stop());
        })
        .catch((error) => {
          Object.assign(result, {
            ok: false,
            errorName: error.name,
          });
        })
        .finally(() => parent.postMessage(result, "*"));
    </script>`;
}

function findChromiumExecutable(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    chromium.executablePath(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/run/current-system/sw/bin/google-chrome-stable",
  ];
  return candidates.find((candidate): candidate is string => {
    if (!candidate || !existsSync(candidate)) return false;
    return (
      spawnSync(candidate, ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
      }).status === 0
    );
  });
}

type MediaResult = {
  ok: boolean;
  origin: string;
  secureContext: boolean;
  cameraPolicy: boolean;
  microphonePolicy: boolean;
  audioTracks?: number;
  videoTracks?: number;
  errorName?: string;
};

type PackageReplayResult = {
  scriptEvent: "load" | "error";
  scriptExecuted: boolean;
  metadataId: string;
  serviceWorkerRegistered: boolean;
  serviceWorkerError: string | null;
};

declare global {
  // Browser-only field installed by the parent test document.
  var __mediaResult: MediaResult | undefined;
  var __kernelTargetExecuted: boolean | undefined;
  var __packageReplayScriptExecuted: boolean | undefined;
  var __packageReplayResult: PackageReplayResult | undefined;
}
