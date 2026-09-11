/**
 * Every self-call this app makes, validated against the app's own generated
 * method schema.
 *
 * Self-call API 1 is not "Candid shapes in JavaScript", and the difference is
 * silent until runtime:
 *
 *   option    the bare value, `null`, or an omitted key — NEVER `[]` / `[v]`.
 *             A `[]` reaches the encoder where a scalar is expected and the
 *             whole call dies with "Self-call scalar does not match the live
 *             Candid type", before any backend validation runs.
 *   Nat/Nat64 a lossless decimal string, not a number.
 *   blob      a Uint8Array, lifted into a binary sidecar by the wire encoder.
 *   principal its text form.
 *   result    a two-field ok/err variant is unwrapped by the Kernel: `ok` is
 *             returned and `err` is thrown, so there is no `{ ok, err }`
 *             envelope in the reply.
 *
 * The payloads here are not written by hand — they are captured from the real
 * call sites through a stubbed `neutron-tools/app`, so this cannot drift from
 * what the app actually sends.
 */

import { beforeAll, expect, mock, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import type { MsgBusToolContext, ScopedKernelClient } from "neutron-tools/app";
import { normalizeToolDescriptor, type MsgBusToolDescriptor } from "neutron-tools/protocol";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

declare global {
  // eslint-disable-next-line no-var
  var __snsgovRefuseTileOpen: boolean | undefined;
}

interface Captured {
  method: string;
  args: unknown[];
}

const captured: Captured[] = [];
/** Tool handlers, captured the one time `src/service.ts` is imported. */
const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
/** Tile-view requests the service made, e.g. after drafting a proposal. */
const tileOpens: { appId: string; tileId: string; view?: string }[] = [];
let insideTool = 0;
const scopedKernel = {
  async querySelf(method: string, args: unknown[] = []) {
    captured.push({ method, args });
    return replyFor(method);
  },
  async updateSelf(method: string, args: unknown[] = []) {
    captured.push({ method, args });
    return replyFor(method);
  },
  async callTool(request: { target: string; name: string; arguments: { appId: string; tileId: string; view?: string } }) {
    expect(request.target).toBe("kernel");
    expect(request.name).toBe("workspace.open_tile");
    if (globalThis.__snsgovRefuseTileOpen) throw new Error("workspace is full");
    tileOpens.push(request.arguments);
    return { instanceId: "i1", workspace: 0, opened: true };
  },
} as unknown as ScopedKernelClient;

mock.module("neutron-tools/app", () => ({
  querySelf: async (method: string, args: unknown[] = []) => {
    if (insideTool) throw new Error("tool attempted ambient querySelf");
    captured.push({ method, args });
    return replyFor(method);
  },
  updateSelf: async (method: string, args: unknown[] = []) => {
    if (insideTool) throw new Error("tool attempted ambient updateSelf");
    captured.push({ method, args });
    return replyFor(method);
  },
  callTool: async () => {
    if (insideTool) throw new Error("tool attempted ambient callTool");
    throw new Error("unexpected ambient callTool in self-call test");
  },
  copyToClipboard: async () => {},
  openAppTile: async (request: { appId: string; tileId: string; view?: string }) => {
    if (insideTool) throw new Error("tool attempted ambient openAppTile");
    if (globalThis.__snsgovRefuseTileOpen) throw new Error("workspace is full");
    tileOpens.push(request);
    return { instanceId: "i1", workspace: 0, opened: true };
  },
  onTileViewRequest: () => () => {},
  exposeTool: (
    name: string,
    options: Omit<MsgBusToolDescriptor, "name">,
    handler: (args: unknown, context: MsgBusToolContext) => Promise<unknown>,
  ) => {
    // A valid handler is unreachable if the resident fails schema registration.
    // Keep the shared production validator even with the Kernel calls stubbed.
    normalizeToolDescriptor({ name, ...options } as MsgBusToolDescriptor);
    handlers.set(name, async (args) => {
      insideTool += 1;
      try { return await handler(args, {
        kernel: scopedKernel,
        caller: { appId: "agent", installationUid: "12", role: "background", endpoint: "app:agent:background" },
        agentMode: false,
        reportProgress() {},
        requestApproval: async () => { throw new Error("read-only test unexpectedly requested approval"); },
        presentUserInterface: async () => { throw new Error("read-only test unexpectedly requested owner review"); },
      } as unknown as MsgBusToolContext); }
      finally { insideTool -= 1; }
    });
  },
}));

const replyOverrides = new Map<string, () => unknown>();

/** Minimal successful replies in the Kernel's projected (unwrapped) shape. */
function replyFor(method: string): unknown {
  const override = replyOverrides.get(method);
  if (override) return override();
  if (method === "snsgov_hotkey") {
    return { principal: "rrkah-fqaaa-aaaaa-aaaaq-cai", can_manage_neuron: true };
  }
  if (method === "snsgov_config") return { snses: [], audit_rows: "0", max_audit_rows: "1000" };
  if (method === "snsgov_drafts") return [];
  if (method === "snsgov_audit") return { rows: [], total: "0" };
  if (method === "snsgov_relay") return new Uint8Array([0x44, 0x49, 0x44, 0x4c, 0x00, 0x00]);
  if (method === "snsgov_relay_batch") {
    return { results: [{ err: "stub" }], attempted: "1", succeeded: "0" };
  }
  if (method === "snsgov_draft_save") return "1";
  return null;
}

let schema: {
  methods: Record<string, { input: JsonSchema; output: JsonSchema; type: string }>;
};

beforeAll(async () => {
  // `npm run package` (which `npm test` runs first) regenerates this.
  schema = JSON.parse(await readFile(join(appRoot, "dist/schema.json"), "utf8"));
});

// --- a focused validator for the subset the generator emits -----------------

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  prefixItems?: JsonSchema[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
};

function validate(value: unknown, spec: JsonSchema, path: string, problems: string[]): void {
  if (spec.oneOf) {
    const branches = spec.oneOf.map((branch) => {
      const local: string[] = [];
      validate(value, branch, path, local);
      return local;
    });
    if (branches.every((local) => local.length > 0)) {
      problems.push(`${path}: matches none of ${spec.oneOf.length} alternatives`);
    }
    return;
  }
  switch (spec.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${path}: expected object, got ${describe(value)}`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const name of spec.required ?? []) {
        if (!Object.hasOwn(record, name)) problems.push(`${path}.${name}: missing required field`);
      }
      for (const [name, entry] of Object.entries(record)) {
        const child = spec.properties?.[name];
        if (!child) {
          if (spec.additionalProperties === false) {
            problems.push(`${path}.${name}: unknown field`);
          }
          continue;
        }
        // An option may be sent as null; anything else must match the type.
        if (entry === null && !(spec.required ?? []).includes(name)) continue;
        validate(entry, child, `${path}.${name}`, problems);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        problems.push(`${path}: expected array, got ${describe(value)}`);
        return;
      }
      if (spec.prefixItems) {
        if (spec.minItems !== undefined && value.length < spec.minItems) {
          problems.push(`${path}: expected at least ${spec.minItems} items`);
        }
        spec.prefixItems.forEach((child, index) =>
          validate(value[index], child, `${path}[${index}]`, problems),
        );
        return;
      }
      if (spec.items) {
        value.forEach((entry, index) =>
          validate(entry, spec.items!, `${path}[${index}]`, problems),
        );
      }
      return;
    }
    case "string":
      // The generator marks Nat/Nat64 as "bigint as string": a number here is
      // the classic lossy mistake and is rejected on the wire.
      if (typeof value !== "string") {
        problems.push(
          `${path}: expected string${spec.description ? ` (${spec.description})` : ""}, got ${describe(value)}`,
        );
      }
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`${path}: expected number, got ${describe(value)}`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path}: expected boolean, got ${describe(value)}`);
      return;
    case "null":
      if (value !== null) problems.push(`${path}: expected null, got ${describe(value)}`);
      return;
    default:
      return;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * A blob is a `Uint8Array` on this wire and is lifted into a sidecar before the
 * JSON shape is checked, so substitute the projection the encoder produces.
 */
function projectBinary(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(projectBinary);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, projectBinary(v)]),
    );
  }
  return value;
}

