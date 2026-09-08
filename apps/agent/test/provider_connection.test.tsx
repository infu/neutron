import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSnapshot } from "../src/chat_types.ts";
import { ProviderConnection } from "../src/provider_connection.tsx";

const initial: AgentSnapshot = {
  ready: true,
  connected: false,
  provider: "chatgpt",
  webToolsAvailable: false,
  selectedModelId: null,
  models: [],
  modelsLoading: false,
  generating: false,
  generatingHere: false,
  conversationRevision: null,
  hiddenMessageCount: 0,
  messages: [],
  error: null,
  chatgpt: { extension: null, connected: false, login: null },
};

function render(snapshot: AgentSnapshot): string {
  return renderToStaticMarkup(
    <ProviderConnection
      snapshot={snapshot}
      busy={false}
      onSelectProvider={() => {}}
      onConnect={() => {}}
      onCancelLogin={() => {}}
      onRefresh={() => {}}
    />,
  );
}

test("ChatGPT connection explains missing extension and keeps other providers available", () => {
  const html = render(initial);
  expect(html).toContain("Neutron extension needed");
  expect(html).toContain("support/extension#readme");
  expect(html).toContain("Check again");
  expect(html).toContain("OpenRouter");
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain("chromewebstore");
});

test("existing pairing and permission produce a direct ChatGPT connection action", () => {
  const html = render({
    ...initial,
    chatgpt: {
      connected: false,
      extension: { available: true, paired: true, granted: true },
      login: null,
    },
  });
  expect(html).toContain("Neutron extension connected");
  expect(html).toContain("Connect ChatGPT");
  expect(html).not.toContain("Extension setup");
});

test("pending device sign-in displays code, isolated external link and cancellation", () => {
  const html = render({
    ...initial,
    chatgpt: {
      connected: false,
      extension: { available: true, paired: true, granted: true },
      login: {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt: Date.now() + 300_000,
      },
    },
  });
  expect(html).toContain('value="ABCD-EFGH"');
  expect(html).toContain('aria-label="OpenAI verification code"');
  expect(html).toContain('href="https://auth.openai.com/codex/device"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Waiting for sign-in");
  expect(html).toContain("Cancel");
  expect(html).not.toContain("Connect ChatGPT");
});

test("busy Agent cannot switch providers from a disconnected tile", () => {
  const html = render({ ...initial, generating: true });
  expect(html).toContain('aria-pressed="false" disabled=""');
  expect(html).toContain('aria-pressed="true" disabled=""');
});

test("OpenRouter remains available without extension and connection failures stay visible", () => {
  const html = render({ ...initial, provider: "openrouter", error: "Sign-in was cancelled" });
  expect(html).toContain("Connect to OpenRouter");
  expect(html).toContain("Sign-in was cancelled");
  expect(html).not.toContain("Neutron extension needed");
});
