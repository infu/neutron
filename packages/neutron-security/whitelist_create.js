import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { getDependencies, walkReplace } from "neutron-scripts/src/walk.js";

const mopsdir = ".mops/";

// These contain forbidden code
const unacceptable = [
  /base.*ExperimentalCycles.mo/,
  /base.*ExperimentalInternetComputer.mo/,
  /base.*ExperimentalStableMemory.mo/,
  /base.*CertifiedData.mo/,
];
const libs = await fs.readdir(mopsdir);
let files = [];
for (let lib of libs) {
  let libpath = path.join(mopsdir, lib, "src/");
  let libfiles = await fs.readdir(libpath);

  files = [...files, ...libfiles.map((x) => [libpath, path.join(libpath, x)])];
}

files = files.filter((x) => x[1].indexOf(".mo") !== -1);

const packages = {};

const hashfiles = {};
const usedHashes = [];

for (let file of files) {
  const packages = { base: file[0] }; // Some base libraries import themselves with mo:base :)

  const dependencies = await getDependencies(
    null,
    file[1],
    packages,
    hashfiles
  );
  walkReplace(dependencies, hashfiles, usedHashes);
}

console.log(chalk.blue("Final whitelisted hashes"));
const whitelisted = {};
hashcheck: for (let hash in hashfiles) {
  const f = hashfiles[hash];
  if (!f.final) continue; // skip intermediate files
  if (!f.dangers.text.length && !f.dangers.ast.length) continue; // No need to whitelist non dangerous files
  for (let regex of unacceptable) {
    // Remove files we don't want to whitelist at all
    if (regex.test(f.path)) {
      continue hashcheck;
    }
  }

  for (let i = 0; i < f.dangers.text.length; i++) {
    delete f.dangers.text[i].context;
  }

  whitelisted[hash] = {
    path: f.path,
    text: f.dangers.text,
    ast: f.dangers.ast,
  };
  console.log({ hash, path: f.path, text: f.dangers.text, ast: f.dangers.ast });
}

await fs.writeFile(
  "./whitelist.js",
  "export const whitelist = " + JSON.stringify(whitelisted, null, 2)
);
