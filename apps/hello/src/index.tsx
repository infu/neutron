import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import {
  createCanisterClient,
  loadNeutronCanisterId,
  loadTileContext,
  type JsonValue,
  type MethodSchemaJson,
  type NeutronCanisterClient,
} from "neutron-tools/app";
import "./style.scss";

const HELLO_METHOD = "hello_world";
const METRICS = [
  ["Layout", "Responsive text", "Resize, split dragging, and iframe clipping."],
  ["Runtime", "Typed call", "Schema-loaded kernel-mediated update request."],
  ["Tile", "Workspace aware", "Multiple instances keep independent context."],
] as const;

function formatResult(value: JsonValue): string {
  return JSON.stringify(value);
}

function formatError(error: unknown): string {
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

export const App = () => {
  const [client, setClient] = useState<NeutronCanisterClient | null>(null);
  const [methodSchema, setMethodSchema] = useState<MethodSchemaJson | null>(
    null
  );
  const [result, setResult] = useState<string | null>(null);
  const [tileContext] = useState(() => loadTileContext());

  useEffect(() => {
    let cancelled = false;

    loadNeutronCanisterId()
      .then(async (id) => {
        const nextClient = createCanisterClient(id);
        const schema = await nextClient.methodSchema(HELLO_METHOD, 10);
        if (cancelled) return;
        setClient(nextClient);
        setMethodSchema(schema);
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult("Error: " + formatError(error));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const callHello = () => {
    if (!client || !methodSchema) return;

    client
      .callDialog(HELLO_METHOD, ["John"])
      .then((value) => setResult(formatResult(value)))
      .catch((error: unknown) => {
        console.error("ERR", error);
        setResult("Error: " + formatError(error));
      });
  };

  return (
    <main className={cx(nt.appFill, "hello-app")}>
      <div className="nt-page hello-shell">
        <header className="nt-page-header hello-header">
          <div className="hello-heading">
            <p className="nt-eyebrow">Sample Neutron App</p>
            <h1 className="nt-title">Hello tile workspace test</h1>
            <div className="nt-tag-list" aria-label="Runtime capabilities">
              <span className="nt-tag nt-tag--success">typed JSON call</span>
              <span className="nt-tag">iframe tile</span>
            </div>
          </div>
          <dl
            aria-label="Tile context"
            className="nt-kv hello-context"
            data-tid="hello-tile-context"
          >
            <dt>App</dt>
            <dd>{tileContext.app ?? "app"}</dd>
            <dt>Tile</dt>
            <dd>{tileContext.tile ?? "tile"}</dd>
          </dl>
        </header>

        <main className="nt-page-main">
          <section className="nt-panel">
            <div className="hello-copy">
              <p className="nt-text">
                This tile is intentionally filled with normal application content
                so kernel window resizing, split dragging, iframe clipping, and
                text flow are easy to inspect while developing the workspace
                manager.
              </p>
              <p className="nt-text">
                Resize this tile from a corner or split edge. The text should
                wrap cleanly, the action button should stay reachable, and the
                result area should remain visible without overlapping the header.
              </p>
            </div>
          </section>

          <section className="nt-grid nt-grid--compact">
            {METRICS.map(([label, value, detail]) => (
              <article className="nt-metric" key={label}>
                <span className="nt-metric-label">{label}</span>
                <strong className="nt-metric-value">{value}</strong>
                <span className="nt-metric-detail">{detail}</span>
              </article>
            ))}
          </section>
        </main>

        <footer className="nt-page-footer hello-footer">
          <button
            className="nt-button nt-button--sm"
            data-tid="hello-call"
            disabled={!client || !methodSchema}
            onClick={callHello}
            type="button"
          >
            Test typed call
          </button>
          <output
            aria-live="polite"
            className={cx("nt-result", "hello-result", {
              "hello-result--empty": !result,
            })}
          >
            {result ? (
              <code data-tid="hello-result">{result}</code>
            ) : (
              "No result yet."
            )}
          </output>
        </footer>
      </div>
    </main>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

const root = createRoot(container);
root.render(<App />);
