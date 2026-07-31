import { Actor, type ActorMethod } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import type { LocalNeutronRuntime } from "neutron-provision/src/local_session.ts";
import {
  createIsolationReport,
  type IsolationReport,
  type LocalPublicRoot,
} from "../src/isolation_report";
import {
  FIXTURE_APP_IDS,
  FIXTURE_SLOT,
  type FixtureAppId,
} from "../src/evidence";
import { createFixtureAgent, fixtureLocalRuntime } from "./pocketic-clock";

type Environment = { production: null } | { local: null };
type SlotStatus =
  | { enabled: null }
  | { disabled: null }
  | { manifest_suspended: null };
type GenerationStatus = { current: null } | { previous: null };

type AdminGeneration = {
  generation: bigint;
  status: GenerationStatus;
  key_name: string;
  public_fingerprint: [] | [Uint8Array];
};

type AdminSlot = {
  app_id: string;
  slot_uid: bigint;
  slot: string;
  status: SlotStatus;
  current_generation: bigint;
  generations: AdminGeneration[];
};

export type AdminSnapshot = {
  environment: [] | [Environment];
  slots: AdminSlot[];
  audit?: AuditEntry[];
};

export type AuditEntry = {
  action: Record<string, null>;
  scope: { app_id: string; installation_uid: bigint };
  at: bigint;
  generation: [] | [bigint];
  outcome: Record<string, null>;
  principal: { toText(): string };
  slot_id: string;
  slot_uid: [] | [bigint];
};

type PublicInfo = {
  canister_principal: { toText(): string };
  slot: string;
  generation: bigint;
  suite: string;
  key_name: string;
  public_key: Uint8Array;
  public_fingerprint: Uint8Array;
  derivation_input: Uint8Array;
};

type VetKeyFailure = Record<string, unknown>;
type Result<T> = { ok: T } | { err: VetKeyFailure };

type FixtureAuditActor = {
  kernel_vetkeys_admin_snapshot: ActorMethod<[null], AdminSnapshot>;
  kernel_vetkeys_audit_snapshot: ActorMethod<[null], AuditEntry[]>;
  kernel_vetkeys_binding: ActorMethod<[
    { app_id: string; slot_id: string },
  ], Result<bigint>>;
  kernel_vetkeys_public_key: ActorMethod<[
    { app_id: string; slot_id: string; generation: bigint },
  ], Result<PublicInfo>>;
};

export type InstalledVerifierInput = {
  canisterId: string;
  host: string;
  identitySeed: number;
};