function check(entry: Captured): string[] {
  const method = schema.methods[entry.method];
  if (!method) return [`${entry.method}: not present in the generated schema`];
  const problems: string[] = [];
  validate(projectBinary(entry.args), method.input, entry.method, problems);
  return problems;
}

async function capture(run: () => Promise<unknown>): Promise<Captured[]> {
  captured.length = 0;
  await run().catch(() => {});
  return [...captured];
}

// --- the call sites ---------------------------------------------------------

test("readHotkey sends a valid payload", async () => {
  const { readHotkey } = await import("../src/data/relay");
  const calls = await capture(() => readHotkey());
  expect(calls.length).toBe(1);
  expect(calls.flatMap(check)).toEqual([]);
});

// The regression that broke voting: `proposal_id: [id]` and `vote: [n]`.
test("voteWithNeurons sends options as bare values, not Candid arrays", async () => {
  const { voteWithNeurons } = await import("../src/data/relay");
  const calls = await capture(() =>
    voteWithNeurons({
      snsRootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
      proposalId: 1066n,
      neuronIds: ["00".repeat(31) + "07"],
      adopt: true,
    }),
  );
  expect(calls.length).toBe(1);
  expect(calls.flatMap(check)).toEqual([]);
  const payload = calls[0]!.args[0] as Record<string, unknown>;
  expect(payload.proposal_id).toBe("1066");
  expect(payload.vote).toBe(1);
});

