import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { BuildOptions } from "esbuild";

const outputFile = "./dist/web/main.js";

async function stripRemoteDiagnostics(): Promise<void> {
  const source = await readFile(outputFile, "utf8");
  const sanitized = source.replaceAll("https://react.dev/errors/", "#react-error-");

  if (sanitized !== source) {
    await writeFile(outputFile, sanitized);
  }
}

const config: BuildOptions = {
  entryPoints: ["./src/index.tsx"],
  outfile: outputFile,
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  platform: "browser",
  plugins: [
    sassPlugin(),
    {
      name: "jetcreeper-self-contained-assets",
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

if (process.argv.slice(2)[0] === "watch") {
  const context = await esbuild.context(config);
  await context.watch();
  console.log("Watching Jetcreeper sources...");
} else {
  try {
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
