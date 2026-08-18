import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const serviceHtmlUrl = new URL("../dist/web/service.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const mainJsUrl = new URL("../dist/web/main.js", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);
const packageUrl = new URL(
  "../agent.v0.3.4.neutron",
  import.meta.url
);

test("Agent declares one resident credential connection", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    id: "agent",
    name: "Agent",
    version: 304,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    capabilities: {
      connections: {
        api: 1,
        providers: [
          {
            provider: "openrouter",
            scopes: [],
          },
        ],
      },
      persistent_browser_storage: { api: 1, surface: "background" },
    },
    tiles: [{ id: "chat", path: "index.html" }],
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("Agent bundles local UI and resident AI SDK runtime", async () => {
  const [html, serviceHtml, css, mainJs, serviceJs] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(serviceHtmlUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(mainJsUrl, "utf8"),
    readFile(serviceJsUrl, "utf8"),
  ]);
  expect(html).toContain("connect-src 'none'");
  expect(serviceHtml).toContain("connect-src https://openrouter.ai");
  expect(html + serviceHtml).not.toMatch(/<script[^>]+https?:\/\//i);
  expect(css).toContain(".ora-composer");
  expect(css).toContain(".ora-model-popover");
  expect(css).toContain(".ora-model-search");
  expect(css).toContain(".ora-toolbar-menu-popover");
  expect(css).not.toContain("scroll-snap");
  expect(css).not.toContain("content-visibility");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
  expect(mainJs).toContain("agent_chat");
  expect(mainJs).toContain("Search models or publishers");
  expect(mainJs).toContain("OpenRouter models");
  expect(mainJs).toContain("ora-model-list-spacer");
  expect(mainJs).toContain("Agent Mode");
  expect(mainJs).toContain("__NEUTRON_AGENT_DEV__");
  expect(serviceJs).not.toContain("__NEUTRON_AGENT_DEV__");
  expect(mainJs).not.toContain("assistant_delta");
  expect(serviceJs).not.toContain("assistant_delta");
  for (const method of [
    "agent_status",
    "openrouter_connect",
    "openrouter_models",
    "openrouter_select_model",
    "agent_chat",
    "agent_stop",
    "openrouter_reset_chat",
    "openrouter_disconnect",
  ]) {
    expect(serviceJs).toContain(method);
  }
  for (const tool of [
    "list_apps",
    "list_app_tools",
    "get_tool_schema",
    "call_app_tool",
  ]) {
    expect(serviceJs).toContain(tool);
  }
  expect(serviceJs).toContain("https://openrouter.ai/api/v1/models");
  expect(serviceJs).not.toContain("localStorage.setItem");
});

test("Agent package contains both app entrypoints", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked);
  expect(paths).toContain("neutron.json");
  expect(paths).toContain("schema.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/service.html");
  expect(paths).toContain("web/service.js");
  expect(paths).toContain("web/static/icon.svg");

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.files.map((file) => file.path)).toContain(
    "app/agent/service.js"
  );
});
