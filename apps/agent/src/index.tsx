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
  IoGlobeOutline,
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
import { MarkdownMessage } from "./markdown_message.tsx";
import { ModelPicker } from "./model_picker.tsx";
import { ToolbarMenu } from "./toolbar_menu.tsx";
import { parseAgentCommand } from "./agent_work.ts";
import "./style.scss";

const TARGET = "app:agent:background" as MsgBusEndpointId;
const STATE_TOPIC = "agent";
const CONNECTION_DIALOG_TIMEOUT_SECONDS = 16 * 60;
const STATUS_REFRESH_INTERVAL_MS = 30_000;
const bus = createMsgBusClient();

function App() {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [webEnabled, setWebEnabled] = useState(false);
  const [activeTool, setActiveTool] = useState<AgentToolActivity | null>(null);
  const [agentMode, setAgentMode] = useState<AgentModeStatus | null>(null);
  const [followBottom, setFollowBottom] = useState(true);
  const historyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const snapshotRef = useRef(snapshot);
  const draftRef = useRef(draft);
  const activeToolRef = useRef(activeTool);
  const chatPendingRef = useRef(chatPending);
  const statusGenerationRef = useRef(0);
  const statusRefreshRunningRef = useRef(false);
  const statusRefreshPendingRef = useRef(false);
  snapshotRef.current = snapshot;
  draftRef.current = draft;
  activeToolRef.current = activeTool;
  chatPendingRef.current = chatPending;

  const readStatus = useCallback(async () => {
    const generation = ++statusGenerationRef.current;
    const [value, mode] = await Promise.all([
      bus.callTool({
        target: TARGET,
        name: "agent_status",
        arguments: {},
      }),
      getAgentModeStatus().catch(() => null),
    ]);
    if (generation !== statusGenerationRef.current) return false;
    setSnapshot(asSnapshot(value));
    if (mode) setAgentMode(mode);
    return true;
  }, []);

  const refreshStatus = useCallback(async () => {
    statusRefreshPendingRef.current = true;
    if (statusRefreshRunningRef.current) return;
    statusRefreshRunningRef.current = true;
    try {
      do {
        statusRefreshPendingRef.current = false;
        for (const retryDelay of [0, 350, 1_200]) {
          if (retryDelay > 0) await delay(retryDelay);
          try {
            if (await readStatus()) break;
          } catch {
            // A later invalidation or the fallback refresh will retry.
          }
        }
      } while (statusRefreshPendingRef.current);
    } finally {
      statusRefreshRunningRef.current = false;
    }
  }, [readStatus]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      while (!cancelled) {
        try {
          if (await readStatus()) return;
        } catch {
          await delay(350);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [readStatus]);

  useEffect(
    () => onAppStateChange(STATE_TOPIC, () => void refreshStatus()),
    [refreshStatus],
  );

  useEffect(() => {
    const refreshVisible = (): void => {
      if (!document.hidden) void refreshStatus();
    };
    const interval = window.setInterval(
      refreshVisible,
      STATUS_REFRESH_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [refreshStatus]);

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

  useEffect(() => {
    if (snapshot && !snapshot.webToolsAvailable) setWebEnabled(false);
  }, [snapshot?.webToolsAvailable]);

  const run = async (
    name: string,
    arguments_: Record<string, JsonValue> = {},
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await bus.callTool(
        { target: TARGET, name, arguments: arguments_ },
        name === "openrouter_connect" || name === "openrouter_disconnect"
          ? CONNECTION_DIALOG_TIMEOUT_SECONDS
          : undefined,
      );
      statusGenerationRef.current += 1;
      setSnapshot(asSnapshot(result));
      return true;
    } catch (error) {
      setSnapshot((current) =>
        current
          ? { ...current, error: safeError(error) }
          : current
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (override?: string, enqueue = false) => {
    const text = (override ?? draft).trim();
    if (
      !text ||
      !snapshot?.connected ||
      !snapshot.selectedModelId || busy
    ) {
      return;
    }
    const command = parseAgentCommand(text);
    if (command.kind === "status") {
      setDraft("");
      void refreshStatus();
      return;
    }
    if (command.kind === "pause" || command.kind === "clear") {
      if (await run(command.kind === "pause" ? "agent_stop" : "agent_clear_goal")) setDraft("");
      return;
    }
    if (snapshot.generatingHere || chatPending || enqueue || command.kind === "queue") {
      const queued = command.kind === "queue" ? command.text : text;
      if (await run("agent_enqueue", { text: queued, mode: enqueue || command.kind === "queue" ? "queue" : "steer" })) setDraft("");
      return;
    }
    setDraft("");
    setFollowBottom(true);
    setChatPending(true);
    setActiveTool(null);
    const developmentRunId = beginAgentDevelopmentRun(text);
    const useWeb = webEnabled && snapshot.webToolsAvailable;
    let turnStarted = false;
    try {
      const result = await bus.callTool(
        {
          target: TARGET,
          name: "agent_chat",
          arguments: {
            text,
            ...(snapshot.conversationRevision
              ? {
                  modelId: snapshot.selectedModelId,
                  conversationRevision: snapshot.conversationRevision,
                }
              : {}),
            ...(useWeb ? { webEnabled: true } : {}),
          },
        },
        {
          timeout: 0,
          onProgress: (value) => {
            const progress = asProgress(value);
            if (!progress) return;
            if (progress.type === "refresh") { void refreshStatus(); return; }
            if (progress.type === "turn_start") {
              turnStarted = true;
              statusGenerationRef.current += 1;
            }
            recordAgentDevelopmentProgress(developmentRunId, progress);
            setSnapshot((current) =>
              applyTranscriptProgress(current, progress),
            );
            setActiveTool((current) => applyToolProgress(current, progress));
          },
        }
      );
      const next = asSnapshot(result);
      statusGenerationRef.current += 1;
      setSnapshot(next);
      completeAgentDevelopmentRun(developmentRunId, next);
    } catch (error) {
      if (!turnStarted) {
        setDraft((current) => current || text);
      }
      failAgentDevelopmentRun(developmentRunId, safeError(error));
      setSnapshot((current) =>
        current
          ? { ...current, error: safeError(error) }
          : current
      );
      void refreshStatus();
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

  const generationActive = snapshot.generatingHere || chatPending;
  const anyGenerationActive = snapshot.generating || generationActive;

  return (
    <main className="nt-app ora-app">
      <div className="ora-shell">
        <section className="ora-history">
          <div
            ref={historyRef}
            className="ora-history-scroll"
            onScroll={onHistoryScroll}
          >
            <div className="ora-history-inner">
              {snapshot.hiddenMessageCount > 0 && (
                <p className="ora-history-truncated" role="status">
                  {snapshot.hiddenMessageCount} earlier messages are retained
                  but not shown in this view.
                </p>
              )}
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
              <IoArrowDown aria-hidden="true" />
            </IconButton>
          )}
        </section>

        {snapshot.error && <ErrorNotice text={snapshot.error} />}

        {snapshot.workers && snapshot.workers.total > 0 && (
          <details className="ora-workers">
            <summary>Workers · {snapshot.workers.active} running · {snapshot.workers.total} total</summary>
            <div className="ora-worker-list">
              {snapshot.workers.items.map((worker) => (
                <details key={worker.id} className="ora-worker">
                  <summary><span>{worker.task}</span><strong>{worker.status}</strong></summary>
                  <p>{worker.task}</p>
                  <p className="ora-worker-meta">{worker.modelId}</p>
                  {worker.lastStop && <p role="status">
                    {worker.status === "stopped" || worker.status === "paused" ? "Stopped" : "Previously stopped"}{worker.lastStop.by === "unknown" ? "" : ` by ${worker.lastStop.by === "coordinator" ? "coordinator" : "parent agent"}`}: {worker.lastStop.reason}
                  </p>}
                  {worker.lastRecovery && <p role="status">
                    {worker.lastRecovery.state === "recovered" ? "Recovered" : worker.lastRecovery.state === "continuing" ? "Continuing" : "Recovery interrupted"}
                    {worker.lastRecovery.from === "length" ? " after reaching the response output limit." : ` after ${worker.lastRecovery.from === "error" ? "an error" : "an interruption"}: ${worker.lastRecovery.detail}`}
                  </p>}
                  {worker.result && <p>{worker.result}</p>}
                  {worker.error && <p role="status">{worker.error}</p>}
                </details>
              ))}
              {snapshot.workers.omitted > 0 && <p>{snapshot.workers.omitted} more workers retained. Ask the agent to list them.</p>}
            </div>
          </details>
        )}
        {snapshot.work?.goal && (
          <section className="ora-goal" aria-label="Current goal">
            <div className="ora-goal-heading">
              <strong>Goal · {snapshot.work.goal.status.replace("_", " ")}</strong>
              {generationActive ? (
                <button type="button" onClick={() => void run("agent_stop")} disabled={busy}>Pause</button>
              ) : (
                <button type="button" onClick={() => void send("/goal resume")} disabled={busy || snapshot.generating}>Resume</button>
              )}
              <button type="button" onClick={() => void run("agent_clear_goal")} disabled={busy}>Clear</button>
            </div>
            <p>{snapshot.work.goal.objective}</p>
            {snapshot.work.goal.checkpoint && <details><summary>Progress checkpoint</summary><p>{snapshot.work.goal.checkpoint}</p></details>}
          </section>
        )}
        {snapshot.work && (snapshot.work.wakeAt !== null || snapshot.work.queued > 0) && (
          <div className="ora-work-status" role="status">
            {snapshot.work.wakeAt !== null && <span>Sleeping until {new Date(snapshot.work.wakeAt).toLocaleTimeString()}</span>}
            {snapshot.work.queued > 0 && <span title={snapshot.work.nextMessage ?? ""}>{snapshot.work.queued} queued</span>}
            {!anyGenerationActive && snapshot.work.queued > 0 && (
              <button type="button" disabled={busy} onClick={() => void send("Continue with the queued requests.")}>Run queued</button>
            )}
          </div>
        )}
        <form className="ora-composer" onSubmit={(event) => event.preventDefault()}>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            aria-label="Message"
            placeholder={snapshot.selectedModelId ? generationActive ? "Steer the agent…" : "Message or /goal…" : "Select a model"}
            disabled={
              !snapshot.selectedModelId || busy
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              } else if (event.key === "Tab" && generationActive && draft.trim()) {
                event.preventDefault();
                void send(undefined, true);
              }
            }}
          />
          <div className="ora-composer-footer">
            <ModelPicker
              loading={snapshot.modelsLoading}
              models={snapshot.models}
              onRefresh={() => run("openrouter_models", { refresh: true })}
              onSelect={(modelId) =>
                run("openrouter_select_model", { modelId })
              }
              selectedModelId={snapshot.selectedModelId}
              selectionLocked={generationActive || busy}
              selectionLockedReason={
                generationActive
                  ? "Stop this response to change models"
                  : "A model action is in progress"
              }
            />
            <div className="ora-composer-actions">
              <IconButton
                label={
                  snapshot.webToolsAvailable
                    ? webEnabled
                      ? "Disable web search and page reading"
                      : "Enable web search and page reading"
                    : "Web access is unavailable in this Agent process"
                }
                className={`ora-composer-toggle ora-web-access${
                  webEnabled ? " is-enabled" : ""
                }`}
                aria-pressed={webEnabled}
                disabled={
                  !snapshot.webToolsAvailable || generationActive || busy
                }
                onClick={() => setWebEnabled((current) => !current)}
              >
                <IoGlobeOutline aria-hidden="true" />
              </IconButton>
              <IconButton
                label={
                  agentMode?.enabled
                    ? "Disable Agent Mode"
                    : "Enable Agent Mode"
                }
                className={
                  agentMode?.enabled
                    ? "ora-composer-toggle ora-agent-mode is-enabled"
                    : "ora-composer-toggle ora-agent-mode"
                }
                aria-pressed={agentMode?.enabled ?? false}
                disabled={
                  generationActive || busy || agentMode?.eligible === false
                }
                onClick={() => void toggleAgentMode()}
              >
                <IoSparklesOutline aria-hidden="true" />
              </IconButton>
              {generationActive ? (
                <>
                <button type="button" className="ora-queue-button" disabled={!draft.trim() || busy} onClick={() => void send(undefined, true)} title="Queue for the next work cycle (Tab)">Queue</button>
                <IconButton label="Steer now" disabled={!draft.trim() || busy} onClick={() => void send()}><IoArrowUp aria-hidden="true" /></IconButton>
                <IconButton
                  label="Stop"
                  type="button"
                  className="ora-send"
                  onClick={() => void run("agent_stop")}
                >
                  <IoStop aria-hidden="true" />
                </IconButton>
                </>
              ) : (
                <IconButton
                  label="Send"
                  type="button"
                  className="ora-send ora-send--active"
                  disabled={
                    !draft.trim() || !snapshot.selectedModelId || busy || snapshot.generating
                  }
                  onClick={() => void send()}
                >
                  <IoArrowUp aria-hidden="true" />
                </IconButton>
              )}
              <ToolbarMenu
                anyGenerating={anyGenerationActive}
                busy={busy}
                conversationGenerating={generationActive}
                hasMessages={snapshot.messages.length > 0}
                onClear={() =>
                  void run("openrouter_reset_chat", {
                    ...(snapshot.conversationRevision
                      ? { conversationRevision: snapshot.conversationRevision }
                      : {}),
                  })
                }
                onClearAll={() => void run("openrouter_reset_all_chats")}
                onDisconnect={() => void run("openrouter_disconnect")}
              />
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}

function Message({ message }: { message: TranscriptMessage }) {
  return (
    <article className={`ora-message ora-message--${message.role}`}>
      {message.role === "assistant" && <span className="ora-message-mark" />}
      <div className="ora-message-body">
        {message.role === "assistant" ? (
          <MarkdownMessage messageId={message.id} text={message.text} />
        ) : (
          message.text
        )}
      </div>
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
    (value.webToolsAvailable !== undefined &&
      typeof value.webToolsAvailable !== "boolean") ||
    typeof value.generating !== "boolean" ||
    (value.generatingHere !== undefined &&
      typeof value.generatingHere !== "boolean") ||
    (value.conversationRevision !== undefined &&
      typeof value.conversationRevision !== "string") ||
    (value.hiddenMessageCount !== undefined &&
      (typeof value.hiddenMessageCount !== "number" ||
        !Number.isSafeInteger(value.hiddenMessageCount) ||
        value.hiddenMessageCount < 0)) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("Invalid Agent state");
  }
  return {
    ...value,
    webToolsAvailable: value.webToolsAvailable === true,
    generatingHere:
      typeof value.generatingHere === "boolean"
        ? value.generatingHere
        : value.generating,
    conversationRevision:
      typeof value.conversationRevision === "string"
        ? value.conversationRevision
        : null,
    hiddenMessageCount:
      typeof value.hiddenMessageCount === "number"
        ? value.hiddenMessageCount
        : 0,
  } as AgentSnapshot;
}

function asProgress(value: JsonValue): AgentProgress | null {
  if (!isJsonObject(value) || typeof value.type !== "string") return null;
  if (!["turn_start", "tool", "work", "workers", "message", "refresh"].includes(value.type)) {
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
