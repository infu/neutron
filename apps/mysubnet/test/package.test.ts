import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { parseWireFields } from "../src/registry";
import { decodeLandPolygons } from "../src/world";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const scriptUrl = new URL("../dist/web/main.js", import.meta.url);
const registrySourceUrl = new URL("../src/registry.ts", import.meta.url);
const globeSourceUrl = new URL("../src/globe.ts", import.meta.url);
const appSourceUrl = new URL("../src/index.tsx", import.meta.url);
const styleSourceUrl = new URL("../src/style.scss", import.meta.url);
const packageUrl = new URL("../mysubnet.v0.3.1.neutron", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("My Subnet declares one safe responsive globe tile", async () => {
  const manifest = await readManifest();

  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "mysubnet",
    name: "My Subnet",
    version: 301,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    tiles: [{
      id: "globe",
      title: "My Subnet",
      path: "index.html",
      icon: "static/icon.svg",
    }],
    func: {},
  });
  expect(manifest.capabilities).toBeUndefined();
});

test("My Subnet bundles a self-contained live globe with small-tile layouts", async () => {
  const [html, css, script, registrySource, globeSource, appSource, styleSource] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(scriptUrl, "utf8"),
    readFile(registrySourceUrl, "utf8"),
    readFile(globeSourceUrl, "utf8"),
    readFile(appSourceUrl, "utf8"),
    readFile(styleSourceUrl, "utf8"),
  ]);

  expect(html).toContain("./main.css");
  expect(html).toContain("./main.js");
  expect(html).not.toMatch(/https?:\/\//i);
  expect(css).toContain(".mysubnet-stage");
  expect(css).toContain("@container mysubnet (max-width: 420px)");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/https?:\/\//i);
  expect(styleSource).not.toMatch(/gradient\s*\(/i);

  expect(globeSource).toContain("WebGLRenderer");
  expect(globeSource).toContain("createEarthTextureCanvas");
  expect(globeSource).toContain("createCloudTextureCanvas");
  expect(globeSource).toContain("LensflareElement");
  expect(globeSource).toContain("FIT_RADIUS * FIT_PADDING");
  expect(globeSource).toContain("Math.min(verticalFov, horizontalFov)");
  expect(globeSource).toContain("prefers-reduced-motion");
  expect(globeSource).toContain("pointerdown");
  expect(globeSource).toContain("delta * 0.052");
  expect(globeSource).not.toContain('addEventListener("wheel"');

  expect(appSource).toContain('className="mysubnet-readout"');
  expect(appSource).toContain("<dt>Subnet</dt>");
  expect(appSource).toContain("<dt>Nodes</dt>");
  expect(appSource).toContain("<dt>Data centers</dt>");
  expect(appSource).toContain("<dt>Countries</dt>");
  expect(appSource).not.toContain("mysubnet-header");
  expect(appSource).not.toContain("mysubnet-footer");
  expect(appSource).not.toContain("RefreshIcon");

  expect(registrySource).toContain("fetchSubnetKeys");
  expect(registrySource).toContain('"get_latest_version"');
  expect(registrySource).toContain('"get_value"');
  expect(registrySource).toContain("node_record_${nodeId}");
  expect(registrySource).toContain("node_operator_record_${operatorId}");
  expect(registrySource).toContain("data_center_record_${dataCenterKey}");
  expect(registrySource).not.toContain("ic-api.internetcomputer.org");
  expect(registrySource).not.toContain('Principal.fromText("aaaaa-aa")');

  expect(script).toContain("get_latest_version");
  expect(script).toContain("node_record_");
  expect(script).toContain("Rotating Earth globe");
});

test("protobuf reader skips mixed Registry fields safely", () => {
  const fields = parseWireFields(Uint8Array.from([
    0x08, 0xac, 0x02,
    0x12, 0x03, 0x69, 0x63, 0x70,
    0x1d, 0x00, 0x00, 0x20, 0x41,
  ]));

  expect(fields.map((field) => field.number)).toEqual([1, 2, 3]);
  expect(fields[0]?.value).toBe(300n);
  expect(new TextDecoder().decode(fields[1]?.value as Uint8Array)).toBe("icp");
  expect(new DataView((fields[2]?.value as Uint8Array).buffer).getFloat32(0, true)).toBe(10);
});

test("bundled Natural Earth topology decodes into valid land rings", () => {
  const polygons = decodeLandPolygons();
  const points = polygons.flat(2);

  expect(polygons.length).toBeGreaterThan(100);
  expect(points.length).toBeGreaterThan(4_000);
  expect(points.every(([longitude, latitude]) => (
    longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
  ))).toBe(true);
});

test("My Subnet package includes the globe and Registry client", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked);

  expect(paths).toContain("neutron.json");
  expect(paths).toContain("schema.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/static/icon.svg");

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.files.map((file) => file.path)).toContain("app/mysubnet/main.js");
});
