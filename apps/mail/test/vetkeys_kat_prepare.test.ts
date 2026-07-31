import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
} from "../scripts/vetkeys_kat.ts";
import type { LocalNeutronRuntime } from "neutron-provision/src/local_session.ts";
import { parseCaptureVetKeysKatCli } from "../scripts/capture-vetkeys-kat.ts";
import {
  assertPostRotationState,
  assertPostSetupState,
  assertPreRotationState,
  parsePrepareVetKeysKatCli,
  readyCaptureCommand,
  type PrepareInstalledState,
  type PrepareMailStatusState,
  type PrepareSlotState,
} from "../scripts/prepare-vetkeys-kat.ts";

const CANISTER = "efadq-gl777-77774-aaaba-cai";
const CONFIG = "/tmp/disposable.ndeploy.json";
const HOST = "http://localhost:8000/";
const RUNTIME = {
  canisterId: CANISTER,
  canisterIds: [CANISTER],
  nodeLabel: "alpha",
  nodeLabels: ["alpha"],
  nodeIndex: 0,
  controlUrl: "http://127.0.0.1:41000/",
  developerIdentityPrincipal: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
  developerIdentitySeed: 2,
  gatewayUrl: HOST,
  instanceId: 3,
  sessionPath: "/tmp/disposable.ndeploy.session.json",
} satisfies LocalNeutronRuntime;
const resolveRuntime = (_options: { configPath?: string }) => RUNTIME;

describe("vetKeys KAT preparation CLI", () => {
  test("derives the target from one config session and requires an exact disposable acknowledgement", () => {
    expect(parsePrepareVetKeysKatCli([
      "--config",
      CONFIG,
      "--confirm-disposable",
      CANISTER,
    ], resolveRuntime)).toEqual({
      canisterId: CANISTER,
      configPath: CONFIG,
      confirmDisposable: CANISTER,
      developerIdentityPrincipal: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
      developerIdentitySeed: 2,
      headless: true,
      host: HOST,
    });
    expect(parsePrepareVetKeysKatCli([
      "--config",
      CONFIG,
      "--confirm-disposable",
      CANISTER,
      "--headed",
      "--chromium-executable",
      "/opt/chromium",
    ], resolveRuntime)).toMatchObject({
      chromiumExecutable: "/opt/chromium",
      headless: false,
      host: HOST,
    });

    let defaultConfig = "";
    parsePrepareVetKeysKatCli([
      "--confirm-disposable",
      CANISTER,
    ], (options) => {
      defaultConfig = options.configPath ?? "";
      return RUNTIME;
    });
    expect(defaultConfig).toMatch(/\/local\.ndeploy\.json$/u);
  });

  test("rejects missing acknowledgement, mismatches, and manual routing flags", () => {
    const base = [
      "--config",
      CONFIG,
      "--confirm-disposable",
      CANISTER,
    ];
    expect(() => parsePrepareVetKeysKatCli([], resolveRuntime))
      .toThrow(/--confirm-disposable is required/u);
    expect(() => parsePrepareVetKeysKatCli([
      ...base.slice(0, -1),
      "ecbfe-lt777-77774-aaabq-cai",
    ], resolveRuntime)).toThrow(/must repeat the exact canonical disposable canister ID/u);
    expect(() => parsePrepareVetKeysKatCli([...base, "--config", CONFIG], resolveRuntime))
      .toThrow(/Duplicate option/u);
    expect(() => parsePrepareVetKeysKatCli([...base, "--host", HOST], resolveRuntime))
      .toThrow(/Unknown argument --host/u);
    expect(() => parsePrepareVetKeysKatCli([...base, "--canister-id", CANISTER], resolveRuntime))
      .toThrow(/Unknown argument --canister-id/u);
    expect(() => parsePrepareVetKeysKatCli([...base, "--surprise", "1"], resolveRuntime))
      .toThrow(/Unknown argument/u);
  });

  test("prints the existing capture contract with a required UID and no overwrite flag", () => {
    const command = readyCaptureCommand(
      { configPath: CONFIG },
      "17",
    );
    expect(command).toBe(
      "npm --workspace neutron-mail run vetkeys:kat:capture -- " +
      `--config '${CONFIG}' --slot-uid 17`,
    );
    expect(command).not.toContain("--replace");
    expect(() => readyCaptureCommand(
      { configPath: CONFIG },
      "0",
    )).toThrow(/positive canonical decimal/u);
  });
});

