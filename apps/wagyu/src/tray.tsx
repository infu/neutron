import { createRoot } from "react-dom/client";
import { WagyuTrayApp } from "./tray/app.tsx";
import "./tray/style.scss";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Wagyu tray root element");
createRoot(root).render(<WagyuTrayApp />);
