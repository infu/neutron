import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { preparePackageInstall, unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);
const mainJsUrl = new URL("../dist/web/main.js", import.meta.url);
const packageUrl = new URL("../spreadsheet.v0.3.2.neutron", import.meta.url);

test("Spreadsheet manifest is a persistent frontend-only resident and tile", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
  expect(validate_neutron_conf(manifest).valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "spreadsheet",
    name: "Spreadsheet",
    version: 302,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    background: { path: "service.html" },
    capabilities: {
      background_ui_requests: { api: 1, categories: ["frontend_tool"] },
      persistent_browser_storage: { api: 1, surface: "background" },
    },
    tiles: [{ id: "workbook", path: "index.html", icon: "static/icon.svg" }],
    func: {},
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("Spreadsheet browser bundles include the public tools, binary port, and usable grid", async () => {
  const service = await readFile(serviceJsUrl, "utf8");
  const main = await readFile(mainJsUrl, "utf8");
  for (const tool of [
    "workbook_help",
    "workbook_status",
    "workbook_session",
    "workbook_read",
    "workbook_find",
    "workbook_apply",
    "workbook_save",
    "workbook_accept_file",
  ]) expect(service).toContain(tool);
  expect(service).toContain("neutron:msgbus:attachment:exec");
  expect(service).toContain("attachments.delegate");
  expect(service).toContain("delegationToken");
  expect(service).toContain("application/vnd.neutron.spreadsheet+json");
  expect(main).toContain("Spreadsheet grid");
  expect(main).toContain("Fill down");
  expect(main).toContain("spreadsheet-save-command");
  expect(main).toContain("Start formula");
  expect(main).toContain("Formula help");
  expect(main).toContain("Find a function");
});

test("Spreadsheet package contains resident, tile, icon, and schemas", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked);
  for (const path of [
    "neutron.json",
    "schema.json",
    "web/index.html",
    "web/main.css",
    "web/main.js",
    "web/service.html",
    "web/service.js",
    "web/static/icon.svg",
  ]) expect(paths).toContain(path);
  const installed = preparePackageInstall(unpacked).files.map((file) => file.path);
  expect(installed).toContain("app/spreadsheet/index.html");
  expect(installed).toContain("app/spreadsheet/service.html");
});
