import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InstallOfferDialogView,
  safeInstallOfferUrl,
} from "../src/install_offers/InstallOfferDialog.tsx";
import {
  clearInstallOffer,
  requestInstallOffer,
} from "../src/install_offers/service.ts";
import { useInstallOfferStore } from "../src/install_offers/store.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";

beforeEach(() => {
  clearInstallOffer("test reset");
  resetUiAttentionState();
});

afterEach(() => {
  clearInstallOffer("test cleanup");
  resetUiAttentionState();
});

test("package dialog attributes the app and never renders URL secrets", () => {
  requestInstallOffer({
    offer: {
      kind: "package_url",
      url:
        "https://downloads.example/apps/mail.neutron" +
        "?token=secret-value&campaign=hidden#private-fragment",
    },
    requester: {
      kind: "app",
      appId: "mail",
      appName: "Neutron Mail",
      surface: "tray",
    },
    assertCurrent: () => true,
    onApprove: () => undefined,
  });

  const html = renderToStaticMarkup(
    <InstallOfferDialogView
      pending={useInstallOfferStore.getState().pending}
    />,
  );
  expect(html).toContain("Neutron Mail");
  expect(html).toContain("mail");
  expect(html).toContain("Application tray");
  expect(html).toContain("https://downloads.example/apps/mail.neutron");
  expect(html).toContain("Neutron has not contacted this source yet");
  expect(html).not.toContain("secret-value");
  expect(html).not.toContain("campaign");
  expect(html).not.toContain("private-fragment");
});

test("repository dialog shows normalized group identity and agent source", () => {
  requestInstallOffer({
    offer: {
      kind: "repository_setup_url",
      url:
        "https://apps.example/install?affiliate=private" +
        "#repo=aaaaa-aa&manifest=friends&digest=" +
        "b".repeat(64),
      reference: {
        repo: "aaaaa-aa",
        manifest: "friends",
        digest: "b".repeat(64),
      },
    },
    requester: {
      kind: "agent",
      appId: "catalog",
      appName: "App Catalog",
      rootAppId: "assistant",
      rootAppName: "Assistant",
      entrypoint: "research",
      tool: "offer_group",
      rootId: "agent-root-4",
    },
    assertCurrent: () => true,
    onApprove: () => undefined,
  });

  const html = renderToStaticMarkup(
    <InstallOfferDialogView
      pending={useInstallOfferStore.getState().pending}
    />,
  );
  expect(html).toContain("Application group");
  expect(html).toContain("Agent tool");
  expect(html).toContain("Assistant");
  expect(html).toContain("assistant");
  expect(html).toContain("research");
  expect(html).toContain("App Catalog");
  expect(html).toContain("catalog");
  expect(html).toContain("offer_group");
  expect(html).toContain("agent-root-4");
  expect(html).toContain("aaaaa-aa");
  expect(html).toContain("friends");
  expect(html).toContain("b".repeat(64));
  expect(html).not.toContain("affiliate");
  expect(html).not.toContain("private");
});

test("safe URL display contains only origin and path", () => {
  expect(
    safeInstallOfferUrl(
      "https://packages.example:8443/path/app.neutron?access=secret#fragment",
    ),
  ).toBe("https://packages.example:8443/path/app.neutron");
  expect(safeInstallOfferUrl("not a url")).toBe("Invalid source URL");
});

test("install offers keep exact provenance optional normally and open it for developers", () => {
  requestInstallOffer({
    offer: {
      kind: "package_url",
      url: "https://downloads.example/apps/mail.neutron",
    },
    requester: {
      kind: "app",
      appId: "mail",
      appName: "Neutron Mail",
      surface: "tile",
    },
    assertCurrent: () => true,
    onApprove: () => undefined,
  });
  const pending = useInstallOfferStore.getState().pending;
  const normal = renderToStaticMarkup(
    <InstallOfferDialogView pending={pending} uiMode="normal" />,
  );
  const developer = renderToStaticMarkup(
    <InstallOfferDialogView pending={pending} uiMode="developer" />,
  );

  expect(consentDetailsTag(normal)).not.toContain(" open");
  expect(consentDetailsTag(developer)).toContain('open=""');
  expect(normal).toContain("Review does not install anything");
  expect(normal).toContain("separate final review");
  expect(normal).toContain("has not verified its publisher");
});

function consentDetailsTag(html: string): string {
  const match = html.match(
    /<details(?=[^>]*data-tid="consent-technical-details")[^>]*>/u,
  );
  if (!match) throw new Error("Missing consent technical details");
  return match[0];
}
