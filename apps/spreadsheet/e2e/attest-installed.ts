import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "fflate";
import { unpackNeutronPackage } from "../../../packages/neutron-compiler/src/install.ts";
import { resolveLocalNeutronRuntime } from "neutron-provision/src/local_session.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const deploymentConfig =
  process.env.NEUTRON_NDEPLOY_CONFIG ??
  fileURLToPath(new URL("../../../local.ndeploy.json", import.meta.url));
const expectedAssets = ["main.js", "service.js"] as const;

async function main(): Promise<void> {
  const sourceManifest = JSON.parse(await readFile(resolve(appRoot, "neutron.json"), "utf8")) as {
    id?: unknown;
    version?: unknown;
  };
  if (sourceManifest.id !== "spreadsheet" || !Number.isInteger(sourceManifest.version)) {
    throw new Error("Spreadsheet neutron.json must declare id spreadsheet and an integer version");
  }

  const archivePath = process.env.NEUTRON_SPREADSHEET_PACKAGE
    ? resolve(process.cwd(), process.env.NEUTRON_SPREADSHEET_PACKAGE)
    : resolve(appRoot, `spreadsheet.v${sourceManifest.version}.neutron`);
  const archive = new Uint8Array(await readFile(archivePath));
  const unpacked = unpackNeutronPackage(archive);
  const packagedManifestBytes = unpacked["neutron.json"];
  if (!packagedManifestBytes) throw new Error(`${archivePath} does not contain neutron.json`);
  const packagedManifest = JSON.parse(new TextDecoder().decode(packagedManifestBytes)) as {
    id?: unknown;
    version?: unknown;
  };
  if (packagedManifest.id !== sourceManifest.id || packagedManifest.version !== sourceManifest.version) {
    throw new Error(
      `Package manifest ${String(packagedManifest.id)} v${String(packagedManifest.version)} does not match source ${sourceManifest.id} v${sourceManifest.version}`,
    );
  }

  const origin = installedOrigin();
  const verified: Array<{ asset: string; bytes: number; sha256: string }> = [];
  for (const asset of expectedAssets) {
    const expected = unpacked[`web/${asset}`];
    if (!expected) throw new Error(`${basename(archivePath)} does not contain web/${asset}`);
    const response = await fetch(new URL(`/app/spreadsheet/${asset}`, `${origin}/`), {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) {
      throw new Error(`Installed ${asset} returned HTTP ${response.status} from ${response.url}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLocaleLowerCase("en-US").includes("javascript")) {
      throw new Error(`Installed ${asset} returned unexpected content type ${contentType || "(missing)"}`);
    }
    const receivedBody = new Uint8Array(await response.arrayBuffer());
    const received = isGzip(receivedBody) ? gunzipSync(receivedBody) : receivedBody;
    const expectedHash = sha256(expected);
    const receivedHash = sha256(received);
    if (received.byteLength !== expected.byteLength || receivedHash !== expectedHash) {
      throw new Error(
        `Installed ${asset} does not match ${basename(archivePath)}: expected ${expected.byteLength} bytes ${expectedHash}, received ${received.byteLength} bytes ${receivedHash}`,
      );
    }
    verified.push({ asset, bytes: received.byteLength, sha256: receivedHash });
  }

  console.log(`Attested installed Spreadsheet at ${origin}`);
  console.log(`Package ${basename(archivePath)} sha256 ${sha256(archive)}`);
  for (const asset of verified) {
    console.log(`${asset.asset} ${asset.bytes} bytes sha256 ${asset.sha256}`);
  }
}

function installedOrigin(): string {
  const runtime = resolveLocalNeutronRuntime({
    configPath: deploymentConfig,
  });
  return localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
