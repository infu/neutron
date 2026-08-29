import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import esbuild from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "neutron-tools/app";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { assertBlastWorkerBundleIsolation } from "../bundle_audit.ts";
import { BLAST_LIMITS, BLAST_STORED_V1_JSON_LIMITS } from "../src/limits.ts";
import {
  BLAST_QUICKJS_WASM_INITIAL_PAGES,
  BLAST_QUICKJS_WASM_MAXIMUM_PAGES,
  newBlastQuickJSVariant,
} from "../src/quickjs_variant.ts";
import type { RunScriptRequest } from "../src/script_runner.ts";

type BundledRunScript = (request: RunScriptRequest) => Promise<JsonValue>;

let temporaryDirectory = "";
let runBundledScript!: BundledRunScript;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "neutron-blast-script-worker-"),
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
      script_runner: join(appRoot, "src/script_runner.ts"),
      script_worker: join(appRoot, "src/script_worker.ts"),
    },
    outdir: temporaryDirectory,
    entryNames: "[name]",
    bundle: true,
    conditions: ["browser", "import", "default"],
    format: "esm",
    metafile: true,
    platform: "browser",
    loader: { ".ts": "ts", ".wasm": "binary" },
    banner: { js: nodeDetectionPrelude },
    footer: { js: nodeDetectionRestore },
  });
  assertBlastWorkerBundleIsolation(build.metafile, ["script_worker.js"]);
  const bundled = (await import(
    `${pathToFileURL(join(temporaryDirectory, "script_runner.js")).href}?test=${Date.now()}`
  )) as Readonly<{ runScript: BundledRunScript }>;
  runBundledScript = bundled.runScript;
});

