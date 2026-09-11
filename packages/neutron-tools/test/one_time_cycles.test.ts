import { expect, test } from "bun:test";
import { quoteOneTimeCycleCall, requestOneTimeCycleCall, getOneTimeCycleCallStatus, listOneTimeCycleCalls } from "../src/app.ts";
import { MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS, type ScopedKernelClient } from "../src/protocol.ts";

test("one-time cycle SDK helpers use the supplied invocation-scoped Kernel client", async () => {
  const calls: unknown[] = [];
  const kernel = { callTool: async (...args: unknown[]) => { calls.push(args); return null; } } as unknown as ScopedKernelClient;
  const request = { requestId: "ab".repeat(16), canister: "um5iw-rqaaa-aaaaq-qaaba-cai", method: "deposit", argsHex: "4449444c0000", cyclesAtoms: "50000000000000", allowPartial: true };
  await quoteOneTimeCycleCall(request, kernel);
  await requestOneTimeCycleCall(request, kernel);
  await getOneTimeCycleCallStatus(request.requestId, kernel);
  await listOneTimeCycleCalls({ before: "12", limit: 4 }, kernel);
  expect(calls).toEqual([
    [{ target: "kernel", name: "backend_calls.cycles_quote", arguments: request }, MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS],
    [{ target: "kernel", name: "backend_calls.cycles_request", arguments: request }, 0],
    [{ target: "kernel", name: "backend_calls.cycles_status", arguments: { requestId: request.requestId } }, MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS],
    [{ target: "kernel", name: "backend_calls.cycles_list", arguments: { before: "12", limit: 4 } }, MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS],
  ]);
});
