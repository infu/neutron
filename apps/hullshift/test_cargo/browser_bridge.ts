// Test-only Kernel tool transport. The app, resident, IndexedDB and Web Worker
// run unchanged; only the enclosing Neutron message bus is replaced here.
type Handler = (arguments_: Record<string, unknown>) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const listeners = new Set<() => void>();
export function exposeTool(name: string, _schema: unknown, handler: Handler) { handlers.set(name, handler); }
export async function callTool(request: { name: string; arguments: Record<string, unknown> }) {
  const handler = handlers.get(request.name);
  if (!handler) throw new Error(`Missing browser-test tool ${request.name}`);
  return structuredClone(await handler(request.arguments));
}
export function loadTileContext() { return { app: "hullshift", instance: "browser-test" }; }
export function onAppStateChange(_topic: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function publishAppStateChange() { for (const listener of listeners) listener(); }
(window as unknown as { hullshiftTest: unknown }).hullshiftTest = { callTool };
