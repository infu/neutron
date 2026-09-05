import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const compilerDirectory = path.resolve(
  process.env.NEUTRON_MOTOKO_COMPILER_DIR ??
    path.join(process.cwd(), "packages/neutron-motoko-wasm/compiler"),
);

test.beforeEach(() => {
  if (process.env.NEUTRON_MOTOKO_REQUIRE_STOCK_STACK === "1") {
    expect(process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? "").not.toMatch(
      /(?:stack[-_]size|stack[-_]switch)/i,
    );
  }
});

type CompileFixture = {
  modules: Array<{ path: string; content: string }>;
  neutron: string;
  appCount?: number;
};

function makeScaleFixture(appCount: number): CompileFixture {
  const modules: CompileFixture["modules"] = [];
  const imports: string[] = [];
  const actorFields: string[] = [];
  const helpersPerApp = Number(
    process.env.NEUTRON_MOTOKO_HELPERS_PER_APP ?? 300,
  );
  const payloadBytesPerApp = Number(
    process.env.NEUTRON_MOTOKO_PAYLOAD_BYTES_PER_APP ?? 0,
  );
  for (let app = 0; app < appCount; app += 1) {
    const id = `app_${app}`;
    const typesPath = `${id}_types`;
    const logicPath = `${id}_logic`;
    modules.push({
      path: `${typesPath}.mo`,
      content:
        "module { public type Memory = { var counter : Nat }; " +
        "public func fresh() : Memory { { var counter = 0 } } }",
    });
    modules.push({
      path: `${logicPath}.mo`,
      content: `module { public let payload = "${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
        app
      ]!.repeat(payloadBytesPerApp)}"; ${Array.from(
        { length: helpersPerApp },
        (_, helper) =>
          `public func helper_${helper}(value : Nat) : Nat { value + ${helper} };`,
      ).join("\n")} }`,
    });
    const calls = Array.from(
      { length: helpersPerApp },
      (_, helper) => `Logic.helper_${helper}(input)`,
    );
    const balancedSum = (start: number, end: number): string => {
      if (end - start <= 1) return calls[start] ?? "0";
      const middle = Math.floor((start + end) / 2);
      return `(${balancedSum(start, middle)} + ${balancedSum(middle, end)})`;
    };
    // Keep source-volume stress separate from an adversarially deep expression.
    const helperCalls =
      process.env.NEUTRON_MOTOKO_BALANCED_HELPER_SUM === "1"
        ? balancedSum(0, calls.length)
        : calls.join(" + ");
    modules.push({
      path: `${id}.mo`,
      content: `import Types "${typesPath}";
        import Logic "${logicPath}";
        module {
          public type Memory = Types.Memory;
          public func memory() : Memory { Types.fresh() };
          public class Init(memory : Memory) {
            public func value(input : Nat) : Nat {
              memory.counter + Logic.payload.size() + ${helperCalls}
            };
          };
        }`,
    });
    const alias = `App${app}`;
    imports.push(`import ${alias} "${id}";`);
    actorFields.push(`
      type Memory_${id}_store = { #v1 : ${alias}.Memory };
      let memory_store_${id} : Memory_${id}_store = #v1(${alias}.memory());
      transient let #v1(memory_${id}) = memory_store_${id};
      transient let init_${id} = ${alias}.Init(memory_${id});
      public query func ${id}_value() : async Nat { init_${id}.value(${app}) };
    `);
  }
  return {
    modules,
    appCount,
    neutron: `${imports.join("\n")}
      shared({ caller = _installer }) persistent actor class Class<system>() = this {
        ${actorFields.join("\n")}
      }`,
  };
}

