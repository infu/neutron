import { createRoot } from "react-dom/client";
import { FeedbackApp } from "./App.tsx";
import { feedbackClient } from "./ui-client.ts";
import "./style.scss";

const root = document.getElementById("root");
if (!root) throw new Error("Missing Feedback root");
createRoot(root).render(<FeedbackApp client={feedbackClient} />);
