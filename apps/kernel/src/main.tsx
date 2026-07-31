import { createRoot } from "react-dom/client";
import { Auth } from "./Auth";
import { Requests } from "./Requests";
import { AppDialogs } from "./AppDialogs";
import { ConnectionDialogs } from "./ConnectionDialogs.tsx";
import { install_app } from "./reducer/apps.ts";
import { WorkspaceShell } from "./workspace/WorkspaceShell.tsx";
import { AgentGrantDialog } from "./AgentModeUI.tsx";
import { ToastViewport } from "./toast/ToastViewport.tsx";
import { RepositorySetupController } from "./repository/RepositorySetupController.tsx";
import { InstallOfferController } from "./install_offers/index.ts";

import "./expose";
import "./connections/callback.ts";
import "./style.scss";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");
const root = createRoot(container);

const App = () => {
  return (
    <>
      <WorkspaceShell />
      <Auth />
      <Requests />
      <InstallOfferController />
      <RepositorySetupController />
      <AppDialogs />
      <ConnectionDialogs />
      <AgentGrantDialog />
      <ToastViewport />
    </>
  );
};

root.render(<App />);

declare global {
  interface Window {
    install_app?: () => Promise<void>;
  }
}

window.install_app = async (): Promise<void> => {
  await install_app();
};
