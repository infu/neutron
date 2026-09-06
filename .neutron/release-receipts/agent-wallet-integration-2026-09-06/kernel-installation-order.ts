import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import msgpack5 from "/srv/shared/code/neutron/node_modules/msgpack5/index.js";
import { validate_neutron_conf as validateSuccessor } from "/srv/shared/code/neutron/packages/neutron-tools/src/validate_schema.ts";
import { buildCapabilityPlan as buildSuccessorPlan } from "/srv/shared/code/neutron/packages/neutron-tools/src/capabilities/plan.ts";

const repo = "/srv/shared/code/neutron";
const sourceSha256 = "b95766b962fabb891e3febac663578505a85d85c50ea51ee0d867f56909ee3a6";
const sourcePath = `${repo}/apps/kernel/.neutron/sources/${sourceSha256}.source.v1.msgpack.gz`;
const sourceBytes = await fs.readFile(sourcePath);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
if (digest(sourceBytes) !== sourceSha256) throw new Error("Published Kernel343 source artifact hash changed");
const snapshot = msgpack5().decode(gunzipSync(sourceBytes));
if (snapshot.package.id !== "kernel" || snapshot.package.version !== 343) throw new Error("Wrong predecessor source identity");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "neutron-k343-schema-"));
await fs.symlink(`${repo}/node_modules`, `${temporary}/node_modules`);
for (const file of snapshot.files) {
  if (!file.path.startsWith("packages/neutron-tools/src/")) continue;
  if (file.path.includes("..")) throw new Error("Unexpected source path");
  const destination = path.join(temporary, file.path);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, file.content);
}
const predecessor = await import(`${temporary}/packages/neutron-tools/src/validate_schema.ts`);
const predecessorPlan = await import(`${temporary}/packages/neutron-tools/src/capabilities/plan.ts`);
const results = [];
for (const app of ["kernel", "uniswap", "wallet"]) {
  const manifestPath = `${repo}/apps/${app}/neutron.json`;
  const bytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const oldValidation = predecessor.validate_neutron_conf(manifest);
  const newValidation = validateSuccessor(manifest);
  if (!newValidation.valid) throw new Error(`${app} rejected by successor: ${newValidation.errors.join("; ")}`);
  const newPlan = buildSuccessorPlan(manifest);
  let oldPlanError: string | null = null;
  try { predecessorPlan.buildCapabilityPlan(manifest); }
  catch (error) { oldPlanError = String(error); }
  if (app === "kernel" && (!oldValidation.valid || oldPlanError)) throw new Error("Successor Kernel itself must remain installable by343");
  if (app !== "kernel" && (oldValidation.valid || !oldPlanError?.includes("frontend_tools"))) throw new Error("Expected precise predecessor capability rejection");
  results.push({
    app, version: manifest.version, manifestSha256: digest(bytes),
    predecessor: { valid: oldValidation.valid, errors: oldValidation.errors.map((error: { stack: string }) => error.stack), planError: oldPlanError },
    successor: { valid: true, frontendTools: newPlan.entries.find((entry) => entry.id === "frontend_tools")?.config ?? null },
  });
}
console.log(JSON.stringify({ source: { app: "kernel", version: 343, file: sourcePath, sha256: sourceSha256, size: sourceBytes.byteLength }, results, requiredInstallationOrder: ["kernel", "reload", "app upgrades"], publication: "one atomic catalog transaction" }, null, 2));
