import msgpack5 from "msgpack5";
import fs from "fs/promises";
import path from "path";
import ignore from "ignore";
import gzip from "gzip-js";

const msgpack = msgpack5();
const defaultIgnore = `
/*
!dist
!dist/*
!package.json
`.split("\n");
async function readFile(filePath) {
  const data = await fs.readFile(filePath);
  const content = Array.from(data);
  return gzip.zip(content);
}

async function readIgnoreFile(dirPath) {
  const ignoreFilePath = path.join(dirPath, ".neutronignore");
  console.log("default ignore", defaultIgnore);
  console.log("add .neutronignore if you want to add files\n");
  let ig = ignore().add(defaultIgnore);

  try {
    const data = await fs.readFile(ignoreFilePath, "utf8");
    console.log([...defaultIgnore, ...data]);
    ig = ignore().add([...defaultIgnore, ...data]);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err; // Rethrow if it's not "file not found"
    }
  }

  return ig;
}
let ig;
async function walkDir(dirPath, rootPath, flatStructure = {}) {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });

  for (let dirent of dirents) {
    try {
      const res = path.resolve(dirPath, dirent.name);
      let rel = path.relative(rootPath, res);

      if (dirent.isDirectory()) {
        await walkDir(res, rootPath, flatStructure);
      } else {
        if (!ig.ignores(rel)) {
          console.log(rel);
          const contents = await readFile(res);
          const relativePath = path.relative(rootPath, res);
          flatStructure[relativePath] = contents;
        }
      }
    } catch (e) {}
  }

  return flatStructure;
}

async function main() {
  const rootDir = process.cwd();
  const data = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
  const packageJson = JSON.parse(data);
  const version = packageJson.version.replace(/[^a-z0-9]/gi, "_");
  const name = packageJson.name.replace(/[^a-z0-9]/gi, "_");
  ig = await readIgnoreFile(rootDir);

  const flatStructure = await walkDir(rootDir, rootDir);
  let rez = msgpack.encode(flatStructure);
  console.log("\nSize: " + rez.length);
  const fn = `${name}.${version}.neutron`;
  console.log("Writing: " + fn);
  fs.writeFile(path.join(rootDir, fn), rez);
}

main().catch(console.error);
