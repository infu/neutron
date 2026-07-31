import fs from "fs/promises";

import {
  assertManifestFunctionExports,
  normalizeManifestBackground,
  normalizeManifestCapabilities,
  normalizeManifestDependencies,
  normalizeManifestDisplayMetadata,
  normalizeManifestTiles,
} from "neutron-tools/src/schema.js";
import { assertNeutronManifest } from "neutron-tools/src/memory.js";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
const neutronJson = await fs.readFile("./neutron.json", "utf-8");
const neutronConfig = JSON.parse(neutronJson);

if (
  neutronConfig &&
  typeof neutronConfig === "object" &&
  Object.prototype.hasOwnProperty.call(neutronConfig, "memory_requires")
) {
  console.log("neutron.json validation errors:");
  console.log("memory_requires is unsupported; app memory cannot be shared");
  process.exit(1);
}

let result = validate_neutron_conf(neutronConfig);
if (result.errors.length > 0) {
  console.log("neutron.json validation errors:");
  for (let error of result.errors) {
    console.log(error.stack);
  }
  process.exit(1);
}

try {
  assertNeutronManifest(neutronConfig, "source");
  assertManifestFunctionExports(neutronConfig);
  normalizeManifestDisplayMetadata(neutronConfig);
  normalizeManifestDependencies(neutronConfig);
  normalizeManifestTiles(neutronConfig);
  normalizeManifestBackground(neutronConfig);
  normalizeManifestCapabilities(neutronConfig);
  buildCapabilityPlan(neutronConfig);
} catch (error) {
  console.log("neutron.json validation errors:");
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log("neutron.json is valid");
