import { expect, test } from "bun:test";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DeploymentModuleHashDetail,
  DeploymentModuleHashError,
} from "../src/settings/DeploymentIntegrityDetails.tsx";

const HASH = "ab".repeat(32);

test("Runtime module-hash detail renders the complete hash and copy control", () => {
  const html = renderToStaticMarkup(
    <dl>
      <DeploymentModuleHashDetail hash={HASH} />
    </dl>,
  );

  expect(html).toContain('data-tid="settings-installed-module-hash"');
  expect(html).toContain("Installed canister Wasm SHA-256");
  expect(html).toContain(`title="${HASH}"`);
  expect(html).toContain(HASH);
  expect(html).toContain('aria-label="Copy installed canister Wasm SHA-256"');
});

test("Runtime module-hash failure is an alert with a working retry", () => {
  let retries = 0;
  const view = DeploymentModuleHashError({
    message: "certificate is stale",
    onRetry: () => {
      retries += 1;
    },
  });
  const html = renderToStaticMarkup(view);

  expect(html).toContain('role="alert"');
  expect(html).toContain("Installed module hash is unavailable");
  expect(html).toContain("certificate is stale");
  expect(html).toContain('aria-label="Retry installed module hash"');

  const controls = Children.toArray(view.props.children);
  const retry = controls[1] as ReactElement<{ onClick: () => void }>;
  retry.props.onClick();
  expect(retries).toBe(1);
});
