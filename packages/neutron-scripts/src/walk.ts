import crypto from "crypto";
import chalk from "chalk";
import fs from "fs/promises";
import {
  checkForDangerousASTCode,
  checkForDangerousTextCode,
} from "neutron-security";
import type { DangerousTextFinding } from "neutron-security/src/text.js";
import path from "path";
import { whitelist } from "../whitelist.ts";
import { loadMotoko } from "neutron-motoko-wasm";

export type DependencySource =
  [hash: string, importPath: string, filePath: string] | null;
export type PackageMap = Record<string, string>;
export type ImportMap = Record<string, string>;
export type DangerReport = {
  text: DangerousTextFinding[];
  ast: string[];
};
export type HashFile = {
  content: string;
  path: string;
  dangers?: DangerReport;
  final?: boolean;
};
export type HashFiles = Record<string, HashFile>;
export type DependencyNode = {
  mods: Record<string, DependencyNode>;
  map: {
    from: DependencySource;
    to: string;
  };
};
export type DependencyCache = Record<string, DependencyNode>;
export type WalkReplaceOptions = {
  allowDangerous?: boolean;
};

export function hashContent(content: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

export function removeCommentsAndEmptyLines(content: string): string {
  let output = "";
  let index = 0;
  let state: "code" | "string" | "char" | "line-comment" | "block-comment" =
    "code";
  let blockDepth = 0;

  while (index < content.length) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (state === "code") {
      if (current === "/" && next === "/") {
        output += " ";
        state = "line-comment";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        output += " ";
        state = "block-comment";
        blockDepth = 1;
        index += 2;
        continue;
      }

      output += current;
      if (current === '"') state = "string";
      else if (current === "'") state = "char";
      index += 1;
      continue;
    }

    if (state === "string" || state === "char") {
      output += current;
      if (current === "\\" && index + 1 < content.length) {
        output += next;
        index += 2;
        continue;
      }
      if (
        (state === "string" && current === '"') ||
        (state === "char" && current === "'")
      ) {
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n") {
        output += current;
        state = "code";
      } else if (current === "\r") {
        output += current;
      }
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      blockDepth += 1;
      index += 2;
      continue;
    }
    if (current === "*" && next === "/") {
      blockDepth -= 1;
      index += 2;
      if (blockDepth === 0) state = "code";
      continue;
    }
    if (current === "\n" || current === "\r") output += current;
    index += 1;
  }

  return output.replace(/^[ \t]*\r?\n/gm, "");
}

export function replaceImportPaths(
  content: string,
  oldImportPath: string,
  newImportPath: string,
): string {
  const escapedOldImportPath = oldImportPath.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const importPattern = new RegExp(
    `^(\\s*)import ([^"]+) "${escapedOldImportPath}"`,
    "gm",
  );
  const replacement = `$1import $2 "${newImportPath}"`;

  return content.replace(importPattern, replacement);
}

