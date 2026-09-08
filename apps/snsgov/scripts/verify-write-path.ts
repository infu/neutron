/**
 * Write-path verification against a real SNS governance canister.
 *
 * This is the M4 gate. It pulls the genuine SNS governance Wasm out of
 * PocketIC's SNS-W, installs it with a hand-built init containing one neuron
 * and one open proposal, then dispatches a vote encoded by our own
 * `encodeRegisterVote` and checks the ballot actually flipped.
 *
 * Run with `npm run verify:write-path`. By default it resolves the repository's
 * hash-pinned PocketIC binary and starts its own server on a free control port.
 * No HTTP gateway or fixed port is needed. SNSGOV_POCKETIC can optionally point
 * at an existing local control server; only the instance created by this script
 * is deleted. Both the instance and an owned server are cleaned up on failure.
 *
 * Expected output:
 *
 *   our encodeRegisterVote: 103 bytes
 *   manage_neuron -> ok=true command=RegisterVote
 *   after:  ballot vote = 1 (1 = yes)
 *   second vote -> errorType=10 "Neuron already voted on proposal."
 *   isAlreadyVoted() = true
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient, type PocketIcRawEffectivePrincipal } from "neutron-provision/src/pocketic_rest.ts";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { idlFactory as govIdl, init as governanceInit } from "../src/candid/sns_governance.did.js";
import { idlFactory as wIdl } from "../src/candid/sns_wasm.did.js";
import { encodeRegisterVote, decodeManageNeuronResponse, isAlreadyVoted } from "../src/data/manage_neuron";
import { toHex } from "../src/data/format";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const ANON = Principal.anonymous();

/**
 * A fresh instance with the SNS feature on.
 *
 * `icp_features.sns` is what makes PocketIC deploy SNS-W with all six SNS Wasms
 * preloaded, which is where the genuine governance Wasm below comes from. No
 * HTTP gateway is requested: every call here goes through the REST control API,
 * and a gateway would only contend for a fixed port.
 */
