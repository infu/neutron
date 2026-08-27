import { afterEach, expect, test } from "bun:test";
import type { MsgBusToolDescriptor } from "neutron-tools";
import {
  MAX_ATTACHMENT_IN_FLIGHT_BYTES_GLOBAL,
  MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT,
  MAX_TOOL_ATTACHMENT_BYTES,
  ATTACHMENT_DELEGATION_TTL_MS,
  acquireAttachmentCapacity,
  assertAttachmentExecEnvelope,
  assertAttachmentResponseEnvelope,
  attachmentCapacitySnapshot,
  attachmentDelegationSnapshot,
  attachmentTransportSnapshot,
  consumeAttachmentDelegation,
  execEndpointWithAttachments,
  handleAttachmentReply,
  issueAttachmentDelegation,
  parseToolAttachmentContract,
  validateToolAttachments,
  type AttachmentCapacityReservation,
  type ToolAttachment,
} from "../src/attachment_bus.ts";
import {
  connectFrameEndpoint,
  getRegisteredEndpoint,
  registerFrameContext,
  subscribeEndpointPortMessages,
} from "../src/frame_context.ts";

const cleanup: Array<() => void> = [];
const reservations: AttachmentCapacityReservation[] = [];

afterEach(() => {
  while (reservations.length) reservations.pop()?.release();
  while (cleanup.length) cleanup.pop()?.();
  expect(attachmentCapacitySnapshot()).toEqual({
    global: 0,
    endpoints: {},
    reservations: 0,
  });
  expect(attachmentDelegationSnapshot()).toEqual({ pending: 0 });
});

function descriptor(
  declaration: unknown,
): MsgBusToolDescriptor {
  return {
    name: "binary",
    inputSchema: { type: "object" },
    annotations: {
      "neutron:attachments": declaration as never,
    },
  };
}

function attachment(bytes: number, mediaType = "application/octet-stream") {
  const data = new ArrayBuffer(bytes);
  return {
    name: "data",
    mediaType,
    byteLength: bytes,
    data,
  } satisfies ToolAttachment;
}

function registeredEndpoint(appId: string) {
  const source = {} as Window;
  cleanup.push(
    registerFrameContext(source, { role: "background", appId }),
  );
  const endpoint = getRegisteredEndpoint(`app:${appId}:background`);
  if (!endpoint) throw new Error("missing endpoint");
  return endpoint;
}

function connectedEndpoint(appId: string) {
  let appPort: MessagePort | undefined;
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer?: Transferable[],
    ) {
      if (transfer?.[0]) appPort = transfer[0] as MessagePort;
    },
  } as unknown as Window;
  cleanup.push(
    registerFrameContext(
      source,
      { role: "background", appId },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(source, true)).toBe(true);
  const endpoint = getRegisteredEndpoint(`app:${appId}:background`);
  if (!endpoint || !appPort) throw new Error("missing connected endpoint");
  cleanup.push(() => appPort?.close());
  return endpoint;
}

const invocationMetadata = {
  id: "invocation-id-000000000001",
  rootId: "invocation-root-000000001",
  capability: "capability-00000000000000000000000000000001",
};

function expectDelegationInvalid(operation: () => unknown): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: "ATTACHMENT_DELEGATION_INVALID" });
}

