import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildOptions } from "esbuild";

const outdir = "./dist/web";
const reactBundles = ["main.js", "tray.js"];

async function stripRemoteDiagnostics(): Promise<void> {
  for (const bundle of reactBundles) {
    const output = path.join(outdir, bundle);
    const source = await readFile(output, "utf8");
    const sanitized = source.replaceAll(
      "https://react.dev/errors/",
      "#react-error-",
    );
    if (sanitized !== source) {
      await writeFile(output, sanitized);
    }
  }
}

const config: BuildOptions = {
  entryPoints: {
    main: "./src/index.tsx",
    service: "./src/service.ts",
    tray: "./src/tray.tsx",
  },
  outdir,
  entryNames: "[name]",
  bundle: true,
  minify: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  platform: "browser",
  plugins: [
    sassPlugin(),
    {
      name: "neutron-self-contained-assets",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0) {
            await stripRemoteDiagnostics();
          }
        });
      },
    },
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

const args = process.argv.slice(2);

await rm(outdir, { force: true, recursive: true });

if (args[0] === "watch") {
  const ctx = await esbuild.context(config);
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  try {
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
