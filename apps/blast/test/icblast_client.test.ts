import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import {
  explainMethodSchema,
  toState,
  validateMethodInputSchema,
} from "icblast";
import {
  IC_RUNTIME_GATEWAY,
  IC_RUNTIME_IDENTITY_PROVIDER,
  createKernelRuntimeConfig,
  isolatedFrameOriginTemplate,
} from "neutron-tools/src/runtime_config.js";
import type {
  JsonValue,
  ScopedKernelClient,
} from "neutron-tools/app";
import {
  BlastDispatchedCallError,
  BlastInputValidationError,
  createBlastIcblastClient,
  type BlastIcblastAdapters,
} from "../src/icblast_client.ts";
import type { BlastLocalIdentity } from "../src/identity.ts";
import { BLAST_LIMITS } from "../src/limits.ts";
import type { BlastTrustedRuntime } from "../src/runtime_config.ts";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const METHOD_SCHEMA = Object.freeze({
  input: Object.freeze({
    type: "array",
    minItems: 1,
    maxItems: 1,
    prefixItems: [{ type: "string" }],
  }),
  output: Object.freeze({ type: "string" }),
});

describe("Blast ICBlast client", () => {
  test("scans exact actor annotations and binds the configured trusted host", async () => {
    const fixture = createFixture({
      z_update: { annotations: [], result: "updated" },
      a_query: { annotations: ["query"], result: "read" },
      composite: { annotations: ["composite_query"], result: "composite" },
      notify: { annotations: ["oneway"], result: null },
    });
    const result = await fixture.client.scan(CANISTER);

    expect(result).toEqual({
      canister: CANISTER,
      methods: [
        { name: "a_query", kind: "query" },
        { name: "composite", kind: "query" },
        { name: "notify", kind: "oneway" },
        { name: "z_update", kind: "update" },
      ],
    });
    expect(fixture.factoryOptions).toHaveLength(1);
    expect(fixture.factoryOptions[0]).toMatchObject({
      host: IC_RUNTIME_GATEWAY,
      local: false,
      didcWasm: expect.any(String),
      allowNumberedPrincipals: false,
      agentOptions: {
        host: IC_RUNTIME_GATEWAY,
        verifyQuerySignatures: true,
        fetchOptions: {
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
        callOptions: {
          redirect: "error",
          signal: expect.any(AbortSignal),
        },
      },
    });
    const requestOptions = capturedRequestOptions(fixture.factoryOptions[0]);
    expect(requestOptions.fetch.signal).toBe(requestOptions.call.signal);
  });

  test("keeps using its validated runtime snapshot after caller mutation", async () => {
    const valid = productionRuntime();
    const supplied = {
      config: { ...valid.config },
      canisterId: valid.canisterId,
      pageOrigin: valid.pageOrigin,
      agentHost: valid.agentHost,
      local: valid.local,
    };
    const fixture = createFixture(
      { read: { annotations: ["query"], result: "read" } },
      { runtime: supplied },
    );

    supplied.config.gateway = "https://attacker.invalid";
    supplied.agentHost = "https://attacker.invalid";
    supplied.local = true;
    await fixture.client.scan(CANISTER);

    expect(fixture.factoryOptions).toHaveLength(1);
    expect(fixture.factoryOptions[0]).toMatchObject({
      host: IC_RUNTIME_GATEWAY,
      local: false,
      agentOptions: {
        host: IC_RUNTIME_GATEWAY,
        verifyQuerySignatures: true,
      },
    });
  });

  test("counts method-name limits in Unicode scalar values", async () => {
    const method = "😀".repeat(192);
    const fixture = createFixture({
      [method]: { annotations: ["query"], result: "read" },
    });

    await expect(fixture.client.schema(CANISTER, method)).resolves.toMatchObject({
      method,
      kind: "query",
    });
    await expect(
      fixture.client.schema(CANISTER, `${method}😀`),
    ).rejects.toThrow("method is invalid");
  });

  test("validates and invokes a query on the same discovered actor", async () => {
    const fixture = createFixture({
      read: { annotations: ["query"], result: { nested: [1, "two"] } },
    });
    const schema = await fixture.client.schema(CANISTER, "read");
    const validation = await fixture.client.validateInput(CANISTER, "read", [
      "ok",
    ]);
    const call = await fixture.client.query({
      canister: CANISTER,
      method: "read",
      args: ["ok"],
    });

    expect(schema.kind).toBe("query");
    expect(schema.schema).toEqual(METHOD_SCHEMA);
    expect(validation).toMatchObject({ valid: true, errors: null });
    expect(call).toEqual({
      canister: CANISTER,
      method: "read",
      kind: "query",
      identityMode: "local",
      result: { nested: [1, "two"] },
      resultBytes: 20,
    });
    expect(fixture.calls).toEqual([{ method: "read", args: ["ok"] }]);
  });

  test("rejects inconsistent ICBlast validation diagnostics", async () => {
    for (const validation of [
      { ok: true, errors: [{ message: "unexpected" }] },
      { ok: false, errors: null },
    ]) {
      const fixture = createFixture(
        { read: { annotations: ["query"], result: null } },
        { validateInput: () => validation },
      );
      await expect(
        fixture.client.validateInput(CANISTER, "read", ["ok"]),
      ).rejects.toThrow("inconsistent validation diagnostics");
      expect(fixture.calls).toEqual([]);
    }
  });

  test("routes a live Candid oneway through the effectful update boundary", async () => {
    const fixture = createFixture({
      notify: { annotations: ["oneway"], result: undefined },
    });

    await expect(fixture.client.update({
      canister: CANISTER,
      method: "notify",
      args: ["ok"],
    })).resolves.toEqual({
      canister: CANISTER,
      method: "notify",
      kind: "oneway",
      identityMode: "local",
      result: null,
      resultBytes: 4,
    });
    await expect(fixture.client.query({
      canister: CANISTER,
      method: "notify",
      args: ["ok"],
    })).rejects.toThrow("live oneway");
    expect(fixture.calls).toEqual([{ method: "notify", args: ["ok"] }]);
  });

  test("never treats an uncertain oneway dispatch as retry-safe", async () => {
    const fixture = createFixture({
      notify: {
        annotations: ["oneway"],
        result: undefined,
        invoke() {
          throw new Error("oneway transport outcome unavailable");
        },
      },
    });

    const error = await fixture.client
      .update({ canister: CANISTER, method: "notify", args: ["ok"] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      canister: CANISTER,
      method: "notify",
      kind: "oneway",
      identityMode: "local",
      resultStatus: "dispatched_result_unknown",
      resultBytes: null,
      dispatchStatus: "unknown",
      retrySafe: false,
    });
    expect(fixture.calls).toEqual([{ method: "notify", args: ["ok"] }]);
  });

  test("uses the callable properties returned by the ICBlast browser actor", async () => {
    const fixture = createFixture(
      { read: { annotations: ["query"], result: "browser actor" } },
      { directActorOnly: true },
    );

    await expect(
      fixture.client.query({ canister: CANISTER, method: "read", args: ["ok"] }),
    ).resolves.toMatchObject({ result: "browser actor" });
    expect(fixture.calls).toEqual([{ method: "read", args: ["ok"] }]);
  });

  test("calls a Candid method named then without making the actor thenable", async () => {
    const fixture = createFixture({
      then: { annotations: ["query"], result: "not a Promise hook" },
    });

    await expect(
      fixture.client.query({
        canister: CANISTER,
        method: "then",
        args: ["ok"],
      }),
    ).resolves.toMatchObject({ result: "not a Promise hook" });
    expect(fixture.calls).toEqual([{ method: "then", args: ["ok"] }]);
  });

  test("installs and clears a fixed app deadline for every public operation", async () => {
    const scheduled: number[] = [];
    let cancelled = 0;
    const fixture = createFixture(
      {
        read: { annotations: ["query"], result: "read" },
        write: { annotations: [], result: "written" },
      },
      {
        scheduleDeadline(_callback, delayMilliseconds) {
          scheduled.push(delayMilliseconds);
          return () => {
            cancelled += 1;
          };
        },
      },
    );

    await fixture.client.scan(CANISTER);
    await fixture.client.schema(CANISTER, "read");
    await fixture.client.validateInput(CANISTER, "read", ["ok"]);
    await fixture.client.query({
      canister: CANISTER,
      method: "read",
      args: ["ok"],
    });
    await fixture.client.update({
      canister: CANISTER,
      method: "write",
      args: ["ok"],
    });

    expect(scheduled).toEqual(
      Array.from(
        { length: 5 },
        () => BLAST_LIMITS.canisterOperationTimeoutMs,
      ),
    );
    expect(cancelled).toBe(5);
    const sessionSignals = fixture.factoryOptions.map((options) => {
      const requestOptions = capturedRequestOptions(options);
      expect(requestOptions.fetch.signal).toBe(requestOptions.call.signal);
      expect(requestOptions.fetch.signal.aborted).toBe(false);
      return requestOptions.fetch.signal;
    });
    expect(new Set(sessionSignals).size).toBe(sessionSignals.length);
  });

  test("fails closed before a query-labelled route can dispatch an update", async () => {
    const fixture = createFixture({
      changed: { annotations: [], result: "must not run" },
    });
    await expect(
      fixture.client.query({
        canister: CANISTER,
        method: "changed",
        args: ["ok"],
      }),
    ).rejects.toThrow("live update");
    expect(fixture.calls).toEqual([]);
  });

  test("cancellation during discovery prevents a local update dispatch", async () => {
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const fixture = createFixture(
      { write: { annotations: [], result: "must not run" } },
      {
        async beforeActor() {
          markDiscoveryStarted();
          await discoveryGate;
        },
      },
    );
    const controller = new AbortController();
    const pending = fixture.client.update(
      {
        canister: CANISTER,
        method: "write",
        args: ["ok"],
      },
      undefined,
      { signal: controller.signal },
    );
    await discoveryStarted;
    controller.abort(new Error("discovery cancelled"));
    releaseDiscovery();
    await expect(pending).rejects.toThrow("discovery cancelled");
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.calls).toEqual([]);
    const requestOptions = capturedRequestOptions(fixture.factoryOptions[0]);
    expect(requestOptions.fetch.signal).toBe(requestOptions.call.signal);
    expect(requestOptions.fetch.signal.aborted).toBe(true);
    expect(requestOptions.fetch.signal.reason).toBe(controller.signal.reason);
  });

  test("snapshots arguments before asynchronous actor discovery", async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const fixture = createFixture(
      { read: { annotations: ["query"], result: "read" } },
      { beforeActor: () => discoveryGate },
    );
    const args: JsonValue[] = ["ok"];
    const pending = fixture.client.query({
      canister: CANISTER,
      method: "read",
      args,
    });
    args[0] = "invalid";
    releaseDiscovery();

    await expect(pending).resolves.toMatchObject({ result: "read" });
    expect(fixture.calls).toEqual([{ method: "read", args: ["ok"] }]);
  });

  test("classifies an app deadline after local update dispatch as unknown and non-retryable", async () => {
    let markDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    let fireDeadline!: () => void;
    let scheduledDelay = 0;
    const fixture = createFixture(
      {
        write: {
          annotations: [],
          result: null,
          async invoke() {
            markDispatchStarted();
            return await new Promise<JsonValue>(() => {});
          },
        },
      },
      {
        scheduleDeadline(callback, delayMilliseconds) {
          fireDeadline = callback;
          scheduledDelay = delayMilliseconds;
          return () => {};
        },
      },
    );
    const pending = fixture.client.update({
      canister: CANISTER,
      method: "write",
      args: ["ok"],
    });

    await dispatchStarted;
    fireDeadline();
    const error = await pending.catch((cause: unknown) => cause);

    expect(scheduledDelay).toBe(BLAST_LIMITS.canisterOperationTimeoutMs);
    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      canister: CANISTER,
      method: "write",
      kind: "update",
      identityMode: "local",
      resultStatus: "dispatched_result_unknown",
      resultBytes: null,
      dispatchStatus: "unknown",
      retrySafe: false,
    });
    const requestOptions = capturedRequestOptions(fixture.factoryOptions[0]);
    expect(requestOptions.fetch.signal).toBe(requestOptions.call.signal);
    expect(requestOptions.fetch.signal.aborted).toBe(true);
    expect(requestOptions.fetch.signal.reason).toMatchObject({
      name: "BlastOperationDeadlineError",
    });
    expect(fixture.calls).toEqual([{ method: "write", args: ["ok"] }]);
  });

  test("classifies a post-dispatch over-budget result with exact byte accounting", async () => {
    const result = "x".repeat(BLAST_LIMITS.canisterResultBytes + 1);
    const fixture = createFixture({
      write: { annotations: [], result },
    });

    const error = await fixture.client
      .update({ canister: CANISTER, method: "write", args: ["ok"] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      resultStatus: "result_exceeds_processing_limit",
      resultBytes: BLAST_LIMITS.canisterResultBytes + 3,
      dispatchStatus: "confirmed",
      retrySafe: false,
    });
    expect(fixture.calls).toEqual([{ method: "write", args: ["ok"] }]);
  });

  test("classifies a post-dispatch result outside the public depth reserve", async () => {
    let result: unknown = null;
    for (let index = 0; index <= BLAST_LIMITS.jsonDepth; index += 1) {
      result = [result];
    }
    const fixture = createFixture({
      write: { annotations: [], result },
    });

    const error = await fixture.client
      .update({ canister: CANISTER, method: "write", args: ["ok"] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      resultStatus: "dispatched_result_unknown",
      resultBytes: null,
      dispatchStatus: "confirmed",
      retrySafe: false,
    });
    expect(fixture.calls).toEqual([{ method: "write", args: ["ok"] }]);
  });

  test("marks only a confirmed live query outcome as retry-safe", async () => {
    const result = "x".repeat(BLAST_LIMITS.canisterResultBytes + 1);
    const fixture = createFixture({
      read: { annotations: ["query"], result },
    });

    const error = await fixture.client
      .query({ canister: CANISTER, method: "read", args: ["ok"] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      kind: "query",
      resultStatus: "result_exceeds_processing_limit",
      dispatchStatus: "confirmed",
      retrySafe: true,
    });
  });

  test("rejects invalid inputs and management-canister calls before dispatch", async () => {
    const fixture = createFixture({
      write: { annotations: [], result: "must not run" },
    });
    await expect(
      fixture.client.update({
        canister: CANISTER,
        method: "write",
        args: ["invalid"],
      }),
    ).rejects.toBeInstanceOf(BlastInputValidationError);
    await expect(
      fixture.client.update({
        canister: "aaaaa-aa",
        method: "write",
        args: ["ok"],
      }),
    ).rejects.toThrow("Management canister");
    expect(fixture.calls).toEqual([]);
  });

  test("keeps real Nat8 and Principal conversion failures before update dispatch", async () => {
    for (const args of [
      [256, "aaaaa-aa"],
      [1, "not-a-principal"],
    ] satisfies JsonValue[][]) {
      const fixture = createCandidBoundaryFixture();

      await expect(
        fixture.client.validateInput(CANISTER, "write", args),
      ).resolves.toMatchObject({ valid: true });
      const error = await fixture.client
        .update({ canister: CANISTER, method: "write", args })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BlastDispatchedCallError);
      expect(fixture.calls).toEqual([]);
    }

    const fixture = createCandidBoundaryFixture();
    await expect(
      fixture.client.update({
        canister: CANISTER,
        method: "write",
        args: [255, "aaaaa-aa"],
      }),
    ).resolves.toMatchObject({ result: null });
    expect(fixture.calls).toEqual([
      { method: "write", args: [255, "aaaaa-aa"] },
    ]);
  });

  test("rejects too many arguments before opening an ICBlast session", async () => {
    const fixture = createFixture({
      write: { annotations: [], result: null },
    });

    await expect(
      fixture.client.update({
        canister: CANISTER,
        method: "write",
        args: Array.from(
          { length: BLAST_LIMITS.canisterArgumentItems + 1 },
          () => null,
        ),
      }),
    ).rejects.toThrow(
      `Canister arguments exceed ${BLAST_LIMITS.canisterArgumentItems} items`,
    );
    expect(fixture.factoryOptions).toEqual([]);
    expect(fixture.calls).toEqual([]);
  });

  test("uses only scoped canister.call_dialog_v2 for an Agent Mode update", async () => {
    let scheduledDeadlines = 0;
    const fixture = createFixture({}, {
      scheduleDeadline() {
        scheduledDeadlines += 1;
        return () => undefined;
      },
    });
    const nestedCalls: unknown[] = [];
    const kernel = kernelFixture(
      ["canister.call_dialog", "canister.call_dialog_v2"],
      async (call: unknown) => {
        nestedCalls.push(call);
        return { accepted: true };
      },
    );

    await expect(
      fixture.client.query(
        {
          canister: CANISTER,
          method: "read",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      ),
    ).rejects.toThrow("cannot atomically attest");
    expect(nestedCalls).toEqual([]);
    const deadlinesBeforeKernelUpdate = scheduledDeadlines;

    const result = await fixture.client.update(
      {
        canister: CANISTER,
        method: "write",
        args: ["ok"],
        identityMode: "kernel",
      },
      kernel,
      { agentMode: true },
    );
    expect(nestedCalls).toEqual([
      {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
        },
      },
    ]);
    expect(scheduledDeadlines).toBe(deadlinesBeforeKernelUpdate);
    expect(result).toEqual({
      canister: CANISTER,
      method: "write",
      kind: "update",
      identityMode: "kernel",
      result: { accepted: true },
      resultBytes: 17,
    });
  });

  test("falls back to legacy Kernel consent only outside Agent Mode", async () => {
    const fixture = createFixture({});
    const nestedCalls: unknown[] = [];
    const kernel = kernelFixture(
      ["canister.call_dialog"],
      async (call: unknown) => {
        nestedCalls.push(call);
        return { accepted: true };
      },
    );

    await expect(
      fixture.client.update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      ),
    ).resolves.toMatchObject({
      identityMode: "kernel",
      result: { accepted: true },
    });
    expect(nestedCalls).toEqual([
      {
        target: "kernel",
        name: "canister.call_dialog",
        arguments: { canister: CANISTER, method: "write", args: ["ok"] },
      },
    ]);

    nestedCalls.length = 0;
    await expect(
      fixture.client.update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
        { agentMode: true },
      ),
    ).rejects.toThrow("Agent Mode requires canister.call_dialog_v2");
    expect(nestedCalls).toEqual([]);
  });

  test("prefers the v2 Kernel consent route for an ordinary call", async () => {
    const fixture = createFixture({});
    const nestedCalls: unknown[] = [];
    const kernel = kernelFixture(
      ["canister.call_dialog", "canister.call_dialog_v2"],
      async (call: unknown) => {
        nestedCalls.push(call);
        return null;
      },
    );

    await fixture.client.update(
      {
        canister: CANISTER,
        method: "write",
        args: [],
        identityMode: "kernel",
      },
      kernel,
    );

    expect(nestedCalls).toEqual([
      expect.objectContaining({ name: "canister.call_dialog_v2" }),
    ]);
  });

  test("rejects a Kernel-identity call to the hosting Neutron before negotiation", async () => {
    const runtime = productionRuntime();
    const fixture = createFixture(
      { write: { annotations: [], result: "local result" } },
      { runtime },
    );
    let listCalls = 0;
    const kernel = kernelFixture(
      ["canister.call_dialog_v2"],
      async () => {
        throw new Error("must not dispatch");
      },
      () => {
        listCalls += 1;
      },
    );

    await expect(
      fixture.client.update({
        canister: runtime.canisterId,
        method: "write",
        args: ["ok"],
      }),
    ).resolves.toMatchObject({
      canister: runtime.canisterId,
      identityMode: "local",
      result: "local result",
    });
    await expect(
      fixture.client.update(
        {
          canister: runtime.canisterId,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      ),
    ).rejects.toThrow("hosting Neutron canister");
    expect(listCalls).toBe(0);
  });

  test("classifies an ambiguous scoped Kernel rejection as an unknown non-retryable boundary", async () => {
    const fixture = createFixture({});
    const kernel = kernelFixture(
      ["canister.call_dialog_v2"],
      async () => {
        throw new Error("reply transport closed");
      },
    );

    const error = await fixture.client
      .update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect(error).toMatchObject({
      canister: CANISTER,
      method: "write",
      kind: "update",
      identityMode: "kernel",
      resultStatus: "dispatched_result_unknown",
      resultBytes: null,
      dispatchStatus: "unknown",
      retrySafe: false,
    });
  });

  test("does not mask the scoped v2 Kernel cancellation reply", async () => {
    const fixture = createFixture({});
    const controller = new AbortController();
    const localAbort = new Error("local abort");
    const kernelReply = kernelPolicyError(
      "REQUEST_CANCELLED",
      "Kernel cancellation fence completed",
    );
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const kernel = kernelFixture(
      ["canister.call_dialog_v2"],
      () => {
        markStarted?.();
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => setTimeout(() => reject(kernelReply), 0),
            { once: true },
          );
        });
      },
    );
    const pending = fixture.client.update(
      {
        canister: CANISTER,
        method: "write",
        args: [],
        identityMode: "kernel",
      },
      kernel,
      { agentMode: true, signal: controller.signal },
    );
    await started;
    controller.abort(localAbort);

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BlastDispatchedCallError);
    expect((error as Error).cause).toBe(kernelReply);
  });

  test("never trusts transported KernelPolicyError fields as dispatch evidence", async () => {
    const fixture = createFixture({});
    for (const rejection of [
      kernelPolicyError("AGENT_CONSENT_DENIED", "Agent denied this call"),
      kernelPolicyError("REQUEST_EXPIRED", "Signature request expired"),
    ]) {
      const kernel = kernelFixture(
        ["canister.call_dialog_v2"],
        async () => {
          throw rejection;
        },
      );
      const error = await fixture.client
        .update(
          {
            canister: CANISTER,
            method: "write",
            args: ["ok"],
            identityMode: "kernel",
          },
          kernel,
        )
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BlastDispatchedCallError);
      expect(error).toMatchObject({
        dispatchStatus: "unknown",
        retrySafe: false,
      });
    }

    // Plain text is not dispatch-phase evidence: a canister or transport can
    // fail with the same message after the Kernel has signed and sent a call.
    const untypedRejection = new Error("User rejected");
    const untypedKernel = kernelFixture(
      ["canister.call_dialog_v2"],
      async () => {
        throw untypedRejection;
      },
    );
    const untypedUnknown = await fixture.client
      .update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        untypedKernel,
      )
      .catch((cause: unknown) => cause);
    expect(untypedUnknown).toBeInstanceOf(BlastDispatchedCallError);
    expect(untypedUnknown).toMatchObject({
      dispatchStatus: "unknown",
      retrySafe: false,
    });

    const cancelled = kernelPolicyError(
      "REQUEST_CANCELLED",
      "The requesting app surface changed",
    );
    const kernel = kernelFixture(
      ["canister.call_dialog_v2"],
      async () => {
        throw cancelled;
      },
    );
    const unknown = await fixture.client
      .update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      )
      .catch((cause: unknown) => cause);
    expect(unknown).toBeInstanceOf(BlastDispatchedCallError);
    expect(unknown).toMatchObject({ dispatchStatus: "unknown" });
  });

  test("preserves a synchronous local Kernel transport failure as pre-dispatch", async () => {
    const fixture = createFixture({});
    const localFailure = new Error("Kernel port rejected the request locally");
    const kernel = kernelFixture(
      ["canister.call_dialog_v2"],
      () => {
        throw localFailure;
      },
    );

    const error = await fixture.client
      .update(
        {
          canister: CANISTER,
          method: "write",
          args: ["ok"],
          identityMode: "kernel",
        },
        kernel,
      )
      .catch((cause: unknown) => cause);

    expect(error).toBe(localFailure);
    expect(error).not.toBeInstanceOf(BlastDispatchedCallError);
  });
});

