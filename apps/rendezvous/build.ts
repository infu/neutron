import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { BuildOptions } from "esbuild";

const outfile = "./dist/web/main.js";

async function stripRemoteDiagnostics(): Promise<void> {
  const source = await readFile(outfile, "utf8");
  const sanitized = source.replaceAll("https://react.dev/errors/", "#react-error-");
  if (sanitized !== source) {
    await writeFile(outfile, sanitized);
  }
}

async function buildMediaEntrypoint(): Promise<void> {
  const result = await esbuild.build({ entryPoints: ["./src/media.ts"], bundle: true, minify: true, format: "iife", platform: "browser", write: false });
  const script = result.outputFiles[0]?.text;
  if (!script) throw new Error("Rendezvous media bundle was empty");
  const template = await readFile("./public/media.html", "utf8");
  const marker = "/*__RENDEZVOUS_MEDIA_SCRIPT__*/";
  if (!template.includes(marker)) throw new Error("Rendezvous media template marker is missing");
  // A replacement callback preserves `$&`, `$\`` and `$'` byte-for-byte in
  // bundled dependencies instead of treating them as String.replace tokens.
  await writeFile("./dist/web/media.html", template.replace(marker, () => script));
}

const config: BuildOptions = {
  entryPoints: { main: "./src/index.tsx", service: "./src/service.ts", tray: "./src/tray.tsx" },
  outdir: "./dist/web",
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
    await buildMediaEntrypoint();
  } catch {
    process.exit(1);
  }
}
