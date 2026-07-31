import {
  createMsgBusClient,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";

export const TRAY_DEMO_TOPIC = "tray_demo";
export const TRAY_DEMO_ENDPOINT =
  "app:kitchensink:background" as MsgBusEndpointId;
export const TRAY_DEMO_TOOLS = {
  snapshot: "tray_demo_snapshot",
  add: "tray_demo_add",
  markRead: "tray_demo_mark_read",
  markAllRead: "tray_demo_mark_all_read",
} as const;

export const TRAY_DEMO_NOTIFICATION_LIMIT = 8;

export type TrayDemoNotification = {
  id: string;
  title: string;
  detail: string;
  time: string;
  read: boolean;
};

export type TrayDemoSnapshot = {
  revision: string;
  unread: number;
  notifications: TrayDemoNotification[];
};

export const trayDemoNotificationSchema: JsonObject = {
  type: "object",
  required: ["id", "title", "detail", "time", "read"],
  properties: {
    id: { type: "string", pattern: "^[1-9][0-9]{0,8}$" },
    title: { type: "string", minLength: 1, maxLength: 80 },
    detail: { type: "string", minLength: 1, maxLength: 180 },
    time: { type: "string", minLength: 1, maxLength: 32 },
    read: { type: "boolean" },
  },
  additionalProperties: false,
};

export const trayDemoSnapshotSchema: JsonObject = {
  type: "object",
  required: ["revision", "unread", "notifications"],
  properties: {
    revision: { type: "string", pattern: "^0$|^[1-9][0-9]{0,8}$" },
    unread: {
      type: "integer",
      minimum: 0,
      maximum: TRAY_DEMO_NOTIFICATION_LIMIT,
    },
    notifications: {
      type: "array",
      maxItems: TRAY_DEMO_NOTIFICATION_LIMIT,
      items: trayDemoNotificationSchema,
    },
  },
  additionalProperties: false,
};

export class TrayDemoClient {
  private readonly bus = createMsgBusClient();

  constructor(
    private readonly endpoint: MsgBusEndpointId = TRAY_DEMO_ENDPOINT,
  ) {}

  async snapshot(): Promise<TrayDemoSnapshot> {
    return parseTrayDemoSnapshot(
      await this.bus.callTool(
        {
          target: this.endpoint,
          name: TRAY_DEMO_TOOLS.snapshot,
          arguments: {},
        },
        10,
      ),
    );
  }

  async add(): Promise<TrayDemoSnapshot> {
    return parseTrayDemoSnapshot(
      await this.bus.callTool(
        {
          target: this.endpoint,
          name: TRAY_DEMO_TOOLS.add,
          arguments: {},
        },
        10,
      ),
    );
  }

  async markRead(id: string): Promise<TrayDemoSnapshot> {
    return parseTrayDemoSnapshot(
      await this.bus.callTool(
        {
          target: this.endpoint,
          name: TRAY_DEMO_TOOLS.markRead,
          arguments: { id },
        },
        10,
      ),
    );
  }

  async markAllRead(): Promise<TrayDemoSnapshot> {
    return parseTrayDemoSnapshot(
      await this.bus.callTool(
        {
          target: this.endpoint,
          name: TRAY_DEMO_TOOLS.markAllRead,
          arguments: {},
        },
        10,
      ),
    );
  }
}

export function parseTrayDemoSnapshot(value: JsonValue): TrayDemoSnapshot {
  if (
    !isJsonObject(value) ||
    typeof value.revision !== "string" ||
    !/^(0|[1-9][0-9]{0,8})$/.test(value.revision) ||
    typeof value.unread !== "number" ||
    !Number.isInteger(value.unread) ||
    value.unread < 0 ||
    value.unread > TRAY_DEMO_NOTIFICATION_LIMIT ||
    !Array.isArray(value.notifications) ||
    value.notifications.length > TRAY_DEMO_NOTIFICATION_LIMIT
  ) {
    throw new Error("Invalid Kitchen Sink tray snapshot");
  }

  const notifications = value.notifications.map(parseNotification);
  if (notifications.filter((notification) => !notification.read).length !== value.unread) {
    throw new Error("Kitchen Sink tray unread count is inconsistent");
  }

  return {
    revision: value.revision,
    unread: value.unread,
    notifications,
  };
}

function parseNotification(value: JsonValue): TrayDemoNotification {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (key) => !["id", "title", "detail", "time", "read"].includes(key),
    ) ||
    typeof value.id !== "string" ||
    !/^[1-9][0-9]{0,8}$/.test(value.id) ||
    typeof value.title !== "string" ||
    value.title.length < 1 ||
    value.title.length > 80 ||
    typeof value.detail !== "string" ||
    value.detail.length < 1 ||
    value.detail.length > 180 ||
    typeof value.time !== "string" ||
    value.time.length < 1 ||
    value.time.length > 32 ||
    typeof value.read !== "boolean"
  ) {
    throw new Error("Invalid Kitchen Sink tray notification");
  }
  return {
    id: value.id,
    title: value.title,
    detail: value.detail,
    time: value.time,
    read: value.read,
  };
}
