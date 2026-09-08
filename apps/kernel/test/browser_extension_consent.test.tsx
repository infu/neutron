import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserExtensionRequest } from "../src/Requests.tsx";
import { requestConsent, useBrowserExtensionStore } from "../src/browser_extension/consent.ts";
import { resetUiAttentionState, useUiAttentionStore } from "../src/ui_attention/owner.ts";

const grant = {
  id: '["owner","agent","1"]', ownerPrincipal: "owner", appId: "agent",
  installationUid: "1", appName: "Agent", createdAt: 1,
};

afterEach(() => {
  useBrowserExtensionStore.getState().dialog?.reject();
  useBrowserExtensionStore.setState({ dialog: null, grants: [], status: null, error: null });
  resetUiAttentionState();
});

test("first extension access opens the trusted app-named approval dialog and clears it on approval", async () => {
  const pending = requestConsent(grant, "Connect <my provider>", () => true);
  const html = renderToStaticMarkup(<BrowserExtensionRequest request={useBrowserExtensionStore.getState().dialog!} />);
  expect(html).toContain('data-tid="browser-extension-permission-dialog"');
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain("Allow Agent to use the browser extension?");
  expect(html).toContain("Access stays enabled until you revoke it in Settings.");
  expect(html).toContain("Connect &lt;my provider&gt;");
  expect(html).toContain('data-tid="browser-extension-permission-reject"');
  useBrowserExtensionStore.getState().dialog!.approve();
  await pending;
  expect(useBrowserExtensionStore.getState().dialog).toBeNull();
  expect(useUiAttentionStore.getState().active).toBeNull();
});

test("a stale endpoint cannot be approved from an already open extension dialog", async () => {
  let current = true;
  const pending = requestConsent(grant, undefined, () => current);
  current = false;
  useBrowserExtensionStore.getState().dialog!.approve();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useBrowserExtensionStore.getState().dialog).toBeNull();
  expect(useUiAttentionStore.getState().active).toBeNull();
});

test("cancelling the originating call closes its pending extension dialog", async () => {
  const controller = new AbortController();
  const pending = requestConsent(grant, undefined, () => true, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useBrowserExtensionStore.getState().dialog).toBeNull();
  expect(useUiAttentionStore.getState().active).toBeNull();
});