function kernelPolicyError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "KernelPolicyError";
  Object.defineProperty(error, "code", {
    enumerable: true,
    value: code,
  });
  return error;
}

function kernelFixture(
  toolNames: readonly string[],
  callTool: (call: unknown) => unknown | Promise<unknown>,
  onList?: () => void,
): ScopedKernelClient {
  return {
    async listTools(target?: string) {
      expect(target).toBe("kernel");
      onList?.();
      return toolNames.map((name) => ({ name }));
    },
    callTool,
  } as unknown as ScopedKernelClient;
}

function capturedRequestOptions(value: unknown): Readonly<{
  fetch: Readonly<{ redirect: string; signal: AbortSignal }>;
  call: Readonly<{ redirect: string; signal: AbortSignal }>;
}> {
  const options = value as {
    agentOptions: {
      fetchOptions: { redirect: string; signal: AbortSignal };
      callOptions: { redirect: string; signal: AbortSignal };
    };
  };
  return {
    fetch: options.agentOptions.fetchOptions,
    call: options.agentOptions.callOptions,
  };
}

type MethodFixture = Readonly<{
  annotations: readonly string[];
  result: unknown;
  invoke?: () => unknown | Promise<unknown>;
}>;

function createFixture(
  methods: Readonly<Record<string, MethodFixture>>,
  fixtureOptions: Readonly<{
    beforeActor?: () => Promise<void>;
    directActorOnly?: boolean;
    validateInput?: BlastIcblastAdapters["validateInput"];
    scheduleDeadline?: (
      callback: () => void,
      delayMilliseconds: number,
    ) => () => void;
    runtime?: BlastTrustedRuntime;
  }> = {},
) {
  const calls: Array<{ method: string; args: JsonValue[] }> = [];
  const factoryOptions: unknown[] = [];
  const actor: Record<string, unknown> = {
    $idlFactory({ IDL }: { IDL: unknown }) {
      const api = IDL as {
        Service(fields: Record<string, unknown>): unknown;
        Func(
          input: unknown[],
          output: unknown[],
          annotations: readonly string[],
        ): unknown;
        Text: unknown;
      };
      return api.Service(
        Object.fromEntries(
          Object.entries(methods).map(([name, fixture]) => [
            name,
            api.Func([api.Text], [api.Text], fixture.annotations),
          ]),
        ),
      );
    },
  };
  const actorMethods = new Map<string, unknown>();
  for (const [method, fixture] of Object.entries(methods)) {
    const dispatch = async (...args: JsonValue[]) => {
      calls.push({ method, args });
      return fixture.invoke ? await fixture.invoke() : fixture.result;
    };
    const callable = Object.assign(dispatch, {
      async prepare(...args: JsonValue[]) {
        return Object.freeze({
          args: Object.freeze([...args]),
          invoke: () => dispatch(...args),
        });
      },
    });
    actorMethods.set(method, callable);
    // ICBlast keeps this reserved name only in $methods so returning the actor
    // from an async factory can never trigger Promise thenable assimilation.
    if (method !== "then") actor[method] = callable;
  }
  if (!fixtureOptions.directActorOnly) {
    Object.defineProperty(actor, "$methods", {
      enumerable: false,
      value: Object.freeze({
        get: (method: string) => actorMethods.get(method),
      }),
    });
  }

  const adapters: BlastIcblastAdapters = {
    async connect(options) {
      factoryOptions.push(options);
      return async () => {
        await fixtureOptions.beforeActor?.();
        return actor as never;
      };
    },
    explainSchema() {
      return METHOD_SCHEMA;
    },
    validateInput:
      fixtureOptions.validateInput ??
      ((_schema, args) =>
        args[0] === "ok"
          ? { ok: true }
          : {
              ok: false,
              errors: [{ instancePath: "/0", message: "must equal ok" }],
            }),
    normalize(value) {
      return value;
    },
    ...(fixtureOptions.scheduleDeadline
      ? { scheduleDeadline: fixtureOptions.scheduleDeadline }
      : {}),
  };
  const client = createBlastIcblastClient({
    runtime: fixtureOptions.runtime ?? productionRuntime(),
    localIdentity: fakeIdentity(),
    adapters,
  });
  return { client, calls, factoryOptions };
}

