import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionDisclosure } from "../src/AppDialogs.tsx";

test("canister principal disclosure promises a scalar, not actor authority", () => {
  const html = renderToStaticMarkup(
    createElement(PermissionDisclosure, {
      permission: {
        source: "kernel",
        kind: "function_resources",
        method: "bind",
        mode: "update",
        resources: [{ kind: "canister_principal" }],
      },
    }),
  );

  expect(html).toContain("Backend function resources");
  expect(html).toContain("canister_principal");
  expect(html).not.toContain("privileged access");
});
