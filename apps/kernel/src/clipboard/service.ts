import {
  KernelPolicyError,
  isJsonObject,
  type JsonValue,
} from "neutron-tools/protocol";
import { showToast } from "../toast/store.ts";

export const MAX_CLIPBOARD_TEXT_BYTES = 256 * 1_024;
export const MAX_KERNEL_UI_CLIPBOARD_TEXT_BYTES = 4 * 1_024 * 1_024;

export type ClipboardAppRequest = {
  role: "tile" | "background" | "tray" | "media";
  focused: boolean;
  userActivated: boolean;
  ownerAuthorized: boolean;
  delegated: boolean;
};

type ClipboardServiceDependencies = {
  writeText: (text: string) => Promise<void>;
  notifyCopied: () => void;
};

export function createClipboardService(
  dependencies: ClipboardServiceDependencies,
) {
  const lastWriteByEndpoint = new Map<string, number>();

  async function writeFromApp(
    payload: JsonValue,
    request: ClipboardAppRequest,
  ): Promise<null> {
    const text = assertClipboardPayload(payload);
    if (!request.ownerAuthorized) {
      throw new KernelPolicyError(
        "OWNER_REQUIRED",
        "Clipboard access requires the authorized owner",
      );
    }
    if (
      request.role !== "tile" ||
      !request.focused ||
      !request.userActivated ||
      request.delegated
    ) {
      throw new KernelPolicyError(
        "USER_INTERACTION_REQUIRED",
        "Copy from a click in the focused app tile",
      );
    }
    await write(text);
    return null;
  }

  async function writeFromKernelUi(
    text: string,
    userActivated: boolean,
    maximumBytes = MAX_CLIPBOARD_TEXT_BYTES,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > MAX_KERNEL_UI_CLIPBOARD_TEXT_BYTES
    ) {
      throw new Error("Invalid Kernel clipboard byte limit");
    }
    assertClipboardText(text, maximumBytes);
    if (!userActivated) {
      throw new KernelPolicyError(
        "USER_INTERACTION_REQUIRED",
        "Copy from a kernel control click",
      );
    }
    await write(text);
  }

  async function write(text: string): Promise<void> {
    await dependencies.writeText(text);
    dependencies.notifyCopied();
  }

  return { writeFromApp, writeFromKernelUi };
}

export const clipboardService = createClipboardService({
  writeText: async (text) => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable");
    }
    await navigator.clipboard.writeText(text);
  },
  notifyCopied: () =>
    showToast({ message: "Copied to clipboard", tone: "success" }),
});

function assertClipboardPayload(payload: JsonValue): string {
  if (
    !isJsonObject(payload) ||
    Object.keys(payload).length !== 1 ||
    typeof payload.text !== "string"
  ) {
    throw new Error("Invalid clipboard payload");
  }
  assertClipboardText(payload.text);
  return payload.text;
}

function assertClipboardText(
  text: string,
  maximumBytes = MAX_CLIPBOARD_TEXT_BYTES,
): void {
  if (typeof text !== "string") throw new Error("Clipboard text must be a string");
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new Error(
      `Clipboard text exceeds ${formatClipboardByteLimit(maximumBytes)}`,
    );
  }
}

function formatClipboardByteLimit(bytes: number): string {
  return bytes % (1_024 * 1_024) === 0
    ? `${bytes / (1_024 * 1_024)} MiB`
    : `${bytes / 1_024} KiB`;
}
