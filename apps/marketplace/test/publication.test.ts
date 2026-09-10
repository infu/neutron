import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { NEUTRON_APP_SOURCE_MEDIA_TYPE } from "neutron-tools/src/package_record.js";
import { NEUTRON_PACKAGE_MEDIA_TYPE, preparePublication } from "../src/publication.ts";
import type { PublicationInput } from "../src/view-types.ts";

// The packer emits a MessagePack string -> binary map of individually gzipped
// files. This small fixture uses that format without a built production app.
function packageBytes(): Uint8Array {
  const path = new TextEncoder().encode("neutron.json");
  const manifest = gzipSync(JSON.stringify({ id: "publication_fixture", version: 7 }));
  return Uint8Array.of(0x81, 0xa0 + path.length, ...path, 0xc5, manifest.length >>> 8, manifest.length & 255, ...manifest);
}
const archive = packageBytes();
const source = gzipSync("Offered source fixture\n");
const digest = (bytes: Uint8Array) => [...createHash("sha256").update(bytes).digest()];
function input(packageType = "", sourceType = ""): PublicationInput {
  return {
    appId: "publication_fixture", title: "Publication fixture", summary: "MIME regression", description: "Local fixture only",
    category: "Apps", priceUsdMicros: "1000000", website: "", releaseNotes: "",
    packageFile: new File([archive], "publication_fixture-7.neutron", { type: packageType }),
    sourceFile: new File([source], "publication_fixture-7.source.tar.gz", { type: sourceType }),
    iconFile: null, screenshotFiles: [],
  };
}

for (const [label, packageType, sourceType] of [
  ["absent", "", ""],
  ["generic", "application/octet-stream", "application/octet-stream"],
  ["misleading", "text/plain", "image/png"],
] as const) test(`${label} File.type does not change package or offered-source MIME or bytes`, async () => {
  const files = input(packageType, sourceType);
  const plan = await preparePublication(files);
  expect(plan.version).toBe("7");
  expect(plan.artifacts).toHaveLength(2);
  expect(plan.artifacts[0]).toMatchObject({ role: "package", purpose: "package", mediaType: NEUTRON_PACKAGE_MEDIA_TYPE, size: archive.length, digest: digest(archive) });
  expect(plan.artifacts[1]).toMatchObject({ role: "source", purpose: "source", mediaType: NEUTRON_APP_SOURCE_MEDIA_TYPE, size: source.length, digest: digest(source) });
  expect(new Uint8Array(await files.packageFile!.arrayBuffer())).toEqual(archive);
  expect(new Uint8Array(await files.sourceFile!.arrayBuffer())).toEqual(new Uint8Array(source));
});

test("supported image MIME and original image digests are retained", async () => {
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=", "base64"));
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  const plan = await preparePublication({ ...input(), iconFile: new File([png], "icon.png", { type: "image/png" }), screenshotFiles: [new File([svg], "screen.svg", { type: "image/svg+xml" })] });
  expect(plan.artifacts[2]).toMatchObject({ role: "icon", purpose: "image", mediaType: "image/png", digest: digest(png) });
  expect(plan.artifacts[3]).toMatchObject({ role: "screenshot", purpose: "image", mediaType: "image/svg+xml", digest: digest(svg) });
});

for (const type of ["", "text/plain"]) test(`unsupported image MIME ${JSON.stringify(type)} is still rejected`, async () => {
  await expect(preparePublication({ ...input(), iconFile: new File(["image fixture"], "icon.png", { type }) })).rejects.toThrow("Choose a supported image file");
});
