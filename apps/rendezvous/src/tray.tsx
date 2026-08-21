import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { dismissTray, openAppTile, querySelf } from "neutron-tools/app";
import "./style.scss";
type Status = { negotiation_count: string; actionable_count: string };
const Tray = () => {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { querySelf<Status>("rendezvous_status", [null]).then(setStatus).catch(() => setStatus(null)); }, []);
  const actionable = Number(status?.actionable_count ?? 0);
  const openRendezvous = () => {
    const opening = openAppTile({ appId: "rendezvous", tileId: "main", reuseExisting: true, view: "negotiations" });
    void opening.then(() => dismissTray()).catch(() => {});
  };
  return <main className="tray" aria-label="Rendezvous requests"><div><strong>Rendezvous</strong><span>{status ? `${actionable} need attention · ${status.negotiation_count} total` : "Status unavailable"}</span></div><button className="nt-button nt-button--sm" onClick={openRendezvous} type="button">{actionable > 0 ? "Review requests" : "Open Rendezvous"}</button></main>;
};
const root = document.getElementById("root"); if (!root) throw new Error("Missing tray root"); createRoot(root).render(<Tray />);