async function createInstance(BASE: string): Promise<number> {
  const subnet = { instruction_config: "Production", state_config: "New", subnet_admins: null, cost_schedule: "Normal" };
  const response = await fetch(`${BASE}/instances`, {
    method: "POST",
    signal: AbortSignal.timeout(15 * 60_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subnet_config_set: {
        nns: subnet, sns: subnet, ii: null, fiduciary: null, bitcoin: null,
        test_threshold_keys: null, system: [], application: [subnet],
        cloud_engine: [], verified_application: [],
      },
      http_gateway_config: null,
      state_dir: null,
      icp_config: null,
      log_level: null,
      bitcoind_addr: null,
      dogecoind_addr: null,
      icp_features: {
        registry: "DefaultConfig", cycles_minting: "DefaultConfig",
        icp_token: "DefaultConfig", cycles_token: "DefaultConfig",
        nns_governance: "DefaultConfig", sns: "DefaultConfig",
        ii: null, nns_ui: null, bitcoin: null, dogecoin: null,
        canister_migration: null,
      },
      incomplete_state: "Disabled",
      initial_time: { AutoProgress: { artificial_delay_ms: null } },
      mainnet_nns_subnet_id: true,
      disable_ingress_validation: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`create instance failed (${response.status}): ${text}`);
  // PocketIC 14 wraps the reply as `{ Created: { instance_id, topology } }`.
  const parsed = JSON.parse(text);
  const id = parsed?.Created?.instance_id ?? parsed?.instance_id;
  if (typeof id !== "number") throw new Error(`no instance_id in ${text.slice(0, 200)}`);
  return id;
}

async function verify(BASE: string, INST: number): Promise<void> {
  const client = new PocketIcRestClient(`${BASE}/`);
  console.log(`pocket-ic instance ${INST} at ${BASE}`);

  // The shared REST transport follows PocketIC operation graph references after
  // 202 replies, without submitting the same accepted write a second time.
  async function call(canister: Principal, method: string, payload: Uint8Array, eff: PocketIcRawEffectivePrincipal): Promise<Uint8Array> {
    const message = await client.submitIngressMessage(INST, {
      sender: ANON, canisterId: canister, method, payload, effectivePrincipal: eff,
    });
    return client.awaitIngressMessage(INST, message);
  }
  async function query(canister: Principal, method: string, payload: Uint8Array): Promise<Uint8Array> {
    return client.queryCanister(INST, { sender: ANON, canisterId: canister, method, payload });
  }

  const topologyResponse = await fetch(`${BASE}/instances/${INST}/read/topology`, { signal: AbortSignal.timeout(30_000) });
  if (!topologyResponse.ok) throw new Error(`Topology read failed (${topologyResponse.status})`);
  const topo = await topologyResponse.json();
  const appSubnet = Object.entries(topo.subnet_configs).find(([, c]: any) => c.subnet_kind === "Application")![0];
  console.log(`application subnet: ${appSubnet}`);

  // 1. Real SNS governance wasm, straight out of SNS-W.
  const SNS_W = Principal.fromText("qaa6y-5yaaa-aaaaa-aaafa-cai");
  const wSvc = wIdl({ IDL }) as any;
  const f = (n: string) => wSvc._fields.find(([m]: [string]) => m === n)[1];
  const verReply = await query(SNS_W, "get_latest_sns_version_pretty", new Uint8Array(IDL.encode(f("get_latest_sns_version_pretty").argTypes, [null])));
  const versions = IDL.decode(f("get_latest_sns_version_pretty").retTypes, verReply)[0] as [string, string][];
  const govHash = versions.find(([n]) => n === "Governance")![1];
  const hash = Uint8Array.from((govHash.match(/../g) as string[]).map((h) => parseInt(h, 16)));
  const wasmReply = await query(SNS_W, "get_wasm", new Uint8Array(IDL.encode(f("get_wasm").argTypes, [{ hash }])));
  const wasm = Uint8Array.from((IDL.decode(f("get_wasm").retTypes, wasmReply)[0] as any).wasm[0].wasm);
  const wasmSha256 = createHash("sha256").update(wasm).digest("hex");
  assert.equal(wasmSha256, govHash.toLowerCase(), "SNS-W must return the requested governance Wasm");
  console.log(`SNS governance wasm from SNS-W: ${wasm.length} bytes, sha256=${wasmSha256}`);

  // 2. Create + install a real governance canister with a pre-made neuron and proposal.
  const MGMT = Principal.fromText("aaaaa-aa");
  const CreateArg = IDL.Record({ amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({})), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64) });
  const CreateRet = IDL.Record({ canister_id: IDL.Principal });
  const createReply = await call(MGMT, "provisional_create_canister_with_cycles",
    new Uint8Array(IDL.encode([CreateArg], [{ amount: [100_000_000_000_000n], settings: [], specified_id: [], sender_canister_version: [] }])),
    { SubnetId: b64(Principal.fromText(appSubnet).toUint8Array()) });
  const govId = (IDL.decode([CreateRet], createReply)[0] as any).canister_id as Principal;
  console.log(`governance canister: ${govId.toText()}`);

  const neuronBytes = new Uint8Array(32); neuronBytes[31] = 1;
  const key = toHex(neuronBytes);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const perms = (ids: number[]) => ({ permissions: Int32Array.from(ids) });
  const params = {
    default_followees: [{ followees: [] }], max_dissolve_delay_seconds: [15_780_096n],
    max_dissolve_delay_bonus_percentage: [100n], max_followees_per_function: [15n],
    neuron_claimer_permissions: [perms([0,1,2,3,4,5,6,7,8,9,10])], neuron_minimum_stake_e8s: [100_000_000n],
    max_neuron_age_for_age_bonus: [15_780_096n], initial_voting_period_seconds: [345_600n],
    neuron_minimum_dissolve_delay_to_vote_seconds: [2_630_016n], reject_cost_e8s: [100_000_000n],
    max_proposals_to_keep_per_action: [100], wait_for_quiet_deadline_increase_seconds: [86_400n],
    max_number_of_neurons: [200_000n], transaction_fee_e8s: [10_000n],
    max_number_of_proposals_with_ballots: [700n], max_age_bonus_percentage: [25n],
    neuron_grantable_permissions: [perms([0,1,2,3,4,5,6,7,8,9,10])],
    voting_rewards_parameters: [{ final_reward_rate_basis_points: [0n], initial_reward_rate_basis_points: [0n], reward_rate_transition_duration_seconds: [31_557_600n], round_duration_seconds: [86_400n] }],
    maturity_modulation_disabled: [true], max_number_of_principals_per_neuron: [5n],
    automatically_advance_target_version: [], custom_proposal_criticality: [],
  };
  const gov = {
    root_canister_id: [MGMT], id_to_nervous_system_functions: [], metrics: [], maturity_modulation: [],
    mode: 1, parameters: [params], is_finalizing_disburse_maturity: [], deployed_version: [],
    cached_upgrade_steps: [], sns_initialization_parameters: "", latest_reward_event: [], pending_version: [],
    swap_canister_id: [MGMT], ledger_canister_id: [MGMT],
    proposals: [[1n, {
      id: [{ id: 1n }], payload_text_rendering: [], topic: [], action: 1n, failure_reason: [], action_auxiliary: [],
      ballots: [[key, { vote: 0, voting_power: 100_000_000n, cast_timestamp_seconds: 0n }]],
      minimum_yes_proportion_of_total: [], reward_event_round: 0n, failed_timestamp_seconds: 0n,
      reward_event_end_timestamp_seconds: [], proposal_creation_timestamp_seconds: now,
      initial_voting_period_seconds: 345_600n, reject_cost_e8s: 100_000_000n,
      latest_tally: [{ yes: 0n, no: 0n, total: 100_000_000n, timestamp_seconds: now }],
      wait_for_quiet_deadline_increase_seconds: 86_400n, decided_timestamp_seconds: 0n,
      proposal: [{ title: "Local test motion", summary: "Vote on me.", url: "", action: [{ Motion: { motion_text: "hi" } }] }],
      proposer: [{ id: neuronBytes }], wait_for_quiet_state: [{ current_deadline_timestamp_seconds: now + 345_600n }],
      minimum_yes_proportion_of_exercised: [], is_eligible_for_rewards: true, executed_timestamp_seconds: 0n,
    }]],
    in_flight_commands: [],
    sns_metadata: [{ url: ["https://example.invalid"], logo: [], name: ["Local Test SNS"], description: ["A local SNS for write-path verification."] }],
    neurons: [[key, {
      id: [{ id: neuronBytes }], staked_maturity_e8s_equivalent: [],
      permissions: [{ principal: [ANON], permission_type: Int32Array.from([3, 4]) }],
      maturity_e8s_equivalent: 0n, cached_neuron_stake_e8s: 100_000_000n,
      created_timestamp_seconds: now, source_nns_neuron_id: [], auto_stake_maturity: [],
      aging_since_timestamp_seconds: now, dissolve_state: [{ DissolveDelaySeconds: 15_780_096n }],
      voting_power_percentage_multiplier: 100n, vesting_period_seconds: [],
      disburse_maturity_in_progress: [], followees: [], topic_followees: [], neuron_fees_e8s: 0n,
    }]],
    genesis_timestamp_seconds: now, target_version: [], timers: [], upgrade_journal: [],
  };
  const initArg = new Uint8Array(IDL.encode(governanceInit({ IDL }) as IDL.Type[], [gov]));
  const InstallArg = IDL.Record({
    mode: IDL.Variant({ install: IDL.Null, reinstall: IDL.Null, upgrade: IDL.Null }),
    canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8),
    sender_canister_version: IDL.Opt(IDL.Nat64),
  });
  await call(MGMT, "install_code", new Uint8Array(IDL.encode([InstallArg], [{
    mode: { install: null }, canister_id: govId, wasm_module: wasm, arg: initArg, sender_canister_version: [],
  }])), { CanisterId: b64(govId.toUint8Array()) });
  console.log("installed real SNS governance with 1 neuron + 1 open proposal");

  // 3. THE TEST: our encoder against the real canister.
  const g = govIdl({ IDL }) as any;
  const gf = (n: string) => g._fields.find(([m]: [string]) => m === n)[1];
  const before = IDL.decode(gf("get_proposal").retTypes, await query(govId, "get_proposal",
    new Uint8Array(IDL.encode(gf("get_proposal").argTypes, [{ proposal_id: [{ id: 1n }] }]))))[0] as any;
  assert.equal(before.result[0].Proposal.ballots[0][1].vote, 0, "Fixture ballot must start uncast");
  console.log(`before: ballot vote = ${before.result[0].Proposal.ballots[0][1].vote}`);

  const voteBytes = encodeRegisterVote(key, 1n, true);
  console.log(`our encodeRegisterVote: ${voteBytes.length} bytes`);
  const reply = await call(govId, "manage_neuron", voteBytes, { CanisterId: b64(govId.toUint8Array()) });
  const outcome = decodeManageNeuronResponse(reply);
  console.log(`manage_neuron -> ok=${outcome.ok} command=${outcome.command ?? "-"} err=${outcome.errorMessage ?? "-"}`);
  assert.equal(outcome.ok, true, outcome.errorMessage ?? "RegisterVote must succeed");
  assert.equal(outcome.command, "RegisterVote");

  const after = IDL.decode(gf("get_proposal").retTypes, await query(govId, "get_proposal",
    new Uint8Array(IDL.encode(gf("get_proposal").argTypes, [{ proposal_id: [{ id: 1n }] }]))))[0] as any;
  const b = after.result[0].Proposal;
  console.log(`after:  ballot vote = ${b.ballots[0][1].vote} (1 = yes)`);
  console.log(`        tally yes = ${b.latest_tally[0].yes}, decided = ${b.decided_timestamp_seconds > 0n}`);
  assert.equal(b.ballots[0][1].vote, 1, "The real governance canister must record our yes vote");
  assert.equal(b.latest_tally[0].yes, 100_000_000n, "The yes tally must include the neuron voting power");

  // 4. Double vote must read as success.
  const second = decodeManageNeuronResponse(await call(govId, "manage_neuron", voteBytes, { CanisterId: b64(govId.toUint8Array()) }));
  console.log(`second vote -> ok=${second.ok} errorType=${second.errorType} msg="${(second.errorMessage ?? "").slice(0, 40)}"`);
  console.log(`isAlreadyVoted() = ${isAlreadyVoted(second)}  <- must be true`);

  assert.equal(second.ok, false, "The second vote must return an already-voted result");
  assert.equal(second.errorType, 10);
  assert.equal(isAlreadyVoted(second), true);
  console.log(JSON.stringify({ verified: true, governanceWasmSha256: wasmSha256, governanceWasmBytes: wasm.length, voteBytes: voteBytes.length, ballotVote: b.ballots[0][1].vote, alreadyVoted: true }));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let server: ChildProcess | undefined;
