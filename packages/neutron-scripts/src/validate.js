import fs from "fs/promises";

import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
const neutronJson = await fs.readFile("./neutron.json", "utf-8");
const neutronConfig = JSON.parse(neutronJson);

let result = validate_neutron_conf(neutronConfig);
if (result.errors.length > 0) {
  console.log("neutron.json validation errors:");
  for (let error of result.errors) {
    console.log(error.stack);
  }
  process.exit(1);
}

console.log("neutron.json is valid");
