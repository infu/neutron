import { describe, expect, test } from "bun:test";
import type {
  JsonValue,
  MsgBusCallOptions,
  MsgBusToolCall,
} from "neutron-tools/app";
import {
  createWagyuResidentVerificationClient,
  retryResidentStartupCall,
  WAGYU_RESIDENT_VERIFICATION_TOOLS,
} from "../src/worker/index.ts";

describe("resident verification startup", () => {
  test("keeps the first feed hydration loading until the endpoint registers", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await retryResidentStartupCall(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("Unknown endpoint 'app:wagyu:background'");
        }
        return "verified";
      },
      undefined,
      [50, 100, 200],
      async (delay) => {
        waits.push(delay);
        return true;
      },
    );

    expect(result).toBe("verified");
    expect(calls).toBe(3);
    expect(waits).toEqual([50, 100]);
  });

  test("does not retry a real resident or verification failure", async () => {
    let calls = 0;
    await expect(
      retryResidentStartupCall(
        async () => {
          calls += 1;
          throw new Error("Certified post proof is invalid");
        },
        undefined,
        [50, 100],
        async () => true,
      ),
    ).rejects.toThrow("Certified post proof is invalid");
    expect(calls).toBe(1);
  });

  test("stops a startup wait when feed hydration is cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = retryResidentStartupCall(
      async () => {
        calls += 1;
        throw new Error("Unknown endpoint 'app:wagyu:background'");
      },
      controller.signal,
      [50, 100],
      async (_delay, signal) => {
        controller.abort();
        return !signal?.aborted;
      },
    );

    await expect(pending).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });
});

test("tile cancellation reaches the resident and frees its active slot", async () => {
  const pending = new Map<
    string,
    (value: JsonValue) => void
  >();
  const cancelledIds: string[] = [];
  const cancellationOptions: Array<number | MsgBusCallOptions | undefined> = [];
  let active = 0;
  const bus = {
    async callTool<T extends JsonValue = JsonValue>(
      call: MsgBusToolCall,
      options?: number | MsgBusCallOptions,
    ): Promise<T> {
      const requestId = String(call.arguments?.requestId ?? "");
      if (call.name === WAGYU_RESIDENT_VERIFICATION_TOOLS.cancel) {
        cancellationOptions.push(options);
        cancelledIds.push(requestId);
        const resolve = pending.get(requestId);
        if (resolve) {
          pending.delete(requestId);
          active -= 1;
          resolve({
            state: "unavailable",
            code: "worker_cancelled",
            reason: "Verification was cancelled",
          });
        }
        return { cancelled: resolve !== undefined } as unknown as T;
      }
      if (active >= 1) {
        return {
          state: "unavailable",
          code: "resident_busy",
          reason: "Fixture active slot is occupied",
        } as unknown as T;
      }
      active += 1;
      return await new Promise<T>((resolve) => {
        pending.set(requestId, resolve as (value: JsonValue) => void);
      });
    },
  };
  const client = createWagyuResidentVerificationClient(
    "app:wagyu:background",
    bus,
  );
  const controller = new AbortController();
  const first = client.verifyProfile(
    { nodeId: "aaaaa-aa" },
    { signal: controller.signal },
  );
  controller.abort();

  expect(await first).toMatchObject({
    state: "unavailable",
    code: "worker_cancelled",
  });
  expect(cancelledIds).toHaveLength(1);
  expect(cancellationOptions).toEqual([{ timeout: 5, control: "cancel" }]);
  expect(active).toBe(0);

  const second = client.verifyProfile({ nodeId: "bbbbb-bb" });
  expect(active).toBe(1);
  const secondId = [...pending.keys()][0]!;
  pending.get(secondId)!({
    state: "unavailable",
    code: "fixture_complete",
    reason: "Fixture completed",
  });
  active -= 1;
  pending.delete(secondId);
  expect(await second).toMatchObject({
    state: "unavailable",
    code: "fixture_complete",
  });
});
