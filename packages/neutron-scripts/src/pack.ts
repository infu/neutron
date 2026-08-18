import msgpack5 from "msgpack5";
import { constants } from "node:fs";
import fs from "fs/promises";
import path from "path";
// import ignore from "ignore";
import zlib from "zlib";
import { assertAppVersion } from "neutron-tools/src/version.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";

const msgpack = msgpack5();
const REMOVED_PACKAGE_BUILD_METADATA_PATH = ".neutron-build.json";
// const defaultIgnore = `
// /*
// !dist
// !dist/*
// `.split("\n");

export async function readFile(filePath: string): Promise<Uint8Array> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Package input is not a regular file: ${filePath}`);
    }
    return compressFileToUint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

export function compressFileToUint8Array(fileBuffer: Buffer): Uint8Array {
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
export type FlatPackage = Record<string, Uint8Array>;

function comparePathNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function archivePath(rootPath: string, filePath: string): string {
  const relativePath = path.relative(rootPath, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Package input escapes dist/: ${filePath}`);
  }
  return relativePath.split(path.sep).join("/");
}

export async function walkDir(
  dirPath: string,
  rootPath: string,
  flatStructure: FlatPackage = Object.create(null) as FlatPackage
): Promise<FlatPackage> {
  const directoryStats = await fs.lstat(dirPath);
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`Package input must not be a symbolic link: ${dirPath}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`Package input is not a directory: ${dirPath}`);
  }

  const dirents = (await fs.readdir(dirPath, { withFileTypes: true }))
    .sort((left, right) => comparePathNames(left.name, right.name));

  for (const dirent of dirents) {
    const res = path.resolve(dirPath, dirent.name);
    const stats = await fs.lstat(res);

    if (stats.isSymbolicLink()) {
      throw new Error(`Package input must not be a symbolic link: ${res}`);
    }
    if (stats.isDirectory()) {
      await walkDir(res, rootPath, flatStructure);
    } else if (stats.isFile()) {
      // if (!ig.ignores(rel)) {
      //   console.log(rel);
      const contents = await readFile(res);
      const relativePath = archivePath(rootPath, res);
      Object.defineProperty(flatStructure, relativePath, {
        configurable: true,
        enumerable: true,
        value: contents,
        writable: true,
      });
      // }
    } else {
      throw new Error(`Package input is not a regular file: ${res}`);
    }
  }

  return flatStructure;
}

export async function packDirectory(
  rootDir = process.cwd(),
): Promise<string> {
  const data = await fs.readFile(path.join(rootDir, "neutron.json"), "utf8");
  const packageJson = JSON.parse(data) as { version?: unknown; id?: unknown };
  const version = packageJson.version;
  if (typeof version !== "number" || typeof packageJson.id !== "string") {
    throw new Error("neutron.json must include string id and numeric version");
  }
  assertAppVersion(version, "neutron.json version");
  // ig = await readIgnoreFile(rootDir);

  const distDir = path.join(rootDir, "dist");
  const flatStructure = await walkDir(distDir, distDir);
  if (flatStructure[REMOVED_PACKAGE_BUILD_METADATA_PATH]) {
    throw new Error(
      `${REMOVED_PACKAGE_BUILD_METADATA_PATH} is removed; package archives are deployment-target neutral`,
    );
  }
  let rez = msgpack.encode(flatStructure);
  console.log("\nSize: " + rez.length);
  const fn = packageArchiveFilename(packageJson.id, version);
  console.log("Writing: " + fn);
  const archivePath = path.join(rootDir, fn);
  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, rez);
    await fs.rename(temporaryPath, archivePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  // Released archives are durable upgrade and publication evidence. Keep
  // every predecessor beside the newly versioned archive; callers select the
  // exact current filename from neutron.json, so coexistence is unambiguous.
  return archivePath;
}

if (import.meta.main) {
  packDirectory().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