test("relayManageNeuron omits absent options entirely", async () => {
  const { relayManageNeuron } = await import("../src/data/relay");
  const calls = await capture(() =>
    relayManageNeuron({
      snsRootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
      args: new Uint8Array([1, 2, 3]),
      kind: "grant",
    }),
  );
  expect(calls.length).toBe(1);
  expect(calls.flatMap(check)).toEqual([]);
  const payload = calls[0]!.args[0] as Record<string, unknown>;
  expect(Object.hasOwn(payload, "proposal_id")).toBe(false);
  expect(Object.hasOwn(payload, "vote")).toBe(false);
});

// Guards the mistake directly: had these been the old `[]` / `[v]` payloads,
// the validator must reject them. Without this, a future regression could pass
// by making the validator too permissive.
test("the validator rejects the Candid-array option shape it exists to catch", () => {
  const broken = [
    {
      sns: "extk7-gaaaa-aaaaq-aacda-cai",
      governance: "eqsml-lyaaa-aaaaq-aacdq-cai",
      title: "t",
      summary: "s",
      url: "",
      action_kind: "Motion",
      id: [],
      payload: [],
      function_id: ["3"],
      rendering: [],
      proposer: [],
      created_by: "agent",
    },
  ];
  const problems: string[] = [];
  validate(broken, schema.methods.snsgov_draft_save!.input, "snsgov_draft_save", problems);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join(" ")).toContain("function_id");
});

// The reported failure. `sns_draft_proposal` is exercised through its real tool
// handler so the payload is the one the agent actually sends.
test("sns_draft_proposal sends a payload the backend can decode", async () => {
  const registry = await import("../src/data/registry");
  mock.module("../src/data/registry", () => ({
    ...registry,
    requireEntry: async () => ({
      canisters: {
        root: "extk7-gaaaa-aaaaq-aacda-cai",
        governance: "eqsml-lyaaa-aaaaq-aacdq-cai",
        ledger: "extk7-gaaaa-aaaaq-aacea-cai",
        swap: null,
        index: null,
      },
      liveness: { governance: true },
    }),
    getRegistry: async () => ({ entries: [], fetchedAt: 0 }),
    displayName: () => "Neutrinite",
  }));
  // Spread the real module: replacing it wholesale would strip the exports
  // other importers of `governance` still need.
  const governance = await import("../src/data/governance");
  mock.module("../src/data/governance", () => ({
    ...governance,
    listNervousSystemFunctions: async () => [
      { id: 3n, name: "custom", kind: "generic", topic: "DaoCommunitySettings" },
    ],
  }));


  await import("../src/service");
  const draft = handlers.get("sns_draft_proposal");
  if (!draft) throw new Error("sns_draft_proposal was never exposed");

  // Both branches: a Motion (whose text is persisted as the action payload),
  // and a custom function with an optional function_id present.
  for (const extra of [
    { motionText: "Adopt the thing." },
    { functionId: "3", actionKind: "custom", payloadHex: "4449444c0000" },
  ]) {
    const calls = await capture(() =>
      draft({
        rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
        title: "Fund the thing",
        summary: "Because it is worth funding.",
        ...extra,
      }),
    );
    const saves = calls.filter((entry) => entry.method === "snsgov_draft_save");
    expect(saves.length).toBe(1);
    expect(saves.flatMap(check)).toEqual([]);
    const payload = saves[0]!.args[0] as Record<string, unknown>;
    // Absent options must be omitted keys, never `[]`.
    for (const name of ["id", "rendering", "proposer"]) {
      expect(Object.hasOwn(payload, name)).toBe(false);
    }
    expect(payload.function_id).toBe(
      (extra as { functionId?: string }).functionId ?? undefined,
    );
  }
});

