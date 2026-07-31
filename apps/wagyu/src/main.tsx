import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagyuApp } from "./app/App.tsx";
import { createNeutronWagyuService } from "./app/service_adapter.ts";
import "./style.scss";

const container = document.getElementById("root");
if (!container) throw new Error("Wagyu root element not found");

const service = createNeutronWagyuService();
createRoot(container).render(
  <StrictMode>
    <WagyuApp service={service} />
  </StrictMode>,
);