describe("vetKeys KAT capture CLI", () => {
  test("derives all routing and identity from the selected config session", () => {
    expect(parseCaptureVetKeysKatCli([
      "--config",
      CONFIG,
      "--slot-uid",
      "17",
      "--replace",
    ], resolveRuntime)).toEqual({
      canisterId: CANISTER,
      configPath: CONFIG,
      developerIdentityPrincipal: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
      developerIdentitySeed: 2,
      host: HOST,
      replace: true,
      slotUid: 17n,
    });
  });

  test("requires the slot UID and rejects manual or duplicate routing", () => {
    expect(() => parseCaptureVetKeysKatCli(["--config", CONFIG], resolveRuntime))
      .toThrow(/--slot-uid is required/u);
    expect(() => parseCaptureVetKeysKatCli([
      "--slot-uid",
      "17",
      "--host",
      HOST,
    ], resolveRuntime)).toThrow(/Unknown argument --host/u);
    expect(() => parseCaptureVetKeysKatCli([
      "--slot-uid",
      "17",
      "--canister-id",
      CANISTER,
    ], resolveRuntime)).toThrow(/Unknown argument --canister-id/u);
    expect(() => parseCaptureVetKeysKatCli([
      "--config",
      CONFIG,
      "--config",
      CONFIG,
      "--slot-uid",
      "17",
    ], resolveRuntime)).toThrow(/Duplicate option --config/u);
    expect(() => parseCaptureVetKeysKatCli(["--slot-uid", "0"], resolveRuntime))
      .toThrow(/Invalid positive decimal slot UID/u);
  });
});

describe("vetKeys KAT installed-state gates", () => {
  test("accepts only a clean unconfigured target or one exact current-only test slot", () => {
    expect(() => assertPreRotationState({
      bindingUid: null,
      mail: cleanMail(),
      slots: [],
    }, MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL)).not.toThrow();

    expect(() => assertPreRotationState({
      bindingUid: "7",
      mail: cleanMail({
        setup: configured("1", null),
      }),
      slots: [currentOnlySlot()],
    }, MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL)).not.toThrow();
  });

  test("rejects production, disabled, foreign-manager, previous, dirty, and ambiguous targets", () => {
    const valid = stateWithSlot();
    const invalid: PrepareInstalledState[] = [
      { ...valid, slots: [{ ...valid.slots[0]!, environment: "production" }] },
      { ...valid, slots: [{ ...valid.slots[0]!, status: "disabled" }] },
      { ...valid, slots: [{ ...valid.slots[0]!, keyHolder: CANISTER }] },
      {
        ...valid,
        slots: [{
          ...valid.slots[0]!,
          previousGeneration: "1",
          currentGeneration: "2",
          generations: [
            generation("2", "current", 32),
            generation("1", "previous", 32),
          ],
        }],
      },
      {
        ...valid,
        mail: cleanMail({ mailRevision: "1" }),
      },
      {
        ...valid,
        slots: [valid.slots[0]!, valid.slots[0]!],
      },
      {
        ...valid,
        bindingUid: null,
      },
      {
        bindingUid: null,
        mail: cleanMail({ setup: configured("1", null) }),
        slots: [],
      },
    ];
    for (const state of invalid) {
      expect(() => assertPreRotationState(
        state,
        MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
      )).toThrow();
    }
  });

  test("requires public material after setup and exact current+previous reconciliation after rotation", () => {
    const setup = stateWithSlot();
    expect(assertPostSetupState(
      setup,
      MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
    )).toEqual({ currentGeneration: "1", slotUid: "7" });

    const rotated: PrepareInstalledState = {
      bindingUid: "7",
      mail: cleanMail({ setup: configured("2", "1") }),
      slots: [{
        ...currentOnlySlot(),
        currentGeneration: "2",
        previousGeneration: "1",
        generations: [
          generation("2", "current", 32),
          generation("1", "previous", 32),
        ],
      }],
    };
    expect(assertPostRotationState(rotated, {
      currentGeneration: "1",
      slotUid: "7",
    })).toEqual({
      currentGeneration: "2",
      previousGeneration: "1",
      slotUid: "7",
    });

    expect(() => assertPostRotationState({
      ...rotated,
      bindingUid: "8",
    }, { currentGeneration: "1", slotUid: "7" })).toThrow(/UID changed/u);
    expect(() => assertPostRotationState({
      ...rotated,
      mail: cleanMail({ setup: configured("2", null) }),
    }, { currentGeneration: "1", slotUid: "7" })).toThrow(/configured generations/u);
  });
});

