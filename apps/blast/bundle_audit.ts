import type { Metafile } from "esbuild";

/** Keep killable guest Workers independent of the app-side message-bus runtime. */
export function assertBlastWorkerBundleIsolation(
  metafile: Metafile,
  workerOutputs: readonly string[],
): void {
  for (const workerOutput of workerOutputs) {
    const output = Object.entries(metafile.outputs).find(([outputPath]) =>
      outputPath.replaceAll("\\", "/").endsWith(`/${workerOutput}`)
    );
    if (!output) {
      throw new Error(`Blast bundle is missing ${workerOutput}`);
    }

    const forbiddenInput = Object.keys(output[1].inputs).find((inputPath) => {
      const normalized = inputPath.replaceAll("\\", "/");
      return (
        normalized.includes("/packages/neutron-tools/") ||
        normalized.includes("/node_modules/neutron-tools/") ||
        (workerOutput === "query_worker.js" &&
          /(?:^|\/)src\/script_guest\.ts$/u.test(normalized))
      );
    });
    if (forbiddenInput !== undefined) {
      throw new Error(
        `Blast ${workerOutput} contains forbidden Worker input: ${forbiddenInput}`,
      );
    }
  }
}
