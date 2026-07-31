import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Plugin } from "esbuild";

export const FILES_INLINE_WORKER_MARKER = "neutron-files-inline-worker-v2";

export type FilesInlineWorkerBundle = Readonly<{
  source: string;
  sha256: string;
  marker: string;
  inputs: readonly string[];
}>;

export async function buildFilesInlineWorkerBundle(
  filesRoot: string,
): Promise<FilesInlineWorkerBundle> {
  const worker = await esbuild.build({
    absWorkingDir: filesRoot,
    entryPoints: ["./src/crypto/worker.ts"],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    write: false,
    metafile: true,
  });
  const output = worker.outputFiles?.[0];
  if (!output || output.text.length < 1_000) {
    throw new Error(
      "Files crypto worker bundle is missing or unexpectedly small",
    );
  }
  const digest = createHash("sha256").update(output.text).digest("hex");
  const marker = `${FILES_INLINE_WORKER_MARKER}:${digest}`;
  return Object.freeze({
    source: `/*! ${marker} */\n${output.text}`,
    sha256: digest,
    marker,
    inputs: Object.freeze(Object.keys(worker.metafile.inputs).sort()),
  });
}

export function filesInlineWorkerModule(bundle: FilesInlineWorkerBundle): string {
  return `export const FILES_CRYPTO_WORKER_SOURCE = ${JSON.stringify(bundle.source)};`;
}

export function filesInlineCryptoWorkerPlugin(filesRoot: string): Plugin {
  return {
    name: "files-inline-crypto-worker",
    setup(build) {
      build.onResolve(
        { filter: /^\.\/worker_source\.ts$/ },
        (args) =>
          args.importer.endsWith("worker_client.ts")
            ? {
                path: "files-crypto-worker-source",
                namespace: "files-crypto-worker",
              }
            : null,
      );
      build.onLoad(
        { filter: /.*/, namespace: "files-crypto-worker" },
        async () => {
          const worker = await buildFilesInlineWorkerBundle(filesRoot);
          return {
            contents: filesInlineWorkerModule(worker),
            loader: "js",
            watchFiles: worker.inputs.map((path) => resolve(filesRoot, path)),
          };
        },
      );
    },
  };
}
