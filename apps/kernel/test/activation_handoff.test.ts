import { expect, test } from "bun:test";
import {
  captureKernelHandoff,
  decodeActivationToken,
  takePendingActivation,
} from "../src/activation_handoff.ts";
import {
  readPendingRepositorySetup,
  type RepositoryStorage,
} from "neutron-tools/repository";

const token = encode(
  Uint8Array.from({ length: 32 }, (_, index) => index),
);

class MemoryStorage implements RepositoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("captures, strips, and takes an activation-only handoff once", () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  const captured = captureKernelHandoff({
    location: {
      href: `https://neutron.invalid/#activate=${token}`,
      hash: `#activate=${token}`,
    },
    storage,
    history: {
      replaceState(_data, _unused, url) {
        calls.push(String(url));
      },
    },
  });

  expect(captured.activationCaptured).toBe(true);
  expect(captured.result.status).toBe("activation_captured");
  expect(calls).toEqual(["https://neutron.invalid/"]);
  expect(takePendingActivation(storage)).toEqual(decodeActivationToken(token));
  expect(takePendingActivation(storage)).toBeNull();
});

test("captures repository setup and activation from one fragment", () => {
  const storage = new MemoryStorage();
  const digest = "a".repeat(64);
  const fragment =
    `#repo=rrkah-fqaaa-aaaaa-aaaaq-cai&manifest=demo&digest=${digest}` +
    `&activate=${token}`;
  const captured = captureKernelHandoff({
    location: {
      href: `https://neutron.invalid/${fragment}`,
      hash: fragment,
    },
    storage,
    history: { replaceState: () => undefined },
  });

  expect(captured.activationCaptured).toBe(true);
  expect(captured.result.status).toBe("captured");
  expect(readPendingRepositorySetup(storage)?.reference).toEqual({
    repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    manifest: "demo",
    digest,
  });
  expect(takePendingActivation(storage)).toEqual(decodeActivationToken(token));
});

test("does not retain an activation when address-bar stripping fails", () => {
  const storage = new MemoryStorage();
  const captured = captureKernelHandoff({
    location: {
      href: `https://neutron.invalid/#activate=${token}`,
      hash: `#activate=${token}`,
    },
    storage,
    history: {
      replaceState() {
        throw new DOMException("denied", "SecurityError");
      },
    },
  });

  expect(captured.activationCaptured).toBe(false);
  expect(captured.result.status).toBe("activation_invalid");
  expect(takePendingActivation(storage)).toBeNull();
});

test("rejects malformed, duplicate, and query-shaped activation fields", () => {
  for (const fragment of [
    "#activate=bad",
    `#activate=${token}&activate=${token}`,
    `#Activate=${token}`,
    `#activate=${token}&unknown=x`,
  ]) {
    const captured = captureKernelHandoff({
      location: {
        href: `https://neutron.invalid/${fragment}`,
        hash: fragment,
      },
      storage: new MemoryStorage(),
      history: { replaceState: () => undefined },
    });
    expect(captured.activationCaptured).toBe(false);
    expect(captured.result.status).toBe("activation_invalid");
  }
});

test("removes query-string handoffs without retaining their secrets", () => {
  const storage = new MemoryStorage();
  const calls: string[] = [];
  const captured = captureKernelHandoff({
    location: {
      href:
        `https://neutron.invalid/?keep=yes&activate=${token}` +
        `#activate=${token}`,
      hash: `#activate=${token}`,
    },
    storage,
    history: {
      replaceState(_data, _unused, url) {
        calls.push(String(url));
      },
    },
  });

  expect(captured.activationCaptured).toBe(false);
  expect(captured.result.status).toBe("activation_invalid");
  expect(calls).toEqual(["https://neutron.invalid/?keep=yes"]);
  expect(takePendingActivation(storage)).toBeNull();
});

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
