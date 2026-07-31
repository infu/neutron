import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  captureRepositorySetupFragment,
  serializeInternalSetupFragment,
} from "neutron-tools/repository";
import { kernelCaptureFailure, kernelSetupStorage } from "../src/bootstrap.ts";

test("kernel captures the internal handoff before importing auth or React", async () => {
  const [bootstrap, entry, build, html] =
    await Promise.all([
      readFile(new URL("../src/bootstrap.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/index.tsx", import.meta.url), "utf8"),
      readFile(new URL("../build.ts", import.meta.url), "utf8"),
      readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    ]);

  expect(entry).not.toMatch(/from ["'].+main/);
  expect(entry).not.toMatch(/from ["'].+playwright_auth/);
  expect(bootstrap.indexOf("captureCurrentHandoff()"))
    .toBeLessThan(bootstrap.indexOf("startApplication()"));
  expect(bootstrap).toContain("window.dispatchEvent");
  expect(bootstrap).toContain("window.location.reload()");
  expect(bootstrap).toContain("captureKernelHandoff");
  expect(bootstrap).toContain("clearPendingActivation");
  expect(bootstrap).toContain("await loadRuntimeDeployment()");
  expect(bootstrap.indexOf("await loadRuntimeDeployment()"))
    .toBeLessThan(bootstrap.indexOf('await import("./playwright_auth.ts")'));
  expect(bootstrap).toContain('await import("./playwright_auth.ts")');
  expect(bootstrap).toContain('await import("./main.tsx")');
  expect(bootstrap).toContain("volatileSetupStorage.set(key, value)");
  expect(bootstrap.indexOf("volatileSetupStorage.set(key, value)"))
    .toBeLessThan(bootstrap.indexOf("window.sessionStorage.setItem(key, value)"));
  expect(build).toContain("splitting: true");
  expect(build).toContain('chunkNames: "chunks/[name]-[hash]"');
  expect(build).toContain('main: "./src/index.tsx"');
  expect(build).not.toContain("process.env.LOCAL");
  expect(build).not.toContain("process.env.ICP_LOCAL_HOST");
  expect(html).toContain('<meta name="referrer" content="no-referrer" />');
});

test("kernel setup storage reports session denial after retaining a volatile copy", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
        removeItem: () => undefined,
      },
    },
  });

  try {
    expect(() => kernelSetupStorage.setItem("denied-test", "retained"))
      .toThrow("denied");
    expect(kernelSetupStorage.getItem("denied-test")).toBe("retained");
  } finally {
    kernelSetupStorage.removeItem("denied-test");
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("kernel stops when a captured setup handoff cannot be stripped", () => {
  const fragment = serializeInternalSetupFragment({
    repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    manifest: "demo",
    digest: "a".repeat(64),
  });
  const values = new Map<string, string>();
  const result = captureRepositorySetupFragment({
    mode: "internal",
    location: {
      href: `https://neutron.invalid/${fragment}`,
      hash: fragment,
    },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    history: {
      replaceState() {
        throw new DOMException("denied", "SecurityError");
      },
    },
  });

  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error("capture failed");
  expect(result.stripped).toBe(false);
  expect(kernelCaptureFailure(result)).toMatch(/could not remove.*address bar/i);
});

test("kernel ignores a malformed setup fragment after stripping it", () => {
  const result = captureRepositorySetupFragment({
    mode: "internal",
    location: {
      href: "https://neutron.invalid/#repo=malformed",
      hash: "#repo=malformed",
    },
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    history: {
      replaceState: () => undefined,
    },
  });

  expect(result.status).toBe("invalid");
  if (result.status !== "invalid") throw new Error("expected invalid handoff");
  expect(result.stripped).toBe(true);
  expect(kernelCaptureFailure(result)).toBeNull();
});

test("kernel fails closed when stale handoff retirement fails", () => {
  expect(
    kernelCaptureFailure({
      status: "invalid",
      error: new Error("invalid") as never,
      cleanUrl: "https://neutron.invalid/",
      stripped: true,
      retireError: new Error("denied"),
    }),
  ).toMatch(/could not retire.*previous temporary setup/i);
});
