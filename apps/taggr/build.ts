import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { BuildOptions } from "esbuild";

// React's production build embeds a documentation URL in its invariant
// messages. App bundles must not reference a remote origin, so rewrite it to a
// local fragment after every build; the package test asserts the result.
const BUNDLES = ["./dist/web/main.js", "./dist/web/service.js"];

async function stripRemoteDiagnostics(): Promise<void> {
  await Promise.all(
    BUNDLES.map(async (outfile) => {
      const source = await readFile(outfile, "utf8").catch(() => null);
      if (source === null) return;
      const sanitized = source.replaceAll(
        "https://react.dev/errors/",
        "#react-error-",
      );
      if (sanitized !== source) await writeFile(outfile, sanitized);
    }),
  );
}

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
    sassPlugin(),
    {
      name: "taggr-self-contained-assets",
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

if (process.argv.slice(2)[0] === "watch") {
  const context = await esbuild.context(config);
  await context.watch();
  console.log("Watching local files for changes...");
} else {
  try {
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
