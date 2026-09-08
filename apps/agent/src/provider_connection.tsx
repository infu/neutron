import { IoOpenOutline, IoRefresh } from "react-icons/io5";
import type { AgentSnapshot } from "./chat_types.ts";

type Provider = "openrouter" | "chatgpt";

export function ProviderConnection({
  snapshot,
  busy,
  onSelectProvider,
  onConnect,
  onCancelLogin,
  onRefresh,
}: {
  snapshot: AgentSnapshot;
  busy: boolean;
  onSelectProvider: (provider: Provider) => void;
  onConnect: () => void;
  onCancelLogin: () => void;
  onRefresh: () => void;
}) {
  const provider = snapshot.provider ?? "openrouter";
  const chatgpt = snapshot.chatgpt;
  const extension = chatgpt?.extension;
  const login = chatgpt?.login;
  const locked = busy || snapshot.generating;
  const needsExtension = !extension?.available || extension.incompatible;

  return (
    <section className="ora-connect" aria-label="Agent connection">
      <div className="ora-provider-tabs" role="group" aria-label="Model provider">
        <button
          type="button"
          aria-pressed={provider === "openrouter"}
          disabled={locked}
          onClick={() => onSelectProvider("openrouter")}
        >
          OpenRouter
        </button>
        <button
          type="button"
          aria-pressed={provider === "chatgpt"}
          disabled={locked}
          onClick={() => onSelectProvider("chatgpt")}
        >
          ChatGPT <span>subscription</span>
        </button>
      </div>

      {provider === "chatgpt" ? (
        <div className="ora-connect-content">
          {login ? (
            <>
              <p>Enter this code on OpenAI’s sign-in page.</p>
              <input
                className="ora-device-code"
                aria-label="OpenAI verification code"
                value={login.userCode}
                readOnly
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
              <a
                className="nt-button nt-button--primary"
                href={login.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open OpenAI <IoOpenOutline aria-hidden="true" />
              </a>
              <div className="ora-connect-actions">
                <span className="ora-connect-waiting" role="status">
                  <span className="ora-spinner" aria-hidden="true" />
                  Waiting for sign-in
                </span>
                <button type="button" disabled={busy} onClick={onCancelLogin}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div className="ora-extension-state" role="status">
                <span className={needsExtension ? "" : "is-available"} aria-hidden="true" />
                {extension?.incompatible
                  ? "Update the Neutron extension"
                  : !extension?.available
                    ? "Neutron extension needed"
                    : !extension.paired
                      ? "Neutron extension ready to pair"
                      : !extension.granted
                        ? "Allow Agent to use the extension"
                        : "Neutron extension connected"}
              </div>
              {needsExtension && (
                <div className="ora-connect-actions">
                  <a
                    href="https://github.com/infu/neutron/tree/main/support/extension#readme"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Extension setup <IoOpenOutline aria-hidden="true" />
                  </a>
                  <button type="button" disabled={busy} onClick={onRefresh}>
                    <IoRefresh aria-hidden="true" /> Check again
                  </button>
                </div>
              )}
              <button
                type="button"
                className="nt-button nt-button--primary"
                disabled={locked || Boolean(extension?.incompatible)}
                onClick={onConnect}
              >
                {busy ? "Connecting…" : "Connect ChatGPT"}
              </button>
              <p>Use your ChatGPT subscription. Sign in with a code on OpenAI’s website.</p>
            </>
          )}
        </div>
      ) : (
        <div className="ora-connect-content">
          <button
            type="button"
            className="nt-button nt-button--primary"
            disabled={locked}
            onClick={onConnect}
          >
            {busy ? "Connecting…" : "Connect to OpenRouter"}
          </button>
          <p>
            Prompts and selected tool results are sent to OpenRouter and its
            downstream model provider.
          </p>
        </div>
      )}
      {snapshot.error && <div className="ora-error" role="status">{snapshot.error}</div>}
    </section>
  );
}
