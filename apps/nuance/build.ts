import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildOptions } from "esbuild";

const outdir = "./dist/web";

// React embeds links to react.dev in its production error messages. App bundles
// must be self-contained, so those are rewritten to inert anchors.
const reactBundles = ["main.js"];

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
    // The tile.
    main: "./src/index.tsx",
    // The resident background that hosts the agent tools. Plain TypeScript:
    // it has no UI and must stay small, since it is mounted for the whole
    // session.
    service: "./src/service.ts",
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
