import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const jsUrl = new URL("../dist/web/main.js", import.meta.url);
const serviceHtmlUrl = new URL("../dist/web/service.html", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);
const workerJsUrl = new URL("../dist/web/model-worker.js", import.meta.url);
const packageUrl = new URL("../gemma.v0.2.1.neutron", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Gemma manifest validates as a persistent chat app", async () => {
  const manifest = await readManifest();
  expect(validate_neutron_conf(manifest).valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "gemma",
    name: "Gemma",
    version: 201,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    description: "Private local Heretic Gemma 4 chat powered by WebGPU",
    src: "main.mo",
    background: {
      path: "service.html",
      description: "Resident Heretic Gemma 4 model and shared conversation",
    },
    capabilities: {
      persistent_browser_storage: { api: 1, surface: "background" },
    },
    tiles: [
      {
        id: "chat",
        title: "Gemma",
        path: "index.html",
        icon: "static/icon.svg",
        description: "Chat with the resident local Heretic Gemma 4 model",
      },
    ],
    func: {},
    memory: { gemma: { version: 1 } },
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("Gemma emits an empty backend method schema", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);
  expect(artifact.app.id).toBe("gemma");
  expect(artifact.methods).toEqual({});
});

test("Gemma bundles direct chat without AI SDK or agent tools", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");
  const js = await readFile(jsUrl, "utf8");
  const serviceHtml = await readFile(serviceHtmlUrl, "utf8");
  const serviceJs = await readFile(serviceJsUrl, "utf8");
  const workerJs = await readFile(workerJsUrl, "utf8");

  expect(html).toContain("./main.css");
  expect(css).toContain(".nt-app");
  expect(css).toContain(".gemma-message");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
  expect(js).toContain("gemma_status");
  expect(serviceHtml).toContain("./service.js");
  for (const method of [
    "gemma_status",
    "gemma_load",
    "gemma_generate",
    "gemma_stop",
    "gemma_reset",
  ]) {
    expect(serviceJs).toContain(method);
  }
  for (const source of [serviceJs, workerJs]) {
    expect(source).not.toContain("list_apps");
    expect(source).not.toContain("get_app_tools");
    expect(source).not.toContain("call_app_tool");
    expect(source).not.toContain("tool_call");
    expect(source).not.toContain("ToolLoopAgent");
  }
  expect(workerJs).toContain("gemma-4-webgpu-kernels");
  expect(workerJs).toContain(
    "feade0377736bdb0931056468949503f547f4d70"
  );
  expect(workerJs).toContain("createObjectURL");
  expect(workerJs).toContain("shader-f16");
  expect(workerJs).toContain("Vzmoi/gemma-4-expr-tst");
  expect(workerJs).toContain("3c4e8ad4641c69e754e5f22e8fdf9275eb2c6408");
  expect(workerJs).not.toContain(
    "google/gemma-4-E2B-it-qat-mobile-transformers"
  );
});

test("Gemma package contains expected install paths", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked).sort();
  expect(paths).toContain("neutron.json");
  expect(paths).toContain("schema.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/service.html");
  expect(paths).toContain("web/service.js");
  expect(paths).toContain("web/model-worker.js");
  expect(paths).toContain("web/static/icon.svg");
  expect(paths.some((path) => /^mo\/[a-f0-9]{64}\.mo$/.test(path))).toBe(true);

  const prepared = preparePackageInstall(unpacked);
  const installed = prepared.files.map((file) => file.path);
  expect(installed).toContain("app/gemma/index.html");
  expect(installed).toContain("app/gemma/main.css");
  expect(installed).toContain("app/gemma/service.html");
  expect(installed).toContain("app/gemma/service.js");
});
