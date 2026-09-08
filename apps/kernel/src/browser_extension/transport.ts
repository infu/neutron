const CHANNEL = "neutron.extension.v1";
const PROTOCOL_VERSION = 1;
const DEFAULT_HANDSHAKE_MS = 1_500;

export class BrowserExtensionTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserExtensionTransportError";
  }
}

export type BrowserExtensionStatus = {
  available: boolean;
  paired: boolean;
  extensionVersion?: string;
  incompatible?: boolean;
};

type TransportOptions = {
  window?: Window | null;
  MessageChannel?: typeof MessageChannel;
  handshakeMs?: number;
};

type Connection = {
  port: MessagePort;
  remotePort: MessagePort;
  origin: string;
  ready: boolean;
  promise: Promise<Connection>;
  resolve: (connection: Connection) => void;
  reject: (error: BrowserExtensionTransportError) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: BrowserExtensionTransportError) => void;
};

/** Local browser transport only; the Kernel service owns app authorization. */
export class BrowserExtensionTransport {
  private connection: Connection | null = null;
  private nextId = 0n;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly disconnectListeners = new Set<
    (error: BrowserExtensionTransportError) => void
  >();
  private readonly revokedListeners = new Set<() => void>();

  constructor(private readonly options: TransportOptions = {}) {}

