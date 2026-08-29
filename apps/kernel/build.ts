import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import copyStaticFiles from "esbuild-copy-static-files";
import fs from "node:fs";
import type { BuildOptions, Metafile, Plugin } from "esbuild";
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

const kernelManifest = JSON.parse(
  fs.readFileSync("./neutron.json", "utf8"),
) as { version?: unknown };
assertAppVersion(kernelManifest.version, "Kernel package version");
const kernelVersion = formatAppVersion(kernelManifest.version);

const retainMetafilePlugin: Plugin = {
  name: "retain-kernel-metafile",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0 && result.metafile !== undefined) {
        writeKernelMetafile(result.metafile);
      }
    });
  },
};

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
  metafile: true,
  define: {
    global: "window",
    "process.env.NEUTRON_VERSION": JSON.stringify(kernelVersion),
  },
  format: "esm",
  jsx: "automatic",
  loader: { ".bin": "file", ".js": "jsx", ".ts": "ts", ".tsx": "tsx" },

  plugins: [
    retainMetafilePlugin,
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
  await esbuild.build(config).catch(() => process.exit(1));
}

function writeKernelMetafile(metafile: Metafile): void {
  const destination = "./meta.json";
  const temporary = `./.meta.json.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(metafile)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
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
