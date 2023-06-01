import { exec as callbackExec } from "child_process";
import { promisify } from "util";
import fs, { mkdir, rm } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { checkForDangerousCode } from "neutron-tools/src/dangerous.js";

function hashContent(content) {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

const exec = promisify(callbackExec);

function parsePackageString(packageString) {
  const packagePattern = /--package (\S+) (\S+)/g;
  const packages = {};

  let match;
  while ((match = packagePattern.exec(packageString)) !== null) {
    packages[match[1]] = match[2];
  }

  return packages;
}

const dfxJson = await fs.readFile("./dfx.json", "utf-8");
const dfxConfig = JSON.parse(dfxJson);
const packtool = dfxConfig?.defaults?.build?.packtool;

const neutronJson = await fs.readFile("./neutron.json", "utf-8");
const neutronConfig = JSON.parse(neutronJson);

let mopsOutput = "";

if (packtool) mopsOutput = await exec(packtool);

const packagesStr = mopsOutput.stdout.replace(/\n/g, " ").trim();

const packages = parsePackageString(packagesStr);

// console.log(packages);

function parseImports(content) {
  const importPattern = /^\s*import (\S+) "(\S+)"/gm;
  const imports = {};

  let match;
  while ((match = importPattern.exec(content)) !== null) {
    imports[match[1]] = match[2];
  }

  return imports;
}

const hashfiles = {};

async function getDependencies(from, filePath, packages) {
  //   console.log({ from, filePath });
  const content = await fs.readFile(filePath, "utf-8");

  const imports = parseImports(content);
  const fileHash = hashContent(content);

  const dependencies = { mods: [] };
  if (!hashfiles[fileHash]) {
    hashfiles[fileHash] = {
      content: removeCommentsAndEmptyLines(content),
    };
  }

  // Dangerous check is intentionally done after removing comments
  let danger = checkForDangerousCode(hashfiles[fileHash].content);
  if (danger.length) {
    console.log(
      "Dangerous code found in",
      filePath,
      ". The use of these keywords directly is prohibited in neutron apps: " +
        danger.join(", ")
    );
  }

  dependencies.map = { from, to: fileHash };

  for (const importName in imports) {
    const importPath = imports[importName];
    if (importPath.startsWith("mo:⛔") || importPath == "mo:prim") continue;
    if (importPath.startsWith("mo:")) {
      let [packagePrefix, packagePath] = importPath.slice(3).split("/");
      if (!packagePath) packagePath = "lib";
      try {
        // Standard way of defining package path
        const packageFullPath = path.join(
          packages[packagePrefix],
          `${packagePath}.mo`
        );
        dependencies.mods[importName] = await getDependencies(
          [fileHash, importPath],
          packageFullPath,
          packages
        );
      } catch (e) {
        try {
          // Another way of definding package path
          const packageFullPath = path.join(
            packages[packagePrefix],
            `${packagePath}/lib.mo`
          );
          // console.log("Secondary package path", packageFullPath);
          dependencies.mods[importName] = await getDependencies(
            [fileHash, importPath],
            packageFullPath,
            packages
          );
        } catch (e) {
          console.error({
            filePath,
            importName,
            importPath,
            packagePath,
            packages,
          });
          throw e;
        }
      }
    } else {
      const fullPath = path.resolve(path.dirname(filePath), `${importPath}.mo`);
      dependencies.mods[importName] = await getDependencies(
        [fileHash, importPath],
        fullPath,
        packages
      );
    }
  }

  return dependencies;
}

function removeCommentsAndEmptyLines(content) {
  // Removes comments.
  const noComments = content.replace(/\/\/.*/g, "");
  // Removes lines with only whitespace.
  const noEmptyLines = noComments.replace(/^\s*\n/gm, "");
  return noEmptyLines;
}

function replaceImportPaths(content, oldImportPath, newImportPath) {
  const importPattern = new RegExp(
    `^\\s*import (\\S+) "${oldImportPath}"`,
    "gm"
  );
  const replacement = `import $1 "${newImportPath}"`;

  return content.replace(importPattern, replacement);
}

const modname = Object.keys(neutronConfig.modules)[0];

const dependencies = await getDependencies(
  null,
  "./backend/" + neutronConfig.modules[modname].src,
  packages
);

// console.log(util.inspect(dependencies, false, null, true));
// console.log(util.inspect(hashfiles, false, null, true));

const usedHashes = [];

const walkReplace = (node) => {
  let reps = [];
  for (let mod in node.mods) {
    reps.push(walkReplace(node.mods[mod]));
  }
  let { from, to } = node.map;

  let newfile = hashfiles[to].content;

  for (let rep of reps) {
    newfile = replaceImportPaths(newfile, rep[0], rep[1]);
  }

  let newhash = hashContent(newfile);
  hashfiles[newhash] = { content: newfile };

  usedHashes.push(newhash);
  return [from?.[1], newhash];
};

walkReplace(dependencies);

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
