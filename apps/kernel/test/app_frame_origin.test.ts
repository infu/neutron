import { expect, test } from "bun:test";
import {
  usesUnprefixedAppFrameOrigin,
} from "../src/capabilities/plan.ts";
import { registryApp } from "./app_registry_fixture.ts";

test("dedicated resident backgrounds keep tile and tray frames off the reserved app host", () => {
  expect(
    usesUnprefixedAppFrameOrigin(
      registryApp({ id: "hello", name: "Hello" }),
    ),
  ).toBe(false);

  expect(
    usesUnprefixedAppFrameOrigin(
      registryApp({
        id: "files",
        name: "Files",
        background: { path: "service.html" },
        capabilities: {
          dedicated_resident_origin: {
            api: 1,
            surface: "background",
            mode: "credentialless_ephemeral_v1",
          },
        },
      }),
    ),
  ).toBe(true);

  expect(
    usesUnprefixedAppFrameOrigin(
      registryApp({
        id: "mail",
        name: "Mail",
        background: { path: "service.html" },
        capabilities: {
          persistent_browser_storage: {
            api: 1,
            surface: "background",
          },
        },
      }),
    ),
  ).toBe(true);
});
