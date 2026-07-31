import { Actor, HttpAgent, type ActorSubclass } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  DerivedPublicKey,
  EncryptedVetKey,
  TransportSecretKey,
} from "@dfinity/vetkeys";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveLocalNeutronRuntime,
  type LocalNeutronRuntime,
} from "neutron-provision/src/local_session.ts";
import { localIdentityFromSeed } from "neutron-provision/src/kernel.ts";
import {
  MAIL_REAL_VETKEYS_KAT_APP_ID,
  MAIL_REAL_VETKEYS_KAT_FILE,
  MAIL_REAL_VETKEYS_KAT_IDENTITY_PRINCIPAL,
  MAIL_REAL_VETKEYS_KAT_IDENTITY_SEED,
  MAIL_REAL_VETKEYS_KAT_KEY_NAME,
  MAIL_REAL_VETKEYS_KAT_SCHEMA,
  MAIL_REAL_VETKEYS_KAT_SLOT_ID,
  MAIL_REAL_VETKEYS_KAT_SUITE,
  MAIL_REAL_VETKEYS_KAT_TRANSPORT_PUBLIC_HEX,
  MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX,
  MAIL_REAL_VETKEYS_KAT_VERSION,
  PINNED_VETKEYS_PACKAGE,
  assertPinnedVetKeysInstallation,
  encodeRealVetKeysKat,
  fromHex,
  hex,
  type RealVetKeysKatGeneration,
  type RealVetKeysKatPublicInfo,
  type RealVetKeysKatVector,
  verifyRealVetKeysKat,
} from "./vetkeys_kat.ts";

/**
 * Loopback-only authorized release harness.
 *
 * Direct kernel_vetkeys_* actor calls are used here solely to capture the real
 * local management-canister response as an offline compatibility vector. They
 * are not an app-facing or supported key-derivation route. Installed apps use
 * Neutron's source-bound browser broker, whose endpoint/session/challenge
 * policy is proved by the separate kernel integration suite.
 */
const mailRoot = resolve(import.meta.dir, "..");
const DEFAULT_LOCAL_CONFIG = fileURLToPath(
  new URL("../../../local.ndeploy.json", import.meta.url),
);

type NullVariant<T extends string> = { [K in T]: null };
type Opt<T> = [] | [T];
type VetKeysError = Record<string, null | { retry_after_seconds: bigint }>;
type VetKeysResult<T> = { ok: T } | { err: VetKeysError };
type Environment = NullVariant<"local"> | NullVariant<"production">;
type SlotStatus =
  | NullVariant<"enabled">
  | NullVariant<"disabled">
  | NullVariant<"manifest_suspended">;
type GenerationStatus = NullVariant<"current"> | NullVariant<"previous">;

type CandidPublicInfo = {
  canister_principal: Principal;
  derivation_input: Uint8Array | number[];
  generation: bigint;
  key_name: string;
  public_fingerprint: Uint8Array | number[];
  public_key: Uint8Array | number[];
  slot: string;
  suite: string;
};

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

type KernelVetKeysActor = {
  kernel_check_authorized(input: null): Promise<boolean>;
  kernel_vetkeys_binding(input: {
    app_id: string;
    slot_id: string;
  }): Promise<VetKeysResult<bigint>>;
  kernel_vetkeys_derive(input: {
    app_id: string;
    expected_slot_uid: bigint;
    generation: bigint;
    slot_id: string;
    transport_public_key: Uint8Array;
  }): Promise<VetKeysResult<{
    encrypted_key: Uint8Array | number[];
    public_info: CandidPublicInfo;
  }>>;
  kernel_vetkeys_list(input: { app_id: string }): Promise<CandidSlot[]>;
  kernel_vetkeys_public_key(input: {
    app_id: string;
    generation: bigint;
    slot_id: string;
  }): Promise<VetKeysResult<CandidPublicInfo>>;
};

