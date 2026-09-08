// The extension uses only this small Chrome API surface; no runtime dependency.
interface ChromeEvent<T extends (...args: any[]) => unknown> { addListener(callback: T): void; removeListener(callback: T): void }
interface ChromeSender { id?: string; frameId?: number; origin?: string; url?: string; tab?: { id?: number; url?: string } }
interface ChromePort {
  name: string;
  sender?: ChromeSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}
declare const chrome: {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getURL(path: string): string;
    getManifest(): { version: string };
    getContexts(filter: { contextTypes: string[]; documentUrls: string[] }): Promise<unknown[]>;
    connect(options: { name: string }): ChromePort;
    sendMessage(message: unknown): Promise<any>;
    onConnect: ChromeEvent<(port: ChromePort) => void>;
    onMessage: ChromeEvent<(message: any, sender: ChromeSender, reply: (response: any) => void) => boolean | void>;
    openOptionsPage(): Promise<void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
    onChanged: ChromeEvent<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>;
  };
  windows: {
    create(options: { url: string; type: "popup"; width: number; height: number }): Promise<{ id?: number }>;
    remove(id: number): Promise<void>;
    onRemoved: ChromeEvent<(id: number) => void>;
  };
  offscreen: { createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void> };
};
