import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BuildOptions, Plugin } from "esbuild";

const workerSources = [
  "./src/computer_worker.ts",
  "./src/computer_engine.ts",
  "./src/chess_rules.ts",
  "./src/chess_api.ts",
].map((file) => resolve(file));

const embeddedWorkerPlugin: Plugin = {
  name: "embedded-chess-worker",
  setup(build) {
    build.onResolve({ filter: /^chess-worker-source$/ }, () => ({
      path: "chess-worker-source",
      namespace: "embedded-chess-worker",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "embedded-chess-worker" },
      async () => {
        const bundled = await esbuild.build({
          entryPoints: ["./src/computer_worker.ts"],
          bundle: true,
          format: "iife",
          loader: { ".ts": "ts" },
          minify: true,
          platform: "browser",
          write: false,
        });
        const source = bundled.outputFiles[0]?.text;
        if (!source) throw new Error("The Chess computer worker did not build");
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
  console.log("Watching local files for changes...");
} else {
  try {
    await rm("./dist/web", { recursive: true, force: true });
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
