import type { FrameContext } from "./frame_context.ts";

export function frameRequestLabel(frame: FrameContext): string {
  if (frame.role === "tile") {
    return `${frame.appId}/${frame.tileId} ${frame.instanceId}`;
  }
  return frame.role === "tray"
    ? `${frame.appId}/tray ${frame.instanceId}`
    : `${frame.appId}/background`;
}
