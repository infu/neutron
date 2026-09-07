import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import type { BuildOptions } from "esbuild";
import { writeNpmBuildEvidence } from "neutron-scripts/src/npm_build_evidence.js";

const config: BuildOptions = {
  entryPoints: {
    main: "./src/main.tsx",
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
  metafile: true,
  plugins: [
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
    const result = await esbuild.build(config);
    await writeNpmBuildEvidence(process.cwd(), result.metafile!);
  } catch {
    process.exit(1);
  }
}

