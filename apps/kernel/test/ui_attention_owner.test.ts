import { beforeEach, expect, test } from "bun:test";
import {
  admitOwnerAttention,
  finishOwnerAttention,
  pauseAppAttention,
  resetUiAttentionState,
} from "../src/ui_attention/owner.ts";

beforeEach(() => resetUiAttentionState());

test("owner attention has one active request but no elapsed-time quota", () => {
  for (let index = 0; index < 40; index += 1) {
    const token = admitOwnerAttention("mail", "frontend_tool");
    expect(() =>
      admitOwnerAttention("contacts", "frontend_tool"),
    ).toThrow("Another app request is active");
    finishOwnerAttention(token);
  }
});

test("explicit app pauses remain enforced independently of admission counts", () => {
  pauseAppAttention("mail", 10_000);
  expect(() => admitOwnerAttention("mail", "frontend_tool")).toThrow(
    "App requests are paused",
  );
  const token = admitOwnerAttention("contacts", "frontend_tool");
  finishOwnerAttention(token);
});