export type CaptureVetKeysKatCli = {
  canisterId: string;
  configPath: string;
  developerIdentityPrincipal: string;
  developerIdentitySeed: number;
  host: string;
  replace: boolean;
  slotUid: bigint;
};

type LocalRuntimeResolver = (options: {
  configPath?: string;
}) => LocalNeutronRuntime;

async function main(): Promise<void> {
  const cli = parseCaptureVetKeysKatCli(process.argv.slice(2));
  await assertPinnedVetKeysInstallation(mailRoot);

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

  const agent = await HttpAgent.create({ host: cli.host, identity });
  await agent.fetchRootKey();
  const actor = Actor.createActor<KernelVetKeysActor>(kernelVetKeysIdl, {
    agent,
    canisterId: cli.canisterId,
  });

  if (!(await actor.kernel_check_authorized(null))) {
    throw new Error(
      `Configured developer principal ${cli.developerIdentityPrincipal} is not authorized by this Neutron`,
    );
  }
  const slot = await loadExactSlot(actor, cli.slotUid);
  const currentGeneration = slot.current_generation;
  const previousGeneration = oneOpt(
    slot.previous_generation,
    "Mail slot must have one previous generation; rotate it before capture",
  );
  if (currentGeneration === previousGeneration) {
    throw new Error("Mail slot current and previous generations are identical");
  }

  const transportSecret = fromHex(
    MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX,
    32,
    "frozen transport secret key",
  );
  const transport = TransportSecretKey.deserialize(transportSecret);
  if (hex(transport.publicKeyBytes()) !== MAIL_REAL_VETKEYS_KAT_TRANSPORT_PUBLIC_HEX) {
    throw new Error("Pinned vetKeys package changed the frozen transport public key");
  }

  const current = await captureGeneration(
    actor,
    cli.slotUid,
    currentGeneration,
    "current",
    transport,
    summaryFingerprint(slot.generations, currentGeneration, "current"),
  );
  const previous = await captureGeneration(
    actor,
    cli.slotUid,
    previousGeneration,
    "previous",
    transport,
    summaryFingerprint(slot.generations, previousGeneration, "previous"),
  );
  const vector: RealVetKeysKatVector = {
    capture: {
      environment: "local",
      identityPrincipal: cli.developerIdentityPrincipal,
      identitySeed: cli.developerIdentitySeed,
      keyName: MAIL_REAL_VETKEYS_KAT_KEY_NAME,
      library: { ...PINNED_VETKEYS_PACKAGE },
    },
    generations: { current, previous },
    neutron: {
      appId: MAIL_REAL_VETKEYS_KAT_APP_ID,
      canisterPrincipal: cli.canisterId,
      slotId: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
      slotUid: cli.slotUid.toString(),
    },
    schema: MAIL_REAL_VETKEYS_KAT_SCHEMA,
    transport: {
      publicKeyHex: MAIL_REAL_VETKEYS_KAT_TRANSPORT_PUBLIC_HEX,
      secretKeyHex: MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX,
    },
    version: MAIL_REAL_VETKEYS_KAT_VERSION,
  };
  verifyRealVetKeysKat(vector);

  const output = resolve(mailRoot, MAIL_REAL_VETKEYS_KAT_FILE);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encodeRealVetKeysKat(vector), {
    encoding: "utf8",
    flag: cli.replace ? "w" : "wx",
    mode: 0o644,
  });
  process.stdout.write(
    `Captured real current+previous vetKeys KAT at ${output}\n` +
      `Neutron ${cli.canisterId}, Mail slot UID ${cli.slotUid.toString()}, generations ` +
      `${currentGeneration.toString()}/${previousGeneration.toString()}\n`,
  );
}

