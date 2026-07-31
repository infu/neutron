import { expect, test } from "bun:test";
import { bindMailInactivityCleanup } from "../src/mail_inactivity.ts";

test("worker deadline and binding changes clear resident plaintext projections", () => {
  let listener: (() => void) | null = null;
  let bindingListener: (() => void) | null = null;
  let privateClears = 0;
  let agentClears = 0;
  let rotationResets = 0;
  const unbind = bindMailInactivityCleanup({
    worker: {
      onInactivityLock(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    session: {
      onBindingChange(next) {
        bindingListener = next;
        return () => { bindingListener = null; };
      },
    },
    privateProjections: [
      { clear: () => { privateClears += 1; } },
      { clear: () => { agentClears += 1; } },
    ],
    rotation: { reset: () => { rotationResets += 1; } },
  });

  (listener as (() => void) | null)!();
  expect({ privateClears, agentClears, rotationResets }).toEqual({
    privateClears: 1,
    agentClears: 1,
    rotationResets: 1,
  });
  (bindingListener as (() => void) | null)!();
  expect({ privateClears, agentClears, rotationResets }).toEqual({
    privateClears: 2,
    agentClears: 2,
    rotationResets: 2,
  });
  unbind();
  expect(listener).toBeNull();
  expect(bindingListener).toBeNull();
});
