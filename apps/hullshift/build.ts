import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BuildOptions, Plugin } from "esbuild";

const workerSources = [
  "./src/generator_worker.ts",
  "./src/worker_protocol.ts",
  "./src/generator.ts",
  "./src/brain_catalog.ts",
  "./src/brain_quality.ts",
  "./src/milestone_dsl.ts",
  "./src/generated/hullshiftbrain.g4.catalog.json",
  "./src/difficulty.ts",
  "./src/solver.ts",
  "./src/simulation.ts",
  "./src/mechanics.ts",
  "./src/model.ts",
  "./src/prng.ts",
  "./src/share_code.ts",
].map((file) => resolve(file));

const embeddedWorkerPlugin: Plugin = {
  name: "embedded-hullshift-worker",
  setup(build) {
    build.onResolve({ filter: /^hullshift-worker-source$/ }, () => ({
      path: "hullshift-worker-source",
      namespace: "embedded-hullshift-worker",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "embedded-hullshift-worker" },
      async () => {
        const bundled = await esbuild.build({
          entryPoints: ["./src/generator_worker.ts"],
          bundle: true,
          format: "iife",
          loader: { ".ts": "ts" },
          minify: true,
          platform: "browser",
          write: false,
        });
        const source = bundled.outputFiles[0]?.text;
        if (!source) throw new Error("The Hullshift generator worker did not build");
        return {
          contents: `export default ${JSON.stringify(source)};`,
          loader: "js",
          watchFiles: workerSources,
        };
      },
    );
  },
};

const config: BuildOptions = {
  entryPoints: {
    main: "./src/index.tsx",
    service: "./src/service.ts",
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
    embeddedWorkerPlugin,
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
  console.log("Watching Hullshift files for changes...");
} else {
  try {
    await rm("./dist/web", { recursive: true, force: true });
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