  async request(
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<unknown> {
    const connection = await this.connect();
    if (connection !== this.connection || !connection.ready) {
      throw disconnectedError();
    }
    const id = (++this.nextId).toString();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // These fields belong to the transport, even if a caller supplies them.
        connection.port.postMessage({ ...payload, id, op });
      } catch {
        this.endConnection(
          connection,
          new BrowserExtensionTransportError(
            "EXTENSION_DISCONNECTED",
            "Could not send the request to the Neutron extension. Reconnect and try again.",
          ),
        );
      }
    });
  }

  async status(): Promise<BrowserExtensionStatus> {
    try {
      const connection = await this.connect();
      const result = await this.request("status");
      if (!isRecord(result)) throw invalidStatus();
      if (result.version !== PROTOCOL_VERSION) throw incompatibleError();
      if (
        typeof result.extensionVersion !== "string" ||
        typeof result.paired !== "boolean" ||
        result.origin !== connection.origin
      ) {
        throw invalidStatus();
      }
      return {
        available: true,
        paired: result.paired,
        extensionVersion: result.extensionVersion,
      };
    } catch (error) {
      if (error instanceof BrowserExtensionTransportError) {
        if (error.code === "EXTENSION_UNAVAILABLE") {
          return { available: false, paired: false };
        }
        if (error.code === "EXTENSION_INCOMPATIBLE") {
          return { available: false, paired: false, incompatible: true };
        }
      }
      throw error;
    }
  }

  disconnect(): void {
    if (this.connection) this.endConnection(this.connection, disconnectedError());
  }

  subscribeDisconnect(
    listener: (error: BrowserExtensionTransportError) => void,
  ): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  subscribeRevoked(listener: () => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  private connect(): Promise<Connection> {
    if (this.connection) return this.connection.promise;

    const browserWindow =
      this.options.window !== undefined
        ? this.options.window
        : typeof window === "undefined"
          ? null
          : window;
    const Channel = this.options.MessageChannel ?? globalThis.MessageChannel;
    if (!browserWindow || browserWindow.top !== browserWindow || !Channel) {
      return Promise.reject(
        new BrowserExtensionTransportError(
          "EXTENSION_UNAVAILABLE",
          "The Neutron extension is only available in the main Neutron browser window.",
        ),
      );
    }

    const channel = new Channel();
    let resolve!: (connection: Connection) => void;
    let reject!: (error: BrowserExtensionTransportError) => void;
    const promise = new Promise<Connection>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const connection: Connection = {
      port: channel.port1,
      remotePort: channel.port2,
      origin: browserWindow.location.origin,
      ready: false,
      promise,
      resolve,
      reject,
      timer: null,
    };
    this.connection = connection;
    connection.port.onmessage = (event) => this.receive(connection, event.data);
    connection.port.onmessageerror = () =>
      this.endConnection(
        connection,
        new BrowserExtensionTransportError(
          "EXTENSION_DISCONNECTED",
          "The Neutron extension connection could not read a message. Reconnect and try again.",
        ),
      );
    connection.port.start();

    // Only extension discovery expires. Pairing, consent, and network requests
    // have no transport timeout and can continue for as long as they need.
    connection.timer = setTimeout(() => {
      this.endConnection(
        connection,
        new BrowserExtensionTransportError(
          "EXTENSION_UNAVAILABLE",
          "The Neutron extension was not detected. Install or enable it, then try again.",
        ),
      );
    }, this.options.handshakeMs ?? DEFAULT_HANDSHAKE_MS);

    try {
      browserWindow.postMessage(
        { channel: CHANNEL, type: "connect" },
        connection.origin,
        [channel.port2],
      );
    } catch {
      this.endConnection(
        connection,
        new BrowserExtensionTransportError(
          "EXTENSION_UNAVAILABLE",
          "Could not connect to the Neutron extension.",
        ),
      );
    }
    return promise;
  }

  private receive(connection: Connection, message: unknown): void {
    if (this.connection !== connection || !isRecord(message)) return;
    if (message.type === "disconnected") {
      this.endConnection(connection, remoteError(message.error, disconnectedError()));
      return;
    }
    if (message.type === "revoked") {
      if (connection.ready) {
        // Revocation can arrive before the successful revoke RPC response.
        // Keep this channel open so that response and cancellation errors arrive.
        for (const listener of [...this.revokedListeners]) {
          try {
            listener();
          } catch {
            // Notify every consumer even when another consumer fails to clean up.
          }
        }
      }
      return;
    }
    if (message.type === "ready") {
      if (message.version !== PROTOCOL_VERSION) {
        this.endConnection(connection, incompatibleError());
      } else if (typeof message.extensionVersion !== "string") {
        this.endConnection(connection, invalidStatus());
      } else if (!connection.ready) {
        connection.ready = true;
        if (connection.timer !== null) clearTimeout(connection.timer);
        connection.timer = null;
        connection.resolve(connection);
      }
      return;
    }
    if (!connection.ready || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok === true) {
      pending.resolve(message.result);
    } else if (message.ok === false) {
      pending.reject(
        remoteError(
          message.error,
          new BrowserExtensionTransportError(
            "EXTENSION_PROTOCOL_ERROR",
            "The Neutron extension returned an invalid error response.",
          ),
        ),
      );
    } else {
      pending.reject(
        new BrowserExtensionTransportError(
          "EXTENSION_PROTOCOL_ERROR",
          "The Neutron extension returned an invalid response.",
        ),
      );
    }
  }

  private endConnection(
    connection: Connection,
    error: BrowserExtensionTransportError,
  ): void {
    if (connection !== this.connection) return;
    this.connection = null;
    if (connection.timer !== null) clearTimeout(connection.timer);
    connection.timer = null;
    connection.port.onmessage = null;
    connection.port.onmessageerror = null;
    try {
      // Closing a MessagePort does not notify its peer. Tell the content bridge
      // to close its runtime port and abort requests before releasing our port.
      connection.port.postMessage({ type: "disconnect" });
    } catch {
      // A broken channel still needs local pending requests and listeners settled.
    }
    connection.port.close();
    connection.remotePort.close();
    connection.reject(error);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener(error);
      } catch {
        // One consumer must not prevent other consumers from cleaning up.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remoteError(
  value: unknown,
  fallback: BrowserExtensionTransportError,
): BrowserExtensionTransportError {
  return isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
    ? new BrowserExtensionTransportError(value.code, value.message)
    : fallback;
}

function disconnectedError(): BrowserExtensionTransportError {
  return new BrowserExtensionTransportError(
    "EXTENSION_DISCONNECTED",
    "The Neutron extension disconnected. Reconnect and try again.",
  );
}

function incompatibleError(): BrowserExtensionTransportError {
  return new BrowserExtensionTransportError(
    "EXTENSION_INCOMPATIBLE",
    "The Neutron extension uses an incompatible protocol. Update Neutron and the extension.",
  );
}

function invalidStatus(): BrowserExtensionTransportError {
  return new BrowserExtensionTransportError(
    "EXTENSION_PROTOCOL_ERROR",
    "The Neutron extension returned invalid connection details.",
  );
}

export const browserExtensionTransport = new BrowserExtensionTransport();
