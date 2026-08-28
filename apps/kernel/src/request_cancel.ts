import { KernelPolicyError } from "neutron-tools/protocol";

export function requestCancellationError(
  signal: AbortSignal | undefined,
  message: string,
): Error {
  if (signal?.reason instanceof KernelPolicyError) return signal.reason;
  return new KernelPolicyError("REQUEST_CANCELLED", message);
}

export function throwIfRequestCancelled(
  signal: AbortSignal | undefined,
  message = "Message-bus request was cancelled by the requesting app",
): void {
  if (signal?.aborted) throw requestCancellationError(signal, message);
}