async function loadExactSlot(
  actor: ActorSubclass<KernelVetKeysActor>,
  expectedSlotUid: bigint,
): Promise<CandidSlot> {
  const binding = expectOk(
    await actor.kernel_vetkeys_binding({
      app_id: MAIL_REAL_VETKEYS_KAT_APP_ID,
      slot_id: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
    }),
    "kernel_vetkeys_binding",
  );
  if (binding !== expectedSlotUid) {
    throw new Error(
      `Mail/mailbox is slot UID ${binding.toString()}, not requested UID ${expectedSlotUid.toString()}`,
    );
  }
  const slots = await actor.kernel_vetkeys_list({ app_id: MAIL_REAL_VETKEYS_KAT_APP_ID });
  const matches = slots.filter((candidate) => candidate.slot === MAIL_REAL_VETKEYS_KAT_SLOT_ID);
  if (matches.length !== 1) throw new Error("Neutron did not return exactly one Mail/mailbox slot");
  const slot = matches[0]!;
  if (!("local" in slot.environment)) {
    throw new Error("Capture refuses a non-local vetKeys environment");
  }
  if (!("enabled" in slot.status)) {
    throw new Error("Capture requires an enabled Mail/mailbox slot");
  }
  const previous = oneOpt(
    slot.previous_generation,
    "Mail slot must have one previous generation; rotate it before capture",
  );
  if (slot.generations.length !== 2) {
    throw new Error("Capture requires exactly one current and one previous generation");
  }
  assertSummaryGeneration(slot.generations, slot.current_generation, "current");
  assertSummaryGeneration(slot.generations, previous, "previous");
  return slot;
}

function assertSummaryGeneration(
  generations: CandidGeneration[],
  expected: bigint,
  status: "current" | "previous",
): void {
  const matches = generations.filter(
    (generation) => generation.generation === expected && status in generation.status,
  );
  if (matches.length !== 1) {
    throw new Error(`Mail slot does not contain exactly one ${status} generation`);
  }
  const generation = matches[0]!;
  if (generation.key_name !== MAIL_REAL_VETKEYS_KAT_KEY_NAME) {
    throw new Error(`Capture refuses ${status} key name ${generation.key_name}`);
  }
  if (generation.public_fingerprint.length !== 1) {
    throw new Error(`${status} generation has no cached public-key fingerprint`);
  }
  if (generation.public_fingerprint[0]!.length !== 32) {
    throw new Error(`${status} generation has a malformed public-key fingerprint`);
  }
}

function summaryFingerprint(
  generations: CandidGeneration[],
  expected: bigint,
  status: "current" | "previous",
): Uint8Array {
  const generation = generations.find(
    (candidate) => candidate.generation === expected && status in candidate.status,
  );
  if (!generation || generation.public_fingerprint.length !== 1) {
    throw new Error(`Missing ${status} generation fingerprint`);
  }
  return Uint8Array.from(generation.public_fingerprint[0]!);
}

async function captureGeneration(
  actor: ActorSubclass<KernelVetKeysActor>,
  slotUid: bigint,
  generation: bigint,
  status: "current" | "previous",
  transport: TransportSecretKey,
  expectedFingerprint: Uint8Array,
): Promise<RealVetKeysKatGeneration> {
  const request = {
    app_id: MAIL_REAL_VETKEYS_KAT_APP_ID,
    generation,
    slot_id: MAIL_REAL_VETKEYS_KAT_SLOT_ID,
  };
  const publicResponse = expectOk(
    await actor.kernel_vetkeys_public_key(request),
    `kernel_vetkeys_public_key(${status})`,
  );
  const publicInfo = projectPublicInfo(publicResponse, generation, status);
  if (publicInfo.publicFingerprintHex !== hex(expectedFingerprint)) {
    throw new Error(`${status} public-key response changed from the live slot summary`);
  }
  const derive = expectOk(
    await actor.kernel_vetkeys_derive({
      ...request,
      expected_slot_uid: slotUid,
      transport_public_key: transport.publicKeyBytes(),
    }),
    `kernel_vetkeys_derive(${status})`,
  );
  const derivePublicInfo = projectPublicInfo(derive.public_info, generation, `${status} derive`);
  if (JSON.stringify(derivePublicInfo) !== JSON.stringify(publicInfo)) {
    throw new Error(`${status} derive returned public info different from public-key lookup`);
  }
  const encrypted = Uint8Array.from(derive.encrypted_key);
  if (encrypted.length !== 192) {
    throw new Error(`${status} derive returned ${encrypted.length} encrypted bytes, expected 192`);
  }
  const decrypted = EncryptedVetKey.deserialize(encrypted).decryptAndVerify(
    TransportSecretKey.deserialize(fromHex(
      MAIL_REAL_VETKEYS_KAT_TRANSPORT_SECRET_HEX,
      32,
      "frozen transport secret key",
    )),
    DerivedPublicKey.deserialize(Uint8Array.from(publicResponse.public_key)),
    Uint8Array.from(publicResponse.derivation_input),
  );
  return {
    decryptedVetKeyHex: hex(decrypted.serialize()),
    derivePublicInfo,
    encryptedVetKeyHex: hex(encrypted),
    generation: generation.toString(),
    publicInfo,
    status,
  };
}