const idl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) => {
  const EmptyError = IDL.Null;
  const VetKeyError = IDL.Variant({
    not_declared: EmptyError,
    not_reserved: EmptyError,
    manifest_suspended: EmptyError,
    disabled: EmptyError,
    generation_unavailable: EmptyError,
    invalid_request: EmptyError,
    challenge_expired: EmptyError,
    challenge_consumed: EmptyError,
    busy: EmptyError,
    low_cycles: EmptyError,
    key_unavailable: EmptyError,
    management_failure: EmptyError,
    source_gone: EmptyError,
    owner_required: EmptyError,
  });
  const SlotStatus = IDL.Variant({
    enabled: IDL.Null,
    disabled: IDL.Null,
    manifest_suspended: IDL.Null,
  });
  const GenerationStatus = IDL.Variant({
    current: IDL.Null,
    previous: IDL.Null,
  });
  const Generation = IDL.Record({
    generation: IDL.Nat64,
    status: GenerationStatus,
    key_name: IDL.Text,
    public_fingerprint: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });
  const AdminSlot = IDL.Record({
    app_id: IDL.Text,
    slot_uid: IDL.Nat,
    slot: IDL.Text,
    purpose: IDL.Opt(IDL.Text),
    key_holder: IDL.Principal,
    status: SlotStatus,
    current_generation: IDL.Nat64,
    previous_generation: IDL.Opt(IDL.Nat64),
    generations: IDL.Vec(Generation),
    created_at: IDL.Nat64,
    created_by: IDL.Principal,
    updated_at: IDL.Nat64,
    updated_by: IDL.Principal,
    last_used_at: IDL.Opt(IDL.Nat64),
    total_derivations: IDL.Nat,
    approximate_cycle_spend: IDL.Nat,
  });
  const AuditAction = IDL.Variant({
    reserve: IDL.Null,
    enable: IDL.Null,
    disable: IDL.Null,
    rotate: IDL.Null,
    retire_generation: IDL.Null,
    transfer: IDL.Null,
    retire_slot: IDL.Null,
    uninstall: IDL.Null,
    derive: IDL.Null,
    public_key: IDL.Null,
    manifest_suspend: IDL.Null,
  });
  const AuditOutcome = IDL.Variant({
    ok: IDL.Null,
    denied: IDL.Null,
    busy: IDL.Null,
    low_cycles: IDL.Null,
    unavailable: IDL.Null,
    failed: IDL.Null,
  });
  const Audit = IDL.Record({
    at: IDL.Nat64,
    scope: IDL.Record({ app_id: IDL.Text, installation_uid: IDL.Nat64 }),
    slot_uid: IDL.Opt(IDL.Nat),
    slot_id: IDL.Text,
    generation: IDL.Opt(IDL.Nat64),
    action: AuditAction,
    principal: IDL.Principal,
    outcome: AuditOutcome,
  });
  const Environment = IDL.Variant({
    production: IDL.Null,
    local: IDL.Null,
  });
  const AdminSnapshot = IDL.Record({
    environment: IDL.Opt(Environment),
    slots: IDL.Vec(AdminSlot),
    audit: IDL.Vec(Audit),
  });
  const PublicInfo = IDL.Record({
    canister_principal: IDL.Principal,
    slot: IDL.Text,
    generation: IDL.Nat64,
    suite: IDL.Text,
    key_name: IDL.Text,
    public_key: IDL.Vec(IDL.Nat8),
    public_fingerprint: IDL.Vec(IDL.Nat8),
    derivation_input: IDL.Vec(IDL.Nat8),
  });
  const BindingResult = IDL.Variant({ ok: IDL.Nat, err: VetKeyError });
  const PublicResult = IDL.Variant({ ok: PublicInfo, err: VetKeyError });
  return IDL.Service({
    kernel_vetkeys_admin_snapshot: IDL.Func(
      [IDL.Null],
      [AdminSnapshot],
      ["query"],
    ),
    kernel_vetkeys_audit_snapshot: IDL.Func(
      [IDL.Null],
      [IDL.Vec(Audit)],
      ["query"],
    ),
    kernel_vetkeys_binding: IDL.Func(
      [IDL.Record({ app_id: IDL.Text, slot_id: IDL.Text })],
      [BindingResult],
      ["query"],
    ),
    kernel_vetkeys_public_key: IDL.Func(
      [IDL.Record({
        app_id: IDL.Text,
        slot_id: IDL.Text,
        generation: IDL.Nat64,
      })],
      [PublicResult],
      [],
    ),
  });
};

export async function compareInstalledBindings(
  input: InstalledVerifierInput,
): Promise<IsolationReport> {
  const actor = await installedActor(input);
  const snapshot = await actor.kernel_vetkeys_admin_snapshot(null);
  assertLocalSnapshot(snapshot);
  const roots = await Promise.all(FIXTURE_APP_IDS.map((appId) =>
    readRoot(actor, snapshot, appId, input.canisterId),
  ));
  return createIsolationReport(roots[0]!, roots[1]!);
}

/** Exact controller-facing projections scanned by the installed redaction gate. */
export async function readInstalledVetKeysProjections(
  input: InstalledVerifierInput,
): Promise<{ admin: AdminSnapshot; audit: AuditEntry[] }> {
  const actor = await installedActor(input);
  const [admin, audit] = await Promise.all([
    actor.kernel_vetkeys_admin_snapshot(null),
    actor.kernel_vetkeys_audit_snapshot(null),
  ]);
  assertLocalSnapshot(admin);
  return { admin, audit };
}

async function installedActor(
  input: InstalledVerifierInput,
): Promise<FixtureAuditActor> {
  const host = assertLoopbackHost(input.host);
  const identity = localIdentityFromSeed(input.identitySeed);
  const agent = await createFixtureAgent(host, identity);
  return Actor.createActor<FixtureAuditActor>(idl, {
    agent,
    canisterId: input.canisterId,
  });
}

export function assertLoopbackHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error("--host must be an absolute loopback URL", { cause: error });
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    !isLoopbackHostname(hostname)
  ) {
    throw new Error("--host must be an HTTP loopback origin without path or credentials");
  }
  return url.origin;
}

export function assertLocalSnapshot(snapshot: AdminSnapshot): void {
  if (
    !Array.isArray(snapshot.environment) ||
    snapshot.environment.length !== 1 ||
    !("local" in snapshot.environment[0]!)
  ) {
    throw new Error("Installed vetKeys environment must be local");
  }
}

