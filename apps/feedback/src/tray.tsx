import { createRoot } from "react-dom/client";
import { FeedbackTray } from "./FeedbackTray.tsx";
import { feedbackClient } from "./ui-client.ts";
import "./style.scss";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Feedback tray root");
createRoot(root).render(<FeedbackTray client={feedbackClient} />);
