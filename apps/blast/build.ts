import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { readFile, rm } from "node:fs/promises";
import type { BuildOptions, Metafile } from "esbuild";
import { assertBlastWorkerBundleIsolation } from "./bundle_audit.ts";

const outdir = "./dist/web";
const config: BuildOptions = {
  entryPoints: {
    service: "./src/service.ts",
    icblast_worker: "./src/icblast_worker.ts",
    script_worker: "./src/script_worker.ts",
    query_worker: "./src/query_worker.ts",
  },
  outdir,
  entryNames: "[name]",
  assetNames: "static/[name]-[hash]",
  bundle: true,
  conditions: ["browser", "import", "default"],
  metafile: true,
  minify: true,
  format: "esm",
  loader: {
    ".ts": "ts",
    ".min.js": "text",
    ".wasm": "file",
    ".bin": "file",
  },
  platform: "browser",
  plugins: [
    copyStaticFiles({
      src: "./public",
      dest: outdir,
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
};

await rm(outdir, { force: true, recursive: true });

if (process.argv.slice(2)[0] === "watch") {
  const context = await esbuild.context({ ...config, minify: false });
  await context.watch();
} else {
  try {
    const result = await esbuild.build(config);
    await auditBrowserBundle(result.metafile);
  } catch (error) {
    if (error instanceof Error && error.message.length > 0) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

async function auditBrowserBundle(
  metafile: Metafile | undefined,
): Promise<void> {
  if (!metafile) throw new Error("Blast bundle audit is missing its metafile");
  assertBlastWorkerBundleIsolation(metafile, [
    "icblast_worker.js",
    "script_worker.js",
    "query_worker.js",
  ]);
  const inputEntries = Object.keys(metafile.inputs);
  const normalized = inputEntries.map((input) => input.replaceAll("\\", "/"));
  const jsonataSourceIndex = normalized.findIndex((input) =>
    input.endsWith("node_modules/jsonata/jsonata.min.js"),
  );
  if (jsonataSourceIndex < 0) {
    throw new Error("Blast bundle is missing JSONata's guest source");
  }
  const queryWorkerOutput = Object.entries(metafile.outputs).find(
    ([outputPath]) => outputPath.replaceAll("\\", "/").endsWith("/query_worker.js"),
  );
  if (
    !queryWorkerOutput ||
    !Object.hasOwn(
      queryWorkerOutput[1].inputs,
      inputEntries[jsonataSourceIndex]!,
    )
  ) {
    throw new Error("Blast query Worker did not bundle JSONata as guest source");
  }
  if (
    normalized.some((input) =>
      input.endsWith("node_modules/jsonata/jsonata.js"),
    )
  ) {
    throw new Error("Blast query Worker contains host-realm JSONata");
  }
  const icblastSourceIndex = normalized.findIndex((input) =>
    input.endsWith("node_modules/icblast/lib/browser.js"),
  );
  if (icblastSourceIndex < 0) {
    throw new Error("Blast bundle is missing ICBlast's browser entrypoint");
  }
  const serviceOutput = requiredOutput(metafile, "service.js");
  const icblastWorkerOutput = requiredOutput(metafile, "icblast_worker.js");
  const icblastSourceInput = inputEntries[icblastSourceIndex]!;
  if (!Object.hasOwn(icblastWorkerOutput.inputs, icblastSourceInput)) {
    throw new Error("Blast ICBlast Worker is missing ICBlast discovery");
  }
  if (Object.hasOwn(serviceOutput.inputs, icblastSourceInput)) {
    throw new Error("Blast resident synchronously bundles ICBlast discovery");
  }
  const didcWasmIndex = normalized.findIndex((input) =>
    input.endsWith(
      "node_modules/icblast/didc_wasm_pkg/didc_rust_bg.bin",
    ),
  );
  if (didcWasmIndex < 0) {
    throw new Error("Blast bundle is missing ICBlast's packaged didc Wasm");
  }
  const didcWasmInput = inputEntries[didcWasmIndex]!;
  const emittedDidcWasm = Object.entries(metafile.outputs).find(
    ([outputPath, output]) =>
      outputPath.endsWith(".bin") &&
      output.bytes > 0 &&
      Object.hasOwn(output.inputs, didcWasmInput),
  );
  if (!emittedDidcWasm) {
    throw new Error("Blast bundle did not emit ICBlast's packaged didc Wasm");
  }
  if (!Object.hasOwn(icblastWorkerOutput.inputs, didcWasmInput)) {
    throw new Error("Blast ICBlast Worker is missing didc Wasm");
  }
  if (Object.hasOwn(serviceOutput.inputs, didcWasmInput)) {
    throw new Error("Blast resident synchronously bundles didc Wasm");
  }
  const forbidden = normalized.find(
    (input) =>
      input.includes("node_modules/icblast/lib/mcp_") ||
      input.includes("node_modules/icblast/bin/") ||
      input.includes("node_modules/@modelcontextprotocol/"),
  );
  if (forbidden !== undefined) {
    throw new Error(`Blast browser bundle contains a forbidden input: ${forbidden}`);
  }
  const legacyConverterCanister = "a4gq6-oaaaa-aaaab-qaa4q-cai";
  for (const outputPath of Object.keys(metafile.outputs)) {
    if (!outputPath.endsWith(".js")) continue;
    if ((await readFile(outputPath, "utf8")).includes(legacyConverterCanister)) {
      throw new Error(
        "Blast browser bundle contains ICBlast's legacy converter canister",
      );
    }
  }
}

function requiredOutput(metafile: Metafile, basename: string) {
  const output = Object.entries(metafile.outputs).find(([outputPath]) =>
    outputPath.replaceAll("\\", "/").endsWith(`/${basename}`),
  );
  if (!output) throw new Error(`Blast bundle is missing ${basename}`);
  return output[1];
}
