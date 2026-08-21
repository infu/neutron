import { simplifyAST } from "./ast.ts";
import type { CompilerAST, Node } from "./ast.ts";

export const DEFAULT_BROWSER_COMPILER_BASE_URL = "/motoko/";
const COMPILER_INITIALIZATION_TIMEOUT_MS = 120_000;

export type WasmMode = "ic" | "wasi";

export type Diagnostic = {
  source: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  code: string;
  category: string;
  message: string;
};

export type CompileWasmResult = {
  wasm: Uint8Array;
  candid: string;
  stable: string;
  diagnostics: Diagnostic[];
};

export type InterpretMotokoResult = {
  stdout: string;
  stderr: string;
};

export type StableCompatibilityResult = {
  compatible: boolean;
  diagnostics: Diagnostic[];
};

export type MotokoInspection = {
  immediateImports: string[];
  hasActorUrl: boolean;
  dotMembers: string[];
};

type CompilerResult<T> = {
  diagnostics?: Diagnostic[];
  code?: T;
};

type RawCompilerMethod =
  | "__version"
  | "saveFile"
  | "removeFile"
  | "renameFile"
  | "readFile"
  | "readDir"
  | "setProjectRoot"
  | "gcFlags"
  | "addPackage"
  | "clearPackage"
  | "compileWasm"
  | "run"
  | "stableCompatible"
  | "inspectMotoko"
  | "parseMotoko";

export type Motoko = {
  version: string;
  read(path: string): Promise<string>;
  write(path: string, content?: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  list(directory: string): Promise<string[]>;
  setProjectRoot(path: string): Promise<void>;
  configurePersistence(mode: MotokoPersistenceMode): Promise<void>;
  configureClassicalCompactingGc(): Promise<void>;
  addPackage(name: string, directory: string): Promise<void>;
  clearPackages(): Promise<void>;
  parseMotoko(content: string, enableRecovery?: boolean): Promise<Node>;
  inspectMotoko(path: string, content: string): Promise<MotokoInspection>;
  run(path: string, args?: readonly string[]): Promise<InterpretMotokoResult>;
  wasm(path: string, mode?: WasmMode): Promise<CompileWasmResult>;
  stableCompatible(
    previousSignature: string,
    nextSignature: string,
  ): Promise<StableCompatibilityResult>;
};

export type MotokoPersistenceMode = "classical" | "enhanced";

export type BrowserCompilerWorker = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};

export type LoadMotokoOptions = {
  browserCompilerBaseUrl?: string;
  browserCompilerWorkerFactory?: (url: string) => BrowserCompilerWorker;
};

declare global {
  var Motoko:
    | {
        version?: string;
        [key: string]: unknown;
      }
    | undefined;
  var NeutronMotokoReady: Promise<unknown> | undefined;
  var Bun: unknown;
}

let motokoPromise: Promise<Motoko> | undefined;
let disposeMotokoService: (() => void) | undefined;

export async function loadMotoko(
  options: LoadMotokoOptions = {},
): Promise<Motoko> {
  motokoPromise ??=
    options.browserCompilerWorkerFactory || isBrowserRuntime()
      ? createBrowserWorkerMotoko(options)
      : isBunRuntime()
        ? createServiceMotoko()
        : createInProcessMotoko();
  return motokoPromise;
}

export function resetMotokoCompilerForTests(): void {
  disposeMotokoService?.();
  disposeMotokoService = undefined;
  motokoPromise = undefined;
}

export async function disposeMotokoCompiler(): Promise<void> {
  disposeMotokoService?.();
  disposeMotokoService = undefined;
  motokoPromise = undefined;
}

export function resolveBrowserCompilerScriptUrl(
  baseUrl: string,
  locationHref = currentLocationHref(),
): string {
  return resolveBrowserCompilerAssetUrl(
    "moc.wasm.js",
    baseUrl,
    locationHref,
  );
}

