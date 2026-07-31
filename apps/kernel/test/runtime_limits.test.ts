import { expect, test } from "bun:test";
import {
  CONNECTIONS_MAX_PROVIDERS_GLOBAL,
  CONNECTIONS_MAX_PROVIDERS_PER_APP,
  CONNECTIONS_MAX_RESIDENT_BACKGROUNDS,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  assertAppSurfaceInventoryCapacity,
  assertTargetAppSurfaceCapacity,
  MAX_INSTALLED_APP_INSTANCES,
  MAX_RESIDENT_APP_FRAMES,
} from "../src/runtime_limits.ts";

test("Connections capacity is derived from the resident-frame envelope", () => {
  expect(CONNECTIONS_MAX_RESIDENT_BACKGROUNDS).toBe(MAX_RESIDENT_APP_FRAMES);
  expect(CONNECTIONS_MAX_PROVIDERS_GLOBAL).toBe(
    MAX_RESIDENT_APP_FRAMES * CONNECTIONS_MAX_PROVIDERS_PER_APP,
  );
});

test("hundreds of headless apps fit the frontend runtime envelope", () => {
  const apps = inventory(200, 0);
  expect(() => assertAppSurfaceInventoryCapacity(apps)).not.toThrow();
});

test("installed-app and resident-frame ceilings have exact boundaries", () => {
  expect(() =>
    assertAppSurfaceInventoryCapacity(
      inventory(MAX_INSTALLED_APP_INSTANCES, 0),
    ),
  ).not.toThrow();
  expect(() =>
    assertAppSurfaceInventoryCapacity(
      inventory(MAX_INSTALLED_APP_INSTANCES + 1, 0),
    ),
  ).toThrow(`maximum is ${MAX_INSTALLED_APP_INSTANCES} including Kernel`);

  expect(() =>
    assertAppSurfaceInventoryCapacity(
      inventory(MAX_RESIDENT_APP_FRAMES, MAX_RESIDENT_APP_FRAMES),
    ),
  ).not.toThrow();
  expect(() =>
    assertAppSurfaceInventoryCapacity(
      inventory(MAX_RESIDENT_APP_FRAMES + 1, MAX_RESIDENT_APP_FRAMES + 1),
    ),
  ).toThrow(`maximum is ${MAX_RESIDENT_APP_FRAMES}`);
});

test("install preflight counts replacements against the complete target", () => {
  const existing = inventory(80, MAX_RESIDENT_APP_FRAMES);

  expect(() =>
    assertTargetAppSurfaceCapacity(existing, [
      { id: "app_000" },
    ]),
  ).not.toThrow();
  expect(() =>
    assertTargetAppSurfaceCapacity(existing, [
      { id: "new_resident", background: { path: "service.html" } },
    ]),
  ).toThrow(`maximum is ${MAX_RESIDENT_APP_FRAMES}`);
  expect(() =>
    assertTargetAppSurfaceCapacity(existing, [
      { id: "duplicate" },
      { id: "duplicate" },
    ]),
  ).toThrow("invalid or repeated");
});

function inventory(
  appCount: number,
  residentCount: number,
): Record<string, { background?: { path: string } }> {
  return Object.fromEntries(
    Array.from({ length: appCount }, (_, index) => [
      `app_${index.toString().padStart(3, "0")}`,
      index < residentCount
        ? { background: { path: "service.html" } }
        : {},
    ]),
  );
}
