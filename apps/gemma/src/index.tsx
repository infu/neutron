import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  IoArrowDown,
  IoArrowUp,
  IoRefresh,
  IoStop,
  IoWarningOutline,
} from "react-icons/io5";
import { cx, nt } from "neutron-design-system";
import {
  callTool,
  loadTileContext,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import type { ChatMessage, ChatSnapshot } from "./chat_types.ts";
import { MODEL_ID } from "./gemma_runtime.ts";
import "./style.scss";

const BOTTOM_THRESHOLD = 32;
const MAX_COMPOSER_HEIGHT = 160;

function MessageView({ message }: { message: ChatMessage }) {
  const pending = message.role === "assistant" && !message.content;
  return (
    <article
      aria-label={message.role === "assistant" ? "Gemma response" : "Your message"}
      className={cx(
        "gemma-message",
        `gemma-message--${message.role}`,
        pending && "gemma-message--pending"
      )}
      data-role={message.role}
    >
      {message.role === "assistant" ? (
        <span className="gemma-message-mark" aria-hidden="true" />
      ) : null}
      <div className="gemma-message-body">
        {pending ? (
          <span className="gemma-typing" aria-label="Generating response">
            <i />
            <i />
            <i />
          </span>
        ) : (
          message.content
        )}
      </div>
    </article>
  );
}

const disconnectedSnapshot: ChatSnapshot = {
  stage: "idle",
  statusText: "Connecting to resident model process...",
  modelId: MODEL_ID,
  modelLoaded: false,
  loadProgress: null,
  webGpuAvailable: true,
  messages: [],
};

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const target = `app:${context.app ?? "gemma"}:background` as MsgBusEndpointId;
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const followingBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const jumpTimerRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(disconnectedSnapshot);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [followingBottom, setFollowingBottom] = useState(true);

  const setBottomFollow = useCallback((value: boolean) => {
    followingBottomRef.current = value;
    setFollowingBottom(value);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const node = chatScrollRef.current;
      if (!node) return;
      setBottomFollow(true);
      programmaticScrollRef.current = behavior === "smooth";
      node.scrollTo({ top: node.scrollHeight, behavior });
      if (behavior === "smooth") {
        if (jumpTimerRef.current !== null) {
          window.clearTimeout(jumpTimerRef.current);
        }
        jumpTimerRef.current = window.setTimeout(() => {
          const current = chatScrollRef.current;
          if (current) current.scrollTop = current.scrollHeight;
          programmaticScrollRef.current = false;
          jumpTimerRef.current = null;
        }, 450);
      }
    },
    [setBottomFollow]
  );

  const applySnapshot = useCallback((next: ChatSnapshot) => {
    if (!mountedRef.current) return;
    setSnapshot(next);
    setConnected(true);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const value = await callTool(
        { target, name: "gemma_status", arguments: {} },
        5
      );
      applySnapshot(assertChatSnapshot(value));
    } catch (error) {
      if (!mountedRef.current) return;
      setConnected(false);
      setSnapshot((current) => ({
        ...current,
        statusText: `Background process unavailable: ${errorMessage(error)}`,
      }));
    }
  }, [applySnapshot, target]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
      }
    };
  }, [refresh]);

  const lastMessage = snapshot.messages.at(-1);
  const historyVersion = `${snapshot.messages.length}:${lastMessage?.id ?? ""}:${
    lastMessage?.content.length ?? 0
  }`;

  useLayoutEffect(() => {
    if (followingBottomRef.current) scrollToBottom();
  }, [historyVersion, scrollToBottom]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    const height = Math.min(input.scrollHeight, MAX_COMPOSER_HEIGHT);
    input.style.height = `${height}px`;
    input.style.overflowY =
      input.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
    if (followingBottomRef.current) {
      window.requestAnimationFrame(() => scrollToBottom());
    }
  }, [draft, scrollToBottom]);

  const loading = !connected || snapshot.stage === "loading";
  const generating = snapshot.stage === "generating";
  const canWrite =
    connected && snapshot.modelLoaded && snapshot.stage !== "loading";
  const canSend = canWrite && !generating && draft.trim().length > 0;

  async function runTool(name: "gemma_load" | "gemma_stop"): Promise<void> {
    if (name === "gemma_load") {
      setSnapshot((current) => ({
        ...current,
        stage: "loading",
        statusText: "Loading resident model...",
        loadProgress: 0,
      }));
    }
    try {
      const value = await callTool({ target, name, arguments: {} }, 900);
      applySnapshot(assertChatSnapshot(value));
    } catch (error) {
      console.error(`[Gemma] tool '${name}' failed`, error);
      await refresh();
    }
  }

  async function sendMessage(): Promise<void> {
    const text = draft.trim();
    if (!canSend || !text) return;
    setDraft("");
    setSnapshot((current) => ({
      ...current,
      stage: "generating",
      statusText: "Generating response...",
      messages: [
        ...current.messages,
        {
          id: `pending-${Date.now()}`,
          role: "user",
          content: text,
        },
      ],
    }));
    try {
      const value = await callTool(
        { target, name: "gemma_generate", arguments: { text } },
        900
      );
      applySnapshot(assertChatSnapshot(value));
    } catch (error) {
      console.error("[Gemma] generation failed", error);
      await refresh();
    }
  }

  const modelUnavailable = connected && !snapshot.modelLoaded && !loading;

  return (
    <main className={cx(nt.appFill, "gemma-app")}>
      <div className="gemma-shell">
        <section className="gemma-history" aria-label="Conversation">
          <div
            aria-live="polite"
            className="gemma-history-scroll"
            data-tid="gemma-history"
            onScroll={(event) => {
              if (programmaticScrollRef.current) return;
              const node = event.currentTarget;
              const distance =
                node.scrollHeight - node.scrollTop - node.clientHeight;
              setBottomFollow(distance <= BOTTOM_THRESHOLD);
            }}
            ref={chatScrollRef}
            role="log"
          >
            <div className="gemma-history-inner">
              {loading ? (
                <div
                  aria-label={snapshot.statusText}
                  className="gemma-loading"
                  data-tid="gemma-loading"
                  role="status"
                  title={snapshot.statusText}
                >
                  <span className="gemma-spinner" aria-hidden="true" />
                  <span
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={
                      snapshot.loadProgress === null
                        ? undefined
                        : Math.round(snapshot.loadProgress * 100)
                    }
                    className="gemma-progress"
                    role="progressbar"
                  >
                    <span
                      style={{
                        width: `${Math.round(
                          (snapshot.loadProgress ?? 0) * 100
                        )}%`,
                      }}
                    />
                  </span>
                </div>
              ) : modelUnavailable ? (
                snapshot.webGpuAvailable ? (
                  <button
                    aria-label="Retry model load"
                    className="nt-icon-button gemma-retry"
                    onClick={() => void runTool("gemma_load")}
                    title={snapshot.statusText}
                    type="button"
                  >
                    <IoRefresh aria-hidden="true" />
                  </button>
                ) : (
                  <span
                    aria-label={snapshot.statusText}
                    className="gemma-unavailable"
                    role="status"
                    title={snapshot.statusText}
                  >
                    <IoWarningOutline aria-hidden="true" />
                  </span>
                )
              ) : null}

              {snapshot.messages.map((message) => (
                <MessageView key={message.id} message={message} />
              ))}
            </div>
          </div>

          {!followingBottom && snapshot.messages.length > 0 ? (
            <button
              aria-label="Jump to latest message"
              className="nt-icon-button gemma-jump-latest"
              data-tid="gemma-jump-latest"
              onClick={() => scrollToBottom("smooth")}
              title="Jump to latest message"
              type="button"
            >
              <IoArrowDown aria-hidden="true" />
            </button>
          ) : null}
        </section>

        <form
          className="gemma-compose"
          data-tid="gemma-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <label className="nt-sr-only" htmlFor="gemma-prompt">
            Message
          </label>
          <textarea
            aria-label="Message"
            className="gemma-input"
            disabled={!canWrite}
            id="gemma-prompt"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Message"
            ref={inputRef}
            rows={1}
            value={draft}
          />
          <button
            aria-label={generating ? "Stop generating" : "Send message"}
            className={cx(
              "nt-icon-button",
              "gemma-send",
              generating && "gemma-send--stop"
            )}
            data-tid={generating ? "gemma-stop" : "gemma-send"}
            disabled={generating ? !connected : !canSend}
            onClick={() => {
              if (generating) void runTool("gemma_stop");
              else void sendMessage();
            }}
            title={generating ? "Stop generating" : "Send message"}
            type="button"
          >
            {generating ? (
              <IoStop aria-hidden="true" />
            ) : (
              <IoArrowUp aria-hidden="true" />
            )}
          </button>
        </form>
      </div>
    </main>
  );
}

function assertChatSnapshot(value: JsonValue): ChatSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.stage !== "string" ||
    typeof value.statusText !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.modelLoaded !== "boolean" ||
    !(
      value.loadProgress === null ||
      (typeof value.loadProgress === "number" &&
        value.loadProgress >= 0 &&
        value.loadProgress <= 1)
    ) ||
    typeof value.webGpuAvailable !== "boolean" ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("Invalid Gemma background status");
  }
  return value as unknown as ChatSnapshot;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