export function resolveBrowserCompilerWorkerUrl(
  baseUrl: string,
  locationHref = currentLocationHref(),
): string {
  return resolveBrowserCompilerAssetUrl(
    "compiler-worker.js",
    baseUrl,
    locationHref,
  );
}

function resolveBrowserCompilerAssetUrl(
  asset: string,
  baseUrl: string,
  locationHref: string | undefined,
): string {
  const base = ensureTrailingSlash(baseUrl);
  if (hasUrlScheme(base)) return new URL(asset, base).toString();
  if (locationHref) {
    return new URL(asset, new URL(base, locationHref)).toString();
  }
  return `${base}${asset}`;
}

async function createBrowserWorkerMotoko({
  browserCompilerBaseUrl = DEFAULT_BROWSER_COMPILER_BASE_URL,
  browserCompilerWorkerFactory = createDefaultBrowserCompilerWorker,
}: LoadMotokoOptions): Promise<Motoko> {
  const workerUrl = resolveBrowserCompilerWorkerUrl(browserCompilerBaseUrl);
  const worker = browserCompilerWorkerFactory(workerUrl);
  let closed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const close = (error: Error): void => {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  worker.onmessage = ({ data }) => {
    if (!isCompilerWorkerResponse(data)) {
      close(new Error("Motoko compiler worker returned an invalid response"));
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) {
      close(new Error("Motoko compiler worker returned an unknown request id"));
      return;
    }
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    close(
      event.error instanceof Error
        ? event.error
        : new Error(
            event.message
              ? `Motoko compiler worker failed: ${event.message}`
              : "Motoko compiler worker failed",
          ),
    );
  };
  worker.onmessageerror = () => {
    close(new Error("Motoko compiler worker response could not be decoded"));
  };

  const dispose = (): void => {
    close(compilerAbortError("Motoko compiler worker was disposed"));
  };
  disposeMotokoService = dispose;

  const call = (
    method: RawCompilerMethod,
    args: unknown[],
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(compilerAbortError("Motoko compiler worker is closed"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("Unable to send a Motoko compiler worker request"),
        );
      }
    });

  try {
    const version = await call("__version", []);
    return wrapAsyncCompiler({ version: String(version), call });
  } catch (error) {
    dispose();
    throw error;
  }
}

async function createInProcessMotoko(): Promise<Motoko> {
  const compiler = await loadNodeCompiler();

  return wrapAsyncCompiler({
    version: String(compiler.version || "(unknown)"),
    call(method, args) {
      const fn = compiler[method];
      if (typeof fn !== "function") {
        throw new Error(`Unknown compiler method ${method}`);
      }
      return Promise.resolve(fn.apply(compiler, args));
    },
  });
}

type CompilerWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

function isCompilerWorkerResponse(
  value: unknown,
): value is CompilerWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(response.id) ||
    (response.id as number) < 1 ||
    typeof response.ok !== "boolean"
  ) {
    return false;
  }
  return response.ok
    ? "result" in response
    : typeof response.error === "string";
}

function createDefaultBrowserCompilerWorker(
  url: string,
): BrowserCompilerWorker {
  if (typeof Worker === "undefined") {
    throw new Error("Browser Worker is not available");
  }
  return new Worker(url, {
    name: "neutron-motoko-compiler",
  }) as BrowserCompilerWorker;
}

function compilerAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function wrapAsyncCompiler(raw: {
  version: string;
  call(method: RawCompilerMethod, args: unknown[]): Promise<unknown>;
}): Motoko {
  const invoke = async <T>(
    method: RawCompilerMethod,
    unwrap: boolean,
    args: unknown[],
  ): Promise<T> => {
    let result: unknown;
    try {
      result = await raw.call(method, args);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(
        `Unable to execute ${method}(${args
          .map((x) => typeof x)
          .join(", ")}):\n${JSON.stringify(error)}`,
      );
    }

    if (!unwrap) return result as T;
    const compilerResult = result as CompilerResult<T>;
    if (compilerResult.code === undefined || compilerResult.code === null) {
      throw new Error(
        compilerResult.diagnostics
          ? compilerResult.diagnostics.map(({ message }) => message).join("; ")
          : "(no diagnostics)",
      );
    }
    return compilerResult.code;
  };

  const invokeCompilerResult = async <T>(
    method: RawCompilerMethod,
    args: unknown[],
  ): Promise<{ code: T; diagnostics: Diagnostic[] }> => {
    const result = await invoke<CompilerResult<T>>(method, false, args);
    if (result.code === undefined || result.code === null) {
      throw new Error(
        result.diagnostics?.map(({ message }) => message).join("; ") ??
          "(no diagnostics)",
      );
    }
    return { code: result.code, diagnostics: result.diagnostics ?? [] };
  };

  return {
    version: raw.version,
    read(path) {
      return invoke("readFile", false, [path]);
    },
    async write(path, content = "") {
      if (typeof content !== "string") {
        throw new Error("Non-string file content");
      }
      await invoke("saveFile", false, [path, content]);
    },
    async rename(path, newPath) {
      await invoke("renameFile", false, [path, newPath]);
    },
    async delete(path) {
      await invoke("removeFile", false, [path]);
    },
    async list(directory) {
      try {
        return await invoke("readDir", false, [directory]);
      } catch (error) {
        if (directory === "") return [];
        if (isMissingFileError(error)) return [];
        throw error;
      }
    },
    async setProjectRoot(path) {
      await invoke("setProjectRoot", false, [path]);
    },
    async configurePersistence(mode) {
      if (mode === "classical") {
        await invoke("gcFlags", false, ["classicOP"]);
        await invoke("gcFlags", false, ["marking"]);
        return;
      }
      if (mode === "enhanced") {
        await invoke("gcFlags", false, ["enhancedOP"]);
        await invoke("gcFlags", false, ["incremental"]);
        return;
      }
      throw new Error(`Unsupported Motoko persistence mode ${String(mode)}`);
    },
    async configureClassicalCompactingGc() {
      await this.configurePersistence("classical");
    },
    async addPackage(name, directory) {
      await invoke("addPackage", false, [name, directory]);
    },
    async clearPackages() {
      await invoke("clearPackage", false, []);
    },
    async parseMotoko(content, enableRecovery = false) {
      const ast = await invoke<CompilerAST>("parseMotoko", true, [
        enableRecovery,
        content,
      ]);
      return simplifyAST(ast) as Node;
    },
    inspectMotoko(path, content) {
      return invoke<MotokoInspection>("inspectMotoko", true, [path, content]);
    },
    async run(path, args = []) {
      const output = await invoke<{
        result?: { error?: unknown };
        stdout?: unknown;
        stderr?: unknown;
      }>("run", false, [Array.from(args), path]);
      const stdout =
        typeof output.stdout === "string" ? output.stdout : "";
      const stderr =
        typeof output.stderr === "string" ? output.stderr : "";
      if (output.result?.error !== null) {
        throw new Error(stderr || stdout || `Unable to interpret ${path}`);
      }
      return { stdout, stderr };
    },
    async wasm(path, mode = "ic") {
      if (mode !== "ic" && mode !== "wasi") {
        throw new Error(`Invalid WASM format: ${mode}`);
      }
      const { code, diagnostics } = await invokeCompilerResult<
        Omit<CompileWasmResult, "diagnostics">
      >("compileWasm", [mode, path]);
      return { ...code, diagnostics };
    },
    async stableCompatible(previousSignature, nextSignature) {
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const previousPath = `stable_${nonce}_previous.most`;
      const nextPath = `stable_${nonce}_next.most`;
      try {
        await invoke("saveFile", false, [previousPath, previousSignature]);
        await invoke("saveFile", false, [nextPath, nextSignature]);
        const result = await invoke<CompilerResult<unknown>>(
          "stableCompatible",
          false,
          [previousPath, nextPath],
        );
        const diagnostics = result.diagnostics ?? [];
        return {
          compatible: !diagnostics.some(isErrorDiagnostic),
          diagnostics,
        };
      } finally {
        await Promise.allSettled([
          invoke("removeFile", false, [previousPath]),
          invoke("removeFile", false, [nextPath]),
        ]);
      }
    },
  };
}