test("preparation mutates lifecycle only through exact installed UI consent and capture stays fail-closed", async () => {
  const [prepareSource, captureSource] = await Promise.all([
    readFile(new URL("../scripts/prepare-vetkeys-kat.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/capture-vetkeys-kat.ts", import.meta.url), "utf8"),
  ]);
  for (const selector of [
    '__NEUTRON_PLAYWRIGHT_LOGIN_AS__',
    'launcher-tile-mail-mail',
    'Set up private Mail',
    'vetkeys-lifecycle-dialog',
    'vetkeys-lifecycle-approve',
    'Rotate key',
    'Retire previous key',
  ]) {
    expect(prepareSource).toContain(selector);
  }
  expect(prepareSource).not.toMatch(/kernel_vetkeys_(?:reserve|rotate|retire|enable|disable)/u);
  expect(prepareSource).not.toContain("mail_crypto_rotate");
  expect(prepareSource).not.toContain("retirement.click(");
  expect(captureSource).toContain("slotUid === null");
  expect(captureSource).toContain('flag: cli.replace ? "w" : "wx"');
  expect(captureSource).toContain("--slot-uid <mail-slot-uid>");
});

function stateWithSlot(): PrepareInstalledState {
  return {
    bindingUid: "7",
    mail: cleanMail({ setup: configured("1", null) }),
    slots: [currentOnlySlot()],
  };
}

function currentOnlySlot(): PrepareSlotState {
  return {
    currentGeneration: "1",
    environment: "local",
    generations: [generation("1", "current", 32)],
    keyHolder: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
    previousGeneration: null,
    purpose: "Encrypt and decrypt private Mail",
    slot: "mailbox",
    status: "enabled",
  };
}

function generation(
  value: string,
  status: "current" | "previous",
  fingerprintBytes: number | null,
) {
  return {
    fingerprintBytes,
    generation: value,
    keyName: "test_key_1",
    status,
  };
}

function configured(
  currentGeneration: string,
  previousGeneration: string | null,
): PrepareMailStatusState["setup"] {
  return {
    kind: "configured",
    currentGeneration,
    keyHolder: MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
    previousGeneration,
  };
}

function cleanMail(
  overrides: Partial<PrepareMailStatusState> = {},
): PrepareMailStatusState {
  return {
    activeSends: "0",
    cleanupEpoch: "0",
    encryptedSettingsRevision: null,
    inboxBytes: "0",
    inboxCount: "0",
    mailRevision: "0",
    outboxCount: "0",
    sentAndOutboxBytes: "0",
    sentCount: "0",
    setup: { kind: "not_configured" },
    storageLevel: "normal",
    unknownInboxBytes: "0",
    unknownInboxCount: "0",
    unreadCount: "0",
    ...overrides,
  };
}