async function readRoot(
  actor: FixtureAuditActor,
  snapshot: AdminSnapshot,
  appId: FixtureAppId,
  expectedCanister: string,
): Promise<LocalPublicRoot> {
  const candidates = snapshot.slots.filter(
    (slot) => slot.app_id === appId && slot.slot === FIXTURE_SLOT,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `${appId}/${FIXTURE_SLOT} must be reserved exactly once before comparison`,
    );
  }
  const slot = candidates[0]!;
  if (!("enabled" in slot.status)) {
    throw new Error(`${appId}/${FIXTURE_SLOT} must be enabled`);
  }
  const current = slot.generations.filter(
    (generation) =>
      generation.generation === slot.current_generation &&
      "current" in generation.status,
  );
  if (
    current.length !== 1 ||
    current[0]!.key_name !== "test_key_1" ||
    current[0]!.public_fingerprint.length !== 1
  ) {
    throw new Error(
      `${appId}/${FIXTURE_SLOT} current generation must use test_key_1 with a public fingerprint`,
    );
  }

  const [binding, publicResult] = await Promise.all([
    actor.kernel_vetkeys_binding({ app_id: appId, slot_id: FIXTURE_SLOT }),
    actor.kernel_vetkeys_public_key({
      app_id: appId,
      slot_id: FIXTURE_SLOT,
      generation: slot.current_generation,
    }),
  ]);
  const bindingUid = unwrap(binding, `${appId} binding`);
  if (bindingUid !== slot.slot_uid) {
    throw new Error(`${appId} binding changed during comparison`);
  }
  const publicInfo = unwrap(publicResult, `${appId} public key`);
  if (
    publicInfo.canister_principal.toText() !== expectedCanister ||
    publicInfo.slot !== FIXTURE_SLOT ||
    publicInfo.generation !== slot.current_generation ||
    publicInfo.suite !== "bls12_381_g2" ||
    publicInfo.key_name !== "test_key_1"
  ) {
    throw new Error(`${appId} returned incompatible public key information`);
  }
  const publicKey = array(publicInfo.public_key, 96, `${appId} public key`);
  const publicFingerprint = array(
    publicInfo.public_fingerprint,
    32,
    `${appId} public fingerprint`,
  );
  const generationFingerprint = array(
    current[0]!.public_fingerprint[0],
    32,
    `${appId} stored public fingerprint`,
  );
  if (!equalBytes(publicFingerprint, generationFingerprint)) {
    throw new Error(`${appId} stored and returned fingerprints disagree`);
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(publicKey),
  )));
  if (!equalBytes(publicFingerprint, digest)) {
    throw new Error(`${appId} fingerprint is not SHA-256 of its public key`);
  }
  return {
    appId,
    slot: publicInfo.slot,
    slotUid: bindingUid.toString(),
    canisterPrincipal: publicInfo.canister_principal.toText(),
    generation: publicInfo.generation.toString(),
    publicKey,
    publicFingerprint,
    derivationInput: array(
      publicInfo.derivation_input,
      32,
      `${appId} derivation input`,
    ),
  };
}

function unwrap<T>(value: Result<T>, label: string): T {
  if ("ok" in value) return value.ok;
  const code = Object.keys(value.err)[0] ?? "unknown";
  throw new Error(`${label} failed: ${code}`);
}

function array(value: Uint8Array, length: number, label: string): number[] {
  const output = Array.from(value);
  if (
    output.length !== length ||
    output.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return output;
}

function equalBytes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function localIdentityFromSeed(seedByte: number): Ed25519KeyIdentity {
  if (!Number.isInteger(seedByte) || seedByte < 0 || seedByte > 255) {
    throw new Error(
      "The configured developer identity seed must be an integer from 0 to 255",
    );
  }
  const seed = new Uint8Array(32);
  seed[31] = seedByte;
  return Ed25519KeyIdentity.generate(seed);
}

function isLoopbackHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(
    hostname,
  );
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127;
}

export function parseArgs(
  args: readonly string[],
  runtime: LocalNeutronRuntime = fixtureLocalRuntime(),
): InstalledVerifierInput {
  if (args.length > 0) throw new Error(`Unknown option ${args[0]}`);
  const input = {
    canisterId: runtime.canisterId,
    host: runtime.gatewayUrl,
    identitySeed: runtime.developerIdentitySeed,
  };
  assertLoopbackHost(input.host);
  localIdentityFromSeed(input.identitySeed);
  return input;
}

if (import.meta.main) {
  try {
    const report = await compareInstalledBindings(
      parseArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
