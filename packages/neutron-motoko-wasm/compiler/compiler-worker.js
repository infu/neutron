"use strict";

const COMPILER_METHODS = new Set([
  "__version",
  "saveFile",
  "removeFile",
  "renameFile",
  "readFile",
  "readDir",
  "setProjectRoot",
  "addPackage",
  "clearPackage",
  "compileWasm",
  "run",
  "stableCompatible",
  "inspectMotoko",
  "parseMotoko",
]);
const COMPILER_INITIALIZATION_TIMEOUT_MS = 120_000;
importScripts("./moc.wasm.js");

const compilerPromise = waitForCompiler();
let dispatchQueue = Promise.resolve();

self.addEventListener("message", (event) => {
  const request = event.data;
  dispatchQueue = dispatchQueue.then(
    () => dispatch(request),
    () => dispatch(request),
  );
});

async function dispatch(request) {
  if (
    !request ||
    typeof request !== "object" ||
    !Number.isSafeInteger(request.id) ||
    request.id < 1
  ) {
    throw new Error("Invalid Motoko compiler worker request");
  }
  if (!COMPILER_METHODS.has(request.method) || !Array.isArray(request.args)) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: "Invalid Motoko compiler worker request",
    });
    return;
  }

  try {
    const compiler = await compilerPromise;
    const result =
      request.method === "__version"
        ? String(compiler.version || "(unknown)")
        : await invokeCompiler(compiler, request.method, request.args);
    postResult({ id: request.id, ok: true, result });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: `${request.method}: ${describeError(error)}`,
    });
  }
}

async function invokeCompiler(compiler, method, args) {
  const fn = compiler[method];
  if (typeof fn !== "function") {
    throw new Error(`Unknown compiler method ${method}`);
  }
  return fn.apply(compiler, args);
}

function postResult(response) {
  const transfer = [];
  collectTransferableBuffers(response.result, transfer, new Set());
  try {
    self.postMessage(response, transfer);
  } catch {
    // A future compiler result may contain a non-transferable buffer view.
    // Structured cloning is still correct and must remain the safe fallback.
    self.postMessage(response);
  }
}

function collectTransferableBuffers(value, target, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    target.push(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !seen.has(value.buffer)) {
      seen.add(value.buffer);
      target.push(value.buffer);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTransferableBuffers(item, target, seen);
    }
    return;
  }
  for (const item of Object.values(value)) {
    collectTransferableBuffers(item, target, seen);
  }
}

async function waitForCompiler() {
  const ready = globalThis.NeutronMotokoReady;
  if (!ready || typeof ready.then !== "function") {
    throw new Error(
      "Motoko Wasm compiler artifact does not expose NeutronMotokoReady",
    );
  }
  await waitForCompilerInitialization(ready);
  if (globalThis.Motoko?.compileWasm) {
    return globalThis.Motoko;
  }
  throw new Error(
    "Motoko Wasm compiler initialized without exporting its API",
  );
}

async function waitForCompilerInitialization(ready) {
  let timeout;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
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
    clearTimeout(timeout);
  }
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
