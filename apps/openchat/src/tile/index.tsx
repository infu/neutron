import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { loadTileContext, onTileViewRequest } from "neutron-tools/app";
import { Browse } from "./Browse.tsx";
import { Chats } from "./Chats.tsx";
import { SignIn } from "./SignIn.tsx";
import { MiniSpinner, type TileView } from "./ui.tsx";
import { useWhoami } from "./hooks.ts";
import { oc, subscribeNav } from "../shared/rpc.ts";
import { OC_VIEW_CHAT } from "../shared/protocol.ts";
import "../style.scss";

function initialView(): TileView {
  try {
    return loadTileContext().tile === "browse" ? "browse" : "people";
  } catch {
    return "people";
  }
}

// The view that holds a given chat: DMs live under "people", everything else
// (groups, community channels) under "communities".
function viewForChat(chatId: string): TileView {
  return chatId.startsWith("direct:") ? "people" : "communities";
}

function App(): React.ReactNode {
  const { who, loading, error, reload } = useWhoami();
  const [view, setView] = useState<TileView>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Agent-driven navigation: when the agent calls show_chat, the resident opens
  // this tile with the "chat" view token and/or publishes a nav revision. Either
  // signal (and an initial check on mount) consumes the pending target and moves
  // the UI to it, exactly as if the user had clicked into that chat.
  useEffect(() => {
    let alive = true;
    const consume = async (): Promise<void> => {
      try {
        const nav = await oc.takePendingNav();
        if (alive && nav) {
          setSelectedId(nav.chatId);
          setView(viewForChat(nav.chatId));
        }
      } catch {
        /* bus not ready yet or nothing pending */
      }
    };
    void consume();
    const stopNav = subscribeNav(() => void consume());
    const stopView = onTileViewRequest((v) => {
      if (v === OC_VIEW_CHAT) void consume();
    });
    return () => {
      alive = false;
      stopNav();
      stopView();
    };
  }, []);

  const navigate = (next: TileView): void => { setSelectedId(null); setView(next); };

  let body: React.ReactNode;
  if (!who && error && !loading) {
    body = <div className="oc-boot"><div className="oc-read-error" role="alert">
      <p>Could not connect to OpenChat</p><p className={nt.meta}>{error}</p>
      <button type="button" className={nt.buttonGhost} onClick={reload}>Reconnect</button>
    </div></div>;
  } else if (loading || !who) {
    body = (
      <div className="oc-boot">
        <MiniSpinner label="Starting OpenChat" />
      </div>
    );
  } else if (who.status !== "logged_in") {
    body = <SignIn onSignedIn={reload} pendingEmail={who.pendingEmail} />;
  } else if (view === "browse") {
    body = <Browse who={who} view={view} onNav={navigate} onReload={reload} />;
  } else {
    body = (
      <Chats
        who={who}
        view={view}
        filter={view === "people" ? "direct" : "spaces"}
        onNav={navigate}
        onReload={reload}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    );
  }

  return <main className={cx(nt.appFill, "oc-root")}>{body}</main>;
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
