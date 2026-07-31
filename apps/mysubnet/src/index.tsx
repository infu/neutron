import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadNeutronCanisterId } from "neutron-tools/app";
import { SubnetGlobe, supportsWebGL } from "./globe";
import {
  loadSubnetTopology,
  type SubnetTopology,
} from "./registry";
import "./style.scss";

const AUTO_REFRESH_MILLISECONDS = 5 * 60 * 1000;

function MySubnetApp() {
  const globeHostRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<SubnetGlobe | null>(null);
  const requestRef = useRef(0);
  const [topology, setTopology] = useState<SubnetTopology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = globeHostRef.current;
    if (!host) return;

    if (!supportsWebGL()) {
      setError("WebGL is unavailable in this browser.");
      return;
    }

    try {
      const globe = new SubnetGlobe({ host });
      globeRef.current = globe;

      return () => {
        globe.dispose();
        globeRef.current = null;
      };
    } catch (runtimeError) {
      setError(readableError(runtimeError, "The globe renderer could not start."));
    }
  }, []);

  const refresh = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);

    try {
      const canisterId = await loadNeutronCanisterId();
      const loaded = await loadSubnetTopology(canisterId);
      if (requestRef.current !== request) return;
      setTopology(loaded);
      setError(null);
    } catch (loadError) {
      if (requestRef.current !== request) return;
      setError(readableError(loadError, "The subnet topology could not be loaded."));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), AUTO_REFRESH_MILLISECONDS);

    return () => {
      requestRef.current += 1;
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    globeRef.current?.setNodes(topology?.nodes ?? []);
  }, [topology]);

  const dataCenters = useMemo(() => new Set(
    topology?.nodes.map((node) => node.dataCenterId).filter(isString) ?? [],
  ).size, [topology]);
  const countries = useMemo(() => new Set(
    topology?.nodes.map((node) => node.countryCode).filter(isString) ?? [],
  ).size, [topology]);

  return (
    <main className="nt-app nt-app--fill mysubnet-app">
      <section
        aria-busy={loading}
        aria-label="My Internet Computer subnet"
        className="mysubnet-stage"
        data-tid="mysubnet-globe"
      >
        <div className="mysubnet-globe" ref={globeHostRef} />

        <dl className="mysubnet-readout" aria-label="Live subnet summary">
          <div>
            <dt>Subnet</dt>
            <dd title={topology?.subnetId}>{topology ? shortSubnetId(topology.subnetId) : loading ? "Locating…" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Nodes</dt>
            <dd>{topology?.nodes.length ?? "—"}</dd>
          </div>
          <div>
            <dt>Data centers</dt>
            <dd>{topology ? dataCenters : "—"}</dd>
          </div>
          <div>
            <dt>Countries</dt>
            <dd>{topology ? countries : "—"}</dd>
          </div>
        </dl>

        {error ? <p className="nt-sr-only" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function shortSubnetId(value: string): string {
  return value.length > 11 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
}

function isString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

createRoot(document.getElementById("root")!).render(<MySubnetApp />);
