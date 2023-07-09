import crypto from "crypto";
import chalk from "chalk";
import fs from "fs/promises";
import {
  checkForDangerousASTCode,
  checkForDangerousTextCode,
} from "neutron-security";
import path from "path";
import { whitelist } from "../whitelist.js";
import mo from "motoko";

export function hashContent(content) {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

export function removeCommentsAndEmptyLines(content) {
  // Removes comments.
  let noComments = content.replace(/\/\*.*?\*.\//gs, "");

  noComments = noComments.replace(/\/\/.*/g, "");
  // Removes lines with only whitespace.
  const noEmptyLines = noComments.replace(/^\s*\n/gm, "");
  return noEmptyLines;
}

export function replaceImportPaths(content, oldImportPath, newImportPath) {
  const importPattern = new RegExp(
    `^\\s*import ([^"]+) "${oldImportPath}"`,
    "gm"
  );
  const replacement = `import $1 "${newImportPath}"`;

  return content.replace(importPattern, replacement);
}

export function displayDangerousCode(dangerousCodeArray) {
  let text = "";
  for (let entry of dangerousCodeArray) {
    text +=
      chalk.white("Disallowed: ") + chalk.bgRed.white("" + entry.code) + "\n";
    text +=
      chalk.green(`${entry.line - 1}: `) +
      chalk.gray(`${entry.context.previous}\n`);
    text +=
      chalk.green(`${entry.line}: `) + chalk.gray(`${entry.context.current}\n`);
    text +=
      chalk.green(`${entry.line + 1}: `) +
      chalk.gray(`${entry.context.next}\n\n`);
  }
  return text;
}

export function parsePackageString(packageString) {
  const packagePattern = /--package (\S+) (\S+)/g;
  const packages = {};

  let match;
  while ((match = packagePattern.exec(packageString)) !== null) {
    packages[match[1]] = match[2];
  }

  return packages;
}

export function parseImports(content) {
  const importPattern = /^\s*import ([^"]+) "(\S+)"/gm;
  const imports = {};

  let match;
  while ((match = importPattern.exec(content)) !== null) {
    imports[match[1]] = match[2];
  }
  return imports;
}

const gdeps = {};

export async function getDependencies(from, filePath, packages, hashfiles) {
  // WARNING!!! Changing even a comma here may break the whole security
  const content = await fs.readFile(filePath, "utf-8");

  const imports = parseImports(removeCommentsAndEmptyLines(content));
  const fileHash = hashContent(content);
  console.log("Processing", filePath);
  if (gdeps[filePath]) {
    return gdeps[filePath];
  }

  // const dependencies = { mods: [] };
  gdeps[filePath] = { mods: [] };

  if (!hashfiles[fileHash]) {
    hashfiles[fileHash] = {
      content: removeCommentsAndEmptyLines(content),
      path: filePath,
    };
  }

  // Dangerous check is intentionally done after removing comments
  let danger = checkForDangerousTextCode(hashfiles[fileHash].content);
  // if (danger.length) {
  //   console.log(
  //     chalk.red("\u2717"),
  //     chalk.yellow(`Text check ::`),
  //     chalk.red(
  //       `Prohibited code found in ${filePath} ${fileHash} used by ${path.relative(
  //         process.cwd(),
  //         from ? from[2] : ""
  //       )}`
  //     )
  //   );
  //   console.log(displayDangerousCode(danger));
  // }

  // Secondary AST level check
  let ast = mo.parseMotoko(hashfiles[fileHash].content);
  let dangerAST = checkForDangerousASTCode(ast);
  // if (dangerAST.length) {
  //   console.log(
  //     chalk.red("\u2717"),
  //     chalk.yellow("AST check :: "),
  //     chalk.red(
  //       "Prohibited AST node found in",
  //       filePath,
  //       "used by",
  //       path.relative(process.cwd(), from ? from[2] : "")
  //     )
  //   );
  //   console.log(
  //     chalk.white("Disallowed: "),
  //     chalk.bgRed.white(dangerAST.join(", "))
  //   );
  // }

  hashfiles[fileHash].dangers = { text: danger, ast: dangerAST };

  gdeps[filePath].map = { from, to: fileHash };

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

        gdeps[filePath].mods[importName] = await getDependencies(
          [fileHash, importPath, filePath],
          packageFullPath,
          packages,
          hashfiles
        );
      } catch (e) {
        if (importPath.indexOf("certified") !== -1) {
          console.log(importPath);
          console.log(e.message);
          process.exit();
        }

        try {
          if (!packages[packagePrefix])
            throw new Error(
              ` ${filePath} Imports a package, but it doesn't exist. Something is wrong`
            );

          // Another way of definding package path
          const packageFullPath = path.join(
            packages[packagePrefix],
            `${packagePath}/lib.mo`
          );
          // console.log("Secondary package path", packageFullPath);
          gdeps[filePath].mods[importName] = await getDependencies(
            [fileHash, importPath, filePath],
            packageFullPath,
            packages,
            hashfiles
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
      gdeps[filePath].mods[importName] = await getDependencies(
        [fileHash, importPath, filePath],
        fullPath,
        packages,
        hashfiles
      );
    }
  }

  return gdeps[filePath];
}

export const walkReplace = (node, hashfiles, usedHashes) => {
  let reps = [];
  for (let mod in node.mods) {
    reps.push(walkReplace(node.mods[mod], hashfiles, usedHashes));
  }
  let { from, to } = node.map;

  let newfile = hashfiles[to].content;

  for (let rep of reps) {
    newfile = replaceImportPaths(newfile, rep[0], rep[1]);
  }

  let newhash = hashContent(newfile);
  hashfiles[newhash] = { ...hashfiles[to], content: newfile, final: true };

  if (!whitelist[newhash]) {
    if (hashfiles[newhash].dangers.text.length) {
      console.log(
        chalk.red("\u2717"),
        chalk.yellow(`Text check ::`),
        chalk.red(
          `Prohibited code found in ${hashfiles[newhash].path} ${newhash}`
        )
      );
      console.log(displayDangerousCode(hashfiles[newhash].dangers.text));
    }
    if (hashfiles[newhash].dangers.ast.length) {
      console.log(
        chalk.red("\u2717"),
        chalk.yellow("AST check :: "),
        chalk.red("Prohibited AST node found in", hashfiles[newhash].path)
      );
      console.log(
        chalk.white("Disallowed: "),
        chalk.bgRed.white(hashfiles[newhash].dangers.ast.join(", "))
      );
    }
  }

  usedHashes.push(newhash);
  return [from?.[1], newhash];
};