async function serveCompiler(
  page: Page,
  {
    loadOnPage = true,
    failWasm = false,
  }: { loadOnPage?: boolean; failWasm?: boolean } = {},
): Promise<void> {
  await page.route("https://compiler.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({
        contentType: "text/html",
        body: loadOnPage
          ? '<!doctype html><script src="/motoko/moc.wasm.js"></script>'
          : "<!doctype html>",
      });
      return;
    }
    if (!url.pathname.startsWith("/motoko/")) {
      await route.fulfill({ status: 404 });
      return;
    }
    const relativePath = url.pathname.slice("/motoko/".length);
    const filePath = path.resolve(compilerDirectory, relativePath);
    if (!filePath.startsWith(compilerDirectory)) {
      await route.fulfill({ status: 403 });
      return;
    }
    if (failWasm && filePath.endsWith(".wasm")) {
      await route.fulfill({
        status: 503,
        contentType: "application/wasm",
        body: "compiler sidecar unavailable",
      });
      return;
    }
    await route.fulfill({
      path: filePath,
      contentType: filePath.endsWith(".wasm")
        ? "application/wasm"
        : "text/javascript",
    });
  });
}

async function loadCompiler(page: Page): Promise<void> {
  await serveCompiler(page);
  await page.goto("https://compiler.test/");
  await page.waitForFunction(
    () =>
      typeof (globalThis as { Motoko?: { compileWasm?: unknown } }).Motoko
        ?.compileWasm === "function",
  );
}

async function loadCompilerWorkerPage(page: Page): Promise<void> {
  await serveCompiler(page, { loadOnPage: false });
  await page.goto("https://compiler.test/");
}

test("wasm_of_ocaml compiler owns transferable output in fresh Chrome contexts", async ({
  browser,
}) => {
  test.info().annotations.push({
    type: "browser-version",
    description: browser.version(),
  });

  for (let run = 0; run < 2; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loadCompiler(page);

    const result = await page.evaluate(() => {
      type CompilerResult<T> = { code: T };
      type Compiler = {
        inspectMotoko(
          path: string,
          source: string,
        ): CompilerResult<{
          immediateImports: string[];
          hasActorUrl: boolean;
          dotMembers: string[];
          patternFields: string[];
        }>;
        saveFile(path: string, source: string): void;
        compileWasm(
          mode: string,
          path: string,
        ): CompilerResult<{
          wasm: Uint8Array;
          candid: string;
        }>;
      };
      const compiler = (globalThis as unknown as { Motoko: Compiler }).Motoko;
      const inspection = compiler.inspectMotoko(
        "inspect.mo",
        'import Prim "mo:prim"; module { public func f(t : Text) : actor {} { Prim.cyclesAdd(1); actor (t) } }',
      ).code;
      compiler.saveFile(
        "main.mo",
        "shared({ caller = _installer }) persistent actor class Class<system>() = this { public query func ping() : async Nat32 { 4294967295 } }",
      );

      const started = performance.now();
      const first = compiler.compileWasm("ic", "main.mo").code.wasm;
      const elapsedMs = performance.now() - started;
      const firstSnapshot = new Uint8Array(first);
      const second = compiler.compileWasm("ic", "main.mo").code.wasm;
      const firstUnchanged = firstSnapshot.every(
        (byte, index) => first[index] === byte,
      );
      const secondSnapshot = new Uint8Array(second);
      first[0] ^= 0xff;
      first[Math.floor(first.length / 2)] ^= 0xff;
      first[first.length - 1] ^= 0xff;
      const resultsAreIsolated = secondSnapshot.every(
        (byte, index) => second[index] === byte,
      );
      structuredClone(first, { transfer: [first.buffer] });
      const detached = first.buffer.byteLength === 0;
      const third = compiler.compileWasm("ic", "main.mo").code.wasm;

      return {
        elapsedMs,
        bytes: third.byteLength,
        exactBuffer:
          third.byteOffset === 0 &&
          third.byteLength === third.buffer.byteLength,
        firstUnchanged,
        resultsAreIsolated,
        detached,
        valid: WebAssembly.validate(third),
        inspection,
      };
    });

    expect(result).toMatchObject({
      exactBuffer: true,
      firstUnchanged: true,
      resultsAreIsolated: true,
      detached: true,
      valid: true,
      inspection: {
        immediateImports: ["mo:prim"],
        hasActorUrl: true,
        dotMembers: ["cyclesAdd"],
        patternFields: [],
      },
    });
    expect(result.bytes).toBeGreaterThan(1000);
    await context.close();
  }
});

