import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
} from "@dfinity/agent";
import type { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "neutron-provision/src/local_session.ts";
import { localIdentityFromSeed } from "neutron-provision/src/kernel.ts";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import {
  MAIL_REAL_VETKEYS_KAT_APP_ID,
  MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
  MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED,
  MAIL_REAL_VETKEYS_KAT_KEY_NAME,
  MAIL_REAL_VETKEYS_KAT_SLOT_ID,
  assertPinnedVetKeysInstallation,
} from "./vetkeys_kat.ts";

const mailRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LOCAL_CONFIG = fileURLToPath(
  new URL("../../../local.ndeploy.json", import.meta.url),
);
const MAIL_SLOT_PURPOSE = "Encrypt and decrypt private Mail";
const OPERATION_TIMEOUT_MS = 45_000;

type Opt<T> = [] | [T];
type Environment = { local: null } | { production: null };
type SlotStatus =
  | { enabled: null }
  | { disabled: null }
  | { manifest_suspended: null };
type GenerationStatus = { current: null } | { previous: null };
type VetKeysError = Record<string, null | { retry_after_seconds: bigint }>;
type VetKeysResult<T> = { ok: T } | { err: VetKeysError };

type CandidGeneration = {
  generation: bigint;
  key_name: string;
  public_fingerprint: Opt<Uint8Array | number[]>;
  status: GenerationStatus;
};

type CandidSlot = {
  approximate_cycle_spend: bigint;
  created_at: bigint;
  current_generation: bigint;
  environment: Environment;
  generations: CandidGeneration[];
  key_holder: Principal;
  last_used_at: Opt<bigint>;
  previous_generation: Opt<bigint>;
  purpose: string;
  total_derivations: bigint;
  slot: string;
  status: SlotStatus;
  updated_at: bigint;
};

type CandidMailStatus = {
  active_sends: bigint;
  cleanup_epoch: bigint;
  contacts_revision: bigint;
  encrypted_settings_revision: Opt<bigint>;
  inbox_bytes: bigint;
  inbox_count: bigint;
  mail_revision: bigint;
  outbox_count: bigint;
  sent_and_outbox_bytes: bigint;
  sent_count: bigint;
  setup:
    | { not_configured: null }
    | {
        configured: {
          current_epoch: bigint;
          key_holder: Principal;
          previous_epoch: Opt<bigint>;
        };
      };
  storage_level:
    | { normal: null }
    | { approaching_limit: null }
    | { almost_full: null };
  unknown_at_receipt_bytes: bigint;
  unknown_at_receipt_count: bigint;
  unread_count: bigint;
};

type MailStoreError = Record<string, unknown>;
type MailStatusResult = { ok: CandidMailStatus } | { err: MailStoreError };

type KatPrepareActor = {
  kernel_check_authorized: ActorMethod<[null], boolean>;
  kernel_vetkeys_binding: ActorMethod<[
    { app_id: string; slot_id: string },
  ], VetKeysResult<bigint>>;
  kernel_vetkeys_list: ActorMethod<[
    { app_id: string },
  ], CandidSlot[]>;
  app_mail__mail_status: ActorMethod<
    [null],
    MailStatusResult
  >;
};

export type PrepareVetKeysKatCli = {
  canisterId: string;
  chromiumExecutable?: string;
  configPath: string;
  confirmDisposable: string;
  developerIdentityPrincipal: string;
  developerIdentitySeed: number;
  headless: boolean;
  host: string;
};

type LocalRuntimeResolver = (options: {
  configPath?: string;
}) => LocalNeutronRuntime;

export type PrepareGenerationState = {
  fingerprintBytes: number | null;
  generation: string;
  keyName: string;
  status: "current" | "previous";
};

export type PrepareSlotState = {
  currentGeneration: string;
  environment: "local" | "production";
  generations: PrepareGenerationState[];
  keyHolder: string;
  previousGeneration: string | null;
  purpose: string;
  slot: string;
  status: "enabled" | "disabled" | "manifest_suspended";
};

export type PrepareMailStatusState = {
  activeSends: string;
  cleanupEpoch: string;
  encryptedSettingsRevision: string | null;
  inboxBytes: string;
  inboxCount: string;
  mailRevision: string;
  outboxCount: string;
  sentAndOutboxBytes: string;
  sentCount: string;
  setup:
    | { kind: "not_configured" }
    | {
        kind: "configured";
        currentGeneration: string;
        keyHolder: string;
        previousGeneration: string | null;
      };
  storageLevel: "normal" | "approaching_limit" | "almost_full";
  unknownInboxBytes: string;
  unknownInboxCount: string;
  unreadCount: string;
};

export type PrepareInstalledState = {
  bindingUid: string | null;
  mail: PrepareMailStatusState;
  slots: PrepareSlotState[];
};

export type CurrentOnlyState = {
  currentGeneration: string;
  slotUid: string;
};

export type PreparedRotationState = CurrentOnlyState & {
  previousGeneration: string;
};

/**
 * Prepare one disposable local installed Neutron for the real vetKeys KAT.
 *
 * Every lifecycle mutation is initiated by a click in Mail's real installed
 * tile and accepted in the kernel's exact lifecycle dialog. Direct actors are
 * deliberately read-only here: they use the configured developer identity and
 * attest the before/after state, but can never reserve, rotate, reconcile,
 * migrate, or retire.
 */
export async function prepareVetKeysKat(
  cli: PrepareVetKeysKatCli,
): Promise<PreparedRotationState> {
  await assertPinnedVetKeysInstallation(mailRoot);
  const identity = deterministicDeveloperIdentity(cli);
  const actor = await createActor(cli, identity);
  if (!await actor.kernel_check_authorized(null)) {
    throw new Error(
      `Configured developer principal ${cli.developerIdentityPrincipal} is not authorized by this disposable Neutron`,
    );
  }

  const before = await readInstalledState(actor);
  assertPreRotationState(before, cli.developerIdentityPrincipal);
  const needsReservation = before.slots.length === 0;
  const needsSetup = before.mail.setup.kind === "not_configured";
  const browserUrl = exactInstalledBrowserUrl(cli.host, cli.canisterId);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: cli.headless,
      ...(cli.chromiumExecutable
        ? { executablePath: cli.chromiumExecutable }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1_440, height: 900 } });
    const failures: string[] = [];
    monitorInstalledSurface(page, failures);
    await page.goto(browserUrl, { waitUntil: "domcontentloaded" });
    await authenticateDeveloperIdentity(page, cli);
    const mail = await openInstalledMail(page);
    await setUpPrivateMailIfNeeded(page, mail, needsSetup, needsReservation);

    const beforeRotationState = await readInstalledState(actor);
    const current = assertPostSetupState(
      beforeRotationState,
      cli.developerIdentityPrincipal,
    );

    await openKeyProtection(mail, current.currentGeneration);
    await rotateOnceThroughExactConsent(page, mail);
    const rotated = await waitForPreparedRotation(actor, current);
    await assertInstalledUiStoppedBeforeRetirement(mail, rotated);

    if (failures.length > 0) {
      throw new Error(`Installed Mail/Neutron surface failed: ${failures.join(" | ")}`);
    }
    return rotated;
  } finally {
    await browser?.close();
  }
}

