import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { BuildOptions } from "esbuild";

// Two browser entrypoints: the resident engine (service.ts, the only surface
// that talks to the OpenChat network) and the tile UI (index.tsx).
const outputFiles = ["./dist/web/main.js", "./dist/web/service.js"];

async function stripRemoteDiagnostics(): Promise<void> {
  for (const outputFile of outputFiles) {
    let source: string;
    try {
      source = await readFile(outputFile, "utf8");
    } catch {
      continue;
    }
    const sanitized = source.replaceAll(
      "https://react.dev/errors/",
      "#react-error-",
    );
    if (sanitized !== source) await writeFile(outputFile, sanitized);
  }
}

const config: BuildOptions = {
  entryPoints: {
    main: "./src/tile/index.tsx",
    service: "./src/service.ts",
  },
  outdir: "./dist/web",
  entryNames: "[name]",
  bundle: true,
  minify: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  platform: "browser",
  define: { global: "globalThis" },
  plugins: [
    sassPlugin(),
    {
      name: "neutron-self-contained-assets",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0) await stripRemoteDiagnostics();
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
