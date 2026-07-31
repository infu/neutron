import esbuild from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import copyStaticFiles from "esbuild-copy-static-files";
import type { BuildOptions } from "esbuild";
import {
  DEFAULT_LOCAL_HOST,
  envFlag,
} from "neutron-tools/src/runtime.js";
import productionCanisters from "./.icp/data/mappings/ic.ids.json";

const dispenserCanisterId =
  process.env.DISPENSER_CANISTER_ID ||
  productionCanisters.dispenser;
const local = envFlag(process.env.LOCAL);
const localHost = process.env.ICP_LOCAL_HOST || DEFAULT_LOCAL_HOST;

const config: BuildOptions = {
  entryPoints: ["./src/index.tsx"],
  outfile: "./build/main.js",
  bundle: true,
  minify: true,
  target: "es2020",
  define: {
    global: "window",
    "process.env.DISPENSER_CANISTER_ID": JSON.stringify(dispenserCanisterId),
    "process.env.LOCAL": JSON.stringify(local),
    "process.env.ICP_LOCAL_HOST": JSON.stringify(localHost),
  },
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  plugins: [
    sassPlugin(),
    copyStaticFiles({
      src: "./public",
      dest: "./build",
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
  platform: "browser",
};

const args = process.argv.slice(2);

if (args[0] === "watch") {
  const ctx = await esbuild.context({ ...config, minify: false });
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  try {
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
