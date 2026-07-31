import { createRoot } from "react-dom/client";
import { MailApp } from "./mail_app.tsx";
import "./style.scss";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Mail root element");
createRoot(root).render(<MailApp />);
