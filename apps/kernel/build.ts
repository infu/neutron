import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import copyStaticFiles from "esbuild-copy-static-files";
import fs from "node:fs";
import type { BuildOptions } from "esbuild";
import { envFlag } from "neutron-tools/src/runtime.js";
import { compilerAssetDirectory } from "neutron-motoko-wasm/node.js";
import {
  assertAppVersion,
  formatAppVersion,
} from "neutron-tools/src/version.js";
import { buildAttachmentCapacityEvidence } from "./evidence/attachment_capacity.ts";

// const neutronModules = {
//   name: "neutron-modules",
//   setup: function (build) {
//     build.onResolve({ filter: /^neutron-.*/ }, function (args) {
//       return {
//         path: args.path,
//         external: true,
//       };
//     });
//   },
// };

const writeMetafile = envFlag(process.env.ESBUILD_META);
const kernelManifest = JSON.parse(
  fs.readFileSync("./neutron.json", "utf8"),
) as { version?: unknown };
assertAppVersion(kernelManifest.version, "Kernel package version");
const kernelVersion = formatAppVersion(kernelManifest.version);

const config: BuildOptions = {
  entryPoints: {
    main: "./src/index.tsx",
  },
  outdir: "./dist/web",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  minify: true,
  metafile: writeMetafile,
  define: {
    global: "window",
    "process.env.NEUTRON_VERSION": JSON.stringify(kernelVersion),
  },
  format: "esm",
  jsx: "automatic",
  loader: { ".js": "jsx", ".ts": "ts", ".tsx": "tsx" },

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
    copyStaticFiles({
      src: compilerAssetDirectory(),
      dest: "./dist/web/motoko",
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
  platform: "browser",
};

const args = process.argv.slice(2);

// esbuild only replaces outputs it emits. Remove obsolete frontend chunks and
// detached qualification files, but retain an existing backend during watch.
fs.rmSync("./dist/web", { recursive: true, force: true });
removeDetachedQualificationArtifacts();
writeKernelReleaseEvidence();

if (args[0] === "watch") {
  const ctx = await esbuild.context({ ...config, minify: false });
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  const result = await esbuild.build(config).catch(() => process.exit(1));
  if (result.metafile) {
    fs.writeFileSync("meta.json", JSON.stringify(result.metafile));
  }
}

function writeKernelReleaseEvidence(): void {
  const metadata = {
    schema: "neutron.kernel.release-evidence.v1",
    attachment_capacity: buildAttachmentCapacityEvidence(),
  };
  fs.mkdirSync("./dist", { recursive: true });
  fs.writeFileSync(
    "./dist/.neutron-release-evidence.json",
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function removeDetachedQualificationArtifacts(): void {
  if (!fs.existsSync("./dist")) return;
  for (const entry of fs.readdirSync("./dist", {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.startsWith("certified-assets-") &&
      entry.name.endsWith(".json")
    ) {
      fs.rmSync(`./dist/${entry.name}`);
    }
  }
}
