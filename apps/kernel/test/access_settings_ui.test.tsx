import fs from "node:fs/promises";
import { createRef } from "react";
import { expect, mock, test } from "bun:test";
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
    getIdentity: () => undefined,
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

const { AccessGroup, ControllerAdditionDialog } = await import(
  "../src/settings/AccessSettings.tsx"
);

const SELF = "aaaaa-aa";
const EXTERNAL =
  "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";

test("controller addition is explicit, default-cancel, and warns about equal authority", async () => {
  const html = renderToStaticMarkup(
    <ControllerAdditionDialog
      onCancel={() => undefined}
      onConfirm={() => undefined}
      principal={EXTERNAL}
    />,
  );

  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain(EXTERNAL);
  expect(html).toContain("equal IC controller");
  expect(html).toContain("replace all installed Wasm");
  expect(html).toContain("change canister settings");
  expect(html).toContain("stop or delete the canister");
  expect(html).toContain("remove your authority");
  expect(html).toContain("Kernel permissions cannot restrict");
  expect(html).toContain('data-tid="settings-access-controller-add-cancel"');
  expect(html).toContain('data-tid="settings-access-controller-add-confirm"');
  expect(html).not.toContain('type="checkbox"');
  expect(
    html.indexOf('data-tid="settings-access-controller-add-cancel"'),
  ).toBeLessThan(
    html.indexOf('data-tid="settings-access-controller-add-confirm"'),
  );

  const source = await fs.readFile(
    new URL("../src/settings/AccessSettings.tsx", import.meta.url),
    "utf8",
  );
  const reviewGate = source.indexOf(
    'if (kind === "controller" && !controllerRiskConfirmed)',
  );
  const mutation = source.indexOf('setOperation(`${kind}-add`)');
  expect(reviewGate).toBeGreaterThan(-1);
  expect(mutation).toBeGreaterThan(reviewGate);
  expect(source.slice(reviewGate, mutation)).toContain(
    "setPendingControllerAddition(principalText)",
  );
  expect(source.slice(reviewGate, mutation)).toContain("return;");
  expect(source).toContain('addPrincipal("controller", principal, true)');
  expect(source).toMatch(
    /function ControllerAdditionDialog[\s\S]*?cancelRef\.current\?\.focus\(\)[\s\S]*?confirmationKeyDown/,
  );
});

test("controller list visibly identifies and explains the protected Self-Controller", () => {
  const html = renderToStaticMarkup(
    <AccessGroup
      busy={false}
      description="Equal platform control"
      error={null}
      guidance={
        <>
          <strong>Self-Controller:</strong> required for checked in-product
          upgrades. Add an external principal you control for independent
          platform management.
        </>
      }
      icon={<span aria-hidden="true" />}
      input=""
      inputRef={createRef<HTMLInputElement>()}
      kind="controller"
      limit={10n}
      onAdd={(event) => event.preventDefault()}
      onInput={() => undefined}
      onRemove={() => undefined}
      principals={[SELF, EXTERNAL]}
      protectedLabel="Self-Controller"
      protectedPrincipal={SELF}
      protectedTitle="Neutron must remain a controller of itself"
      title="Controllers"
    />,
  );

  expect(html).toContain("Self-Controller:");
  expect(html).toContain("checked in-product upgrades");
  expect(html).toContain("external principal you control");
  expect(html).toContain("(Self-Controller)");
  expect(html).toContain("Neutron must remain a controller of itself");
  expect(html).not.toContain(`aria-label="Remove ${SELF}"`);
  expect(html).toContain(`aria-label="Remove ${EXTERNAL}"`);
});
