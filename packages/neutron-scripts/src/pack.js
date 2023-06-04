import msgpack5 from "msgpack5";
import fs from "fs/promises";
import path from "path";
// import ignore from "ignore";
import zlib from "zlib";

const msgpack = msgpack5();
// const defaultIgnore = `
// /*
// !dist
// !dist/*
// `.split("\n");

async function readFile(filePath) {
  const data = await fs.readFile(filePath);

  return compressFileToUint8Array(data);
}

async function compressFileToUint8Array(fileBuffer) {
  // Compress file
  const compressedBuffer = zlib.gzipSync(fileBuffer);

  // Convert to Uint8Array
  const uint8Array = new Uint8Array(
    compressedBuffer.buffer,
    compressedBuffer.byteOffset,
    compressedBuffer.byteLength
  );

  return uint8Array;
}

// async function readIgnoreFile(dirPath) {
//   const ignoreFilePath = path.join(dirPath, ".neutronignore");
//   console.log("default ignore", defaultIgnore);
//   console.log("add .neutronignore if you want to add files\n");
//   let ig = ignore().add(defaultIgnore);

//   try {
//     const data = await fs.readFile(ignoreFilePath, "utf8");
//     console.log([...defaultIgnore, ...data]);
//     ig = ignore().add([...defaultIgnore, ...data]);
//   } catch (err) {
//     if (err.code !== "ENOENT") {
//       throw err; // Rethrow if it's not "file not found"
//     }
//   }

//   return ig;
// }

// let ig;
async function walkDir(dirPath, rootPath, flatStructure = {}) {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });

  for (let dirent of dirents) {
    try {
      const res = path.resolve(dirPath, dirent.name);
      let rel = path.relative(rootPath, res);

      if (dirent.isDirectory()) {
        await walkDir(res, rootPath, flatStructure);
      } else {
        // if (!ig.ignores(rel)) {
        //   console.log(rel);
        const contents = await readFile(res);
        const relativePath = path.relative(rootPath, res);
        flatStructure[relativePath] = contents;
        // }
      }
    } catch (e) {}
  }

  return flatStructure;
}

async function main() {
  const rootDir = process.cwd();
  const data = await fs.readFile(path.join(rootDir, "neutron.json"), "utf8");
  const packageJson = JSON.parse(data);
  const version = packageJson.version;
  const id = packageJson.id.replace(/[^a-z0-9]/gi, "_");
  // ig = await readIgnoreFile(rootDir);

  const distDir = path.join(rootDir, "dist");
  const flatStructure = await walkDir(distDir, distDir);
  let rez = msgpack.encode(flatStructure);
  console.log("\nSize: " + rez.length);
  const fn = `${id}.v${version}.neutron`;
  console.log("Writing: " + fn);
  fs.writeFile(path.join(rootDir, fn), rez);
}

main().catch(console.error);
