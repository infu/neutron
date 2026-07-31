import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { copyFile, rm } from "node:fs/promises";
import type { BuildOptions } from "esbuild";
import {
  filesInlineCryptoWorkerPlugin,
} from "./scripts/worker_bundle.ts";

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
    filesInlineCryptoWorkerPlugin(process.cwd()),
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
    await copyFile(
      "./THIRD_PARTY_NOTICES.md",
      "./dist/THIRD_PARTY_NOTICES.md",
    );
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