test("sns_vote_history sends Nat fields as decimal strings", async () => {
  await import("../src/service");
  const history = handlers.get("sns_vote_history");
  if (!history) throw new Error("sns_vote_history was never exposed");

  for (const args of [{}, { limit: 10, before: 42 }]) {
    const calls = await capture(() => history(args));
    const audits = calls.filter((entry) => entry.method === "snsgov_audit");
    expect(audits.length).toBe(1);
    expect(audits.flatMap(check)).toEqual([]);
    const payload = audits[0]!.args[0] as Record<string, unknown>;
    expect(typeof payload.limit).toBe("string");
    if ("before" in args) expect(payload.before).toBe("42");
    else expect(Object.hasOwn(payload, "before")).toBe(false);
  }
});
test("every self-call method the app names exists in the schema", async () => {
  const sources = await Promise.all(
    ["src/service.ts", "src/data/relay.ts", "src/ui/Setup.tsx", "src/ui/Registration.tsx"].map(
      async (path) => readFile(join(appRoot, path), "utf8"),
    ),
  );
  const named = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/(?:querySelf|updateSelf)\(\s*"([a-z0-9_]+)"/g)) {
      named.add(match[1]!);
    }
  }
  expect(named.size).toBeGreaterThan(0);
  const unknown = [...named].filter((name) => !schema.methods[name]);
  expect(unknown).toEqual([]);
});

// `motionText` used to be accepted by the tool schema and then dropped, leaving
// a Motion draft that no one could send.
test("a Motion's text is persisted, and a Motion without one is refused", async () => {
  const draft = handlers.get("sns_draft_proposal");
  if (!draft) throw new Error("sns_draft_proposal was never exposed");

  const calls = await capture(() =>
    draft({
      rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
      title: "Adopt",
      summary: "Summary is not the motion.",
      motionText: "The DAO resolves to do the thing.",
    }),
  );
  const save = calls.find((entry) => entry.method === "snsgov_draft_save");
  const payload = save!.args[0] as Record<string, unknown>;
  expect(payload.action_kind).toBe("Motion");
  expect(new TextDecoder().decode(payload.payload as Uint8Array)).toBe(
    "The DAO resolves to do the thing.",
  );

  await expect(
    draft({
      rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
      title: "Adopt",
      summary: "No motion text supplied.",
    }),
  ).rejects.toThrow(/motionText is required/);
});

// The owner should not have to know where drafts live: the agent points the
// tile straight at what it just wrote.
test("drafting a proposal opens the tile on that draft", async () => {
  const draft = handlers.get("sns_draft_proposal");
  if (!draft) throw new Error("sns_draft_proposal was never exposed");
  tileOpens.length = 0;

  const result = (await draft({
    rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
    title: "Adopt",
    summary: "A summary.",
    motionText: "The DAO resolves.",
  })) as { draftId: string; shownToOwner: boolean };

  expect(tileOpens.length).toBe(1);
  expect(tileOpens[0]).toMatchObject({
    appId: "snsgov",
    tileId: "main",
    view: `draft/${result.draftId}`,
  });
  expect(result.shownToOwner).toBe(true);
});

// A Kernel that refuses to open a tile must not turn a saved draft into a
// failed one — the draft is still there, and the header count still shows it.
test("a refused tile open still reports the draft as saved", async () => {
  const draft = handlers.get("sns_draft_proposal");
  if (!draft) throw new Error("sns_draft_proposal was never exposed");
  const restore = globalThis.__snsgovRefuseTileOpen;
  globalThis.__snsgovRefuseTileOpen = true;
  try {
    const result = (await draft({
      rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
      title: "Adopt",
      summary: "A summary.",
      motionText: "The DAO resolves.",
    })) as { draftId: string; shownToOwner: boolean };
    expect(result.draftId).toBe("1");
    expect(result.shownToOwner).toBe(false);
  } finally {
    globalThis.__snsgovRefuseTileOpen = restore;
  }
});