function projectPublicInfo(
  info: CandidPublicInfo,
  generation: bigint,
  label: string,
): RealVetKeysKatPublicInfo {
  if (
    info.canister_principal.toText() === "aaaaa-aa" ||
    info.generation !== generation ||
    info.key_name !== MAIL_REAL_VETKEYS_KAT_KEY_NAME ||
    info.slot !== MAIL_REAL_VETKEYS_KAT_SLOT_ID ||
    info.suite !== MAIL_REAL_VETKEYS_KAT_SUITE ||
    info.public_key.length !== 96 ||
    info.public_fingerprint.length !== 32 ||
    info.derivation_input.length !== 32
  ) {
    throw new Error(`${label} public info does not match the frozen local profile`);
  }
  return {
    canisterPrincipal: info.canister_principal.toText(),
    derivationInputHex: hex(info.derivation_input),
    generation: generation.toString(),
    keyName: info.key_name,
    publicFingerprintHex: hex(info.public_fingerprint),
    publicKeyHex: hex(info.public_key),
    slot: info.slot,
    suite: info.suite,
  };
}

function expectOk<T>(result: VetKeysResult<T>, operation: string): T {
  if ("ok" in result) return result.ok;
  const tag = Object.keys(result.err)[0] ?? "unknown";
  throw new Error(`${operation} failed with ${tag}`);
}

function oneOpt<T>(value: Opt<T>, error: string): T {
  if (value.length !== 1) throw new Error(error);
  return value[0]!;
}