function createCandidBoundaryFixture() {
  const calls: Array<{ method: string; args: JsonValue[] }> = [];
  const argumentTypes = [IDL.Nat8, IDL.Principal];
  const dispatch = async (nat8: number, principal: Principal): Promise<null> => {
    calls.push({ method: "write", args: [nat8, principal.toText()] });
    return null;
  };
  const write = Object.assign(
    async (nat8: number, principal: string) =>
      dispatch(nat8, Principal.fromText(principal)),
    {
      async prepare(nat8: number, principal: string) {
        const encoded = IDL.encode(argumentTypes, [
          nat8,
          Principal.fromText(principal),
        ]);
        const [preparedNat8, preparedPrincipal] = IDL.decode(
          argumentTypes,
          encoded,
        ) as [number, Principal];
        return Object.freeze({
          args: Object.freeze([preparedNat8, preparedPrincipal.toText()]),
          invoke: () => dispatch(preparedNat8, preparedPrincipal),
        });
      },
    },
  );
  const actor = Object.freeze({
    $idlFactory: candidBoundaryService,
    $methods: Object.freeze({
      get: (method: string) => (method === "write" ? write : undefined),
    }),
  });
  const adapters: BlastIcblastAdapters = {
    async connect() {
      return async () => actor as never;
    },
    explainSchema(source, method) {
      return explainMethodSchema(source, method, {
        allowNumberedPrincipals: false,
      });
    },
    validateInput: validateMethodInputSchema,
    normalize: toState,
  };
  return {
    calls,
    client: createBlastIcblastClient({
      runtime: productionRuntime(),
      localIdentity: fakeIdentity(),
      adapters,
    }),
  };
}