// `get_sns_canisters_summary` is an update that makes root fan out one
// management call per canister and pay for each. An agent listing canisters
// must not spend the DAO's cycles as a side effect of looking.
test("sns_canisters reads cycles only when asked", async () => {
  let summaryCalls = 0;
  const rootModule = await import("../src/data/root");
  mock.module("../src/data/root", () => ({
    ...rootModule,
    listSnsCanisters: async () => [
      { canisterId: "extk7-gaaaa-aaaaq-aacda-cai", role: "root" },
      { canisterId: "uwkt7-miaaa-aaaal-qdeuq-cai", role: "dapp" },
    ],
    readCanistersCycles: async () => {
      summaryCalls += 1;
      return [
        { canisterId: "extk7-gaaaa-aaaaq-aacda-cai", role: "root", cycles: 93_951_889_123_456n, status: "running" },
        // Root reports an unreachable canister with no status at all.
        { canisterId: "uwkt7-miaaa-aaaal-qdeuq-cai", role: "dapp" },
      ];
    },
  }));

  const handlers2 = new Map<string, (args: unknown) => Promise<unknown>>();
  const service = await import("../src/service");
  void service;
  const canisters = handlers.get("sns_canisters") ?? handlers2.get("sns_canisters");
  if (!canisters) throw new Error("sns_canisters was never exposed");

  const listed = (await canisters({
    rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
  })) as { total: number; totalCycles?: string; note?: string };
  expect(summaryCalls).toBe(0);
  expect(listed.total).toBe(2);
  expect(listed.totalCycles).toBeUndefined();
  expect(listed.note).toMatch(/withCycles/);

  const withCycles = (await canisters({
    rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
    withCycles: true,
  })) as {
    totalCycles: string;
    unreachable: number;
    canisters: { canisterId: string; cycles: string | null; status: string }[];
  };
  expect(summaryCalls).toBe(1);
  expect(withCycles.totalCycles).toBe("93.951T");
  // An unreachable canister is unknown, never zero.
  expect(withCycles.unreachable).toBe(1);
  expect(withCycles.canisters[1]!.cycles).toBeNull();
  expect(withCycles.canisters[1]!.status).toBe("unreachable");
});