export function parseCaptureVetKeysKatCli(
  args: readonly string[],
  resolveRuntime: LocalRuntimeResolver = resolveLocalNeutronRuntime,
): CaptureVetKeysKatCli {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  let configPath: string | null = null;
  let slotUid: bigint | null = null;
  let replace = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--replace") {
      if (replace) throw new Error(`Duplicate option --replace\n${usage()}`);
      replace = true;
      continue;
    }
    if (option !== "--config" && option !== "--slot-uid") {
      throw new Error(`Unknown argument ${option ?? ""}\n${usage()}`);
    }
    if (seen.has(option)) throw new Error(`Duplicate option ${option}`);
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option ?? "argument"}\n${usage()}`);
    }
    index += 1;
    if (option === "--config") configPath = resolve(value);
    else slotUid = parsePositiveNat(value, "slot UID");
  }
  if (slotUid === null) {
    throw new Error(`--slot-uid is required\n${usage()}`);
  }
  const selectedConfigPath = configPath ?? DEFAULT_LOCAL_CONFIG;
  const runtime = resolveRuntime({ configPath: selectedConfigPath });
  return {
    canisterId: runtime.canisterId,
    configPath: selectedConfigPath,
    developerIdentityPrincipal: runtime.developerIdentityPrincipal,
    developerIdentitySeed: runtime.developerIdentitySeed,
    host: runtime.gatewayUrl,
    replace,
    slotUid,
  };
}

function parsePositiveNat(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value) || value.length > 40) {
    throw new Error(`Invalid positive decimal ${label}`);
  }
  return BigInt(value);
}

function usage(): string {
  return [
    "Capture the real local Mail current+previous vetKeys known-answer vector.",
    "This authorized loopback release harness is not an app-facing derivation API.",
    "",
    "Usage:",
    "  bun scripts/capture-vetkeys-kat.ts [--config <CONFIG.ndeploy.json>] \\",
    "    --slot-uid <mail-slot-uid> [--replace]",
    "",
    "The config defaults to the repository's local.ndeploy.json. The target",
    "canister, gateway, and developer identity come only from that config's one",
    "matching schema-3 provision session; --host and --canister-id are not supported.",
    "Preconditions: the configured developer matches the frozen KAT identity and",
    "is authorized; Mail/mailbox is enabled; the slot was",
    "rotated once and retains exactly one previous generation; the kernel vetKeys",
    "environment is local and both generations use test_key_1.",
    "",
  ].join("\n");
}

const kernelVetKeysIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
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
  const GenerationSummary = IDL.Record({
    generation: IDL.Nat64,
    key_name: IDL.Text,
    public_fingerprint: IDL.Opt(IDL.Vec(IDL.Nat8)),
    status: GenerationStatus,
  });
  const PublicSlotSummary = IDL.Record({
    approximate_cycle_spend: IDL.Nat,
    created_at: IDL.Nat64,
    current_generation: IDL.Nat64,
    environment: Environment,
    generations: IDL.Vec(GenerationSummary),
    key_holder: IDL.Principal,
    last_used_at: IDL.Opt(IDL.Nat64),
    previous_generation: IDL.Opt(IDL.Nat64),
    purpose: IDL.Text,
    total_derivations: IDL.Nat,
    slot: IDL.Text,
    status: SlotStatus,
    updated_at: IDL.Nat64,
  });
  const PublicKeyInfo = IDL.Record({
    canister_principal: IDL.Principal,
    derivation_input: IDL.Vec(IDL.Nat8),
    generation: IDL.Nat64,
    key_name: IDL.Text,
    public_fingerprint: IDL.Vec(IDL.Nat8),
    public_key: IDL.Vec(IDL.Nat8),
    slot: IDL.Text,
    suite: IDL.Text,
  });
  const BindingResult = IDL.Variant({ err: VetKeyError, ok: IDL.Nat });
  const PublicKeyResult = IDL.Variant({ err: VetKeyError, ok: PublicKeyInfo });
  const DeriveOutput = IDL.Record({
    encrypted_key: IDL.Vec(IDL.Nat8),
    public_info: PublicKeyInfo,
  });
  const DeriveResult = IDL.Variant({ err: VetKeyError, ok: DeriveOutput });
  return IDL.Service({
    kernel_check_authorized: IDL.Func([IDL.Null], [IDL.Bool], ["query"]),
    kernel_vetkeys_binding: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [BindingResult],
      ["query"],
    ),
    kernel_vetkeys_derive: IDL.Func(
      [IDL.Record({
        app_id: IDL.Text,
        expected_slot_uid: IDL.Nat,
        generation: IDL.Nat64,
        slot_id: IDL.Text,
        transport_public_key: IDL.Vec(IDL.Nat8),
      })],
      [DeriveResult],
      [],
    ),
    kernel_vetkeys_list: IDL.Func(
      [IDL.Record({ app_id: IDL.Text })],
      [IDL.Vec(PublicSlotSummary)],
      ["query"],
    ),
    kernel_vetkeys_public_key: IDL.Func(
      [IDL.Record({
        app_id: IDL.Text,
        generation: IDL.Nat64,
        slot_id: IDL.Text,
      })],
      [PublicKeyResult],
      [],
    ),
  });
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
