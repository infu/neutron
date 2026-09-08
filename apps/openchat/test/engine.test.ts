import { expect, test } from "bun:test";
import { OpenChatEngine } from "../src/engine/engine.ts";

// Regression for the "back at the sign-in screen after idle" bug: whoami must
// await the session restore and never wedge. With no stored session it should
// resolve to a stable logged-out (not throw, not hang).
test("whenReady resolves and whoami is stable with no stored session", async () => {
  const engine = new OpenChatEngine({ publish() {} });
  expect(engine.whoami().status).toBe("logged_out");
  await engine.whenReady();
  expect(engine.whoami().status).toBe("logged_out");
  // Idempotent: a second whenReady (as the visibility re-check triggers) is fine.
  await engine.whenReady();
  expect(engine.whoami().status).toBe("logged_out");
});
