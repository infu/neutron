(() => {
  "use strict";

  const CHANNEL = "neutron:connections:v1";
  const FLOW_KEY = "neutron:connections:pending-flow:v1";
  const params = new URLSearchParams(window.location.search);
  const flow = params.get("flow") || window.localStorage.getItem(FLOW_KEY) || "";
  const code = params.get("code") || "";
  const error = params.get("error") || params.get("error_description") || "";
  const message = document.getElementById("message");

  if (!flow || (!code && !error) || typeof BroadcastChannel === "undefined") {
    show("Connection callback is invalid", true);
    return;
  }

  const channel = new BroadcastChannel(CHANNEL);
  const callback = {
    type: "neutron:connection:callback",
    flow,
    ...(code ? { code } : {}),
    ...(error ? { error: error.slice(0, 256) } : {}),
  };
  const retry = window.setInterval(() => channel.postMessage(callback), 500);
  const timeout = window.setTimeout(() => {
    window.clearInterval(retry);
    show("Return to Neutron to retry the connection", true);
    channel.close();
  }, 15_000);

  channel.addEventListener("message", (event) => {
    const result = event.data;
    if (
      !result ||
      result.type !== "neutron:connection:result" ||
      result.flow !== flow
    ) {
      return;
    }
    window.clearTimeout(timeout);
    window.clearInterval(retry);
    window.localStorage.removeItem(FLOW_KEY);
    if (result.ok) {
      show("Connected", false);
    } else {
      show(typeof result.error === "string" ? result.error : "Connection failed", true);
    }
    window.setTimeout(() => window.close(), result.ok ? 500 : 1_000);
    channel.close();
  });

  channel.postMessage(callback);

  function show(text, failed) {
    if (message) message.textContent = text;
    document.body.classList.toggle("failed", failed);
    document.body.classList.toggle("done", !failed);
  }
})();
