import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  KITCHEN_GUIDE_IDS,
  PageGuide,
} from "../src/page_guides.tsx";

test("every Kitchen Sink workbench route has a complete implementation guide", () => {
  expect(KITCHEN_GUIDE_IDS).toHaveLength(25);
  expect(new Set(KITCHEN_GUIDE_IDS).size).toBe(KITCHEN_GUIDE_IDS.length);

  for (const id of KITCHEN_GUIDE_IDS) {
    const html = renderToStaticMarkup(<PageGuide id={id} />);
    expect(html).toContain(`data-tid="kitchen-guide-${id}"`);
    expect(html).toContain("Why use it");
    expect(html).toContain("What really happens");
    expect(html.match(/<li>/gu)).toHaveLength(3);
    expect(html).toContain("Kernel enforces");
    expect(html).toContain("Authority limit");
    expect(html).toContain("Who can see it");
    expect(html).toContain("ks-code-example");
    expect(html).toContain("ks-code-");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  }
});

test("the guide covers critical truth-in-labeling boundaries", () => {
  const stableStore = renderToStaticMarkup(<PageGuide id="stable_store" />);
  const chainKey = renderToStaticMarkup(<PageGuide id="chain_key_signing" />);
  const vetKeys = renderToStaticMarkup(<PageGuide id="vetkeys" />);
  const routes = renderToStaticMarkup(<PageGuide id="certified_reads" />);
  const denseData = renderToStaticMarkup(<PageGuide id="data" />);
  const walletFunding = renderToStaticMarkup(<PageGuide id="wallet_funding" />);

  expect(stableStore).toContain("plaintext to subnet replicas");
  expect(chainKey).toContain("provenance, not truth or human approval");
  expect(vetKeys).toContain("compromised browser");
  expect(routes).toContain("public plaintext");
  expect(routes).toContain("does not prove the content is true");
  expect(denseData).toContain("inert examples");
  expect(walletFunding).toContain("cannot spend Neutrinite governance&#x27;s allowance");
  expect(walletFunding).toContain("does not interpret ICP amounts");
});