test("attachment declarations are closed, bounded, and media-type specific", () => {
  const contract = parseToolAttachmentContract(
    descriptor({
      version: 1,
      input: {
        name: "data",
        mediaTypes: ["application/octet-stream"],
        maxBytes: 8,
        required: true,
      },
      output: {
        name: "data",
        mediaTypes: ["application/octet-stream"],
        maxBytes: 4,
        required: true,
      },
    }),
  );
  expect(contract).toEqual({
    version: 1,
    input: {
      name: "data",
      mediaTypes: ["application/octet-stream"],
      maxBytes: 8,
      required: true,
    },
    output: {
      name: "data",
      mediaTypes: ["application/octet-stream"],
      maxBytes: 4,
      required: true,
    },
  });
  validateToolAttachments([attachment(8)], contract!.input, "input");
  expect(() =>
    validateToolAttachments(
      [attachment(1, "text/csv")],
      contract!.input,
      "input",
    ),
  ).toThrow("unsupported media type");
  expect(() =>
    validateToolAttachments([attachment(9)], contract!.input, "input"),
  ).toThrow("declared byte limit");
  expect(() => validateToolAttachments([], contract!.input, "input")).toThrow(
    "requires the declared input attachment",
  );

  expect(() =>
    parseToolAttachmentContract(
      descriptor({
        version: 1,
        input: {
          name: "data",
          mediaTypes: ["application/octet-stream"],
          maxBytes: MAX_TOOL_ATTACHMENT_BYTES + 1,
          required: true,
        },
      }),
    ),
  ).toThrow("invalid input attachment declaration");
  expect(() =>
    parseToolAttachmentContract(
      descriptor({ version: 1, input: contract!.input, extra: true }),
    ),
  ).toThrow("invalid attachment declaration");
});

test("wire envelopes accept one exact ArrayBuffer and reject arbitrary clones", () => {
  const request = {
    type: "neutron:msgbus:attachment:exec",
    version: 1,
    id: 7,
    payload: {
      action: "tools.call",
      payload: {
        target: "app:files:background",
        name: "writeBinary",
        arguments: { path: "/book.xlsx" },
      },
    },
    attachments: [attachment(3)],
  };
  expect(assertAttachmentExecEnvelope(request).id).toBe(7);
  expect(() =>
    assertAttachmentExecEnvelope({
      ...request,
      attachments: [attachment(1), attachment(1)],
    }),
  ).toThrow("At most one attachment");
  expect(() =>
    assertAttachmentExecEnvelope({
      ...request,
      attachments: [
        {
          name: "data",
          mediaType: "application/octet-stream",
          byteLength: 3,
          data: new Uint8Array(3),
        },
      ],
    }),
  ).toThrow("Invalid binary tool attachment");
  expect(() =>
    assertAttachmentExecEnvelope({ ...request, unexpected: true }),
  ).toThrow("Invalid attachment request envelope");
  expect(() =>
    assertAttachmentExecEnvelope({ ...request, delegationToken: "malformed" }),
  ).toThrow("Invalid attachment delegation token");
  try {
    assertAttachmentExecEnvelope({ ...request, delegationToken: "malformed" });
  } catch (error) {
    expect(error).toMatchObject({ code: "ATTACHMENT_DELEGATION_INVALID" });
  }

  expect(() =>
    assertAttachmentResponseEnvelope({
      type: "neutron:msgbus:attachment:response",
      version: 1,
      id: 7,
      error: { message: "no" },
      attachments: [attachment(1)],
    }),
  ).toThrow("cannot include data");
});

test("delegation tokens are endpoint-bound, one-use, and expire closed", () => {
  const owner = connectedEndpoint("delegation_owner");
  const other = connectedEndpoint("delegation_other");
  const issued = issueAttachmentDelegation(owner, invocationMetadata);
  expect(issued.token).toMatch(/^[a-f0-9]{48}$/);
  expect(consumeAttachmentDelegation(owner, issued.token)).toEqual(
    invocationMetadata,
  );
  expectDelegationInvalid(() =>
    consumeAttachmentDelegation(owner, issued.token),
  );

  const wrongEndpoint = issueAttachmentDelegation(owner, invocationMetadata);
  expectDelegationInvalid(() =>
    consumeAttachmentDelegation(other, wrongEndpoint.token),
  );
  expectDelegationInvalid(() =>
    consumeAttachmentDelegation(owner, wrongEndpoint.token),
  );

  const now = Date.now();
  const expired = issueAttachmentDelegation(owner, invocationMetadata, now);
  expectDelegationInvalid(() =>
    consumeAttachmentDelegation(
      owner,
      expired.token,
      now + ATTACHMENT_DELEGATION_TTL_MS,
    ),
  );
  expect(attachmentDelegationSnapshot()).toEqual({ pending: 0 });
});