let temp: string | undefined;
let base = process.env.SNSGOV_POCKETIC?.replace(/\/+$/, "");
let instanceId: number | undefined;
try {
  if (!base) {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "snsgov-write-test-"));
    const binary = await resolvePocketIcBinary({ cacheDirectory: path.resolve(import.meta.dir, "../../../.neutron/cache/bin") });
    const portFile = path.join(temp, "control.port");
    server = spawn(binary.path, ["--ttl", "120", "--port-file", portFile, "--log-levels", "error"], { stdio: ["ignore", "pipe", "pipe"] });
    let serverError = "";
    server.stdout?.resume();
    server.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-8192); });
    server.on("error", (error) => { serverError = error.message; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || !server.pid) throw new Error(`PocketIC startup failed: ${serverError}`);
      try {
        const port = Number((await fs.readFile(portFile, "utf8")).trim());
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          base = `http://127.0.0.1:${port}`;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(25);
    }
    if (!base) throw new Error(`PocketIC did not publish its control port: ${serverError}`);
    console.log(`owned PocketIC ${binary.version}, binary sha256=${binary.sha256}`);
  }
  instanceId = await createInstance(base);
  await verify(base, instanceId);
} finally {
  try {
    if (instanceId !== undefined && base) {
      await new PocketIcRestClient(`${base}/`).deleteInstance(instanceId);
      console.log(`deleted instance ${instanceId}`);
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (server.exitCode === null && Date.now() < deadline) await delay(25);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
}
