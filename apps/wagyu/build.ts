import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions, Plugin } from "esbuild";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const outdir = path.join(appRoot, "dist/web");
const reactBundles = ["main.js", "tray.js"];
const packagedSourceModule = path.join(
  appRoot,
  "src/worker/packaged_source.ts",
);

async function buildVerificationWorkerSource(): Promise<{
  readonly source: string;
  readonly watchFiles: readonly string[];
}> {
  const result = await esbuild.build({
    absWorkingDir: appRoot,
    entryPoints: ["./src/worker/entry.ts"],
    bundle: true,
    format: "iife",
    legalComments: "none",
    minify: true,
    platform: "browser",
    write: false,
    metafile: true,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error("Wagyu verification Worker build was not singular");
  }
  return {
    source: result.outputFiles[0]!.text,
    watchFiles: Object.keys(result.metafile.inputs).map((input) =>
      path.resolve(appRoot, input)
    ),
  };
}

const packagedVerificationWorkerPlugin: Plugin = {
  name: "wagyu-packaged-verification-worker",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]src[\\/]worker[\\/]packaged_source\.ts$/ },
      async (args) => {
        if (path.resolve(args.path) !== packagedSourceModule) return null;
        const worker = await buildVerificationWorkerSource();
        return {
          contents:
            `const source=${JSON.stringify(worker.source)};export default source;`,
          loader: "js",
          watchFiles: [...worker.watchFiles],
        };
      },
    );
  },
};

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

async function enablePackagedWorkerCsp(): Promise<void> {
  const output = path.join(outdir, "service.html");
  const source = await readFile(output, "utf8");
  const networkWorkerPolicy = "worker-src 'self';";
  const packagedWorkerPolicy = "worker-src blob:;";
  if (source.includes(networkWorkerPolicy)) {
    await writeFile(
      output,
      source.replace(networkWorkerPolicy, packagedWorkerPolicy),
    );
    return;
  }
  if (!source.includes(packagedWorkerPolicy)) {
    throw new Error(
      "Wagyu resident CSP has no closed verification Worker policy",
    );
  }
}

const config: BuildOptions = {
  absWorkingDir: appRoot,
  entryPoints: {
    main: "./src/main.tsx",
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
    packagedVerificationWorkerPlugin,
    sassPlugin(),
    copyStaticFiles({
      src: path.join(appRoot, "public"),
      dest: outdir,
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
    {
      name: "wagyu-self-contained-assets",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0) {
            await Promise.all([
              stripRemoteDiagnostics(),
              enablePackagedWorkerCsp(),
            ]);
          }
        });
      },
    },
  ],
};

await rm(outdir, { force: true, recursive: true });

if (process.argv.slice(2)[0] === "watch") {
  const context = await esbuild.context(config);
  await context.watch();
  console.log("Watching Wagyu sources for changes...");
} else {
  try {
    await esbuild.build(config);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
