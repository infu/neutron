import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const compilerDirectory = path.resolve(
  process.env.NEUTRON_MOTOKO_COMPILER_DIR ??
    path.join(process.cwd(), "packages/neutron-motoko-wasm/compiler"),
);

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
      content: `module { public let payload = "${
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[app]!.repeat(
          payloadBytesPerApp,
        )
      }"; ${Array.from(
        { length: helpersPerApp },
        (_, helper) =>
          `public func helper_${helper}(value : Nat) : Nat { value + ${helper} };`,
      ).join("\n")} }`,
    });
    const helperCalls = Array.from(
      { length: helpersPerApp },
      (_, helper) => `Logic.helper_${helper}(input)`,
    ).join(" + ");
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
        inspectMotoko(path: string, source: string): CompilerResult<{
          immediateImports: string[];
          hasActorUrl: boolean;
          dotMembers: string[];
        }>;
        saveFile(path: string, source: string): void;
        compileWasm(mode: string, path: string): CompilerResult<{
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
          third.byteOffset === 0 && third.byteLength === third.buffer.byteLength,
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
      },
    });
    expect(result.bytes).toBeGreaterThan(1000);
    await context.close();
  }
});

test("compiler Worker reports the actual loader failure", async ({ browser }) => {
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
  const fixturePath = process.env.NEUTRON_MOTOKO_FIXTURE;
  const scaleApps = Number(process.env.NEUTRON_MOTOKO_SCALE_APPS ?? 0);
  test.skip(
    !fixturePath && scaleApps <= 0,
    "Set NEUTRON_MOTOKO_FIXTURE or NEUTRON_MOTOKO_SCALE_APPS",
  );
  const fixture: CompileFixture = fixturePath
    ? (JSON.parse(await fs.readFile(fixturePath, "utf8")) as CompileFixture)
    : makeScaleFixture(scaleApps);
  const runs: Array<{
    elapsedMs: number;
    appCount: number | null;
    moduleCount: number;
    sourceBytes: number;
    generatedSourceBytes: number;
    diagnosticCount: number;
    diagnosticCodes: Record<string, number>;
    wasmBytes: number;
    wasmHash: string;
    candidBytes: number;
    stableBytes: number;
    valid: boolean;
  }> = [];

  for (let run = 0; run < 2; run += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loadCompilerWorkerPage(page);
    runs.push(
      await page.evaluate(async (input) => {
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
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", result.code.wasm),
        );
        const wasmHash = [...digest]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        const summary = {
          elapsedMs,
          appCount: input.appCount ?? null,
          moduleCount: input.modules.length,
          sourceBytes: input.modules.reduce(
            (total, module) => total + module.content.length,
            0,
          ),
          generatedSourceBytes: input.neutron.length,
          diagnosticCount: result.diagnostics.length,
          diagnosticCodes: Object.fromEntries(
            [...new Set(result.diagnostics.map(({ code }) => code))]
              .sort()
              .map((code) => [
                code,
                result.diagnostics.filter((diagnostic) => diagnostic.code === code)
                  .length,
              ]),
          ),
          wasmBytes: result.code.wasm.byteLength,
          wasmHash,
          candidBytes: result.code.candid.length,
          stableBytes: result.code.stable.length,
          valid: WebAssembly.validate(result.code.wasm),
        };
        worker.terminate();
        return summary;
      }, fixture),
    );
    await context.close();
  }

  console.log("representative compiler runs", JSON.stringify(runs));
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
    candidBytes: runs[0]!.candidBytes,
    stableBytes: runs[0]!.stableBytes,
    valid: true,
  });
});
