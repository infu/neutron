import type { Motoko } from "neutron-motoko-wasm";
import {
  getDependencies,
  walkReplace,
  type DependencyCache,
  type HashFiles,
  type PackageMap,
} from "./walk.ts";

export type PrepareMotokoProgramOptions = {
  compiler: Pick<Motoko, "write">;
  sourcePath: string;
  packages?: PackageMap;
  allowDangerous?: boolean;
};

export type PreparedMotokoProgram = {
  entryPath: string;
  sourceCount: number;
};

export async function prepareMotokoProgram({
  compiler,
  sourcePath,
  packages = {},
  allowDangerous = false,
}: PrepareMotokoProgramOptions): Promise<PreparedMotokoProgram> {
  const hashfiles: HashFiles = {};
  const cache: DependencyCache = {};
  const dependencies = await getDependencies(
    null,
    sourcePath,
    packages,
    hashfiles,
    cache,
  );
  const used: string[] = [];
  const [, entry] = walkReplace(dependencies, hashfiles, used, {
    allowDangerous,
  });
  const sourceHashes = [...new Set(used)];
  for (const hash of sourceHashes) {
    await compiler.write(`${hash}.mo`, hashfiles[hash]!.content);
  }
  return {
    entryPath: `${entry}.mo`,
    sourceCount: sourceHashes.length,
  };
}