test("compact inspection handles deeply nested harmless primitive names in a Worker", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loadCompilerWorkerPage(page);
  const results = await page.evaluate(async () => {
    type Inspection = {
      immediateImports: string[];
      hasActorUrl: boolean;
      dotMembers: string[];
      patternFields: string[];
    };
    const worker = new Worker("/motoko/compiler-worker.js");
    let nextId = 1;
    const inspect = (source: string): Promise<Inspection> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const onMessage = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          worker.removeEventListener("message", onMessage);
          if (!event.data.ok) reject(new Error(event.data.error));
          else if (!event.data.result.code) {
            reject(new Error(JSON.stringify(event.data.result.diagnostics)));
          } else resolve(event.data.result.code as Inspection);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({
          id,
          method: "inspectMotoko",
          args: ["deep.mo", source],
        });
      });
    try {
      const harmless = [];
      for (const terms of [1_000, 3_000, 10_000]) {
        harmless.push(
          await inspect(
            `module { let cyclesAdd = 0; public func value() : Nat { cyclesAdd + ${Array(terms).fill("1").join(" + ")} } }`,
          ),
        );
      }
      const acquired = await inspect(
        'import { cyclesAdd = add } "mo:prim"; module { public func value() { add(1) } }',
      );
      return { harmless, acquired };
    } finally {
      worker.terminate();
    }
  });
  expect(results.harmless).toEqual(
    Array.from({ length: 3 }, () => ({
      immediateImports: [],
      hasActorUrl: false,
      dotMembers: [],
      patternFields: [],
    })),
  );
  expect(results.acquired).toMatchObject({
    immediateImports: ["mo:prim"],
    patternFields: ["cyclesAdd"],
  });
  await context.close();
});

test("compiler Worker reports the actual loader failure", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await serveCompiler(page, { loadOnPage: false, failWasm: true });
  await page.goto("https://compiler.test/");

  const error = await page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker("/motoko/compiler-worker.js");
        worker.addEventListener("message", (event) => {
          worker.terminate();
          if (event.data?.ok === false) resolve(String(event.data.error));
          else reject(new Error("Compiler Worker unexpectedly initialized"));
        });
        worker.addEventListener("error", (event) => {
          worker.terminate();
          reject(event.error ?? new Error(event.message));
        });
        worker.postMessage({ id: 1, method: "__version", args: [] });
      }),
  );

  expect(error).toContain(
    "__version: Error: Motoko Wasm compiler initialization failed",
  );
  expect(error).not.toContain("did not initialize");
  await context.close();
});

