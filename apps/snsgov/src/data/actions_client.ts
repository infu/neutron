import { callTool, type JsonObject } from "neutron-tools/app";

/** The tile uses the same resident interface as agents. A timeout only stops
 * observation; callers retain operationId and read its saved outcome. */
export async function invoke<T>(name: string, args: object = {}, signal?: AbortSignal): Promise<T> {
  return await callTool({
    target: "app:snsgov:background", name, arguments: args as JsonObject,
  }, { timeout: 300, ...(signal ? { signal } : {}) }) as T;
}

/** Create once per new intent and retain through review, funding and recovery. */
export function operationId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
