import { execFile as callbackExecFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  disposeMotokoCompiler,
  loadMotoko,
} from "neutron-motoko-wasm";
import {
  getDependencies,
  parsePackageString,
  type DependencyCache,
  type HashFiles,
  type PackageMap,
} from "./walk.ts";

const execFile = promisify(callbackExecFile);

export type MopsCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

export type CompileMotokoOptions = {
  sourcePath: string;
  outputPath: string;
  emitStableTypes?: boolean;
  cwd?: string;
  packages?: PackageMap;
  run?: MopsCommandRunner;
};

export type CompiledMotokoPaths = {
  wasmPath: string;
  candidPath: string;
  stableTypesPath?: string;
};

export type CompileMotokoCliOptions = {
  sourcePath: string;
  outputPath: string;
  emitStableTypes: boolean;
  cwd?: string;
};

const runMops: MopsCommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFile(command, args, {
    ...options,
    encoding: "utf8",
  });
  return { stdout, stderr };
};

// The vendored compiler has one process-global virtual filesystem. Serialize
// builds and dispose it between runs so a failed build cannot leak source files
// or compiler configuration into the next one.
let compileQueue: Promise<void> = Promise.resolve();

export function compileMotokoWithCandid(
  options: CompileMotokoOptions,
): Promise<CompiledMotokoPaths> {
  const result = compileQueue.then(() => compileIsolated(options));
  compileQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function compileIsolated({
  sourcePath,
  outputPath,
  emitStableTypes = false,
  cwd = process.cwd(),
  packages,
  run = runMops,
}: CompileMotokoOptions): Promise<CompiledMotokoPaths> {
  const buildRoot = path.resolve(cwd);
  const wasmPath = path.resolve(buildRoot, outputPath);
  const candidPath = `${wasmPath}.did`;
  const stableTypesPath = `${wasmPath}.most`;

  await disposeMotokoCompiler();
  try {
    const packageMap = normalizePackageRoots(
      buildRoot,
      packages ?? (await resolveMopsPackages(buildRoot, run)),
    );
    const hashfiles: HashFiles = {};
    const dependencyCache: DependencyCache = {};
    const absoluteSourcePath = path.resolve(buildRoot, sourcePath);
    await getDependencies(
      null,
      absoluteSourcePath,
      packageMap,
      hashfiles,
      dependencyCache,
    );

    const mo = await loadMotoko();
    await mo.clearPackages();
    await mo.setProjectRoot(buildRoot);
    for (const [name, directory] of Object.entries(packageMap)) {
      await mo.addPackage(name, directory);
    }
    // Keep each module at its original absolute path. Rewriting modules to
    // content hashes would change compiler-visible identities and therefore
    // stable signatures.
    for (const file of Object.keys(dependencyCache).sort()) {
      await mo.write(file, await fs.readFile(file, "utf8"));
    }

    const compiled = await mo.wasm(absoluteSourcePath, "ic");
    await fs.mkdir(path.dirname(wasmPath), { recursive: true });
    await Promise.all([
      fs.writeFile(wasmPath, compiled.wasm),
      fs.writeFile(candidPath, compiled.candid, "utf8"),
      ...(emitStableTypes
        ? [fs.writeFile(stableTypesPath, compiled.stable, "utf8")]
        : []),
    ]);

    return {
      wasmPath,
      candidPath,
      ...(emitStableTypes ? { stableTypesPath } : {}),
    };
  } catch (error) {
    await Promise.all([
      fs.rm(wasmPath, { force: true }),
      fs.rm(candidPath, { force: true }),
      fs.rm(stableTypesPath, { force: true }),
    ]);
    throw error;
  } finally {
    await disposeMotokoCompiler();
  }
}

async function resolveMopsPackages(
  cwd: string,
  run: MopsCommandRunner,
): Promise<PackageMap> {
  const { stdout } = await run("mops", ["sources"], { cwd });
  return parsePackageString(stdout.replace(/\n/g, " ").trim());
}

function normalizePackageRoots(
  cwd: string,
  packages: PackageMap,
): PackageMap {
  return Object.fromEntries(
    Object.entries(packages).map(([name, directory]) => [
      name,
      path.resolve(cwd, directory),
    ]),
  );
}

export function parseCompileMotokoArgs(
  args: readonly string[],
): CompileMotokoCliOptions {
  let sourcePath: string | undefined;
  let outputPath: string | undefined;
  let cwd: string | undefined;
  let emitStableTypes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--emit-stable-types") {
      emitStableTypes = true;
      continue;
    }
    if (
      argument === "--source" ||
      argument === "--output" ||
      argument === "--cwd"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--source") sourcePath = value;
      else if (argument === "--output") outputPath = value;
      else cwd = value;
      continue;
    }
    throw new Error(`Unknown compile-motoko argument: ${argument}`);
  }

  if (!sourcePath) throw new Error("--source is required");
  if (!outputPath) throw new Error("--output is required");
  return {
    sourcePath,
    outputPath,
    emitStableTypes,
    ...(cwd ? { cwd } : {}),
  };
}

if (import.meta.main) {
  compileMotokoWithCandid(
    parseCompileMotokoArgs(process.argv.slice(2)),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
