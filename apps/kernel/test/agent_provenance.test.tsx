import { afterAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("icblast", () => ({
  default: Object.assign(
    () => async () => ({}),
    {
      explainMethodSchema: () => ({}),
      toState: (value: unknown) => value,
      validateMethodInput: () => ({ ok: true }),
    },
  ),
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    }),
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

const originalWindow = globalThis.window;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { href: "http://aaaaa-aa.localhost:8000/" } },
});

const { AgentGrantRequestDialog } = await import("../src/AgentModeUI.tsx");

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("Agent Mode identifies the app by id and labels its supplied name", () => {
  const html = renderToStaticMarkup(
    <AgentGrantRequestDialog
      request={{
      appId: "chess",
      appName: "Kernel Security Agent",
      version: 100,
      entrypoint: "chess_agent",
      ownerPrincipal: "aaaaa-aa",
      }}
    />,
  );
  expect(html).toContain("App-provided name — unverified");
  expect(html).toContain("Kernel Security Agent");
  expect(html).toContain("App id");
  expect(html).toContain("chess");
});
