import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = process.cwd();
const appRoot = path.join(repoRoot, "apps/gemma");
const webRoot = path.join(appRoot, "dist/web");
const kernelOrigin = "https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io";
const appOrigin = "https://gemma--ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io";

test.beforeAll(() => {
  execFileSync("npm", ["run", "build"], {
    cwd: appRoot,
    stdio: "pipe",
  });
});

test("Gemma keeps its loaded model and conversation when the tile remounts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get() {
        return {
          async requestAdapter() {
            return {
              features: new Set(["shader-f16"]),
              info: { description: "Playwright mock adapter" },
            };
          },
        };
      },
    });
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === kernelOrigin) {
      await route.fulfill({
        contentType: "text/html",
        body: kernelFixtureHtml,
      });
      return;
    }
    if (url.hostname === "huggingface.co") {
      await route.fulfill({
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: mockGemmaModule,
      });
      return;
    }
    if (url.origin === appOrigin) {
      const relativePath = url.pathname.slice(1) || "index.html";
      if (relativePath === "model-worker.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: mockWorkerWithoutWebGpu,
        });
        return;
      }
      const filePath = path.join(webRoot, relativePath);
      const contentType = contentTypeFor(relativePath);
      await route.fulfill({
        contentType,
        headers: { "access-control-allow-origin": "*" },
        body: await readFile(filePath),
      });
      return;
    }
    await route.abort();
  });

  await page.goto(`${kernelOrigin}/`);
  const tile = page.frameLocator('iframe[data-role="tile"]').nth(0);
  const background = page.frameLocator('iframe[data-role="background"]');
  await expect(page.locator('iframe[data-role="background"]')).toHaveCount(1);
  expect(
    await background.locator("body").evaluate(async (_body, origin) => {
      const cache = await caches.open("gemma-e2e");
      await cache.put(`${origin}/cache-check`, new Response("cached"));
      return {
        origin: location.origin,
        value: await (await cache.match(`${origin}/cache-check`))?.text(),
      };
    }, appOrigin)
  ).toEqual({ origin: appOrigin, value: "cached" });
  await expect(
    tile.getByRole("textbox", { name: "Message", exact: true })
  ).toBeEnabled();
  await expect(tile.getByRole("heading")).toHaveCount(0);

  const composer = tile.getByRole("textbox", { name: "Message", exact: true });
  const initialComposerHeight = await composer.evaluate(
    (element) => (element as HTMLTextAreaElement).getBoundingClientRect().height
  );
  await composer.fill("one\ntwo\nthree");
  const expandedComposerHeight = await composer.evaluate(
    (element) => (element as HTMLTextAreaElement).getBoundingClientRect().height
  );
  expect(expandedComposerHeight).toBeGreaterThan(initialComposerHeight);

  await composer.fill("Hi");
  await expect(tile.getByRole("button", { name: "Send message" })).toBeEnabled();
  await tile.getByRole("button", { name: "Send message" }).click();
  await expect(tile.locator(".gemma-message--assistant")).toContainText(
    "Mock response: Hi"
  );

  await page.evaluate(() => {
    (window as Window & { addTile(): void }).addTile();
  });
  await expect(page.locator('iframe[data-role="tile"]')).toHaveCount(2);
  const secondTile = page.frameLocator('iframe[data-role="tile"]').nth(1);
  const secondComposer = secondTile.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await expect(secondComposer).toBeEnabled();
  await expect(secondTile.locator(".gemma-message--assistant")).toContainText(
    "Mock response: Hi"
  );

  await tile.locator('[data-tid="gemma-history"]').evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(
    tile.getByRole("button", { name: "Jump to latest message" })
  ).toBeVisible();

  await secondComposer.fill("Still resident?");
  await secondTile.getByRole("button", { name: "Send message" }).click();
  await expect(tile.locator(".gemma-message--assistant").last()).toContainText(
    "Mock response: Still resident?"
  );
  const unlockedScrollTop = await tile
    .locator('[data-tid="gemma-history"]')
    .evaluate((element) => element.scrollTop);
  expect(unlockedScrollTop).toBeLessThanOrEqual(1);

  await tile.getByRole("button", { name: "Jump to latest message" }).click();
  await expect
    .poll(() =>
      tile.locator('[data-tid="gemma-history"]').evaluate((element) =>
        Math.round(element.scrollHeight - element.scrollTop - element.clientHeight)
      )
    )
    .toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    (window as Window & { remountTile(): void }).remountTile();
  });
  await expect(composer).toBeEnabled();
  await expect(tile.locator(".gemma-message--user").first()).toContainText("Hi");
  await expect(tile.locator(".gemma-message--assistant").first()).toContainText(
    "Mock response: Hi"
  );
  await expect(page.locator('iframe[data-role="background"]')).toHaveCount(1);

  await page.reload();
  await expect(page.locator('iframe[data-role="background"]')).toHaveCount(1);
  await expect(composer).toBeEnabled();
});

