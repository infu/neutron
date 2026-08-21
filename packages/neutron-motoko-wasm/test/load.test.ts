import { expect, test } from "bun:test";
import {
  disposeMotokoCompiler,
  loadMotoko,
  resetMotokoCompilerForTests,
  type BrowserCompilerWorker,
  resolveBrowserCompilerScriptUrl,
  resolveBrowserCompilerWorkerUrl,
} from "../src/index.ts";

test("resolves a relative browser compiler base URL against the page URL", () => {
  expect(
    resolveBrowserCompilerScriptUrl(
      "/motoko/",
      "http://4caro-hl777-77775-aaaba-cai.localhost:8000/"
    )
  ).toBe(
    "http://4caro-hl777-77775-aaaba-cai.localhost:8000/motoko/moc.wasm.js"
  );
});

test("resolves an absolute browser compiler base URL directly", () => {
  expect(
    resolveBrowserCompilerScriptUrl(
      "https://example.test/assets/motoko",
      "http://localhost:8000/"
    )
  ).toBe("https://example.test/assets/motoko/moc.wasm.js");
});

test("resolves the browser compiler worker beside the compiler assets", () => {
  expect(
    resolveBrowserCompilerWorkerUrl(
      "/motoko",
      "http://4caro-hl777-77775-aaaba-cai.localhost:8000/workspace",
    ),
  ).toBe(
    "http://4caro-hl777-77775-aaaba-cai.localhost:8000/motoko/compiler-worker.js",
  );
});

test("uses and disposes a dedicated browser compiler worker", async () => {
  resetMotokoCompilerForTests();
  const urls: string[] = [];
  const workers: FakeCompilerWorker[] = [];
  const workerFactory = (url: string): BrowserCompilerWorker => {
    urls.push(url);
    const worker = new FakeCompilerWorker();
    workers.push(worker);
    return worker;
  };

  try {
    const first = await loadMotoko({
      browserCompilerBaseUrl: "/test-motoko",
      browserCompilerWorkerFactory: workerFactory,
    });
    await first.configureClassicalCompactingGc();
    await first.write("main.mo", "actor {}");
    const compiled = await first.wasm("main.mo");

    expect(first.version).toBe("fake-moc");
    expect(compiled.wasm).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(workers[0]?.methods).toEqual([
      "__version",
      "gcFlags",
      "gcFlags",
      "saveFile",
      "compileWasm",
    ]);
    expect(workers[0]?.requests.slice(1, 3).map(({ args }) => args)).toEqual([
      ["classicOP"],
      ["marking"],
    ]);

    await disposeMotokoCompiler();
    expect(workers[0]?.terminated).toBe(true);

    const second = await loadMotoko({
      browserCompilerBaseUrl: "/test-motoko",
      browserCompilerWorkerFactory: workerFactory,
    });
    expect(workers).toHaveLength(2);
    expect(urls).toEqual([
      "/test-motoko/compiler-worker.js",
      "/test-motoko/compiler-worker.js",
    ]);
    await second.configurePersistence("enhanced");
    expect(workers[1]?.requests.slice(1, 3).map(({ args }) => args)).toEqual([
      ["enhancedOP"],
      ["incremental"],
    ]);
    workers[1]?.blockedMethods.add("saveFile");
    const pendingWrite = second.write("cancelled.mo", "actor {}");
    await disposeMotokoCompiler();
    await expect(pendingWrite).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    resetMotokoCompilerForTests();
  }
  expect(workers[1]?.terminated).toBe(true);
});

test("loads the vendored Wasm compiler and compiles a small actor", async () => {
  const mo = await loadMotoko();
  await mo.configureClassicalCompactingGc();
  await mo.write("dependency.mo", "module { public let value : Nat32 = 4294967295 }");
  await mo.write(
    "main.mo",
    `import Dependency "dependency";
     shared({ caller = _installer }) persistent actor class Class<system>() = this {
       public query func ping() : async Nat32 { Dependency.value };
     }`,
  );

  const result = await mo.wasm("main.mo", "ic");
  expect(result.wasm.length).toBeGreaterThan(1000);
  expect(result.wasm).toBeInstanceOf(Uint8Array);
  expect(result.wasm.byteOffset).toBe(0);
  expect(result.wasm.byteLength).toBe(result.wasm.buffer.byteLength);
  expect(result.candid).toContain("ping");
  expect(result.diagnostics.filter(({ code }) => code === "M0005")).toEqual([]);
  const module = new WebAssembly.Module(result.wasm.slice().buffer);
  expect(
    WebAssembly.Module.customSections(
      module,
      "icp:private enhanced-orthogonal-persistence",
    ),
  ).toHaveLength(0);
});

test("interprets Motoko without invoking a host compiler", async () => {
  const mo = await loadMotoko();
  await mo.write("interpreter-ok.mo", "40 + 2");
  await mo.write("interpreter-bad.mo", "40 +");

  const result = await mo.run("interpreter-ok.mo");
  expect(result).toEqual({ stdout: "42 : Nat\n", stderr: "" });
  await expect(mo.run("interpreter-bad.mo")).rejects.toThrow("syntax error");
});

test("resolves project-relative files and registered Motoko packages", async () => {
  const mo = await loadMotoko();
  await mo.clearPackages();
  await mo.setProjectRoot("/project");
  await mo.addPackage("answer", "/packages/answer");
  await mo.write(
    "/packages/answer/lib.mo",
    "module { public let value : Nat = 42 }",
  );
  await mo.write(
    "/project/main.mo",
    'import Answer "mo:answer"; Answer.value',
  );

  const result = await mo.run("/project/main.mo");
  expect(result.stdout).toBe("42 : Nat\n");
});

type FakeCompilerRequest = {
  id: number;
  method: string;
  args: unknown[];
};

class FakeCompilerWorker implements BrowserCompilerWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  blockedMethods = new Set<string>();
  methods: string[] = [];
  requests: FakeCompilerRequest[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    const request = message as FakeCompilerRequest;
    this.methods.push(request.method);
    this.requests.push(request);
    if (this.blockedMethods.has(request.method)) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({
        data: {
          id: request.id,
          ok: true,
          result: fakeCompilerResult(request.method),
        },
      } as MessageEvent<unknown>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fakeCompilerResult(method: string): unknown {
  if (method === "__version") return "fake-moc";
  if (method === "compileWasm") {
    return {
      diagnostics: [],
      code: {
        wasm: new Uint8Array([0, 97, 115, 109]),
        candid: "service : {}",
        stable: "",
      },
    };
  }
  return undefined;
}
