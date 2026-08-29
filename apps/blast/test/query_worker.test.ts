import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import esbuild from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "neutron-tools/app";
import { assertBlastWorkerBundleIsolation } from "../bundle_audit.ts";
import { isQuickJSMemoryFailure } from "../src/quickjs_error.ts";
import {
  QUERY_PROTOCOL_VERSION,
  isQueryResponse,
  type QueryRequest,
  type QueryResponse,
} from "../src/query_protocol.ts";

type BundledQuery = (
  expression: string,
  input: JsonValue,
  signal?: AbortSignal,
) => Promise<JsonValue>;

let temporaryDirectory = "";
let queryWorkerUrl = "";
let queryWorkerSource = "";
let runBundledQuery!: BundledQuery;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "neutron-blast-query-worker-"),
  );
  const appRoot = join(import.meta.dir, "..");
  const nodeDetectionPrelude =
    "const __blastNodeVersion=globalThis.process?.versions?.node;" +
    "if(globalThis.process?.versions)globalThis.process.versions.node=undefined;";
  const nodeDetectionRestore =
    "if(globalThis.process?.versions)" +
    "globalThis.process.versions.node=__blastNodeVersion;";
  const build = await esbuild.build({
    entryPoints: {
      query_runner: join(appRoot, "src/query_runner.ts"),
      query_worker: join(appRoot, "src/query_worker.ts"),
    },
    outdir: temporaryDirectory,
    entryNames: "[name]",
    bundle: true,
    conditions: ["browser", "import", "default"],
    format: "esm",
    metafile: true,
    platform: "browser",
    loader: { ".ts": "ts", ".min.js": "text", ".wasm": "binary" },
    banner: { js: nodeDetectionPrelude },
    footer: { js: nodeDetectionRestore },
  });
  assertBlastWorkerBundleIsolation(build.metafile, ["query_worker.js"]);
  const bundled = (await import(
    `${pathToFileURL(join(temporaryDirectory, "query_runner.js")).href}?test=${Date.now()}`
  )) as Readonly<{ runJsonataQuery: BundledQuery }>;
  runBundledQuery = bundled.runJsonataQuery;
  queryWorkerUrl = pathToFileURL(
    join(temporaryDirectory, "query_worker.js"),
  ).href;
  queryWorkerSource = await readFile(
    join(temporaryDirectory, "query_worker.js"),
    "utf8",
  );
});

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("bundled heap-limited JSONata Worker", () => {
  test("recognizes QuickJS and browser Wasm memory-trap messages", () => {
    expect(isQuickJSMemoryFailure("Out of bounds memory access")).toBe(true);
    expect(isQuickJSMemoryFailure("Memory access out of bounds")).toBe(true);
    expect(isQuickJSMemoryFailure("ordinary query failure")).toBe(false);
  });

  test("does not bundle the script host bridge into the query Worker", () => {
    expect(queryWorkerSource).not.toContain("__blastHost");
    expect(queryWorkerSource).not.toContain("collections.put_page");
    expect(queryWorkerSource).not.toContain("blast.identity");
  });

  test("settles cancellation when an Error has a throwing message getter", async () => {
    const reason = new Error("hidden");
    Object.defineProperty(reason, "message", {
      get: () => {
        throw new Error("hostile message getter");
      },
    });
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      runBundledQuery("$", null, controller.signal),
    ).rejects.toThrow("JSONata query was cancelled");
  });

  test("queries nested paged data without flattening the input", async () => {
    const result = await runBundledQuery(
      `{
        "ids": pages.proposals[open = true].id,
        "yes": $sum(pages.proposals[open = true].votes.yes)
      }`,
      {
        pages: [
          {
            cursor: "page-1",
            proposals: [
              { id: "1", open: true, votes: { yes: 7, no: 2 } },
              { id: "2", open: false, votes: { yes: 9, no: 1 } },
            ],
          },
          {
            cursor: "page-2",
            proposals: [
              { id: "3", open: true, votes: { yes: 4, no: 5 } },
            ],
          },
        ],
      },
    );

    expect(result).toEqual({ ids: ["1", "3"], yes: 11 });
  });

  test(
    "repeatedly bounds nonterminating QuickJS work and safely tears down the real Worker",
    async () => {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const response = await runWorkerRequest(
          "($loop := function(){ $loop() }; $loop())",
          null,
          150,
        );
        expect(response.ok).toBe(false);
        if (!response.ok) {
          expect(response.error).toMatch(
            /JSONata query (?:deadline exceeded|exceeded its memory limit)/u,
          );
        }
      }
    },
    30_000,
  );

  test(
    "rejects an allocation bomb without making the next query unusable",
    async () => {
      await expect(
        runBundledQuery(
          '$pad("", 4000, $pad("", 10000, "x"))',
          null,
        ),
      ).rejects.toThrow("memory limit");
      await expect(runBundledQuery("$sum([1, 2, 3])", null)).resolves.toBe(6);
    },
    10_000,
  );

  test("rejects cyclic and non-JSON results instead of changing them", async () => {
    await expect(
      runBundledQuery('$ ~> | $ | {"self": $} |', { value: 1 }),
    ).rejects.toThrow("must not contain cycles");
    await expect(
      runBundledQuery('{"callable": function($value){$value}}', null),
    ).rejects.toThrow("must be JSON-compatible");
    await expect(runBundledQuery("missing.path", {})).rejects.toThrow(
      "must be JSON-compatible",
    );
  });
});

function runWorkerRequest(
  expression: string,
  input: JsonValue,
  timeoutMs: number,
): Promise<QueryResponse> {
  const worker = new Worker(queryWorkerUrl, {
    type: "module",
    name: "neutron-blast-jsonata-test",
  });
  const request: QueryRequest = {
    type: "blast:query:run",
    version: QUERY_PROTOCOL_VERSION,
    expression,
    input,
    timeoutMs,
  };
  return new Promise<QueryResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Bundled JSONata Worker test timed out"));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event.message || "Bundled JSONata Worker failed"));
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isQueryResponse(event.data)) {
        cleanup();
        reject(new Error("Bundled JSONata Worker protocol violation"));
        return;
      }
      cleanup();
      resolve(event.data);
    });
    worker.postMessage(request);
  });
}
