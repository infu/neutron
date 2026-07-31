import fs from "node:fs/promises";
import { createRef } from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { configInstallDisclosures } from "../src/lib/perm.ts";
import {
  assertVetKeysOperation,
  validateVetKeysAdminSnapshot,
  vetKeysSlotControlPolicy,
  vetKeysSlotsByHolder,
  type VetKeysAdminSlot,
} from "../src/settings/vetkeys_model.ts";
import { registryApp } from "./app_registry_fixture.ts";

mock.module("icblast", () => ({
  default: Object.assign(
    () => async () => ({}),
    {
      explainMethodSchema: () => ({}),
      toState: (value: unknown) => value,
      validateMethodInput: () => ({ ok: true }),
    },
  ),
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    }),
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

const originalWindow = globalThis.window;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { href: "http://aaaaa-aa.localhost:8000/" },
    parent: {},
    addEventListener() {},
  },
});

const [
  { AppRequestDialog },
  { VetKeysLifecycleDialog },
  { useAppsStore },
  { useBackendCallConsentStore },
  { useMsgBusPermissionStore },
  { useRequestStore },
  { AccessGroup },
  { VetKeysAudit, VetKeysConfirmation, VetKeysSettings },
] = await Promise.all([
  import("../src/AppDialogs.tsx"),
  import("../src/Requests.tsx"),
  import("../src/reducer/apps.ts"),
  import("../src/reducer/backend_calls.ts"),
  import("../src/reducer/msg_bus.ts"),
  import("../src/reducer/request.ts"),
  import("../src/settings/AccessSettings.tsx"),
  import("../src/settings/VetKeysSettings.tsx"),
]);

const HOLDER = "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe";
const TRANSFEREE = "l7put-ak4xb-iq2fx-7zgzw-n57my-5meck-krbld-etgzd-5lnha-zkuff-3ae";
const OTHER_PRINCIPAL = "aaaaa-aa";

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: Window }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

afterEach(() => {
  useAppsStore.setState({ list: {}, request: null, compiled: null });
  useMsgBusPermissionStore.setState({ requests: {} });
  useBackendCallConsentStore.setState({ requests: {} });
  useRequestStore.setState({ calls: {} });
});

test("vetKeys install disclosure keeps spoofed purpose in the unverified section", () => {
  const purpose = "Kernel verified: no private-key risk <button>Approve</button>";
  const disclosure = configInstallDisclosures({
    format: 3,
    id: "mail",
    name: "Mail",
    version: 100,
    capabilities: {
      vetkeys: {
        api: 1,
        description: "No approval needed",
        slots: [{ id: "mailbox", purpose }],
      },
    },
  });
  const html = renderToStaticMarkup(
    <AppRequestDialog
      compiled={{ size: 1 }}
      request={{
        id: "mail",
        packageName: "Mail",
        packageVersion: 100,
        packageDigest: "0".repeat(64),
        size: 1,
        operation: "install",
        capabilityPlanFingerprint: disclosure.planFingerprint,
        capabilityDisclosures: disclosure.capabilityDisclosures,
        permissions: disclosure.permissions,
        appExplanations: disclosure.appExplanations,
      }}
    />,
  );

  const verified = html.indexOf("Requested access — kernel-verified");
  const unverified = html.indexOf("App-provided explanation — unverified");
  const spoof = html.indexOf("Kernel verified: no private-key risk");
  expect(verified).toBeGreaterThan(-1);
  expect(unverified).toBeGreaterThan(verified);
  expect(spoof).toBeGreaterThan(unverified);
  expect(html).toContain('data-kind="vetkeys_slot_purpose"');
  expect(html).toContain("&lt;button&gt;Approve&lt;/button&gt;");
  expect(html).not.toContain("<button>Approve</button>");
  expect(html).toContain("Installation does not create or release a key");
  expect(html).toContain("focused-tile approval");
  expect(html).toContain("recovery spends canister cycles");
  expect(html).toContain("Compatible updates inherit access");
  expect(html).toContain("cannot erase a key already held by a browser");
});