test("delegation admission is bounded per endpoint and globally", () => {
  const endpoints = Array.from({ length: 17 }, (_, index) =>
    connectedEndpoint(`delegation_bound_${index}`),
  );
  for (let index = 0; index < 4; index += 1) {
    issueAttachmentDelegation(endpoints[0]!, invocationMetadata);
  }
  expect(() =>
    issueAttachmentDelegation(endpoints[0]!, invocationMetadata),
  ).toThrow("This endpoint has too many pending attachment delegations");
  for (const endpoint of endpoints.slice(1, 16)) {
    for (let index = 0; index < 4; index += 1) {
      issueAttachmentDelegation(endpoint, invocationMetadata);
    }
  }
  expect(attachmentDelegationSnapshot()).toEqual({ pending: 64 });
  expect(() =>
    issueAttachmentDelegation(endpoints[16]!, invocationMetadata),
  ).toThrow("Too many pending attachment delegations");
});

test("endpoint replacement prunes every outstanding delegation", () => {
  const endpoint = connectedEndpoint("delegation_cleanup");
  issueAttachmentDelegation(endpoint, invocationMetadata);
  issueAttachmentDelegation(endpoint, invocationMetadata);
  expect(attachmentDelegationSnapshot()).toEqual({ pending: 2 });
  const unregister = cleanup.splice(cleanup.length - 2, 1)[0];
  unregister?.();
  expect(attachmentDelegationSnapshot()).toEqual({ pending: 0 });
});

test("settlement-retained capacity survives disconnect until explicit release", () => {
  const endpoint = registeredEndpoint("capacity_settlement");
  const reservation = acquireAttachmentCapacity(endpoint, 2048);
  reservations.push(reservation);
  reservation.retainUntilSettlement();
  cleanup.pop()?.();
  expect(reservation.signal.aborted).toBe(true);
  expect(attachmentCapacitySnapshot().global).toBe(2048);
  reservation.release();
  expect(attachmentCapacitySnapshot()).toEqual({
    global: 0,
    endpoints: {},
    reservations: 0,
  });
});

test("capacity is capped per endpoint and globally and releases exactly once", () => {
  const first = registeredEndpoint("capacity_one");
  const second = registeredEndpoint("capacity_two");
  const third = registeredEndpoint("capacity_three");
  const one = acquireAttachmentCapacity(
    first,
    MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT,
  );
  reservations.push(one);
  expect(() => acquireAttachmentCapacity(first, 1)).toThrow(
    "Endpoint attachment in-flight byte limit",
  );
  const two = acquireAttachmentCapacity(
    second,
    MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT,
  );
  reservations.push(two);
  expect(attachmentCapacitySnapshot().global).toBe(
    MAX_ATTACHMENT_IN_FLIGHT_BYTES_GLOBAL,
  );
  expect(() => acquireAttachmentCapacity(third, 1)).toThrow(
    "Global attachment in-flight byte limit",
  );
  one.release();
  expect(attachmentCapacitySnapshot().global).toBe(
    MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT,
  );
  one.release();
  expect(attachmentCapacitySnapshot().global).toBe(
    MAX_ATTACHMENT_IN_FLIGHT_BYTES_PER_ENDPOINT,
  );
});

test("endpoint removal aborts and releases an active reservation", () => {
  const endpoint = registeredEndpoint("capacity_disconnect");
  const reservation = acquireAttachmentCapacity(endpoint, 1024);
  reservations.push(reservation);
  cleanup.pop()?.();
  expect(reservation.signal.aborted).toBe(true);
  expect(attachmentCapacitySnapshot()).toEqual({
    global: 0,
    endpoints: {},
    reservations: 0,
  });
});

