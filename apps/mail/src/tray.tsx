import { createRoot } from "react-dom/client";
import { MailTray } from "./mail_app.tsx";
import "./style.scss";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Mail tray root element");
createRoot(root).render(<MailTray />);