function candidBoundaryService({ IDL: candid }: { IDL: typeof IDL }) {
  return candid.Service({
    write: candid.Func(
      [candid.Nat8, candid.Principal],
      [candid.Null],
      [],
    ),
  });
}

function productionRuntime(): BlastTrustedRuntime {
  const config = createKernelRuntimeConfig({
    target: "ic",
    gateway: IC_RUNTIME_GATEWAY,
    identity_provider: IC_RUNTIME_IDENTITY_PROVIDER,
    canister_id: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    deployment_id: "02".repeat(16),
    root_key_policy: "mainnet",
    allow_loopback_http: false,
    isolated_frame_origin_template: isolatedFrameOriginTemplate(
      "ic",
      "ryjl3-tyaaa-aaaaa-aaaba-cai",
    ),
    update_source_origin: null,
  });
  const pageOrigin =
    "https://i0123456789abcdef01234567--ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io";
  return Object.freeze({
    config,
    canisterId: config.canister_id,
    pageOrigin,
    agentHost: config.gateway,
    local: false,
  });
}

function fakeIdentity(): BlastLocalIdentity {
  return {
    slot: 0,
    identity: {} as BlastLocalIdentity["identity"],
    principal: "2vxsx-fae",
    createdAt: 0,
    publicKeyFingerprint: "00".repeat(32),
  };
}