export function parsePrepareVetKeysKatCli(
  args: readonly string[],
  resolveRuntime: LocalRuntimeResolver = resolveLocalNeutronRuntime,
): PrepareVetKeysKatCli {
  const values = new Map<string, string>();
  let headless = true;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--headed") {
      if (!headless) throw new Error("Duplicate option --headed");
      headless = false;
      continue;
    }
    if (![
      "--config",
      "--confirm-disposable",
      "--chromium-executable",
    ].includes(option)) {
      throw new Error(`Unknown argument ${option}\n${prepareUsage()}`);
    }
    if (values.has(option)) throw new Error(`Duplicate option ${option}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    values.set(option, value);
    index += 1;
  }

  const rawConfirmation = values.get("--confirm-disposable");
  if (!rawConfirmation) {
    throw new Error(
      "--confirm-disposable is required and must repeat the provision session's exact disposable Neutron canister ID\n" +
      prepareUsage(),
    );
  }
  const configPath = resolve(values.get("--config") ?? DEFAULT_LOCAL_CONFIG);
  const runtime = resolveRuntime({ configPath });
  const canisterId = runtime.canisterId;
  const confirmDisposable = canonicalCanister(
    rawConfirmation,
    "--confirm-disposable",
  );
  if (confirmDisposable !== canisterId || rawConfirmation !== canisterId) {
    throw new Error(
      "--confirm-disposable must repeat the exact canonical disposable canister ID; review/live canisters are refused",
    );
  }
  const chromiumExecutable = values.get("--chromium-executable");
  if (chromiumExecutable !== undefined && !chromiumExecutable.startsWith("/")) {
    throw new Error("--chromium-executable must be an absolute path");
  }
  return {
    canisterId,
    confirmDisposable,
    configPath,
    developerIdentityPrincipal: runtime.developerIdentityPrincipal,
    developerIdentitySeed: runtime.developerIdentitySeed,
    headless,
    host: runtime.gatewayUrl,
    ...(chromiumExecutable ? { chromiumExecutable } : {}),
  };
}

export function assertPreRotationState(
  state: PrepareInstalledState,
  expectedHolder: string,
): void {
  assertCleanMailStore(state.mail);
  if (state.slots.length === 0) {
    if (state.bindingUid !== null) {
      throw new Error("Mail/mailbox has a binding but no exact public slot");
    }
    if (state.mail.setup.kind !== "not_configured") {
      throw new Error("Mail is configured without an exact Mail/mailbox slot");
    }
    return;
  }
  if (state.slots.length !== 1) {
    throw new Error("KAT preparation refuses ambiguous or additional Mail slots");
  }
  const slot = state.slots[0]!;
  assertCurrentOnlySlot(slot, expectedHolder, false);
  const uid = positiveDecimal(state.bindingUid, "Mail/mailbox slot UID");
  if (uid === "0") throw new Error("Mail/mailbox slot UID must be positive");
  assertMailSetupMatchesCurrent(state.mail, slot, true);
}

export function assertPostSetupState(
  state: PrepareInstalledState,
  expectedHolder: string,
): CurrentOnlyState {
  assertCleanMailStore(state.mail);
  if (state.slots.length !== 1) {
    throw new Error("Mail setup did not produce exactly one Mail/mailbox slot");
  }
  const slot = state.slots[0]!;
  assertCurrentOnlySlot(slot, expectedHolder, true);
  const slotUid = positiveDecimal(state.bindingUid, "Mail/mailbox slot UID");
  assertMailSetupMatchesCurrent(state.mail, slot, false);
  return { currentGeneration: slot.currentGeneration, slotUid };
}

export function assertPostRotationState(
  state: PrepareInstalledState,
  before: CurrentOnlyState,
): PreparedRotationState {
  assertCleanMailStore(state.mail);
  if (state.slots.length !== 1) {
    throw new Error("Rotation did not leave exactly one Mail/mailbox slot");
  }
  const slot = state.slots[0]!;
  assertExactSlotIdentity(slot);
  if (slot.environment !== "local" || slot.status !== "enabled") {
    throw new Error("Rotation left the local test Mail slot unavailable");
  }
  const slotUid = positiveDecimal(state.bindingUid, "Mail/mailbox slot UID");
  if (slotUid !== before.slotUid) {
    throw new Error("Mail/mailbox slot UID changed during UI rotation");
  }
  const previousGeneration = positiveDecimal(
    slot.previousGeneration,
    "Mail previous generation",
  );
  if (
    previousGeneration !== before.currentGeneration ||
    slot.currentGeneration === previousGeneration
  ) {
    throw new Error("Rotation did not retain the exact former current generation");
  }
  if (slot.generations.length !== 2) {
    throw new Error("Rotation must stop with exactly one current and one previous generation");
  }
  assertExactGeneration(slot.generations, slot.currentGeneration, "current", true);
  assertExactGeneration(slot.generations, previousGeneration, "previous", true);
  if (state.mail.setup.kind !== "configured") {
    throw new Error("Mail did not reconcile the rotated slot");
  }
  if (
    state.mail.setup.currentGeneration !== slot.currentGeneration ||
    state.mail.setup.previousGeneration !== previousGeneration ||
    state.mail.setup.keyHolder !== slot.keyHolder
  ) {
    throw new Error("Mail's configured generations do not match its retained kernel slot");
  }
  return {
    currentGeneration: slot.currentGeneration,
    previousGeneration,
    slotUid,
  };
}

export function readyCaptureCommand(
  cli: Pick<PrepareVetKeysKatCli, "configPath">,
  slotUid: string,
): string {
  positiveDecimal(slotUid, "Mail/mailbox slot UID");
  return "npm --workspace neutron-mail run vetkeys:kat:capture -- " +
    `--config ${shellArgument(cli.configPath)} --slot-uid ${slotUid}`;
}

export function prepareUsage(): string {
  return [
    "Prepare a disposable installed local Neutron for Mail's real current+previous vetKeys KAT.",
    "The command authenticates the configured developer identity and performs setup/rotation only through the installed UI.",
    "",
    "Usage:",
    "  bun scripts/prepare-vetkeys-kat.ts [--config <CONFIG.ndeploy.json>] \\",
    "    --confirm-disposable <same-principal> [--headed] [--chromium-executable <absolute-path>]",
    "",
    "The config defaults to the repository's local.ndeploy.json. The target",
    "canister, gateway, and developer identity come only from that config's one",
    "matching schema-3 provision session; --host and --canister-id are not supported.",
    "The target must have an unused Mail store and either no Mail/mailbox slot or",
    "one enabled current-only local test_key_1 slot managed by the configured developer. Targets",
    "with production keys, prior Mail use, a previous generation, or ambiguity are refused.",
    "The exact canister ID must be repeated because rotation mutates key lifecycle",
    "state; never point this command at a review or live Neutron.",
    "",
  ].join("\n");
}

async function createActor(
  cli: PrepareVetKeysKatCli,
  identity: Ed25519KeyIdentity,
): Promise<ActorSubclass<KatPrepareActor>> {
  const agent = await HttpAgent.create({ host: cli.host, identity });
  await agent.fetchRootKey();
  return Actor.createActor<KatPrepareActor>(katPrepareIdl, {
    agent,
    canisterId: cli.canisterId,
  });
}

async function readInstalledState(
  actor: ActorSubclass<KatPrepareActor>,
): Promise<PrepareInstalledState> {
  const [slots, bindingResult, mailResult] = await Promise.all([
    actor.kernel_vetkeys_list({ app_id: MAIL_REAL_VETKEYS_KAT_APP_ID }),
    actor.kernel_vetkeys_binding({
      app_id: MAIL_REAL_VETKEYS_KAT_APP_ID,
      slot_id: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
    }),
    actor.app_mail__mail_status(null),
  ]);
  const bindingUid = "ok" in bindingResult
    ? bindingResult.ok.toString()
    : expectOnlyNotReserved(bindingResult.err);
  if (!("ok" in mailResult)) {
    throw new Error(
      `Mail status failed with ${Object.keys(mailResult.err)[0] ?? "unknown"}`,
    );
  }
  return {
    bindingUid,
    mail: projectMailStatus(mailResult.ok),
    slots: slots.map(projectSlot),
  };
}

function projectSlot(slot: CandidSlot): PrepareSlotState {
  return {
    currentGeneration: slot.current_generation.toString(),
    environment: variantTag(slot.environment, ["local", "production"], "environment"),
    generations: slot.generations.map((generation) => ({
      fingerprintBytes:
        generation.public_fingerprint.length === 0
          ? null
          : generation.public_fingerprint[0]!.length,
      generation: generation.generation.toString(),
      keyName: generation.key_name,
      status: variantTag(generation.status, ["current", "previous"], "generation status"),
    })),
    keyHolder: slot.key_holder.toText(),
    previousGeneration: oneOptionalNat(slot.previous_generation, "previous generation"),
    purpose: slot.purpose,
    slot: slot.slot,
    status: variantTag(
      slot.status,
      ["enabled", "disabled", "manifest_suspended"],
      "slot status",
    ),
  };
}

function projectMailStatus(status: CandidMailStatus): PrepareMailStatusState {
  const setup = "not_configured" in status.setup
    ? { kind: "not_configured" as const }
    : {
        kind: "configured" as const,
        currentGeneration: status.setup.configured.current_epoch.toString(),
        keyHolder: status.setup.configured.key_holder.toText(),
        previousGeneration: oneOptionalNat(
          status.setup.configured.previous_epoch,
          "Mail previous generation",
        ),
      };
  return {
    activeSends: status.active_sends.toString(),
    cleanupEpoch: status.cleanup_epoch.toString(),
    encryptedSettingsRevision: oneOptionalNat(
      status.encrypted_settings_revision,
      "encrypted settings revision",
    ),
    inboxBytes: status.inbox_bytes.toString(),
    inboxCount: status.inbox_count.toString(),
    mailRevision: status.mail_revision.toString(),
    outboxCount: status.outbox_count.toString(),
    sentAndOutboxBytes: status.sent_and_outbox_bytes.toString(),
    sentCount: status.sent_count.toString(),
    setup,
    storageLevel: variantTag(
      status.storage_level,
      ["normal", "approaching_limit", "almost_full"],
      "Mail storage level",
    ),
    unknownInboxBytes: status.unknown_at_receipt_bytes.toString(),
    unknownInboxCount: status.unknown_at_receipt_count.toString(),
    unreadCount: status.unread_count.toString(),
  };
}

function assertCleanMailStore(mail: PrepareMailStatusState): void {
  const nonzero = Object.entries({
    activeSends: mail.activeSends,
    cleanupEpoch: mail.cleanupEpoch,
    inboxBytes: mail.inboxBytes,
    inboxCount: mail.inboxCount,
    mailRevision: mail.mailRevision,
    outboxCount: mail.outboxCount,
    sentAndOutboxBytes: mail.sentAndOutboxBytes,
    sentCount: mail.sentCount,
    unknownInboxBytes: mail.unknownInboxBytes,
    unknownInboxCount: mail.unknownInboxCount,
    unreadCount: mail.unreadCount,
  }).filter(([, value]) => value !== "0");
  if (nonzero.length > 0 || mail.encryptedSettingsRevision !== null) {
    throw new Error(
      "KAT preparation refuses a previously used Mail store; use a fresh disposable Neutron",
    );
  }
  if (mail.storageLevel !== "normal") {
    throw new Error("KAT preparation requires normal empty Mail storage");
  }
}

function assertCurrentOnlySlot(
  slot: PrepareSlotState,
  expectedHolder: string,
  requireFingerprint: boolean,
): void {
  assertExactSlotIdentity(slot);
  if (slot.environment !== "local") {
    throw new Error("KAT preparation refuses production vetKeys");
  }
  if (slot.status !== "enabled") {
    throw new Error("KAT preparation requires an enabled Mail/mailbox slot");
  }
  if (slot.keyHolder !== expectedHolder) {
    throw new Error("Seed 2 must be the Mail/mailbox lifecycle manager for this disposable run");
  }
  if (slot.previousGeneration !== null || slot.generations.length !== 1) {
    throw new Error("KAT preparation refuses an already-previous or ambiguous Mail slot");
  }
  positiveDecimal(slot.currentGeneration, "Mail current generation");
  assertExactGeneration(
    slot.generations,
    slot.currentGeneration,
    "current",
    requireFingerprint,
  );
}

function assertExactSlotIdentity(slot: PrepareSlotState): void {
  if (
    slot.slot !== MAIL_REAL_VETKEYS_KAT_SLOT_ID ||
    slot.purpose !== MAIL_SLOT_PURPOSE
  ) {
    throw new Error("KAT preparation requires the exact installed Mail/mailbox declaration");
  }
}

function assertExactGeneration(
  generations: PrepareGenerationState[],
  generation: string,
  status: "current" | "previous",
  requireFingerprint: boolean,
): void {
  const matches = generations.filter((candidate) =>
    candidate.generation === generation && candidate.status === status
  );
  if (matches.length !== 1) {
    throw new Error(`Mail slot must contain exactly one ${status} generation`);
  }
  const match = matches[0]!;
  if (match.keyName !== MAIL_REAL_VETKEYS_KAT_KEY_NAME) {
    throw new Error(`KAT preparation refuses ${status} key name ${match.keyName}`);
  }
  if (
    (requireFingerprint && match.fingerprintBytes !== 32) ||
    (!requireFingerprint && match.fingerprintBytes !== null && match.fingerprintBytes !== 32)
  ) {
    throw new Error(`Mail ${status} generation has an invalid public-key fingerprint`);
  }
}

function assertMailSetupMatchesCurrent(
  mail: PrepareMailStatusState,
  slot: PrepareSlotState,
  allowNotConfigured: boolean,
): void {
  if (mail.setup.kind === "not_configured") {
    if (allowNotConfigured) return;
    throw new Error("Mail did not cache its exact current public generation");
  }
  if (
    mail.setup.currentGeneration !== slot.currentGeneration ||
    mail.setup.previousGeneration !== null ||
    mail.setup.keyHolder !== slot.keyHolder
  ) {
    throw new Error("Mail setup does not match the current-only Mail/mailbox slot");
  }
}

async function authenticateDeveloperIdentity(
  page: Page,
  cli: Pick<
    PrepareVetKeysKatCli,
    "developerIdentityPrincipal" | "developerIdentitySeed"
  >,
): Promise<void> {
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & {
      __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string>;
    }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login hook is unavailable");
    return login(seed);
  }, cli.developerIdentitySeed);
  if (principal !== cli.developerIdentityPrincipal) {
    throw new Error("Installed Neutron authenticated a principal other than the configured developer identity");
  }
  if (await page.locator('[data-tid="auth-error"]').count()) {
    throw new Error("Installed Neutron rejected its configured developer identity");
  }
}

async function openInstalledMail(page: Page): Promise<FrameLocator> {
  const background = page.locator('[data-tid="app-background-frame"][data-app-id="mail"]');
  await background.waitFor({ state: "attached", timeout: OPERATION_TIMEOUT_MS });
  if (await background.count() !== 1) {
    throw new Error("Installed Neutron must expose exactly one Mail resident frame");
  }
  const selector = 'iframe[data-app-id="mail"][data-tile-id="mail"]';
  if (await page.locator(selector).count() === 0) {
    const launcher = page.locator('[data-tid="launcher"]');
    if (!await launcher.isVisible().catch(() => false)) {
      const open = page.locator('[data-tid="launcher-open"]');
      if (await open.count() !== 1) throw new Error("Installed Neutron launcher is unavailable");
      await open.click();
      await launcher.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
    }
    const tile = page.locator('[data-tid="launcher-tile-mail-mail"]');
    if (await tile.count() !== 1) throw new Error("Mail is not installed in this Neutron");
    await tile.click();
  }
  const frame = page.locator(selector);
  await frame.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  if (await frame.count() !== 1) {
    throw new Error("Disposable KAT target must have exactly one installed Mail tile");
  }
  const mail = page.frameLocator(selector);
  await mail.getByRole("main", { name: "Private Mail" })
    .waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  await mail.getByRole("heading", { name: "Inbox" })
    .waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  return mail;
}

async function setUpPrivateMailIfNeeded(
  page: Page,
  mail: FrameLocator,
  needsSetup: boolean,
  needsReservation: boolean,
): Promise<void> {
  const setup = mail.getByRole("button", { name: "Set up private Mail" }).first();
  if (needsSetup) {
    await setup.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
    await setup.click();
    if (needsReservation) {
      await approveExactLifecycle(page, "Activate private-key slot");
    }
  } else if (await setup.isVisible().catch(() => false)) {
    throw new Error("Configured Mail unexpectedly exposed its setup action");
  }
  await mail.getByRole("searchbox", { name: "Search loaded mail headers" })
    .waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  if (await page.locator('[data-tid="vetkeys-lifecycle-dialog"]').count()) {
    throw new Error("Mail setup left an unexpected lifecycle request open");
  }
  if (await setup.count()) throw new Error("Private Mail setup did not finish seamlessly");
}

async function openKeyProtection(
  mail: FrameLocator,
  currentGeneration: string,
): Promise<void> {
  await mail.getByRole("button", { name: "Storage settings" }).click();
  await mail.getByRole("heading", { name: "Storage" })
    .waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  const generations = mail.getByLabel("Mail key generations");
  await generations.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  const text = await generations.innerText();
  if (!text.includes(`Current ${currentGeneration}`) || text.includes("Previous")) {
    throw new Error("Installed Mail UI does not show the attested current-only generation");
  }
}

async function rotateOnceThroughExactConsent(
  page: Page,
  mail: FrameLocator,
): Promise<void> {
  const rotate = mail.getByRole("button", { name: "Rotate key", exact: true });
  if (await rotate.count() !== 1) {
    throw new Error("Installed Mail must expose exactly one Rotate key action");
  }
  await rotate.click();
  await approveExactLifecycle(page, "Rotate private-key generation");
}

async function approveExactLifecycle(page: Page, title: string): Promise<void> {
  const dialog = page.locator('[data-tid="vetkeys-lifecycle-dialog"]');
  await dialog.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  if (await dialog.count() !== 1 || await dialog.getAttribute("role") !== "alertdialog") {
    throw new Error("Kernel lifecycle consent dialog is missing or ambiguous");
  }
  const text = await dialog.innerText();
  for (const expected of [
    title,
    "Mail (mail)",
    "mailbox",
    "App-provided purpose — unverified",
    MAIL_SLOT_PURPOSE,
  ]) {
    if (!text.includes(expected)) {
      throw new Error(`Kernel lifecycle consent omitted ${expected}`);
    }
  }
  const approve = dialog.locator('[data-tid="vetkeys-lifecycle-approve"]');
  if (await approve.count() !== 1 || await approve.innerText() !== "Approve") {
    throw new Error("Kernel lifecycle approval control is not exact");
  }
  await approve.click();
  await dialog.waitFor({ state: "detached", timeout: OPERATION_TIMEOUT_MS });
}

async function waitForPreparedRotation(
  actor: ActorSubclass<KatPrepareActor>,
  before: CurrentOnlyState,
): Promise<PreparedRotationState> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let lastError: unknown = new Error("Mail rotation did not start");
  while (Date.now() < deadline) {
    try {
      return assertPostRotationState(await readInstalledState(actor), before);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Installed UI rotation did not reach exact current+previous state", {
    cause: lastError,
  });
}

async function assertInstalledUiStoppedBeforeRetirement(
  mail: FrameLocator,
  rotated: PreparedRotationState,
): Promise<void> {
  const generations = mail.getByLabel("Mail key generations");
  await generations.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  const text = await generations.innerText();
  if (
    !text.includes(`Current ${rotated.currentGeneration}`) ||
    !text.includes(`Previous ${rotated.previousGeneration}`)
  ) {
    throw new Error("Installed Mail UI did not reconcile both retained generations");
  }
  const retirement = mail.getByRole("button", {
    name: "Retire previous key",
    exact: true,
  });
  await retirement.waitFor({ state: "visible", timeout: OPERATION_TIMEOUT_MS });
  if (await retirement.count() !== 1) {
    throw new Error("Installed Mail UI does not show the retained previous generation");
  }
}

function monitorInstalledSurface(page: Page, failures: string[]): void {
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    failures.push(
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
}

function deterministicDeveloperIdentity(
  cli: Pick<
    PrepareVetKeysKatCli,
    "developerIdentityPrincipal" | "developerIdentitySeed"
  >,
): Ed25519KeyIdentity {
  const identity = localIdentityFromSeed(cli.developerIdentitySeed);
  if (identity.getPrincipal().toText() !== cli.developerIdentityPrincipal) {
    throw new Error("Configured local developer identity does not match its derived principal");
  }
  if (
    cli.developerIdentitySeed !== MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED ||
    cli.developerIdentityPrincipal !== MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL
  ) {
    throw new Error(
      "The selected local config's developer identity does not match the frozen Mail vetKeys KAT profile",
    );
  }
  return identity;
}

function exactInstalledBrowserUrl(host: string, canisterId: string): string {
  const origin = localCanisterOrigin(canisterId, host);
  const url = new URL(origin);
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    if (url.hostname.split(".")[0] !== canisterId) {
      throw new Error("Installed browser target is not the exact local canister origin");
    }
    return `${url.origin}/`;
  }
  if (url.hostname !== "[::1]" && url.hostname !== "::1") {
    throw new Error("Installed browser target escaped explicit loopback");
  }
  url.pathname = "/";
  url.searchParams.set("canisterId", canisterId);
  return url.toString();
}

function canonicalCanister(value: string, label: string): string {
  let canonical: string;
  try {
    canonical = Principal.fromText(value).toText();
  } catch (error) {
    throw new Error(`${label} must be a valid principal`, { cause: error });
  }
  if (canonical !== value || canonical === "aaaaa-aa") {
    throw new Error(`${label} must be a canonical non-management principal`);
  }
  return canonical;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function positiveDecimal(value: string | null, label: string): string {
  if (value === null || !/^[1-9][0-9]*$/u.test(value) || value.length > 40) {
    throw new Error(`${label} must be a positive canonical decimal`);
  }
  return value;
}

function oneOptionalNat(value: Opt<bigint>, label: string): string | null {
  if (value.length === 0) return null;
  if (value.length !== 1) throw new Error(`${label} is ambiguous`);
  return value[0]!.toString();
}

function expectOnlyNotReserved(error: VetKeysError): null {
  const tags = Object.keys(error);
  if (tags.length === 1 && tags[0] === "not_reserved" && error.not_reserved === null) {
    return null;
  }
  throw new Error(
    `Mail/mailbox binding failed with ${tags[0] ?? "unknown"}`,
  );
}

function variantTag<const T extends string>(
  value: Record<string, unknown>,
  allowed: readonly T[],
  label: string,
): T {
  const tags = Object.keys(value);
  if (tags.length !== 1 || !allowed.includes(tags[0] as T)) {
    throw new Error(`${label} is invalid or ambiguous`);
  }
  return tags[0] as T;
}

const katPrepareIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const VetKeyError = IDL.Variant({
    busy: IDL.Null,
    challenge_consumed: IDL.Null,
    challenge_expired: IDL.Null,
    disabled: IDL.Null,
    generation_unavailable: IDL.Null,
    invalid_request: IDL.Null,
    key_unavailable: IDL.Null,
    low_cycles: IDL.Null,
    management_failure: IDL.Null,
    manifest_suspended: IDL.Null,
    not_declared: IDL.Null,
    not_reserved: IDL.Null,
    owner_required: IDL.Null,
    source_gone: IDL.Null,
  });
  const Environment = IDL.Variant({ local: IDL.Null, production: IDL.Null });
  const SlotStatus = IDL.Variant({
    disabled: IDL.Null,
    enabled: IDL.Null,
    manifest_suspended: IDL.Null,
  });
  const GenerationStatus = IDL.Variant({ current: IDL.Null, previous: IDL.Null });
  const Generation = IDL.Record({
    generation: IDL.Nat64,
    key_name: IDL.Text,
    public_fingerprint: IDL.Opt(IDL.Vec(IDL.Nat8)),
    status: GenerationStatus,
  });
  const Slot = IDL.Record({
    approximate_cycle_spend: IDL.Nat,
    created_at: IDL.Nat64,
    current_generation: IDL.Nat64,
    environment: Environment,
    generations: IDL.Vec(Generation),
    key_holder: IDL.Principal,
    last_used_at: IDL.Opt(IDL.Nat64),
    previous_generation: IDL.Opt(IDL.Nat64),
    purpose: IDL.Text,
    total_derivations: IDL.Nat,
    slot: IDL.Text,
    status: SlotStatus,
    updated_at: IDL.Nat64,
  });
  const BindingResult = IDL.Variant({ err: VetKeyError, ok: IDL.Nat });
  const RevisionConflict = IDL.Record({
    cleanup_epoch: IDL.Nat,
    contacts_revision: IDL.Nat,
    mail_revision: IDL.Nat,
  });
  const MailStoreError = IDL.Variant({
    clock_invalid: IDL.Null,
    contacts_conflict: IDL.Null,
    corrupt_state: IDL.Null,
    invalid_request: IDL.Null,
    not_found: IDL.Null,
    revision_conflict: RevisionConflict,
  });
  const MailSetup = IDL.Variant({
    configured: IDL.Record({
      current_epoch: IDL.Nat64,
      key_holder: IDL.Principal,
      previous_epoch: IDL.Opt(IDL.Nat64),
    }),
    not_configured: IDL.Null,
  });
  const StorageLevel = IDL.Variant({
    almost_full: IDL.Null,
    approaching_limit: IDL.Null,
    normal: IDL.Null,
  });
  const MailStatus = IDL.Record({
    active_sends: IDL.Nat,
    cleanup_epoch: IDL.Nat,
    contacts_revision: IDL.Nat,
    encrypted_settings_revision: IDL.Opt(IDL.Nat64),
    inbox_bytes: IDL.Nat,
    inbox_count: IDL.Nat,
    mail_revision: IDL.Nat,
    outbox_count: IDL.Nat,
    sent_and_outbox_bytes: IDL.Nat,
    sent_count: IDL.Nat,
    setup: MailSetup,
    storage_level: StorageLevel,
    unknown_at_receipt_bytes: IDL.Nat,
    unknown_at_receipt_count: IDL.Nat,
    unread_count: IDL.Nat,
  });
  const MailStatusResult = IDL.Variant({ err: MailStoreError, ok: MailStatus });
  return IDL.Service({
    kernel_check_authorized: IDL.Func([IDL.Null], [IDL.Bool], ["query"]),
    kernel_vetkeys_binding: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [BindingResult],
      ["query"],
    ),
    kernel_vetkeys_list: IDL.Func(
      [IDL.Record({ app_id: IDL.Text })],
      [IDL.Vec(Slot)],
      ["query"],
    ),
    app_mail__mail_status: IDL.Func(
      [IDL.Null],
      [MailStatusResult],
      ["query"],
    ),
  });
};

if (import.meta.main) {
  if (process.argv.slice(2).some((value) => value === "--help" || value === "-h")) {
    process.stdout.write(prepareUsage());
  } else {
    try {
      const cli = parsePrepareVetKeysKatCli(process.argv.slice(2));
      const prepared = await prepareVetKeysKat(cli);
      process.stdout.write(
        `Prepared disposable local Mail/mailbox slot UID ${prepared.slotUid}.\n` +
        `Retained current generation ${prepared.currentGeneration} and previous generation ${prepared.previousGeneration}.\n` +
        "Ready capture command (does not overwrite an existing vector):\n" +
        `${readyCaptureCommand(cli, prepared.slotUid)}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
