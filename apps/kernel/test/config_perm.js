import { configPermissions } from "../src/lib/perm.js";
import fs from "fs/promises";

console.log(configPermissions(JSON.parse(await fs.readFile("./neutron.json"))));

console.log(
  configPermissions(JSON.parse(await fs.readFile("../hello/neutron.json")))
);