afterAll(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("bundled QuickJS Worker", () => {
  test("hard-bounds the shipped QuickJS module's linear memory", async () => {
    const module = await newQuickJSWASMModuleFromVariant(
      newBlastQuickJSVariant(),
    );
    const memory = module.getWasmMemory();
    expect(memory.buffer.byteLength).toBe(
      BLAST_QUICKJS_WASM_INITIAL_PAGES * 64 * 1024,
    );

    expect(
      memory.grow(
        BLAST_QUICKJS_WASM_MAXIMUM_PAGES -
          BLAST_QUICKJS_WASM_INITIAL_PAGES,
      ),
    ).toBe(BLAST_QUICKJS_WASM_INITIAL_PAGES);
    expect(memory.buffer.byteLength).toBe(
      BLAST_QUICKJS_WASM_MAXIMUM_PAGES * 64 * 1024,
    );
    expect(() => memory.grow(1)).toThrow();
  });

  test("executes supplied source after locking dynamic evaluation", async () => {
    const result = await runBundledScript({
      source: String.raw`
        return {
          answer: input.left + input.right,
          evalDisabled: typeof eval === "undefined",
          functionDisabled: typeof Function === "undefined",
          arrowConstructorDisabled: (() => {}).constructor === undefined,
          asyncConstructorDisabled: (async () => {}).constructor === undefined,
          generatorConstructorDisabled: (function* () {}).constructor === undefined,
        };
      `,
      input: { left: 19, right: 23 },
      timeoutMs: 3_000,
      host: async () => null,
    });

    expect(result).toEqual({
      answer: 42,
      evalDisabled: true,
      functionDisabled: true,
      arrowConstructorDisabled: true,
      asyncConstructorDisabled: true,
      generatorConstructorDisabled: true,
    });
  });

  test("reports a rejected guest promise without an unhandled child rejection", async () => {
    await expect(
      runBundledScript({
        source: "return await Promise.reject(new Error('expected rejection'));",
        input: null,
        timeoutMs: 3_000,
        host: async () => null,
      }),
    ).rejects.toThrow("expected rejection");
  });

  test("keeps a bounded guest error Unicode-scalar-safe at the cutoff", async () => {
    const expected = `Error: ${"x".repeat(989)}😀...`;
    const error = await runBundledScript({
      source: `throw new Error(${JSON.stringify(
        `${"x".repeat(989)}😀${"y".repeat(4)}`,
      )});`,
      input: null,
      timeoutMs: 3_000,
      host: async () => null,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expected);
  });

  test("bounds a multi-megabyte guest Error before copying it to the host", async () => {
    const error = await runBundledScript({
      source: `throw new Error("x".repeat(4_000_000));`,
      input: null,
      timeoutMs: 3_000,
      host: async () => null,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toStartWith("Error: ");
    expect(Array.from((error as Error).message)).toHaveLength(1_000);
    expect((error as Error).message).toEndWith("...");
  });

  test("round trips an awaited call through the bounded host bridge", async () => {
    const calls: unknown[] = [];
    const result = await runBundledScript({
      source: "return await blast.scan({ canister: input.canister });",
      input: { canister: "rrkah-fqaaa-aaaaa-aaaaq-cai" },
      timeoutMs: 3_000,
      host: async (operation, argumentsValue, signal) => {
        calls.push({ operation, arguments: argumentsValue });
        expect(signal.aborted).toBe(false);
        return { methods: [{ name: "read", kind: "query" }] };
      },
    });

    expect(calls).toEqual([
      {
        operation: "blast.scan",
        arguments: { canister: "rrkah-fqaaa-aaaaa-aaaaq-cai" },
      },
    ]);
    expect(result).toEqual({ methods: [{ name: "read", kind: "query" }] });
  });

  test("settles a host rejection whose string conversion throws", async () => {
    const result = await runBundledScript({
      source: String.raw`
        try {
          await blast.identity();
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
      input: null,
      timeoutMs: 3_000,
      host: async () => {
        throw {
          toString: () => {
            throw new Error("hostile string conversion");
          },
        };
      },
    });

    expect(result).toBe("Host operation failed");
  });

  test("rejects a fifth concurrent host call inside the Worker", async () => {
    let hostCalls = 0;
    const result = await runBundledScript({
      source: String.raw`
        const pending = Array.from({ length: 5 }, () => blast.identity());
        return await Promise.all(pending.map(async (request) => {
          try {
            await request;
            return "ok";
          } catch (error) {
            return error.message;
          }
        }));
      `,
      input: null,
      timeoutMs: 3_000,
      host: async () => {
        hostCalls += 1;
        return null;
      },
    });

    expect(hostCalls).toBe(BLAST_LIMITS.scriptConcurrentHostCalls);
    expect(result).toEqual([
      ...Array(BLAST_LIMITS.scriptConcurrentHostCalls).fill("ok"),
      "Script concurrent host-call limit exceeded",
    ]);
  });

  test("rejects host calls beyond the Worker total before dispatch", async () => {
    let hostCalls = 0;
    const result = await runBundledScript({
      source: `
        let completed = 0;
        for (
          let index = 0;
          index <= ${BLAST_LIMITS.scriptHostCalls};
          index += 1
        ) {
          try {
            await blast.identity();
            completed += 1;
          } catch (error) {
            return { completed, error: error.message };
          }
        }
        return { completed, error: null };
      `,
      input: null,
      timeoutMs: 10_000,
      host: async () => {
        hostCalls += 1;
        return null;
      },
    });

    expect(hostCalls).toBe(BLAST_LIMITS.scriptHostCalls);
    expect(result).toEqual({
      completed: BLAST_LIMITS.scriptHostCalls,
      error: "Script host-call limit exceeded",
    });
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
      runBundledScript({
        source: "return null;",
        input: null,
        timeoutMs: 3_000,
        signal: controller.signal,
        host: async () => null,
      }),
    ).rejects.toThrow("Script execution was cancelled");
  });

  test("snapshots only guest-observed responses across settlement and prototype tampering", async () => {
    let releaseUpdate!: () => void;
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let markUpdateSettled!: () => void;
    const updateSettled = new Promise<void>((resolve) => {
      markUpdateSettled = resolve;
    });
    const calls: Array<
      Readonly<{
        operation: string;
        requestId: number;
        observedResponseIds: readonly number[];
      }>
    > = [];
    const result = await runBundledScript({
      source: String.raw`
        const pendingUpdate = blast.update({
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          args: [],
        });
        Array.prototype.toJSON = () => [1];
        await run.checkpoint({ phase: "issued-before-update-response" });
        const update = await pendingUpdate;
        await run.checkpoint({ phase: "after-update-response" });
        return update;
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, _argumentsValue, _signal, causality) => {
        if (causality === undefined) throw new Error("Missing host causality");
        calls.push({ operation, ...causality });
        if (operation === "blast.update") {
          await updateRelease;
          markUpdateSettled();
          return { committed: true };
        }
        if (
          calls.filter((call) => call.operation === "run.checkpoint").length ===
          1
        ) {
          releaseUpdate();
          await updateSettled;
        }
        return { checkpointed: true };
      },
    });

    expect(result).toEqual({ committed: true });
    expect(calls).toEqual([
      { operation: "blast.update", requestId: 1, observedResponseIds: [] },
      { operation: "run.checkpoint", requestId: 2, observedResponseIds: [] },
      {
        operation: "run.checkpoint",
        requestId: 3,
        // The first checkpoint response was consumed before the update.
        observedResponseIds: [2, 1],
      },
    ]);
  });

  test("does not acknowledge a settled update until guest code consumes it", async () => {
    const calls: Array<
      Readonly<{
        operation: string;
        requestId: number;
        observedResponseIds: readonly number[];
      }>
    > = [];
    const result = await runBundledScript({
      source: String.raw`
        const unseen = blast.update({
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          args: [],
        });
        await blast.identity();
        await run.checkpoint({ phase: "before-consuming-update" });
        const update = await unseen;
        await run.checkpoint({ phase: "after-consuming-update" });
        return update;
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, _argumentsValue, _signal, causality) => {
        if (causality === undefined) throw new Error("Missing host causality");
        calls.push({ operation, ...causality });
        if (operation === "blast.identity") {
          // Let the earlier update response settle in QuickJS while it remains
          // unobserved by the guest program.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (operation === "blast.update") return { committed: true };
        return { ok: true };
      },
    });

    expect(result).toEqual({ committed: true });
    expect(calls).toEqual([
      { operation: "blast.update", requestId: 1, observedResponseIds: [] },
      { operation: "blast.identity", requestId: 2, observedResponseIds: [] },
      {
        operation: "run.checkpoint",
        requestId: 3,
        observedResponseIds: [2],
      },
      {
        operation: "run.checkpoint",
        requestId: 4,
        observedResponseIds: [2, 3, 1],
      },
    ]);
  });

  test("preserves Promise chaining while recording each consumed response once", async () => {
    const calls: Array<
      Readonly<{
        operation: string;
        observedResponseIds: readonly number[];
      }>
    > = [];
    const result = await runBundledScript({
      source: String.raw`
        const update = blast.update({
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "commit",
          args: [],
        });
        const chained = update.then().finally(() => undefined);
        // Let the host attach to the script's outer Promise before exercising
        // the bootstrap's captured Promise intrinsics.
        await blast.identity();
        const nativeResolve = Promise.resolve;
        const nativeReject = Promise.reject;
        const nativeThen = Promise.prototype.then;
        Promise.resolve = undefined;
        Promise.reject = undefined;
        Promise.prototype.then = undefined;
        const first = await chained;
        const second = await update;
        Promise.resolve = nativeResolve;
        Promise.reject = nativeReject;
        Promise.prototype.then = nativeThen;
        const recovered = await blast.query({ fail: true }).catch(
          (error) => ({ message: error.message }),
        );
        await run.checkpoint({ phase: "done" });
        return { first, second, recovered };
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, argumentsValue, _signal, causality) => {
        if (causality === undefined) throw new Error("Missing host causality");
        calls.push({
          operation,
          observedResponseIds: causality.observedResponseIds,
        });
        if (operation === "blast.update") return { committed: true };
        if (operation === "blast.query" && argumentsValue.fail === true) {
          throw new Error("expected host failure");
        }
        return { ok: true };
      },
    });

    expect(result).toEqual({
      first: { committed: true },
      second: { committed: true },
      recovered: { message: "expected host failure" },
    });
    expect(calls.at(-1)).toEqual({
      operation: "run.checkpoint",
      observedResponseIds: [2, 1],
    });
  });

  test("returns invalid-call failures asynchronously without dispatch", async () => {
    let hostCalls = 0;
    const result = await runBundledScript({
      source: String.raw`
        const cycle = {};
        cycle.self = cycle;
        let threwSynchronously = false;
        let pending;
        try {
          pending = blast.update({ args: cycle });
        } catch (_error) {
          threwSynchronously = true;
        }
        let rejected = false;
        try {
          await pending;
        } catch (_error) {
          rejected = true;
        }
        return { threwSynchronously, rejected };
      `,
      input: null,
      timeoutMs: 3_000,
      host: async () => {
        hostCalls += 1;
        return null;
      },
    });

    expect(result).toEqual({ threwSynchronously: false, rejected: true });
    expect(hostCalls).toBe(0);
  });

  test("rejects non-JSON host arguments before dispatch", async () => {
    let hostCalls = 0;
    const result = await runBundledScript({
      source: String.raw`
        const cycle = {};
        cycle.self = cycle;
        const invalid = [
          { label: "undefined", value: [undefined] },
          { label: "non-finite", value: [NaN] },
          { label: "function", value: [() => true] },
          { label: "sparse", value: Array(1) },
          { label: "cycle", value: cycle },
          { label: "date", value: new Date(0) },
          { label: "map", value: new Map([["key", "value"]]) },
        ];
        const rejected = [];
        for (const test of invalid) {
          try {
            await blast.update({
              canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
              method: "write",
              args: test.value,
            });
          } catch (_error) {
            rejected.push(test.label);
          }
        }
        Array.prototype.pop = () => undefined;
        Array.prototype.push = () => 0;
        Array.isArray = () => false;
        WeakSet.prototype.add = () => undefined;
        WeakSet.prototype.delete = () => false;
        WeakSet.prototype.has = () => false;
        Number.isFinite = () => true;
        Number.isSafeInteger = () => true;
        Object.getOwnPropertyDescriptors = () => ({});
        Object.getPrototypeOf = () => null;
        Object.setPrototypeOf = (value) => value;
        Object.prototype.value = null;
        Reflect.ownKeys = () => [];
        JSON.parse = () => null;
        JSON.stringify = () => "null";
        String.prototype.charCodeAt = () => 0;
        globalThis.Number = () => 0;
        globalThis.String = () => "0";

        let tamperingRejected = false;
        try {
          await blast.update({
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            method: "write",
            args: [undefined],
          });
        } catch (_error) {
          tamperingRejected = true;
        }
        return { rejected, tamperingRejected };
      `,
      input: null,
      timeoutMs: 3_000,
      host: async () => {
        hostCalls += 1;
        return null;
      },
    });

    expect(result).toEqual({
      rejected: [
        "undefined",
        "non-finite",
        "function",
        "sparse",
        "cycle",
        "date",
        "map",
      ],
      tamperingRejected: true,
    });
    expect(hostCalls).toBe(0);
  });

  test("rejects values that QuickJS dump would coerce before validation", async () => {
    const invalidSources = [
      "return undefined;",
      "return NaN;",
      "return () => true;",
      "return Array(1);",
      "const value = {}; value.self = value; return value;",
      "return new Date(0);",
      "return new Map([['key', 'value']]);",
      String.raw`
        Array.prototype.pop = () => undefined;
        Array.prototype.push = () => 0;
        Array.isArray = () => false;
        WeakSet.prototype.has = () => false;
        Object.getOwnPropertyDescriptors = () => ({});
        Object.getPrototypeOf = () => null;
        Reflect.ownKeys = () => [];
        JSON.stringify = () => "null";
        return [undefined];
      `,
    ];

    for (const source of invalidSources) {
      await expect(
        runBundledScript({
          source,
          input: null,
          timeoutMs: 3_000,
          host: async () => null,
        }),
      ).rejects.toThrow(/JSON|array|cycle|plain/u);
    }
  });

  test("keeps Blast wrappers from rejecting a maximum-depth host value", async () => {
    let value: unknown = null;
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      value = [value];
    }
    const maximumDepth = value as JsonValue;
    const operations: string[] = [];
    const result = await runBundledScript({
      source: String.raw`
        const response = await blast.scan({ canister: "rrkah-fqaaa-aaaaa-aaaaq-cai" });
        await collections.putPage("collection", "depth", response.value);
        let depth = 0;
        let current = response.value;
        while (Array.isArray(current)) {
          depth += 1;
          current = current[0];
        }
        return depth;
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, argumentsValue) => {
        operations.push(operation);
        if (operation === "blast.scan") return { value: maximumDepth };
        expect(argumentsValue).toEqual({
          id: "collection",
          key: "depth",
          value: maximumDepth,
        });
        return true;
      },
    });

    expect(operations).toEqual(["blast.scan", "collections.put_page"]);
    expect(result).toBe(BLAST_LIMITS.jsonDepth);
  });

  test("round trips and forwards a complete canister-sized value", async () => {
    const payload = "x".repeat(BLAST_LIMITS.canisterResultBytes);
    const operations: string[] = [];
    const result = await runBundledScript({
      source: String.raw`
        const response = await blast.query({
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          method: "read",
        });
        const stored = await collections.putPage(
          "collection",
          "page",
          response.payload,
        );
        return { payloadCharacters: response.payload.length, stored };
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, argumentsValue) => {
        operations.push(operation);
        if (operation === "blast.query") return { payload };
        expect(argumentsValue).toEqual({
          id: "collection",
          key: "page",
          value: payload,
        });
        return true;
      },
    });

    expect(result).toEqual({ payloadCharacters: payload.length, stored: true });
    expect(operations).toEqual(["blast.query", "collections.put_page"]);
  });

  test("bounds a finite pages limit and stops without consuming its hidden continuation", async () => {
    const calls: JsonValue[] = [];
    const result = await runBundledScript({
      source: String.raw`
        for await (const _value of collections.pages("unused", { limit: 0 })) {
          throw new Error("zero-limit iterator produced a value");
        }
        const values = [];
        for await (const value of collections.pages("collection", { limit: 51 })) {
          values.push(value);
        }
        return values;
      `,
      input: null,
      timeoutMs: 3_000,
      host: async (operation, argumentsValue) => {
        expect(operation).toBe("collections.pages");
        calls.push(argumentsValue);
        if (argumentsValue.cursor === null) {
          return {
            values: Array.from({ length: 50 }, (_value, index) => index),
            nextCursor: "next",
          };
        }
        return { values: [50], nextCursor: "still-more" };
      },
    });

    expect(result).toEqual(
      Array.from({ length: 51 }, (_value, index) => index),
    );
    expect(calls).toEqual([
      { id: "collection", cursor: null, limit: 50 },
      { id: "collection", cursor: "next", limit: 1 },
    ]);
  });

  test("returns an explicit cursor from one resumable collection batch", async () => {
    const result = await runBundledScript({
      source: String.raw`
        return await collections.readPages("collection", {
          cursor: input.cursor,
          limit: 2,
        });
      `,
      input: { cursor: "50" },
      timeoutMs: 3_000,
      host: async (operation, argumentsValue) => {
        expect(operation).toBe("collections.pages");
        expect(argumentsValue).toEqual({
          id: "collection",
          cursor: "50",
          limit: 2,
        });
        return { values: [[51], [52]], nextCursor: "52" };
      },
    });

    expect(result).toEqual({ values: [[51], [52]], nextCursor: "52" });
  });

  test("streams a retained schema-v1 page at the legacy JSON-node limit", async () => {
    const retainedPage = Array.from(
      { length: BLAST_STORED_V1_JSON_LIMITS.nodes - 1 },
      () => null,
    );
    const result = await runBundledScript({
      source: String.raw`
          let count = 0;
          for await (const page of collections.pages("legacy")) {
            count += page.length;
          }
          return count;
        `,
      input: null,
      timeoutMs: 5_000,
      host: async (operation) => {
        expect(operation).toBe("collections.pages");
        return { values: [retainedPage], nextCursor: null };
      },
    });

    expect(result).toBe(BLAST_STORED_V1_JSON_LIMITS.nodes - 1);
  }, 10_000);

  test("interrupts CPU-bound source at its QuickJS deadline", async () => {
    await expect(
      runBundledScript({
        source: "while (true) {}",
        input: null,
        timeoutMs: 1_000,
        host: async () => null,
      }),
    ).rejects.toThrow("Script deadline exceeded");
  }, 10_000);

  test("normalizes an interrupt reached through pending Promise jobs", async () => {
    await expect(
      runBundledScript({
        source: "await Promise.resolve(); while (true) {}",
        input: null,
        timeoutMs: 1_000,
        host: async () => null,
      }),
    ).rejects.toThrow("Script deadline exceeded");
  }, 10_000);

  test("reports an allocation bomb and keeps the next Worker usable", async () => {
    await expect(
      runBundledScript({
        source: String.raw`
            const value = "x".repeat(40_000_000);
            return value.length;
          `,
        input: null,
        timeoutMs: 3_000,
        host: async () => null,
      }),
    ).rejects.toThrow(/memory limit|out of memory|allocation/u);
    await expect(
      runBundledScript({
        source: "return 42;",
        input: null,
        timeoutMs: 3_000,
        host: async () => null,
      }),
    ).resolves.toBe(42);
  }, 10_000);

  test("retains usable headroom below the guest heap limit", async () => {
    await expect(
      runBundledScript({
        source: String.raw`
            const value = "x".repeat(20_000_000);
            return value.length;
          `,
        input: null,
        timeoutMs: 3_000,
        host: async () => null,
      }),
    ).resolves.toBe(20_000_000);
  }, 10_000);

  test("reclaims a Worker when guest code catches allocator exhaustion", async () => {
    const recovered = await runBundledScript({
      source: String.raw`
          try {
            "x".repeat(40_000_000);
          } catch (_error) {
            return 42;
          }
          return 0;
        `,
      input: null,
      timeoutMs: 3_000,
      host: async () => null,
    });
    expect(recovered).toBe(42);

    await expect(
      runBundledScript({
        source: "return 43;",
        input: null,
        timeoutMs: 3_000,
        host: async () => null,
      }),
    ).resolves.toBe(43);
  }, 10_000);

  test("terminates the Worker and aborts an in-flight host call", async () => {
    let markHostStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => {
      markHostStarted = resolve;
    });
    let markHostSettled!: () => void;
    const hostSettled = new Promise<void>((resolve) => {
      markHostSettled = resolve;
    });
    let hostWasAborted = false;
    let hostSettlementObserved = false;
    const controller = new AbortController();
    const pending = runBundledScript({
      source: "return await blast.scan({ canister: 'test' });",
      input: null,
      timeoutMs: 3_000,
      signal: controller.signal,
      host: async (_operation, _argumentsValue, signal) => {
        markHostStarted();
        return await new Promise<JsonValue>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              hostWasAborted = true;
              setTimeout(() => {
                hostSettlementObserved = true;
                markHostSettled();
                reject(signal.reason);
              }, 0);
            },
            { once: true },
          );
        });
      },
    });

    await hostStarted;
    controller.abort(new Error("cancelled by bundled Worker test"));
    await expect(pending).rejects.toThrow("cancelled by bundled Worker test");
    expect(hostWasAborted).toBe(true);
    await hostSettled;
    expect(hostSettlementObserved).toBe(true);
  });

  test("settles the script deadline without waiting for a non-cooperative host", async () => {
    let markHostStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => {
      markHostStarted = resolve;
    });
    let hostSignal: AbortSignal | undefined;
    const pending = runBundledScript({
      source: "return await blast.identity();",
      input: null,
      timeoutMs: 1_000,
      host: async (_operation, _argumentsValue, signal) => {
        hostSignal = signal;
        markHostStarted();
        return await new Promise<JsonValue>(() => undefined);
      },
    });

    await hostStarted;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const failedToSettle = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(
        () => reject(new Error("Script deadline did not settle promptly")),
        4_000,
      );
    });
    try {
      await expect(Promise.race([pending, failedToSettle])).rejects.toThrow(
        "Script completed with unfinished host operations",
      );
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
    expect(hostSignal?.aborted).toBe(true);
  }, 10_000);
});