function isErrorDiagnostic(diagnostic: Diagnostic): boolean {
  return (
    diagnostic.severity === 1 || diagnostic.category.toLowerCase() === "error"
  );
}

async function createServiceMotoko(): Promise<Motoko> {
  const { spawn } =
    await dynamicImport<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { createInterface } =
    await dynamicImport<typeof import("node:readline")>("node:readline");
  const node = process.env.NEUTRON_MOTOKO_NODE || "node";
  const servicePath = new URL("../compiler-service.cjs", import.meta.url)
    .pathname;
  // Large generated modules can recurse deeply inside wasm_of_ocaml. Pass the
  // stack limit directly because Node intentionally rejects it in NODE_OPTIONS.
  const child = spawn(node, ["--stack-size=16384", servicePath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.ok) entry.resolve(decode(response.result));
    else entry.reject(new Error(response.error));
  });

  child.on("exit", (code, signal) => {
    const error = new Error(
      `Motoko compiler service exited with ${signal ?? code}`,
    );
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });

  disposeMotokoService = () => {
    if (closed) return;
    closed = true;
    const error = new Error("Motoko compiler service was disposed");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    lines.close();
    child.stdin.end();
    child.kill();
  };

  const call = (method: RawCompilerMethod, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(new Error("Motoko compiler service is closed"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    });

  const version = await call("__version", []);
  return wrapAsyncCompiler({
    version: String(version),
    call,
  });
}

async function loadNodeCompiler(): Promise<
  NonNullable<typeof globalThis.Motoko>
> {
  const { createRequire } =
    await dynamicImport<typeof import("node:module")>("node:module");
  const requireFn = createRequire(import.meta.url);
  const loaderPath = new URL("../compiler/moc.wasm.cjs", import.meta.url)
    .pathname;
  globalThis.Motoko = undefined;
  requireFn(loaderPath);
  return waitForCompiler();
}

async function waitForCompiler(): Promise<
  NonNullable<typeof globalThis.Motoko>
> {
  const ready = globalThis.NeutronMotokoReady;
  if (!ready || typeof ready.then !== "function") {
    throw new Error(
      "Motoko Wasm compiler artifact does not expose NeutronMotokoReady",
    );
  }
  await waitForCompilerInitialization(ready);
  const compiler = globalThis.Motoko;
  if (compiler && typeof compiler.compileWasm === "function") {
    return compiler;
  }
  throw new Error(
    "Motoko Wasm compiler initialized without exporting its API",
  );
}

async function waitForCompilerInitialization(
  ready: Promise<unknown>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Motoko Wasm compiler initialization timed out after ${
                  COMPILER_INITIALIZATION_TIMEOUT_MS / 1_000
                } seconds`,
              ),
            ),
          COMPILER_INITIALIZATION_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    throw new Error(
      `Motoko Wasm compiler initialization failed: ${describeError(error)}`,
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function dynamicImport<T>(specifier: string): Promise<T> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<T>;
  return importer(specifier);
}

function decode(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__uint8array" in value &&
    typeof value.__uint8array === "string"
  ) {
    const binary = atob(value.__uint8array);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decode(item)]),
    );
  }
  return value;
}

function isBrowserRuntime(): boolean {
  return "document" in globalThis && "window" in globalThis;
}

function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}

function currentLocationHref(): string | undefined {
  const locationRef = (globalThis as { location?: { href?: unknown } })
    .location;
  return typeof locationRef?.href === "string" ? locationRef.href : undefined;
}

function isMissingFileError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : JSON.stringify(error);
  return typeof message === "string" && message.includes("ENOENT");
}

export default loadMotoko;
