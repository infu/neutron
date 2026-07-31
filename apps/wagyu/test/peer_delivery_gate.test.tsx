import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PeerDeliveryGate } from "../src/app/components/PeerDeliveryGate.tsx";

test("missing peer delivery presents one owner approval action", () => {
  const html = renderToStaticMarkup(
    <PeerDeliveryGate busy={false} error={null} onEnable={() => undefined} />,
  );

  expect(html).toContain("Permission needed");
  expect(html).toContain("Enable peer delivery");
  expect(html).toContain("other Neutrons");
  expect(html).not.toContain("disabled");
  expect(html).not.toContain('role="alert"');
});

test("peer delivery approval reports its pending and failed states", () => {
  const pending = renderToStaticMarkup(
    <PeerDeliveryGate busy error={null} onEnable={() => undefined} />,
  );
  const failed = renderToStaticMarkup(
    <PeerDeliveryGate
      busy={false}
      error="Permission was not approved."
      onEnable={() => undefined}
    />,
  );

  expect(pending).toContain("disabled");
  expect(pending).toContain("Waiting for approval…");
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Permission was not approved.");
});