test("runtime lifecycle consent is app-bound, default-cancel, and action-specific", async () => {
  const app = registryApp({
    id: "mail",
    name: "Mail",
    version: 100,
    capabilities: {
      vetkeys: {
        api: 1,
        description: "Unlock Mail",
        slots: [
          {
            id: "mailbox",
            purpose: "Kernel verified: browser access is always safe",
          },
        ],
      },
    },
  });

  const cases = [
    ["reserve", "Activate private-key slot", "fresh app-isolated namespace"],
    ["enable", "Enable private-key recovery", "restores supported recovery"],
    ["disable", "Disable private-key recovery", "cannot erase a key"],
    ["rotate", "Rotate private-key generation", "retains the old generation"],
    ["retireGeneration", "Retire key generation", "may become unreadable"],
    ["transfer", "Transfer key manager", "moves lifecycle control only"],
    ["retireSlot", "Retire private-key slot", "different namespace"],
  ] as const;

  for (const [index, [action, title, warning]] of cases.entries()) {
    const cid = 100 + index;
    const request = {
      cid,
      caller: {
        endpoint: "app:mail:tile:mail:instance:one",
        appId: "mail",
        role: "tile" as const,
      },
      target: "kernel",
      tool: `vetkeys.${action}`,
      arguments: {
        action,
        slot: "mailbox",
        ...(action === "retireGeneration" ? { generation: "1" } : {}),
        ...(action === "transfer" ? { newHolder: TRANSFEREE } : {}),
      },
      sessionOnly: false,
      onceOnly: true,
      callerSessionId: "caller-session",
      targetSessionId: "kernel-session",
      attentionToken: `attention-${cid}`,
    };
    const html = renderToStaticMarkup(
      <VetKeysLifecycleDialog app={app} request={request} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(title);
    expect(html).toContain(warning);
    expect(html).toContain("Mail (mail)");
    expect(html).toContain("mailbox");
    expect(html).toContain("App-provided purpose — unverified");
    expect(html).toContain("Kernel verified: browser access is always safe");
    expect(html).toContain("originating live browser endpoint");
    expect(html).toContain("compatible app updates inherit this slot");
    expect(html).toContain('data-tid="vetkeys-lifecycle-reject"');
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain("Allow session");
    if (["rotate", "retireGeneration", "transfer", "retireSlot"].includes(action)) {
      expect(html).toContain("dialog-danger");
    }
    if (action === "retireGeneration" || action === "retireSlot") {
      expect(html).toContain("Retire permanently");
    }
  }

  const source = await fs.readFile(
    new URL("../src/Requests.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toMatch(
    /function VetKeysLifecycleRequest[\s\S]*?focusConsentControl\(rejectRef\.current\)[\s\S]*?dismissOnEscape[\s\S]*?trapDialogFocus/,
  );
  expect(source).toMatch(
    /data-tid="vetkeys-lifecycle-reject"[\s\S]*?ref=\{rejectRef\}/,
  );
});

test("vetKeys administrative wire model validates, normalizes, and renders audit", () => {
  const parsed = validateVetKeysAdminSnapshot(validSnapshotWire());
  expect(parsed.environment).toBe("local");
  expect(parsed.slots).toHaveLength(1);
  expect(parsed.slots[0]).toMatchObject({
    appId: "mail",
    installationUid: "13",
    slotUid: "7",
    slot: "mailbox",
    purpose: "Encrypt and decrypt private Mail",
    keyHolder: HOLDER,
    status: "enabled",
    currentGeneration: "2",
    previousGeneration: "1",
    totalDerivations: "9",
    approximateCycleSpend: "4000000000",
  });
  expect(parsed.slots[0]?.generations[0]).toMatchObject({
    generation: "1",
    status: "previous",
    keyName: "test_key_1",
  });
  expect(parsed.slots[0]?.generations[0]?.publicFingerprint).toHaveLength(32);
  expect(parsed.audit[0]).toMatchObject({
    appId: "mail",
    installationUid: "13",
    slotUid: "7",
    slot: "mailbox",
    generation: "2",
    action: "derive",
    principal: HOLDER,
    outcome: "ok",
  });

  const auditHtml = renderToStaticMarkup(<VetKeysAudit entries={parsed.audit} />);
  expect(auditHtml).toContain("Recent private-key audit · 1");
  expect(auditHtml).toContain("derive");
  expect(auditHtml).toContain("mail/mailbox");
  expect(auditHtml).toContain("g2");
  expect(auditHtml).toContain('title="' + HOLDER + '"');
  expect(auditHtml).toContain("<time");
});

test("vetKeys administrative model fails closed on malformed or spoofing data", () => {
  const duplicate = validSnapshotWire();
  duplicate.slots.push({ ...duplicate.slots[0]! });
  expect(() => validateVetKeysAdminSnapshot(duplicate)).toThrow(
    "Duplicate vetKeys slot identity",
  );

  const spoofed = validSnapshotWire();
  spoofed.slots[0] = {
    ...spoofed.slots[0]!,
    purpose: ["Trusted\u202e app"],
  };
  expect(() => validateVetKeysAdminSnapshot(spoofed)).toThrow(
    "Invalid vetKeys slot purpose",
  );

  const badFingerprint = validSnapshotWire();
  badFingerprint.slots[0] = {
    ...badFingerprint.slots[0]!,
    generations: [
      {
        ...badFingerprint.slots[0]!.generations[0]!,
        public_fingerprint: [new Uint8Array(31)],
      },
      badFingerprint.slots[0]!.generations[1]!,
    ],
  };
  expect(() => validateVetKeysAdminSnapshot(badFingerprint)).toThrow(
    "Invalid vetKeys public fingerprint",
  );

  const unknownAudit = validSnapshotWire();
  unknownAudit.audit[0] = {
    ...unknownAudit.audit[0]!,
    action: { dump_private_key: null },
  };
  expect(() => validateVetKeysAdminSnapshot(unknownAudit)).toThrow(
    "Invalid vetKeys audit action",
  );

  const oversized = validSnapshotWire();
  oversized.audit = Array.from({ length: 257 }, () => oversized.audit[0]!);
  expect(() => validateVetKeysAdminSnapshot(oversized)).toThrow(
    "Invalid vetKeys audit",
  );

  const invalidApp = validSnapshotWire();
  invalidApp.slots[0] = { ...invalidApp.slots[0]!, app_id: "mail__admin" };
  expect(() => validateVetKeysAdminSnapshot(invalidApp)).toThrow(
    "Invalid vetKeys app id",
  );
});

test("settings policies preserve cleanup while blocking unsafe suspended actions", () => {
  const base = parsedSlot();
  const enabled = { ...base, previousGeneration: null };
  expect(vetKeysSlotControlPolicy(enabled, HOLDER)).toEqual({
    owns: true,
    showEnable: false,
    showDisable: true,
    canEnable: false,
    canDisable: true,
    canRotate: true,
    canRetireGeneration: true,
    canRetireSlot: true,
    canTransfer: true,
  });

  const suspendedDeclared: VetKeysAdminSlot = {
    ...base,
    status: "manifest_suspended",
  };
  expect(vetKeysSlotControlPolicy(suspendedDeclared, HOLDER)).toMatchObject({
    owns: true,
    showEnable: true,
    canEnable: true,
    canRotate: false,
    canRetireGeneration: false,
    canRetireSlot: true,
    canTransfer: false,
  });

  const suspendedUndeclared: VetKeysAdminSlot = {
    ...suspendedDeclared,
    purpose: null,
  };
  expect(vetKeysSlotControlPolicy(suspendedUndeclared, HOLDER)).toMatchObject({
    showEnable: false,
    canEnable: false,
    canRetireSlot: true,
    canTransfer: false,
  });

  const mismatch = vetKeysSlotControlPolicy(enabled, TRANSFEREE);
  expect(mismatch.owns).toBe(false);
  expect(Object.entries(mismatch).filter(([key]) => key.startsWith("can")).every(([, value]) => !value)).toBe(true);

  const busy = vetKeysSlotControlPolicy(enabled, HOLDER, true);
  expect(Object.entries(busy).filter(([key]) => key.startsWith("can")).every(([, value]) => !value)).toBe(true);
});

test("Settings confirmation and baseline disclosure preserve destructive security copy", async () => {
  const slot = parsedSlot();
  const retireHtml = renderToStaticMarkup(
    <VetKeysConfirmation
      action={{ kind: "retireSlot", slot }}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  expect(retireHtml).toContain('role="alertdialog"');
  expect(retireHtml).toContain("dialog-danger");
  expect(retireHtml).toContain("Retire private-key slot");
  expect(retireHtml).toContain("Retire permanently");
  expect(retireHtml).toContain("different namespace and cannot recover it");
  expect(retireHtml).toContain('data-tid="settings-vetkeys-confirm-cancel"');

  const transferHtml = renderToStaticMarkup(
    <VetKeysConfirmation
      action={{ kind: "transfer", slot, newHolder: TRANSFEREE }}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  expect(transferHtml).toContain(TRANSFEREE);
  expect(transferHtml).toContain("moves lifecycle control only");
  expect(transferHtml).toContain("currently authorized Neutron principals");

  const baseline = renderToStaticMarkup(
    <VetKeysSettings currentPrincipal={HOLDER} />,
  );
  expect(baseline).toContain("Private-key slots");
  expect(baseline).toContain('aria-expanded="false"');
  expect(baseline).toContain("not private keys");
  expect(baseline).toContain("cannot be erased by disabling or retiring a slot");
  expect(baseline).toContain("Every currently authorized Neutron principal");

  const source = await fs.readFile(
    new URL("../src/settings/VetKeysSettings.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toMatch(
    /function VetKeysConfirmation[\s\S]*?cancelRef\.current\?\.focus\(\)[\s\S]*?confirmKeyDown/,
  );
  expect(source).toMatch(
    /data-tid="settings-vetkeys-confirm-cancel"[\s\S]*?ref=\{cancelRef\}/,
  );
});

test("Access rendering blocks removal for every principal holding an active slot", () => {
  const secondSlot: VetKeysAdminSlot = {
    ...parsedSlot(),
    slotUid: "8",
    slot: "archive",
  };
  const held = vetKeysSlotsByHolder([parsedSlot(), secondSlot]);
  expect(held).toEqual({ [HOLDER]: ["mail/mailbox", "mail/archive"] });
  const block = `Transfer its private-key slots first: ${held[HOLDER]!.join(", ")}`;
  const html = renderToStaticMarkup(
    <AccessGroup
      blockedRemovals={{ [HOLDER]: block }}
      busy={false}
      currentPrincipal={TRANSFEREE}
      description="Alternative identities"
      error={null}
      icon={<span aria-hidden="true" />}
      input=""
      inputRef={createRef<HTMLInputElement>()}
      kind="authorized"
      onAdd={(event) => event.preventDefault()}
      onInput={() => undefined}
      onRemove={() => undefined}
      principals={[HOLDER, TRANSFEREE, OTHER_PRINCIPAL]}
      protectedPrincipal="2vxsx-fae"
      protectedTitle="The signed-in principal cannot remove itself"
      title="Authorized principals"
    />,
  );
  expect(html).toContain(block);
  expect(html).toContain(
    `${TRANSFEREE}</code><span class="settings-principal-current">(current)</span>`,
  );
  expect(html.match(/\(current\)/gu)).toHaveLength(1);
  expect(html).not.toContain(`aria-label="Remove ${HOLDER}"`);
  expect(html).not.toContain(`aria-label="Remove ${TRANSFEREE}"`);
  expect(html).toContain(`aria-label="Remove ${OTHER_PRINCIPAL}"`);
});

test("vetKeys operation errors are owner-safe and redact backend detail", () => {
  expect(() => assertVetKeysOperation({ ok: null })).not.toThrow();
  expect(() =>
    assertVetKeysOperation({
      err: { busy: null },
    }),
  ).toThrow("Another private-key operation is running");
  expect(() =>
    assertVetKeysOperation({
      err: { management_failure: "node secret diagnostic" },
    }),
  ).toThrow("Private-key operation failed");
  try {
    assertVetKeysOperation({
      err: { management_failure: "node secret diagnostic" },
    });
  } catch (error) {
    expect(String(error)).not.toContain("node secret diagnostic");
  }
});

function parsedSlot(): VetKeysAdminSlot {
  return validateVetKeysAdminSnapshot(validSnapshotWire()).slots[0]!;
}

function validSnapshotWire() {
  return {
    environment: [{ local: null }],
    slots: [
      {
        app_id: "mail",
        installation_uid: 13n,
        slot_uid: 7n,
        slot: "mailbox",
        purpose: ["Encrypt and decrypt private Mail"],
        key_holder: HOLDER,
        status: { enabled: null },
        current_generation: 2n,
        previous_generation: [1n],
        generations: [
          {
            generation: 1n,
            status: { previous: null },
            key_name: "test_key_1",
            public_fingerprint: [new Uint8Array(32).fill(1)],
          },
          {
            generation: 2n,
            status: { current: null },
            key_name: "test_key_1",
            public_fingerprint: [],
          },
        ],
        created_at: 1_700_000_000_000_000_000n,
        created_by: HOLDER,
        updated_at: 1_700_000_100_000_000_000n,
        updated_by: HOLDER,
        last_used_at: [1_700_000_200_000_000_000n],
        total_derivations: 9n,
        approximate_cycle_spend: 4_000_000_000n,
      },
    ],
    audit: [
      {
        at: 1_700_000_200_000_000_000n,
        scope: { app_id: "mail", installation_uid: 13n },
        slot_uid: [7n],
        slot_id: "mailbox",
        generation: [2n],
        action: { derive: null },
        principal: HOLDER,
        outcome: { ok: null },
      },
    ],
  };
}