test("representative compiler fixture is deterministic in fresh Chrome contexts", async ({
  browser,
}) => {
  test.setTimeout(
    Number(process.env.NEUTRON_MOTOKO_FIXTURE_TIMEOUT_MS ?? 300_000),
  );
  const fixturePath = process.env.NEUTRON_MOTOKO_FIXTURE;
  const scaleApps = Number(process.env.NEUTRON_MOTOKO_SCALE_APPS ?? 0);
  test.skip(
    !fixturePath && scaleApps <= 0,
    "Set NEUTRON_MOTOKO_FIXTURE or NEUTRON_MOTOKO_SCALE_APPS",
  );
  const fixture: CompileFixture = fixturePath
    ? (JSON.parse(await fs.readFile(fixturePath, "utf8")) as CompileFixture)
    : makeScaleFixture(scaleApps);
  const persistence = process.env.NEUTRON_MOTOKO_PERSISTENCE ?? "classical";
  expect(["classical", "enhanced"]).toContain(persistence);
  const fixtureHash = createHash("sha256")
    .update(JSON.stringify(fixture))
    .digest("hex");
  const manifest = JSON.parse(
    await fs.readFile(path.join(compilerDirectory, "manifest.json"), "utf8"),
  ) as { source: { revision: string }; sha256: Record<string, string> };
  const compilerSha256 = Object.fromEntries(
    await Promise.all(
      Object.entries(manifest.sha256).map(async ([file, expected]) => {
        const actual = createHash("sha256")
          .update(await fs.readFile(path.join(compilerDirectory, file)))
          .digest("hex");
        expect(actual, `compiler artifact ${file}`).toBe(expected);
        return [file, actual];
      }),
    ),
  );
  const workerSha256 = createHash("sha256")
    .update(
      await fs.readFile(path.join(compilerDirectory, "compiler-worker.js")),
    )
    .digest("hex");
  const runs: Array<{
    elapsedMs: number;
    compilerId: string;
    appCount: number | null;
    moduleCount: number;
    sourceBytes: number;
    generatedSourceBytes: number;
    diagnosticCount: number;
    diagnosticCodes: Record<string, number>;
    wasmBytes: number;
    wasmHash: string;
    wasmWithoutCompilerIdHash: string;
    wasmWithBaselineCompilerIdHash: string;
    compilerIdDataReplacements: number;
    wasmSections: Array<{ name: string; bytes: number; sha256: string }>;
    candidBytes: number;
    candidHash: string;
    stableBytes: number;
    stableHash: string;
    valid: boolean;
  }> = [];
  const baseline = process.env.NEUTRON_MOTOKO_BASELINE_REPORT
    ? (JSON.parse(
        await fs.readFile(process.env.NEUTRON_MOTOKO_BASELINE_REPORT, "utf8"),
      ) as {
        browser: string;
        chromiumArgs: string;
        persistence: string;
        fixtureHash: string;
        runs: typeof runs;
      })
    : undefined;
  // Older reports predate recording the API's build ID. This explicit override
  // permits their exact byte hashes to remain the baseline evidence.
  const baselineCompilerId =
    baseline?.runs[0]?.compilerId ??
    process.env.NEUTRON_MOTOKO_BASELINE_COMPILER_ID;
  if (baseline) expect(baselineCompilerId).toBeTruthy();

  for (let run = 0; run < 2; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loadCompilerWorkerPage(page);
    runs.push(
      await page.evaluate(
        async ({ fixture: input, persistence, baselineCompilerId }) => {
          type WorkerResponse =
            | { id: number; ok: true; result: unknown }
            | { id: number; ok: false; error: string };
          let nextId = 1;
          const call = <T>(
            worker: Worker,
            method: string,
            args: unknown[],
          ): Promise<T> =>
            new Promise((resolve, reject) => {
              const id = nextId++;
              const onMessage = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.id !== id) return;
                worker.removeEventListener("message", onMessage);
                if (event.data.ok) resolve(event.data.result as T);
                else reject(new Error(event.data.error));
              };
              worker.addEventListener("message", onMessage);
              worker.postMessage({ id, method, args });
            });
          const inspectionWorker = new Worker("/motoko/compiler-worker.js");
          for (const module of input.modules) {
            await call(inspectionWorker, "inspectMotoko", [
              module.path,
              module.content,
            ]);
          }
          inspectionWorker.terminate();

          const worker = new Worker("/motoko/compiler-worker.js");
          const compilerId = await call<string>(worker, "__version", []);
          // Match Neutron's production configuration instead of the raw compiler's
          // enhanced-persistence default, which has a different memory footprint.
          for (const option of persistence === "classical"
            ? ["classicOP", "marking"]
            : ["enhancedOP", "incremental"]) {
            await call(worker, "gcFlags", [option]);
          }
          for (const module of input.modules) {
            await call(worker, "saveFile", [module.path, module.content]);
          }
          await call(worker, "saveFile", ["neutron.mo", input.neutron]);
          const started = performance.now();
          const result = await call<{
            diagnostics: Array<{ code: string }>;
            code: {
              wasm: Uint8Array;
              candid: string;
              stable: string;
            };
          }>(worker, "compileWasm", ["ic", "neutron.mo"]);
          const elapsedMs = performance.now() - started;
          const encoder = new TextEncoder();
          const hash = async (bytes: Uint8Array): Promise<string> => {
            const digest = new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes),
            );
            return [...digest]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          };
          // A fresh compiler build changes both its provenance custom section
          // and the compilerVersion text exported by runtime information. Keep
          // raw hashes, then substitute only the exact runtime build-ID bytes
          // when comparing with another build, preserving every other byte.
          const wasm = result.code.wasm;
          const sections: Array<{
            name: string;
            bytes: number;
            sha256: string;
          }> = [];
          const withoutCompilerId = new Uint8Array(wasm.length);
          const withBaselineCompilerId = new Uint8Array(wasm.length);
          withoutCompilerId.set(wasm.subarray(0, 8));
          withBaselineCompilerId.set(wasm.subarray(0, 8));
          let compilerIdDataReplacements = 0;
          let copied = 8;
          let offset = 8;
          const readUleb = (): number => {
            let value = 0;
            let shift = 0;
            while (true) {
              const byte = wasm[offset++];
              if (byte === undefined || shift >= 35)
                throw new Error("Invalid Wasm section length");
              value += (byte & 0x7f) * 2 ** shift;
              if ((byte & 0x80) === 0) return value;
              shift += 7;
            }
          };
          while (offset < wasm.length) {
            const start = offset;
            const id = wasm[offset++];
            const length = readUleb();
            const end = offset + length;
            if (end > wasm.length) throw new Error("Truncated Wasm section");
            let name = `section:${id}`;
            if (id === 0) {
              const nameLength = readUleb();
              if (offset + nameLength > end)
                throw new Error("Truncated Wasm custom section name");
              name = new TextDecoder().decode(
                wasm.subarray(offset, offset + nameLength),
              );
            }
            const bytes = wasm.subarray(start, end);
            sections.push({
              name,
              bytes: bytes.length,
              sha256: await hash(bytes),
            });
            if (
              name !== "icp:public motoko:compiler" &&
              name !== "icp:private motoko:compiler"
            ) {
              withoutCompilerId.set(bytes, copied);
              if (
                id === 11 &&
                baselineCompilerId &&
                baselineCompilerId !== compilerId
              ) {
                const needle = encoder.encode(compilerId);
                const replacement = encoder.encode(baselineCompilerId);
                if (
                  needle.length === 0 ||
                  needle.length !== replacement.length
                ) {
                  throw new Error(
                    "Compiler build IDs must have equal byte lengths for an exact baseline comparison",
                  );
                }
                const substituted = bytes.slice();
                for (let at = 0; at <= bytes.length - needle.length; at += 1) {
                  if (
                    needle.every((byte, index) => bytes[at + index] === byte)
                  ) {
                    substituted.set(replacement, at);
                    compilerIdDataReplacements += 1;
                    at += needle.length - 1;
                  }
                }
                withBaselineCompilerId.set(substituted, copied);
              } else {
                withBaselineCompilerId.set(bytes, copied);
              }
              copied += bytes.length;
            }
            offset = end;
          }
          const candid = encoder.encode(result.code.candid);
          const stable = encoder.encode(result.code.stable);
          const summary = {
            elapsedMs,
            compilerId,
            appCount: input.appCount ?? null,
            moduleCount: input.modules.length,
            sourceBytes: input.modules.reduce(
              (total, module) => total + encoder.encode(module.content).length,
              0,
            ),
            generatedSourceBytes: encoder.encode(input.neutron).length,
            diagnosticCount: result.diagnostics.length,
            diagnosticCodes: Object.fromEntries(
              [...new Set(result.diagnostics.map(({ code }) => code))]
                .sort()
                .map((code) => [
                  code,
                  result.diagnostics.filter(
                    (diagnostic) => diagnostic.code === code,
                  ).length,
                ]),
            ),
            wasmBytes: result.code.wasm.byteLength,
            wasmHash: await hash(wasm),
            wasmWithoutCompilerIdHash: await hash(
              withoutCompilerId.subarray(0, copied),
            ),
            wasmWithBaselineCompilerIdHash: await hash(
              withBaselineCompilerId.subarray(0, copied),
            ),
            compilerIdDataReplacements,
            wasmSections: sections,
            candidBytes: candid.length,
            candidHash: await hash(candid),
            stableBytes: stable.length,
            stableHash: await hash(stable),
            valid: WebAssembly.validate(result.code.wasm),
          };
          worker.terminate();
          return summary;
        },
        { fixture, persistence, baselineCompilerId },
      ),
    );
    await context.close();
  }

  const report = {
    browser: browser.version(),
    chromiumArgs: process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? "",
    compilerDirectory,
    compilerRevision: manifest.source.revision,
    compilerSha256,
    workerSha256,
    persistence,
    fixtureHash,
    runs,
  };
  console.log("representative compiler runs", JSON.stringify(report));
  await test.info().attach("compiler-fixture-report", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  if (process.env.NEUTRON_MOTOKO_REPORT_PATH) {
    await fs.writeFile(
      process.env.NEUTRON_MOTOKO_REPORT_PATH,
      JSON.stringify(report, null, 2),
    );
  }
  if (baseline) {
    expect(report.browser).toBe(baseline.browser);
    expect(report.chromiumArgs).toBe(baseline.chromiumArgs);
    expect(report.persistence).toBe(baseline.persistence);
    expect(report.fixtureHash).toBe(baseline.fixtureHash);
    expect(runs[0]).toMatchObject({
      diagnosticCount: baseline.runs[0]!.diagnosticCount,
      diagnosticCodes: baseline.runs[0]!.diagnosticCodes,
      wasmWithBaselineCompilerIdHash:
        baseline.runs[0]!.wasmWithoutCompilerIdHash,
      compilerIdDataReplacements:
        baselineCompilerId === runs[0]!.compilerId ? 0 : 1,
      candidHash: baseline.runs[0]!.candidHash,
      stableHash: baseline.runs[0]!.stableHash,
    });
  }
  expect(runs[0]).toMatchObject({
    moduleCount: fixture.modules.length,
    valid: true,
  });
  expect(runs[0]!.diagnosticCodes.M0005).toBeUndefined();
  expect(runs[1]).toMatchObject({
    moduleCount: runs[0]!.moduleCount,
    sourceBytes: runs[0]!.sourceBytes,
    generatedSourceBytes: runs[0]!.generatedSourceBytes,
    diagnosticCount: runs[0]!.diagnosticCount,
    diagnosticCodes: runs[0]!.diagnosticCodes,
    wasmBytes: runs[0]!.wasmBytes,
    wasmHash: runs[0]!.wasmHash,
    wasmWithoutCompilerIdHash: runs[0]!.wasmWithoutCompilerIdHash,
    wasmWithBaselineCompilerIdHash: runs[0]!.wasmWithBaselineCompilerIdHash,
    compilerIdDataReplacements: runs[0]!.compilerIdDataReplacements,
    wasmSections: runs[0]!.wasmSections,
    candidBytes: runs[0]!.candidBytes,
    candidHash: runs[0]!.candidHash,
    stableBytes: runs[0]!.stableBytes,
    stableHash: runs[0]!.stableHash,
    valid: true,
  });
});
