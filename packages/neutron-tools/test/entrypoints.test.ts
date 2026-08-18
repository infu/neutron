import { expect, test } from "bun:test";

test("protocol and kernel entrypoints install no browser listener", async () => {
  const originalWindow = globalThis.window;
  let listeners = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener() {
        listeners += 1;
      },
    },
  });
  try {
    await import(
      new URL("../src/tools.ts?root-purity-test", import.meta.url).href
    );
    await import(
      new URL("../src/protocol.ts?protocol-purity-test", import.meta.url).href
    );
    await import(
      new URL("../src/kernel.ts?kernel-purity-test", import.meta.url).href
    );
    expect(listeners).toBe(0);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("package exposes explicit protocol, app, kernel, and record roles", async () => {
  const manifest = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  expect(manifest.exports).toMatchObject({
    ".": "./src/tools.ts",
    "./protocol": "./src/protocol.ts",
    "./app": "./src/app_entry.ts",
    "./kernel": "./src/kernel.ts",
    "./package_record": "./src/package_record.ts",
    "./package_record.js": "./src/package_record.ts",
  });
});
