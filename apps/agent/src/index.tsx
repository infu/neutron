import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  IoArrowDown,
  IoArrowUp,
  IoLink,
  IoSparklesOutline,
  IoStop,
} from "react-icons/io5";
import {
  createMsgBusClient,
  disableAgentMode,
  getAgentModeStatus,
  isJsonObject,
  onAppStateChange,
  requestAgentMode,
  type AgentModeStatus,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import type {
  AgentProgress,
  AgentSnapshot,
  AgentToolActivity,
  TranscriptMessage,
} from "./chat_types.ts";
import {
  applyToolProgress,
  applyTranscriptProgress,
} from "./chat_progress.ts";
import {
  beginAgentDevelopmentRun,
  completeAgentDevelopmentRun,
  failAgentDevelopmentRun,
  installAgentDevelopmentApi,
  recordAgentDevelopmentProgress,
} from "./development.ts";
import { ModelPicker } from "./model_picker.tsx";
import { ToolbarMenu } from "./toolbar_menu.tsx";
import "./style.scss";

const TARGET = "app:agent:background" as MsgBusEndpointId;
const STATE_TOPIC = "agent";
const bus = createMsgBusClient();

function App() {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [activeTool, setActiveTool] = useState<AgentToolActivity | null>(null);
  const [agentMode, setAgentMode] = useState<AgentModeStatus | null>(null);
  const [followBottom, setFollowBottom] = useState(true);
  const historyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const snapshotRef = useRef(snapshot);
  const draftRef = useRef(draft);
  const activeToolRef = useRef(activeTool);
  const chatPendingRef = useRef(chatPending);
  snapshotRef.current = snapshot;
  draftRef.current = draft;
  activeToolRef.current = activeTool;
  chatPendingRef.current = chatPending;

  const readStatus = useCallback(async () => {
    const [value, mode] = await Promise.all([
      bus.callTool({
        target: TARGET,
        name: "agent_status",
        arguments: {},
      }),
      getAgentModeStatus(),
    ]);
    setSnapshot(asSnapshot(value));
    setAgentMode(mode);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      while (!cancelled) {
        try {
          const value = await bus.callTool(
            { target: TARGET, name: "agent_status", arguments: {} },
            10
          );
          const mode = await getAgentModeStatus().catch(() => null);
          if (!cancelled) {
            setSnapshot(asSnapshot(value));
            if (mode) setAgentMode(mode);
          }
          return;
        } catch {
          await delay(350);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => onAppStateChange(STATE_TOPIC, () => void readStatus().catch(() => undefined)),
    [readStatus],
  );

  useEffect(
    () =>
      installAgentDevelopmentApi({
        prepare(text) {
          draftRef.current = text;
          setDraft(text);
          setFollowBottom(true);
        },
        inspect() {
          return {
            snapshot: snapshotRef.current,
            draft: draftRef.current,
            activeTool: activeToolRef.current,
            chatPending: chatPendingRef.current,
          };
        },
      }),
    [],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    if (!followBottom) return;
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
  }, [snapshot?.messages, activeTool, followBottom]);

  const run = async (
    name: string,
    arguments_: Record<string, JsonValue> = {},
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await bus.callTool({
        target: TARGET,
        name,
        arguments: arguments_,
      });
      setSnapshot(asSnapshot(result));
      return true;
    } catch (error) {
      setSnapshot((current) =>
        current
          ? { ...current, error: safeError(error), generating: false }
          : current
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (
      !text ||
      !snapshot?.connected ||
      !snapshot.selectedModelId ||
      snapshot.generating ||
      chatPending
    ) {
      return;
    }
    setDraft("");
    setFollowBottom(true);
    setChatPending(true);
    setActiveTool(null);
    const developmentRunId = beginAgentDevelopmentRun(text);
    try {
      const result = await bus.callTool(
        {
          target: TARGET,
          name: "agent_chat",
          arguments: { text },
        },
        {
          timeout: 15 * 60,
          onProgress: (value) => {
            const progress = asProgress(value);
            if (!progress) return;
            recordAgentDevelopmentProgress(developmentRunId, progress);
            setSnapshot((current) =>
              applyTranscriptProgress(current, progress),
            );
            setActiveTool((current) => applyToolProgress(current, progress));
          },
        }
      );
      const next = asSnapshot(result);
      setSnapshot(next);
      completeAgentDevelopmentRun(developmentRunId, next);
    } catch (error) {
      failAgentDevelopmentRun(developmentRunId, safeError(error));
      setSnapshot((current) =>
        current
          ? { ...current, error: safeError(error), generating: false }
          : current
      );
      void readStatus().catch(() => undefined);
    } finally {
      setActiveTool(null);
      setChatPending(false);
    }
  };

  const toggleAgentMode = async () => {
    setBusy(true);
    try {
      setAgentMode(
        agentMode?.enabled
          ? await disableAgentMode()
          : await requestAgentMode("agent_chat"),
      );
    } catch (error) {
      setSnapshot((current) =>
        current ? { ...current, error: safeError(error) } : current,
      );
    } finally {
      setBusy(false);
    }
  };

  const onHistoryScroll = () => {
    const history = historyRef.current;
    if (!history) return;
    const distance = history.scrollHeight - history.scrollTop - history.clientHeight;
    setFollowBottom(distance < 28);
  };

  if (!snapshot) {
    return (
      <main className="nt-app ora-app ora-loading" aria-label="Loading">
        <span className="ora-spinner" />
      </main>
    );
  }

  if (!snapshot.connected) {
    return (
      <main className="nt-app ora-app ora-disconnected">
        <div className="ora-connect">
          <IoLink aria-hidden="true" />
          <button
            type="button"
            className="nt-button nt-button--primary"
            disabled={busy}
            onClick={() => void run("openrouter_connect")}
          >
            {busy ? "Connecting" : "Connect to OpenRouter"}
          </button>
          <p>
            Prompts and selected tool results are sent to OpenRouter and its
            downstream model provider.
          </p>
          {snapshot.error && <ErrorNotice text={snapshot.error} />}
        </div>
      </main>
    );
  }

  const generationActive = snapshot.generating || chatPending;

  return (
    <main className="nt-app ora-app">
      <div className="ora-shell">
        <header className="ora-toolbar">
          <ModelPicker
            loading={snapshot.modelsLoading}
            models={snapshot.models}
            onRefresh={() => run("openrouter_models", { refresh: true })}
            onSelect={(modelId) => run("openrouter_select_model", { modelId })}
            selectedModelId={snapshot.selectedModelId}
            selectionLocked={generationActive || busy}
            selectionLockedReason={
              generationActive
                ? "Stop the response to change models"
                : "A model action is in progress"
            }
          />
          <div className="ora-toolbar-actions">
            <IconButton
              label={
                agentMode?.enabled ? "Disable Agent Mode" : "Enable Agent Mode"
              }
              className={
                agentMode?.enabled
                  ? "ora-agent-mode is-enabled"
                  : "ora-agent-mode"
              }
              aria-pressed={agentMode?.enabled ?? false}
              disabled={
                generationActive || busy || agentMode?.eligible === false
              }
              onClick={() => void toggleAgentMode()}
            >
              <IoSparklesOutline aria-hidden="true" />
              <span>Agent Mode</span>
            </IconButton>
            <ToolbarMenu
              busy={busy}
              generating={generationActive}
              hasMessages={snapshot.messages.length > 0}
              onClear={() => void run("openrouter_reset_chat")}
              onDisconnect={() => void run("openrouter_disconnect")}
            />
          </div>
        </header>

        <section className="ora-history">
          <div
            ref={historyRef}
            className="ora-history-scroll"
            onScroll={onHistoryScroll}
          >
            <div className="ora-history-inner">
              {snapshot.messages.map((entry) => (
                <Message key={entry.id} message={entry} />
              ))}
              {activeTool && <ToolActivityLine activity={activeTool} />}
            </div>
          </div>
          {!followBottom && (
            <IconButton
              label="Jump to latest"
              className="ora-jump"
              onClick={() => setFollowBottom(true)}
            >
              <IoArrowDown />
            </IconButton>
          )}
        </section>

        {snapshot.error && <ErrorNotice text={snapshot.error} />}

        <form className="ora-composer">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            aria-label="Message"
            placeholder={snapshot.selectedModelId ? "Message" : "Select a model"}
            disabled={!snapshot.selectedModelId || busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!generationActive) void send();
              }
            }}
          />
          {generationActive ? (
            <IconButton
              label="Stop"
              type="button"
              className="ora-send"
              onClick={() => void run("agent_stop")}
            >
              <IoStop />
            </IconButton>
          ) : (
            <IconButton
              label="Send"
              type="button"
              className="ora-send ora-send--active"
              disabled={!draft.trim() || !snapshot.selectedModelId || busy}
              onClick={() => void send()}
            >
              <IoArrowUp />
            </IconButton>
          )}
        </form>
      </div>
    </main>
  );
}

function Message({ message }: { message: TranscriptMessage }) {
  return (
    <article className={`ora-message ora-message--${message.role}`}>
      {message.role === "assistant" && <span className="ora-message-mark" />}
      <div className="ora-message-body">{message.text}</div>
    </article>
  );
}

function ToolActivityLine({ activity }: { activity: AgentToolActivity }) {
  return (
    <div
      className="ora-tool"
      role="status"
      aria-live="polite"
      title={`${activity.name}: ${activity.text}`}
    >
      <span className="ora-tool-dot" aria-hidden="true" />
      <span className="ora-tool-name">{activity.name}</span>
      <span className="ora-tool-text">{activity.text}</span>
    </div>
  );
}

function IconButton({
  label,
  children,
  danger = false,
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`ora-icon-button ${danger ? "ora-icon-button--danger" : ""} ${className}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function ErrorNotice({ text }: { text: string }) {
  return (
    <div className="ora-error" role="status">
      {text}
    </div>
  );
}

function asSnapshot(value: JsonValue): AgentSnapshot {
  if (
    !isJsonObject(value) ||
    typeof value.ready !== "boolean" ||
    typeof value.connected !== "boolean" ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("Invalid Agent state");
  }
  return value as AgentSnapshot;
}

function asProgress(value: JsonValue): AgentProgress | null {
  if (!isJsonObject(value) || typeof value.type !== "string") return null;
  if (value.type !== "turn_start" && value.type !== "tool") {
    return null;
  }
  return value as AgentProgress;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
