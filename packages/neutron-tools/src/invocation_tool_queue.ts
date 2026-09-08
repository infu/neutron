import type {
  JsonValue, MsgBusCallOptions, MsgBusClient, MsgBusToolCall, MsgBusToolContext,
} from "./protocol.ts";

// Match the Kernel's existing MAX_PARALLEL_CHILDREN admission capacity. Waiting
// here preserves every requested read instead of losing quotes to that limit.
const PARALLEL_CHILDREN = 4;
type Pending = { serial: boolean; start(finish: () => void): void };
type Queue = { active: number; serialActive: boolean; pending: Pending[] };
const queues = new WeakMap<MsgBusToolContext["kernel"], Queue>();

function drain(queue: Queue): void {
  while (queue.active < PARALLEL_CHILDREN) {
    // Reads stay FIFO and serial calls stay FIFO. A queued provider review
    // must not prevent installation-approved reads from using available slots.
    const index = queue.pending.findIndex((pending) => !pending.serial || !queue.serialActive);
    if (index < 0) return;
    const pending = queue.pending.splice(index, 1)[0]!;
    queue.active++;
    if (pending.serial) queue.serialActive = true;
    pending.start(() => {
      queue.active--;
      if (pending.serial) queue.serialActive = false;
      drain(queue);
    });
  }
}

/** Share the existing child-call capacity across clients within one invocation.
 * The original scoped client supplies authority; this adapter only schedules
 * calls. Unlisted calls serialize so provider reviews cannot overlap.
 */
export function createQueuedInvocationToolClient(
  context: Pick<MsgBusToolContext, "kernel" | "signal" | "agentMode">,
  isParallelRead: (call: MsgBusToolCall) => boolean,
): Pick<MsgBusClient, "callTool"> {
  if (!context.agentMode) return context.kernel;
  let queue = queues.get(context.kernel);
  if (!queue) { queue = { active: 0, serialActive: false, pending: [] }; queues.set(context.kernel, queue); }
  const shared = queue;
  return {
    callTool<T extends JsonValue = JsonValue>(call: MsgBusToolCall, options?: number | MsgBusCallOptions): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const signals = [...new Set([context.signal, typeof options === "object" ? options.signal : undefined]
          .filter((signal): signal is AbortSignal => signal !== undefined))];
        const aborted = () => signals.find((signal) => signal.aborted);
        const cleanup = () => { for (const signal of signals) signal.removeEventListener("abort", cancel); };
        const cancel = () => {
          const index = shared.pending.indexOf(pending);
          if (index < 0) return; // Active requests use their original transport cancellation.
          shared.pending.splice(index, 1);
          cleanup();
          reject(aborted()?.reason);
          drain(shared);
        };
        const pending: Pending = {
          serial: !isParallelRead(call),
          start(finish) {
            cleanup();
            const stopped = aborted();
            if (stopped) { reject(stopped.reason); finish(); return; }
            let dispatched: Promise<T>;
            try {
              // Keep the exact scoped receiver, call and transport options.
              dispatched = context.kernel.callTool<T>(call, options);
            } catch (error) {
              dispatched = Promise.reject(error);
            }
            Promise.resolve(dispatched).then(
              (result) => { finish(); resolve(result); },
              (error: unknown) => { finish(); reject(error); },
            );
          },
        };
        shared.pending.push(pending);
        for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
        if (aborted()) cancel();
        drain(shared);
      });
    },
  };
}
