import { createMsgBusClient, exposeTool, publishAppStateChange, setTrayState } from "neutron-tools/app";
import { protocolClient } from "./client.ts";
import { createFeedbackNotifications } from "./notification_state.ts";
import { createFeedbackTools } from "./service_state.ts";

// This background-owned client is used solely for automatic notification
// refresh. Agent and UI handlers receive their own exact context.kernel.
const residentKernel = createMsgBusClient();
const notifications = createFeedbackNotifications({
  session: async () => (await protocolClient({ kernel: residentKernel })).session(),
  badge: badge => setTrayState({ badge }),
  publish: (topic, revision) => publishAppStateChange(topic, revision),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: handle => window.clearTimeout(handle as number),
});
for (const tool of createFeedbackTools({ client: protocolClient, observed: notifications.observe, changed: notifications.changed })) exposeTool(tool.name, tool.options, tool.handler);
notifications.start();
window.addEventListener("online", () => { void notifications.refresh(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void notifications.refresh(); });
window.addEventListener("pagehide", () => notifications.stop());