test("attachment progress keeps total bounds without an elapsed-time quota", async () => {
  let appPort: MessagePort | undefined;
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer?: Transferable[],
    ) {
      if (transfer?.[0]) appPort = transfer[0] as MessagePort;
    },
  } as unknown as Window;
  cleanup.push(
    registerFrameContext(
      source,
      { role: "background", appId: "attachment_progress" },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(source, true)).toBe(true);
  const endpoint = getRegisteredEndpoint("app:attachment_progress:background");
  if (!endpoint || !appPort) throw new Error("missing connected endpoint");
  const values: unknown[] = [];
  cleanup.push(
    subscribeEndpointPortMessages(({ endpoint: sourceEndpoint, event }) => {
      if (sourceEndpoint === endpoint) {
        handleAttachmentReply(sourceEndpoint, event.data);
      }
    }),
  );
  appPort.addEventListener("message", (event) => {
    const request = event.data as { id: number };
    for (let index = 0; index < 40; index += 1) {
      appPort?.postMessage({
        type: "neutron:msgbus:attachment:progress",
        version: 1,
        id: request.id,
        value: { index },
      });
    }
    appPort?.postMessage({
      type: "neutron:msgbus:attachment:response",
      version: 1,
      id: request.id,
      ok: { complete: true },
    });
  });
  appPort.start();

  await expect(
    execEndpointWithAttachments(
      endpoint,
      "__neutron_msgbus_tools_call",
      { name: "stream", arguments: {} },
      [],
      { timeoutSeconds: 1, onProgress: (value) => values.push(value) },
    ),
  ).resolves.toEqual({ value: { complete: true }, attachments: [] });
  expect(values).toEqual(
    Array.from({ length: 40 }, (_, index) => ({ index })),
  );
  appPort.close();
});

test("outgoing timeout drops callback state after transferring its input", async () => {
  let appPort: MessagePort | undefined;
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer?: Transferable[],
    ) {
      if (transfer?.[0]) appPort = transfer[0] as MessagePort;
    },
  } as unknown as Window;
  cleanup.push(
    registerFrameContext(
      source,
      { role: "background", appId: "attachment_timeout" },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(source, true)).toBe(true);
  const endpoint = getRegisteredEndpoint("app:attachment_timeout:background");
  if (!endpoint || !appPort) throw new Error("missing connected endpoint");
  const data = new Uint8Array([1, 2, 3]).buffer;
  const pending = execEndpointWithAttachments(
    endpoint,
    "__neutron_msgbus_tools_call",
    { name: "hang", arguments: {} },
    [
      {
        name: "data",
        mediaType: "application/octet-stream",
        byteLength: data.byteLength,
        data,
      },
    ],
    { timeoutSeconds: 0.01 },
  );
  expect(data.byteLength).toBe(0);
  expect(attachmentTransportSnapshot()).toEqual({ pendingCalls: 1 });
  await expect(pending).rejects.toMatchObject({ code: "ATTACHMENT_TIMEOUT" });
  expect(attachmentTransportSnapshot()).toEqual({ pendingCalls: 0 });
  appPort.close();
});

test("endpoint reconnection rejects pending calls and active byte reservations", async () => {
  const appPorts: MessagePort[] = [];
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer?: Transferable[],
    ) {
      if (transfer?.[0]) appPorts.push(transfer[0] as MessagePort);
    },
  } as unknown as Window;
  cleanup.push(
    registerFrameContext(
      source,
      { role: "background", appId: "attachment_reconnect" },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(source, true)).toBe(true);
  const endpoint = getRegisteredEndpoint("app:attachment_reconnect:background");
  if (!endpoint) throw new Error("missing connected endpoint");
  const reservation = acquireAttachmentCapacity(endpoint, 4096);
  reservations.push(reservation);
  const pending = execEndpointWithAttachments(
    endpoint,
    "__neutron_msgbus_tools_call",
    { name: "hang", arguments: {} },
    [],
    { timeoutSeconds: 10 },
  );
  expect(connectFrameEndpoint(source, true)).toBe(true);
  await expect(pending).rejects.toMatchObject({
    code: "ATTACHMENT_ENDPOINT_CHANGED",
  });
  expect(reservation.signal.aborted).toBe(true);
  expect(attachmentTransportSnapshot()).toEqual({ pendingCalls: 0 });
  expect(attachmentCapacitySnapshot()).toEqual({
    global: 0,
    endpoints: {},
    reservations: 0,
  });
  for (const port of appPorts) port.close();
});
