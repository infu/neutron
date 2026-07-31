import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BuildOptions, Plugin } from "esbuild";

const inlineCryptoWorkerPlugin: Plugin = {
  name: "mail-inline-crypto-worker",
  setup(build) {
    build.onResolve(
      { filter: /^\.\/crypto_worker_source\.ts$/ },
      (args) => args.importer.endsWith("crypto_worker_client.ts")
        ? { path: "mail-crypto-worker-source", namespace: "mail-crypto-worker" }
        : null,
    );
    build.onLoad(
      { filter: /.*/, namespace: "mail-crypto-worker" },
      async () => {
        const worker = await esbuild.build({
          absWorkingDir: process.cwd(),
          entryPoints: ["./src/crypto_worker.ts"],
          bundle: true,
          minify: true,
          format: "iife",
          platform: "browser",
          write: false,
          metafile: true,
        });
        const output = worker.outputFiles?.[0];
        if (!output || output.text.length < 1_000) {
          throw new Error("Mail crypto worker bundle is missing or unexpectedly small");
        }
        return {
          contents: `export const MAIL_CRYPTO_WORKER_SOURCE = ${JSON.stringify(output.text)};`,
          loader: "js",
          watchFiles: Object.keys(worker.metafile.inputs).map((path) => resolve(path)),
        };
      },
    );
  },
};

const config: BuildOptions = {
  entryPoints: {
    main: "./src/main.tsx",
    service: "./src/service.ts",
    tray: "./src/tray.tsx",
  },
  outdir: "./dist/web",
  entryNames: "[name]",
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  platform: "browser",
  plugins: [
    inlineCryptoWorkerPlugin,
    sassPlugin(),
    copyStaticFiles({
      src: "./public",
      dest: "./dist/web",
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
};

if (process.argv.slice(2)[0] === "watch") {
  const context = await esbuild.context(config);
  await context.watch();
} else {
  try {
    await rm("./dist/web", { recursive: true, force: true });
    await esbuild.build(config);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
