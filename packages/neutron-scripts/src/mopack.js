import { exec as callbackExec } from "child_process";
import { promisify } from "util";
import fs, { mkdir, rm } from "fs/promises";
import path from "path";
import {
  hashContent,
  removeCommentsAndEmptyLines,
  replaceImportPaths,
  displayDangerousCode,
  parsePackageString,
  parseImports,
  getDependencies,
  walkReplace,
} from "./walk.js";
const exec = promisify(callbackExec);

const neutronJson = await fs.readFile("./neutron.json", "utf-8");
const neutronConfig = JSON.parse(neutronJson);
const modname = neutronConfig.id;
const start_file = neutronConfig.src;

let mopsOutput = await exec("mops sources");

const packagesStr = mopsOutput.stdout.replace(/\n/g, " ").trim();

const packages = parsePackageString(packagesStr);

const hashfiles = {};

const dependencies = await getDependencies(
  null,
  "./backend/" + start_file,
  packages,
  hashfiles
);

const usedHashes = [];

walkReplace(dependencies, hashfiles, usedHashes);

await rm("./dist/mo", { recursive: true, force: true });
try {
  await mkdir("./dist/mo");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}

for (const hash of usedHashes) {
  const filePath = path.join("./dist/mo", `${hash}.mo`);

  let newcontent = hashfiles[hash].content;
  if (hashContent(newcontent) !== hash) throw "Hash mismatch";

  await fs.writeFile(filePath, newcontent, "utf-8");
}