export function displayDangerousCode(
  dangerousCodeArray: DangerousTextFinding[],
): string {
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

export function parsePackageString(packageString: string): PackageMap {
  const packagePattern = /--package (\S+) (\S+)/g;
  const packages: PackageMap = {};

  let match: RegExpExecArray | null;
  while ((match = packagePattern.exec(packageString)) !== null) {
    const [, packageName, packagePath] = match;
    if (!packageName || !packagePath) continue;
    packages[packageName] = packagePath;
  }

  return packages;
}

export function parseImports(content: string): ImportMap {
  const importPattern = /^\s*import ([^"]+) "(\S+)"/gm;
  const imports: ImportMap = {};

  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    const [, importName, importPath] = match;
    if (!importName || !importPath) continue;
    imports[importName] = importPath;
  }
  return imports;
}

export async function getDependencies(
  from: DependencySource,
  filePath: string,
  packages: PackageMap,
  hashfiles: HashFiles,
  dependencyCache: DependencyCache = {},
): Promise<DependencyNode> {
  // WARNING!!! Changing even a comma here may break the whole security
  const content = await fs.readFile(filePath, "utf-8");

  const normalizedContent = removeCommentsAndEmptyLines(content);
  const imports = parseImports(normalizedContent);
  const fileHash = hashContent(content);
  console.log("Processing", filePath);
  if (dependencyCache[filePath]) {
    const cached = requireDependencyNode(dependencyCache, filePath);
    return {
      ...cached,
      map: { ...cached.map, from },
    };
  }

  dependencyCache[filePath] = { mods: {}, map: { from, to: fileHash } };

  if (!hashfiles[fileHash]) {
    hashfiles[fileHash] = {
      content: normalizedContent,
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
  const mo = await loadMotoko();
  let ast = await mo.parseMotoko(hashfiles[fileHash].content);
  let dangerAST = checkForDangerousASTCode(ast, hashfiles[fileHash].content);
  // Text inspection supplies readable source locations, while the full AST is
  // the authority for member/object-pattern acquisition. Filter broad name
  // candidates so harmless locals and record fields are not reserved words.
  const astFindings = new Set<string>(dangerAST);
  danger = danger.filter(({ code }) => astFindings.has(code));
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

  const currentFile = requireHashFile(hashfiles, fileHash);
  currentFile.dangers = { text: danger, ast: dangerAST };

  const dependencyNode = requireDependencyNode(dependencyCache, filePath);
  dependencyNode.map = { from, to: fileHash };

  for (const importName in imports) {
    const importPath = imports[importName];
    if (!importPath) continue;
    if (importPath.startsWith("mo:⛔") || importPath == "mo:prim") continue;
    if (importPath.startsWith("mo:")) {
      const [packagePrefix, initialPackagePath] = importPath
        .slice(3)
        .split("/");
      if (!packagePrefix) {
        throw new Error(`Invalid Motoko import path ${importPath}`);
      }
      if (
        packagePrefix === "base" &&
        !isInstalledPackageSource(filePath, packages)
      ) {
        throw new Error(
          `${filePath} imports unsupported mo:base package directly; use mo:core`,
        );
      }
      let packagePath = initialPackagePath;
      if (!packagePath) packagePath = "lib";
      const packageRoot = packages[packagePrefix];
      if (!packageRoot) {
        throw new Error(
          ` ${filePath} Imports a package, but it doesn't exist. Something is wrong`,
        );
      }
      try {
        // Standard way of defining package path

        const packageFullPath = path.join(packageRoot, `${packagePath}.mo`);

        dependencyNode.mods[importName] = await getDependencies(
          [fileHash, importPath, filePath],
          packageFullPath,
          packages,
          hashfiles,
          dependencyCache,
        );
      } catch {
        try {
          // Another way of definding package path
          const packageFullPath = path.join(
            packageRoot,
            `${packagePath}/lib.mo`,
          );
          // console.log("Secondary package path", packageFullPath);
          dependencyNode.mods[importName] = await getDependencies(
            [fileHash, importPath, filePath],
            packageFullPath,
            packages,
            hashfiles,
            dependencyCache,
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
      dependencyNode.mods[importName] = await getDependencies(
        [fileHash, importPath, filePath],
        fullPath,
        packages,
        hashfiles,
        dependencyCache,
      );
    }
  }

  return dependencyNode;
}

function isInstalledPackageSource(
  filePath: string,
  packages: PackageMap,
): boolean {
  const absoluteFile = path.resolve(filePath);
  return Object.values(packages).some((root) => {
    const relative = path.relative(path.resolve(root), absoluteFile);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    );
  });
}

export const walkReplace = (
  node: DependencyNode,
  hashfiles: HashFiles,
  usedHashes: string[],
  { allowDangerous = false }: WalkReplaceOptions = {},
): [string | undefined, string] => {
  let reps: Array<[string | undefined, string]> = [];
  for (let mod in node.mods) {
    const child = node.mods[mod];
    if (!child) throw new Error(`Missing dependency node ${mod}`);
    reps.push(walkReplace(child, hashfiles, usedHashes, { allowDangerous }));
  }
  let { from, to } = node.map;

  const sourceFile = requireHashFile(hashfiles, to);
  let newfile = sourceFile.content;

  for (let rep of reps) {
    const [oldImportPath, newImportPath] = rep;
    if (oldImportPath) {
      newfile = replaceImportPaths(newfile, oldImportPath, newImportPath);
    }
  }

  let newhash = hashContent(newfile);
  hashfiles[newhash] = { ...sourceFile, content: newfile, final: true };
  const finalFile = requireHashFile(hashfiles, newhash);
  if (!finalFile.dangers) {
    throw new Error(`Missing danger analysis for ${finalFile.path}`);
  }

  if (!allowDangerous && !whitelist[newhash]) {
    if (finalFile.dangers.text.length) {
      console.log(
        chalk.red("\u2717"),
        chalk.yellow(`Text check ::`),
        chalk.red(`Prohibited code found in ${finalFile.path} ${newhash}`),
      );
      console.log(displayDangerousCode(finalFile.dangers.text));
    }
    if (finalFile.dangers.ast.length) {
      console.log(
        chalk.red("\u2717"),
        chalk.yellow("AST check :: "),
        chalk.red("Prohibited AST node found in", finalFile.path),
      );
      console.log(
        chalk.white("Disallowed: "),
        chalk.bgRed.white(finalFile.dangers.ast.join(", ")),
      );
    }
    if (finalFile.dangers.text.length || finalFile.dangers.ast.length) {
      const findings = [
        ...finalFile.dangers.text.map(({ code }) => code),
        ...finalFile.dangers.ast,
      ];
      throw new Error(
        `Disallowed Motoko code in ${finalFile.path}: ${[
          ...new Set(findings),
        ].join(", ")}`,
      );
    }
  }

  usedHashes.push(newhash);
  return [from?.[1], newhash];
};

function requireHashFile(hashfiles: HashFiles, hash: string): HashFile {
  const file = hashfiles[hash];
  if (!file) throw new Error(`Missing hash file ${hash}`);
  return file;
}

function requireDependencyNode(
  dependencyCache: DependencyCache,
  filePath: string,
): DependencyNode {
  const node = dependencyCache[filePath];
  if (!node) throw new Error(`Missing dependency node ${filePath}`);
  return node;
}
