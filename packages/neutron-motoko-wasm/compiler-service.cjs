const readline = require("node:readline");

const COMPILER_INITIALIZATION_TIMEOUT_MS = 120_000;

require("./compiler/moc.wasm.cjs");

function encode(value) {
  if (value instanceof Uint8Array) {
    return { __uint8array: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)])
    );
  }
  return value;
}

async function waitForCompiler() {
  const ready = globalThis.NeutronMotokoReady;
  if (!ready || typeof ready.then !== "function") {
    throw new Error(
      "Motoko Wasm compiler artifact does not expose NeutronMotokoReady"
    );
  }
  await waitForCompilerInitialization(ready);
  if (globalThis.Motoko?.compileWasm) {
    return globalThis.Motoko;
  }
  throw new Error(
    "Motoko Wasm compiler initialized without exporting its API"
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
                } seconds`
              )
            ),
          COMPILER_INITIALIZATION_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    throw new Error(
      `Motoko Wasm compiler initialization failed: ${describeError(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  let compilerPromise;
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    try {
      compilerPromise ??= waitForCompiler();
      const compiler = await compilerPromise;
      if (request.method === "__version") {
        process.stdout.write(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: String(compiler.version || "(unknown)"),
          }) + "\n"
        );
        continue;
      }
      const fn = compiler[request.method];
      if (typeof fn !== "function") {
        throw new Error(`Unknown compiler method ${request.method}`);
      }
      const result = fn.apply(compiler, request.args);
      process.stdout.write(
        JSON.stringify({ id: request.id, ok: true, result: encode(result) }) +
          "\n"
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          ok: false,
          error: `${request.method}: ${describeError(error)}`,
        }) + "\n"
      );
    }
  }
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message;
  if (error && typeof error === "object") {
    return JSON.stringify({
      constructor: error.constructor?.name,
      string: String(error),
      keys: Object.keys(error),
      properties: Object.getOwnPropertyNames(error),
      stack: error.stack,
    });
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