function contentTypeFor(file: string): string {
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "text/javascript";
}

const mockGemmaModule = `
export const Gemma4Mobile = {
  async load(modelId, options = {}) {
    if (modelId !== "Vzmoi/gemma-4-expr-tst") {
      throw new Error("Unexpected model ID: " + modelId);
    }
    if (options.revision !== "3c4e8ad4641c69e754e5f22e8fdf9275eb2c6408") {
      throw new Error("Unexpected model revision: " + options.revision);
    }
    if (options.cache !== true) throw new Error("Persistent model cache disabled");
    options.onProgress?.({ status: "Loading mock model" });
    return {
      async warmup() {},
      async *generate(messages) {
        const prompt = messages[messages.length - 1]?.content ?? "";
        yield {
          delta:
            "Mock response: " + prompt +
            "\\n\\nResident response remains available while tiles change workspaces. ".repeat(5),
        };
      },
      reset() {},
      dispose() {},
    };
  },
};
`;

const mockWorkerWithoutWebGpu = `
postMessage({
  type: "ready",
  snapshot: {
    stage: "error",
    statusText: "WebGPU is unavailable in this worker.",
    modelId: "Vzmoi/gemma-4-expr-tst",
    modelLoaded: false,
    loadProgress: null,
    webGpuAvailable: false,
    messages: [],
  },
});
`;

const kernelFixtureHtml = `<!doctype html>
<html>
  <body>
    <div id="background"></div>
    <div id="workspace"></div>
    <script>
      const callbacks = new Map();
      let nextId = 1000;
      let backgroundPort;

      function send(port, action, payload) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          callbacks.set(id, { resolve, reject });
          port.postMessage({ type: "exec", id, payload: { action, payload } });
        });
      }

      function attachPort(port, role) {
        port.addEventListener("message", async (event) => {
          const message = event.data;
          if (message?.type === "response") {
            const callback = callbacks.get(message.id);
            if (!callback) return;
            callbacks.delete(message.id);
            if (Object.prototype.hasOwnProperty.call(message, "error")) {
              callback.reject(message.error);
            } else {
              callback.resolve(message.ok);
            }
            return;
          }
          if (role !== "tile" || message?.type !== "exec") return;
          try {
            const call = message.payload.payload;
            if (
              message.payload.action !== "tools.call" ||
              call.target !== "app:gemma:background"
            ) {
              throw new Error("Unsupported fixture call");
            }
            const result = await send(
              backgroundPort,
              "__neutron_msgbus_tools_call",
              {
                name: call.name,
                arguments: call.arguments || {},
                caller: {
                  endpoint: "app:gemma:tile:chat:instance:test",
                  appId: "gemma",
                  role: "tile",
                },
              }
            );
            port.postMessage({ type: "response", id: message.id, ok: result });
          } catch (error) {
            port.postMessage({
              type: "response",
              id: message.id,
              error: { message: error?.message || String(error) },
            });
          }
        });
        port.start();
      }

      function connect(frame, role) {
        const channel = new MessageChannel();
        if (role === "background") backgroundPort = channel.port1;
        attachPort(channel.port1, role);
        frame.contentWindow.postMessage(
          {
            type: "neutron:msgbus:connect",
            version: 1,
            sessionId: role + "-1234567890abcdef",
          },
          role === "background" ? "${appOrigin}" : "*",
          [channel.port2]
        );
      }

      function createFrame(role, src) {
        const frame = document.createElement("iframe");
        frame.dataset.role = role;
        frame.sandbox =
          role === "background"
            ? "allow-scripts allow-same-origin"
            : "allow-scripts";
        frame.src = src;
        frame.addEventListener("load", () => connect(frame, role), { once: true });
        return frame;
      }

      const background = createFrame("background", "${appOrigin}/service.html");
      background.style.display = "none";
      document.getElementById("background").append(background);

      window.remountTile = function remountTile() {
        const workspace = document.getElementById("workspace");
        workspace.replaceChildren(
          createFrame(
            "tile",
            "${appOrigin}/index.html?app=gemma&tile=chat&instance=test&workspace=1"
          )
        );
      };
      window.addTile = function addTile() {
        document.getElementById("workspace").append(
          createFrame(
            "tile",
            "${appOrigin}/index.html?app=gemma&tile=chat&instance=second&workspace=1"
          )
        );
      };
      window.remountTile();
    </script>
  </body>
</html>`;
