// Resident engine entry point. This is the only surface that talks to the
// OpenChat network. Importing neutron-tools/app installs the message-bus
// handshake; registerTools exposes the tool surface consumed by both the tile
// UI and the Neutron agent; the engine publishes a state revision whenever the
// chat list changes so open tiles can refresh.
import { publishAppStateChange } from "neutron-tools/app";
import { OpenChatEngine } from "./engine/engine.ts";
import { registerTools } from "./tools/surface.ts";

const engine = new OpenChatEngine({
  publish(topic, revision) {
    void publishAppStateChange(topic, revision).catch(() => undefined);
  },
});

registerTools(engine);

void engine.start().catch((error: unknown) => {
  console.error("OpenChat engine failed to start", error);
});
