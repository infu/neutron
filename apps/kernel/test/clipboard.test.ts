import { expect, test } from "bun:test";
import {
  MAX_CLIPBOARD_TEXT_BYTES,
  createClipboardService,
  type ClipboardAppRequest,
} from "../src/clipboard/service.ts";

const allowed: ClipboardAppRequest = {
  role: "tile",
  focused: true,
  userActivated: true,
  ownerAuthorized: true,
  delegated: false,
};

test("clipboard service writes exact text and notifies after success", async () => {
  const events: string[] = [];
  const service = createClipboardService({
    writeText: async (text) => {
      events.push(`write:${text}`);
    },
    notifyCopied: () => events.push("notify"),
  });

  await expect(
    service.writeFromApp({ text: "line 1\nline 2" }, allowed),
  ).resolves.toBeNull();
  expect(events).toEqual(["write:line 1\nline 2", "notify"]);
});

test("clipboard service rejects background and tray surfaces plus inactive or unauthorized tiles", async () => {
  for (const request of [
    { ...allowed, role: "background" as const },
    { ...allowed, role: "tray" as const },
    { ...allowed, focused: false },
    { ...allowed, userActivated: false },
    { ...allowed, delegated: true },
  ]) {
    const service = inertService();
    await expect(service.writeFromApp({ text: "no" }, request)).rejects.toMatchObject({
      code: "USER_INTERACTION_REQUIRED",
    });
  }
  await expect(
    inertService().writeFromApp(
      { text: "no" },
      { ...allowed, ownerAuthorized: false },
    ),
  ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
});

test("clipboard service validates the exact bounded payload", async () => {
  const service = inertService();
  await expect(
    service.writeFromApp({ text: "ok", extra: true }, allowed),
  ).rejects.toThrow("Invalid clipboard payload");
  await expect(
    service.writeFromApp(
      { text: "x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1) },
      allowed,
    ),
  ).rejects.toThrow("exceeds 256 KiB");
});

test("clipboard service does not impose an elapsed-time quota", async () => {
  let writes = 0;
  const service = createClipboardService({
    writeText: async () => {
      writes += 1;
    },
    notifyCopied: () => undefined,
  });

  await service.writeFromApp({ text: "one" }, allowed);
  await service.writeFromApp({ text: "two" }, allowed);
  await service.writeFromApp(
    { text: "other" },
    allowed,
  );
  await service.writeFromApp({ text: "three" }, allowed);
  expect(writes).toBe(4);
});

test("clipboard service does not notify and permits retry after a browser failure", async () => {
  let attempts = 0;
  let notifications = 0;
  const service = createClipboardService({
    writeText: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("denied");
    },
    notifyCopied: () => {
      notifications += 1;
    },
  });

  await expect(service.writeFromApp({ text: "retry" }, allowed)).rejects.toThrow(
    "denied",
  );
  await expect(service.writeFromApp({ text: "retry" }, allowed)).resolves.toBeNull();
  expect(notifications).toBe(1);
});

function inertService() {
  return createClipboardService({
    writeText: async () => undefined,
    notifyCopied: () => undefined,
  });
}