// An agent that says "I've opened Neutrinite" when nothing moved is worse than
// one that reports it could not. These pin the honest-reporting behaviour.
test("sns_show opens the tile on the page it names", async () => {
  const governance = await import("../src/data/governance");
  mock.module("../src/data/governance", () => ({
    ...governance,
    getProposal: async (_gov: string, id: bigint) =>
      id === 1066n ? { id, title: "A proposal", ballots: [] } : null,
  }));

  const service = await import("../src/service");
  void service;
  const show = handlers.get("sns_show");
  if (!show) throw new Error("sns_show was never exposed");

  tileOpens.length = 0;
  const sns = (await show({ rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai" })) as {
    view: string;
    showing: string;
  };
  expect(sns.view).toBe("sns/extk7-gaaaa-aaaaq-aacda-cai");
  expect(tileOpens[0]).toMatchObject({ appId: "snsgov", tileId: "main" });

  const tab = (await show({
    rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
    tab: "canisters",
  })) as { view: string };
  expect(tab.view).toBe("sns/extk7-gaaaa-aaaaq-aacda-cai/canisters");

  const proposal = (await show({
    rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai",
    proposalId: "1066",
  })) as { view: string };
  expect(proposal.view).toBe("sns/extk7-gaaaa-aaaaq-aacda-cai/proposals/1066");

  const drafts = (await show({ screen: "drafts" })) as { view: string };
  expect(drafts.view).toBe("drafts");
  expect(tileOpens.length).toBe(4);
});

test("sns_show refuses a proposal that does not exist", async () => {
  const show = handlers.get("sns_show");
  if (!show) throw new Error("sns_show was never exposed");
  tileOpens.length = 0;
  await expect(
    show({ rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", proposalId: "999999" }),
  ).rejects.toThrow(/no proposal 999999/);
  // Nothing was opened, so nothing is claimed.
  expect(tileOpens.length).toBe(0);
});

test("sns_show reports a refused open instead of claiming success", async () => {
  const show = handlers.get("sns_show");
  if (!show) throw new Error("sns_show was never exposed");
  const restore = globalThis.__snsgovRefuseTileOpen;
  globalThis.__snsgovRefuseTileOpen = true;
  try {
    await expect(show({ screen: "setup" })).rejects.toThrow(/could not open the tile/);
  } finally {
    globalThis.__snsgovRefuseTileOpen = restore;
  }
});


test("custom drafts retain the exact payload and refuse missing bytes before saving", async () => {
  const draft = handlers.get("sns_draft_proposal")!;
  const input = { rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", title: "Custom", summary: "Review", actionKind: "custom", functionId: "3" };
  captured.length = 0;
  await expect(draft(input)).rejects.toThrow(/payloadHex/);
  expect(captured.filter((row) => row.method === "snsgov_draft_save")).toEqual([]);
  // Byte alignment is enforced by the handler because the shared schema
  // deliberately accepts only simple regexes, without repeated byte groups.
  for (const payloadHex of ["4449444c000", "4449444c000g", "0x4449444c0000", "44 49444c0000", "000000000000"]) {
    captured.length = 0;
    await expect(draft({ ...input, payloadHex })).rejects.toThrow(/payloadHex/);
    expect(captured.filter((row) => row.method === "snsgov_draft_save")).toEqual([]);
  }
  await draft({ ...input, payloadHex: "4449444c0000" });
  const saved = captured.find((row) => row.method === "snsgov_draft_save")!.args[0] as { payload: Uint8Array };
  expect(Array.from(saved.payload)).toEqual([68, 73, 68, 76, 0, 0]);
});

test("draft and hotkey agent reads use the invocation client", async () => {
  captured.length = 0;
  await handlers.get("sns_drafts")!({});
  await handlers.get("sns_my_neurons")!({});
  expect(captured.map((row) => row.method)).toEqual(["snsgov_drafts", "snsgov_hotkey", "snsgov_config"]);
});


test("a submitted draft reports cleanup failure without reporting submission failure", async () => {
  const { sendDraft } = await import("../src/data/drafts");
  const service = governanceIdl({ IDL }) as unknown as { _fields: [string, { retTypes: IDL.Type[] }][] };
  const type = service._fields.find(([name]) => name === "manage_neuron")![1].retTypes[0]!;
  replyOverrides.set("snsgov_relay", () => new Uint8Array(IDL.encode([type], [{ command: [{ MakeProposal: { proposal_id: [{ id: 987n }] } }] }])));
  replyOverrides.set("snsgov_draft_delete", () => { throw new Error("reply interrupted"); });
  try {
    const result = await sendDraft({ id: "7", sns: "extk7-gaaaa-aaaaq-aacda-cai", governance: "eqsml-lyaaa-aaaaq-aacdq-cai", title: "Adopt", summary: "Review", url: "", actionKind: "Motion", motionText: "Adopt this", createdBy: "agent", updatedAtSeconds: 0n }, "00".repeat(31) + "07");
    expect(result.proposalId).toBe(987n);
    expect(result.cleanupWarning).toContain("Do not send this draft again");
  } finally { replyOverrides.clear(); }
});

test("an undecodable signed relay response is unknown, never a definite rejection", async () => {
  const { relayManageNeuron } = await import("../src/data/relay");
  for (const reply of [new Uint8Array([0, 1, 2]), new Uint8Array([68, 73, 68, 76, 0, 0]), null]) {
    replyOverrides.set("snsgov_relay", () => reply);
    try {
      await expect(relayManageNeuron({ snsRootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", args: new Uint8Array([68, 73, 68, 76, 0, 0]), kind: "proposal" })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    } finally { replyOverrides.clear(); }
  }
});

test("agent vote planning uses the scoped principal and actual eligibility without the old unattended opt-in", async () => {
  const governance = await import("../src/data/governance");
  const neuronIds = Array.from({ length: 21 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
  const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
  let discoveryPrincipal: string | undefined;
  mock.module("../src/data/governance", () => ({
    ...governance,
    listAllNeurons: async (_governance: string, options: { ofPrincipal?: string }) => {
      discoveryPrincipal = options.ofPrincipal;
      return { neurons: neuronIds.map((id) => ({ id, permissions: [{ principal, permissions: [4] }] })), truncated: false, failures: [] };
    },
    getProposal: async () => ({ id: 1066n, title: "Review", status: "open", deadlineSeconds: BigInt(Math.floor(Date.now() / 1000)) + 3600n, ballots: neuronIds.map((neuronId) => ({ neuronId, vote: 0 })) }),
  }));
  const sns = "extk7-gaaaa-aaaaq-aacda-cai";
  replyOverrides.set("snsgov_config", () => ({ snses: [{ sns, governance: "eqsml-lyaaa-aaaaq-aacdq-cai", voting_enabled: true, agent_voting_enabled: false }] }));
  try {
    captured.length = 0;
    const plan = await handlers.get("sns_vote_plan")!({ rootCanisterId: sns, proposalId: "1066" }) as { eligibleNeuronIds: string[]; discoveryComplete: boolean };
    expect(plan.eligibleNeuronIds).toEqual(neuronIds);
    expect(plan.discoveryComplete).toBe(true);
    expect(discoveryPrincipal).toBe(principal);
    expect(captured.filter((row) => row.method === "snsgov_hotkey")).toHaveLength(1);
    expect(captured.every((row) => ["snsgov_hotkey", "snsgov_config"].includes(row.method))).toBe(true);
    // This is a planning/scope test; durable dispatch and partial SNS command
    // outcomes are covered by the operation and neuron-action suites.
  } finally { replyOverrides.clear(); }
});

test("native drafts retain exact action bytes and expose one durable submission identity", async () => {
  const draft = handlers.get("sns_draft_proposal")!;
  const { decodeProposalAction, proposalActionToJson } = await import("../src/data/proposal_actions");
  const { draftOperationId } = await import("../src/action_tools");
  const action = { Motion: { motion_text: "The DAO resolves to retain this exact action." } };
  captured.length = 0;
  await draft({ rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", title: "A native Motion", summary: "Review exact content", action });
  const saved = captured.find(row => row.method === "snsgov_draft_save")!.args[0] as Record<string, unknown>;
  expect(saved.action_kind).toBe("NativeActionV1");
  expect(saved.payload).toBeInstanceOf(Uint8Array);
  expect(proposalActionToJson(decodeProposalAction(saved.payload as Uint8Array))).toEqual(action);
  expect(captured.filter(row => row.method === "snsgov_draft_save").flatMap(check)).toEqual([]);
  const row = { ...saved, id: "44", created_at_seconds: "100", updated_at_seconds: "100" };
  replyOverrides.set("snsgov_drafts", () => [row]);
  try {
    const result = await handlers.get("sns_drafts")!({}) as { drafts: Record<string, unknown>[] };
    const retained = result.drafts[0]!;
    expect(retained.action).toEqual(action);
    expect(retained.payloadProvenance).toBe("original_saved_action");
    expect(retained.operationId).toMatch(/^[0-9a-f]{32}$/);
    expect(retained.operationId).toBe(await draftOperationId({ ...row, proposer: new Uint8Array(32).fill(7) }));
    expect(retained.operationId).not.toBe(await draftOperationId({ ...row, summary: "Changed content" }));
    expect(retained.operationId).not.toBe(await draftOperationId({ ...row, updated_at_seconds: "101" }));
  } finally { replyOverrides.clear(); }
  captured.length = 0;
  await expect(draft({ rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", title: "Mixed", summary: "Conflicting encodings", action, motionText: "Other text" })).rejects.toThrow(/mix|combine|legacy|explicit/i);
  expect(captured.some(row => row.method === "snsgov_draft_save")).toBe(false);
});

test("saved operation reads retain unknown outcomes and never dispatch while inspecting exact bytes", async () => {
  const { encodeRegisterVote } = await import("../src/data/manage_neuron");
  const operationId = "cd".repeat(16);
  const neuronId = "00".repeat(31) + "07";
  const request = encodeRegisterVote(neuronId, 1066n, true);
  const operation = {
    operation_id: operationId,
    sns: "extk7-gaaaa-aaaaq-aacda-cai", governance: "eqsml-lyaaa-aaaaq-aacdq-cai",
    input_json: JSON.stringify({ version: 1, kind: "manage", principal: "rrkah-fqaaa-aaaaa-aaaaq-cai", neuronId }),
    review_json: JSON.stringify({ title: "Vote yes", proposalId: "1066" }), state_json: '{"version":1,"completedSteps":[]}',
    initiator: "agent", seq: "7", revision: "2", created_at_seconds: "100", updated_at_seconds: "101",
    steps: [{ step_id: "command", args: request, status: "unknown", error: "reply interrupted", attempted_at_seconds: "101" }],
  };
  replyOverrides.set("snsgov_operation_get", () => operation);
  try {
    captured.length = 0;
    const result = await handlers.get("sns_operation_status_v1")!({ operationId, includeRaw: true }) as {
      operationId: string; status: string; input: { neuronId: string }; steps: { status: string; argsHex: string; replyHex?: string }[];
    };
    expect(result.operationId).toBe(operationId);
    expect(result.status).toBe("pending");
    expect(result.input.neuronId).toBe(neuronId);
    expect(result.steps[0]!.status).toBe("unknown");
    expect(result.steps[0]!.argsHex).toBe(Buffer.from(request).toString("hex"));
    expect(result.steps[0]!.replyHex).toBeUndefined();
    expect(captured).toEqual([{ method: "snsgov_operation_get", args: [operationId] }]);
  } finally { replyOverrides.clear(); }
});

test("draft deletion uses the invocation client and the exact decimal draft id", async () => {
  captured.length = 0;
  const draftId = "9007199254740993";
  const result = await handlers.get("sns_delete_draft_v1")!({ draftId });
  expect(result).toEqual({ deleted: true, draftId });
  expect(captured).toEqual([{ method: "snsgov_draft_delete", args: [draftId] }]);
  expect(captured.flatMap(check)).toEqual([]);
});

test("one-neuron lookup uses the invocation identity and reports an absent neuron as null", async () => {
  const governance = await import("../src/data/governance");
  const neuronId = "07".repeat(32);
  const lookups: [string, string][] = [];
  mock.module("../src/data/governance", () => ({
    ...governance,
    getNeuron: async (governanceId: string, id: string) => { lookups.push([governanceId, id]); return undefined; },
    readParameters: async () => ({}),
  }));
  captured.length = 0;
  const result = await handlers.get("sns_neuron_v1")!({ rootCanisterId: "extk7-gaaaa-aaaaq-aacda-cai", neuronId });
  expect(result).toMatchObject({ version: 1, principal: "rrkah-fqaaa-aaaaa-aaaaq-cai", neuron: null, token: null });
  expect(lookups).toEqual([["eqsml-lyaaa-aaaaq-aacdq-cai", neuronId]]);
  expect(captured).toEqual([{ method: "snsgov_hotkey", args: [null] }]);
});

test("operation history keeps a lossless cursor and does not classify replied summaries as accepted", async () => {
  const operationId = "ef".repeat(16);
  const cursor = "9007199254740993";
  replyOverrides.set("snsgov_operation_list", () => ({
    rows: [{ operation_id: operationId, seq: "7", sns: "extk7-gaaaa-aaaaq-aacda-cai", governance: "eqsml-lyaaa-aaaaq-aacdq-cai", initiator: "agent", revision: "2", created_at_seconds: "100", updated_at_seconds: "101", steps: [{ step_id: "command", status: "replied" }] }],
    next_before: "7", total: "9007199254740994",
  }));
  try {
    captured.length = 0;
    const result = await handlers.get("sns_operation_history_v1")!({ cursor, limit: 10 }) as { operations: Record<string, unknown>[]; nextCursor: string; total: string };
    expect(result.nextCursor).toBe("7");
    expect(result.total).toBe("9007199254740994");
    expect(result.operations[0]).toMatchObject({ operationId, status: "recorded", outcomeVerified: false });
    expect(captured).toEqual([{ method: "snsgov_operation_list", args: [{ before: cursor, limit: "10" }] }]);
  } finally { replyOverrides.clear(); }
});
