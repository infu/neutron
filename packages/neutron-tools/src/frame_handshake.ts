export type MsgBusFrameProbeEnvelope = Readonly<{
  type: "neutron:msgbus:probe";
  version: 1;
}>;

export type MsgBusFrameReadyEnvelope = Readonly<{
  type: "neutron:msgbus:ready";
  version: 1;
}>;

export const MSG_BUS_FRAME_PROBE: MsgBusFrameProbeEnvelope = Object.freeze({
  type: "neutron:msgbus:probe",
  version: 1,
});

export const MSG_BUS_FRAME_READY: MsgBusFrameReadyEnvelope = Object.freeze({
  type: "neutron:msgbus:ready",
  version: 1,
});

export function isMsgBusFrameProbe(
  value: unknown,
): value is MsgBusFrameProbeEnvelope {
  return isExactEnvelope(value, MSG_BUS_FRAME_PROBE.type);
}

export function isMsgBusFrameReady(
  value: unknown,
): value is MsgBusFrameReadyEnvelope {
  return isExactEnvelope(value, MSG_BUS_FRAME_READY.type);
}

function isExactEnvelope(
  value: unknown,
  type: MsgBusFrameProbeEnvelope["type"] | MsgBusFrameReadyEnvelope["type"],
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as { type?: unknown }).type === type &&
    (value as { version?: unknown }).version === 1
  );
}
