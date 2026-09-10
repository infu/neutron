// All rights reserved. See ../LICENSE.
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { inspectPackageFiles, inspectUpdatePackage, hostedSourceArtifactPath, SOURCE_COMPRESSED_MAX_BYTES } from "../../update-source/src/model.ts";
import { preparePackageInstall } from "neutron-compiler/src/install.ts";
import { normalizeManifestDependencies } from "neutron-tools/src/schema.ts";
import { download, reader, sha256 } from "./audit-download.ts";
import { Candidate, CandidatePage, PageRequest, AuditRequest, Audit, AccessRequest, AccessReply, call, encode, decode, result, unwrap, natural, json, principal, relay, RELAY_METHODS, type CandidateValue, type Target } from "./operator-wire.ts";

export async function inspectCandidate(candidate: CandidateValue, packageBytes: Uint8Array, sourceBytes?: Uint8Array) {
  const filename = `${candidate.appId}.neutron`;
  const metadata = inspectUpdatePackage(filename, packageBytes);
  if (metadata.record.sha256 !== Buffer.from(candidate.digest).toString("hex") || metadata.record.id !== candidate.appId || BigInt(metadata.record.version) !== candidate.version) throw new Error("The package manifest/version/digest does not match the reviewed candidate.");
  const manifest = preparePackageInstall(packageBytes).manifest;
  const dependencies = Object.values(normalizeManifestDependencies(manifest)).map(value => ({ appId: value.app, minVersion: String(value.min_version) })).sort((a, b) => a.appId.localeCompare(b.appId));
  const declared = candidate.dependencies.map(value => ({ appId: value.appId, minVersion: String(value.minVersion) })).sort((a, b) => a.appId.localeCompare(b.appId));
  if (JSON.stringify(dependencies) !== JSON.stringify(declared)) throw new Error("Candidate dependencies differ from the packaged manifest.");
  const sourceDigest = candidate.sourceDigest[0] ? Buffer.from(candidate.sourceDigest[0]).toString("hex") : null;
  if (sourceDigest !== (metadata.hostedSource?.sha256 ?? null)) throw new Error("Candidate offered-source digest differs from the package's declared source.");
  if (Boolean(candidate.sourceArtifactId.length) !== Boolean(sourceDigest)) throw new Error("Candidate offered-source reference is incomplete.");
  if (sourceDigest && (!sourceBytes || sha256(sourceBytes) !== sourceDigest)) throw new Error("The exact declared offered source is missing or altered.");
  const [checked] = await inspectPackageFiles([filename], { read: async () => packageBytes, readSource: async () => { if (!sourceBytes) throw new Error("Offered source missing."); return sourceBytes; } });
  return { checked: checked!, manifest, dependencies };
}

export function stampInput(input: { requestId: string; candidateId: string; digest: string; sourceDigest?: string; decision: string; analysis: string; reason?: string }) {
  if (!input.requestId.trim() || !input.analysis.trim()) throw new Error("An explicit request ID and nonempty inspection analysis are required.");
  if (!["approved", "rejected", "revoked"].includes(input.decision)) throw new Error("Decision must be approved, rejected or revoked.");
  if (input.decision !== "approved" && !input.reason?.trim()) throw new Error("Rejection and revocation require a nonempty reason.");
  if (!/^[0-9a-f]{64}$/.test(input.digest) || (input.sourceDigest !== undefined && !/^[0-9a-f]{64}$/.test(input.sourceDigest))) throw new Error("Supply the exact reviewed SHA-256 package/source digests in lowercase hexadecimal.");
  return { requestId: input.requestId, candidateId: natural(input.candidateId, "candidate"), expectedDigest: Buffer.from(input.digest, "hex"), expectedSourceDigest: input.sourceDigest ? [Buffer.from(input.sourceDigest, "hex")] : [], decision: { [input.decision]: null }, analysis: input.analysis, reason: input.reason ? [input.reason] : [] };
}

const HELP = `Marketplace operator tools (all writes default to a review only)

bun scripts/operator.ts queue --canister ID --identity NAME --network ic
bun scripts/operator.ts candidate --candidate ID --canister ID --identity NAME --network ic
bun scripts/operator.ts review --candidate ID --out DIR --canister ID --identity NAME --network ic --execute
bun scripts/operator.ts stamp --candidate ID --digest HEX [--source-digest HEX] --request ID --decision approved|rejected|revoked --analysis FILE [--reason FILE] --canister ID --identity NAME --network ic [--execute]
bun scripts/operator.ts relay --neutron ID --method NAME --args-bin FILE --cycles NAT --canister ID --identity NAME --network ic [--execute]
bun scripts/operator.ts admin-auditor --neutron ID --auditor ID --active true|false --fee-version NAT --cycles NAT --canister ID --identity NAME --network ic [--execute]
bun scripts/operator.ts reserve-app --neutron ID --app ID --publisher ID --title TEXT --fee-version NAT --cycles NAT --canister ID --identity NAME --network ic [--execute]
bun scripts/operator.ts reserve-route --neutron ID --method NAME --canister ID --identity NAME --network ic [--execute]
bun scripts/operator.ts burn-account --neutron ID --ledger ID --recipient ID [--subaccount HEX] --fee-version NAT --cycles NAT --canister ID --identity NAME --network ic [--execute]

Queries and assigned-auditor updates call the protocol directly. All other
updates call the installed marketplace app on the specified Neutron and attach
the reviewed cycles. Its backend reservation must already permit that exact
protocol/method; use normal Neutron permissions to establish it.
Private HTTP credentials are ephemeral and never written to review output.
Use --host URL --root-key FILE for a local trusted replica. No deployment occurs.
`;

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries([
    ...["canister", "identity", "network", "candidate", "out", "cursor", "limit", "request", "decision", "analysis", "reason", "neutron", "method", "args-bin", "cycles", "fee-version", "auditor", "active", "app", "publisher", "title", "host", "root-key", "ledger", "recipient", "subaccount", "digest", "source-digest"].map(key => [key, { type: "string" as const }]), ["execute", { type: "boolean" }], ["help", { type: "boolean" }],
  ]) });
  const command = parsed.positionals[0], values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help || !command) { process.stdout.write(HELP); return; }
  const get = (key: string) => { const value = values[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required.`); return value; };
  const optional = (key: string): string | undefined => typeof values[key] === "string" ? values[key] as string : undefined;
  const target: Target = { canister: principal(get("canister")), identity: get("identity"), network: get("network"), rootKeyFile: optional("root-key") };
  const execute = values.execute === true;
  if (command === "reserve-route") {
    const method = get("method"), neutron = principal(get("neutron"));
    if (!RELAY_METHODS.has(method)) throw new Error("Only an exact supported marketplace update can be reserved.");
    const scope = IDL.Variant({ exact: IDL.Record({ principal: IDL.Principal, method: IDL.Text }), principal: IDL.Principal, method: IDL.Text });
    const input = { app_id: "marketplace", actions: [{ reserve: { exact: { principal: Principal.fromText(target.canister), method } } }] };
    if (!execute) { process.stdout.write(json({ action: "reserve_exact_backend_route", neutron, input })); return; }
    const bytes = encode(IDL.Record({ app_id: IDL.Text, actions: IDL.Vec(IDL.Variant({ reserve: scope, release: scope })) }), input);
    const reply = await call({ ...target, canister: neutron }, "kernel_backend_reservations_apply", bytes, false);
    process.stdout.write(Buffer.from(reply).toString("hex") + "\n"); return;
  }
  if (command === "queue") {
    const cursor = optional("cursor");
    const input = { cursor: cursor ? [natural(cursor, "cursor")] : [], limit: natural(optional("limit") ?? "20", "limit") };
    process.stdout.write(json(unwrap(decode(CandidatePage, await call(target, "audit_queue", encode(PageRequest, input), true))))); return;
  }
  if (command === "candidate" || command === "review") {
    const candidate = unwrap(decode<{ ok: CandidateValue } | { err: { code: string; message: string } }>(result(Candidate), await call(target, "audit_candidate", encode(IDL.Nat64, natural(get("candidate"), "candidate")), true)));
    if (command === "candidate") { process.stdout.write(json(candidate)); return; }
    const packageDigest = Buffer.from(candidate.digest).toString("hex"), sourceDigest = candidate.sourceDigest[0] ? Buffer.from(candidate.sourceDigest[0]).toString("hex") : null;
    const paths = [`/repo/v1/packages/${packageDigest}.neutron`, ...(sourceDigest ? [`/repo/v1/sources/${sourceDigest}.source.v1.msgpack.gz`] : [])];
    if (!execute) { process.stdout.write(json({ action: "audit_access_and_certified_download", canister: target.canister, candidate, paths, output: path.resolve(get("out")), attachedCycles: "0", requiresAssignedAuditor: true })); return; }
    const token = randomBytes(32).toString("hex"), requestId = randomBytes(16).toString("hex");
    try {
      const granted = unwrap(decode<{ ok: { request_id: string; paths: string[]; accepted_cycles: bigint } } | { err: { code: string; message: string } }>(AccessReply, await call(target, "audit_access", encode(AccessRequest, { request_id: requestId, token, paths, fee_version: 0n }), false)));
      if (granted.request_id !== requestId || JSON.stringify(granted.paths) !== JSON.stringify(paths) || granted.accepted_cycles !== 0n) throw new Error("The audit grant does not match the exact requested artifacts.");
      const transport = await reader(target.canister, optional("host") ?? "https://icp-api.io", target.rootKeyFile);
      const packageBytes = await download({ ...transport, canister: target.canister, path: paths[0]!, token, expectedDigest: packageDigest });
      const sourceBytes = sourceDigest ? await download({ ...transport, canister: target.canister, path: paths[1]!, token, expectedDigest: sourceDigest, maximumBytes: SOURCE_COMPRESSED_MAX_BYTES }) : undefined;
      const inspected = await inspectCandidate(candidate, packageBytes, sourceBytes);
      const directory = path.resolve(get("out")); await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, `${candidate.appId}.neutron`);
      await writeFile(filename, packageBytes, { mode: 0o600, flag: "wx" });
      if (sourceBytes && sourceDigest) await writeFile(hostedSourceArtifactPath(filename, sourceDigest), sourceBytes, { mode: 0o600, flag: "wx" });
      const report = { format: 1, canister: target.canister, candidate, package: inspected.checked.record, source: inspected.checked.hostedSource ? { sha256: inspected.checked.hostedSource.sha256, size: inspected.checked.hostedSource.size } : null, dependencies: inspected.dependencies, transport: "request-bound-certified-http-v2", checks: ["Exact candidate digest", "Package manifest and dependencies", "Declared offered source and build inputs"], malwareAssessment: "Not performed by this command. Inspect the saved files and submit explicit analysis separately." };
      await writeFile(path.join(directory, "review.json"), json(report), { mode: 0o600, flag: "wx" }); process.stdout.write(json(report)); return;
    } catch (error) { const message = error instanceof Error ? error.message : String(error); throw new Error(message.split(token).join("[redacted review credential]")); }
  }
  if (command === "stamp") {
    const input = stampInput({ candidateId: get("candidate"), digest: get("digest"), ...(optional("source-digest") ? { sourceDigest: get("source-digest") } : {}), requestId: get("request"), decision: get("decision"), analysis: await readFile(get("analysis"), "utf8"), ...(optional("reason") ? { reason: await readFile(get("reason"), "utf8") } : {}) });
    if (!execute) { process.stdout.write(json({ action: "audit_stamp", canister: target.canister, input, attachedCycles: "0" })); return; }
    process.stdout.write(json(unwrap(decode(result(Audit), await call(target, "audit_stamp", encode(AuditRequest, input), false))))); return;
  }
  let method: string, args: Uint8Array, review: unknown = null;
  if (command === "relay") { method = get("method"); args = new Uint8Array(await readFile(get("args-bin"))); }
  else if (command === "admin-auditor") {
    const active = get("active"); if (active !== "true" && active !== "false") throw new Error("--active must be true or false.");
    method = "admin_auditor_set";
    review = { principal: Principal.fromText(principal(get("auditor"))), active: active === "true", feeVersion: natural(get("fee-version"), "fee-version") };
    args = encode(IDL.Record({ principal: IDL.Principal, active: IDL.Bool, feeVersion: IDL.Nat }), review);
  } else if (command === "reserve-app") {
    method = "admin_reserve_app";
    review = { appId: get("app"), publisher: Principal.fromText(principal(get("publisher"))), title: get("title"), feeVersion: natural(get("fee-version"), "fee-version") };
    args = encode(IDL.Record({ appId: IDL.Text, publisher: IDL.Principal, title: IDL.Text, feeVersion: IDL.Nat }), review);
  } else if (command === "burn-account") {
    const subaccount = optional("subaccount");
    if (subaccount && !/^[0-9a-f]{64}$/.test(subaccount)) throw new Error("--subaccount must contain exactly 32 bytes in lowercase hexadecimal.");
    method = "admin_set_burn_account";
    review = { ledger: Principal.fromText(principal(get("ledger"))), account: [{ owner: Principal.fromText(principal(get("recipient"))), subaccount: subaccount ? [Buffer.from(subaccount, "hex")] : [] }], feeVersion: natural(get("fee-version"), "fee-version") };
    args = encode(IDL.Record({ ledger: IDL.Principal, account: IDL.Opt(IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })), feeVersion: IDL.Nat }), review);
  } else throw new Error(`Unknown operator command: ${command}`);
  const neutron = principal(get("neutron")), cycles = natural(get("cycles"), "cycles");
  if (!execute) { process.stdout.write(json({ action: "neutron_relay", neutron, canister: target.canister, method, input: review, argumentBytes: args.length, argumentSha256: sha256(args), attachedCycles: cycles, requiresExistingBackendReservation: true })); return; }
  const reply = await relay(target, neutron, method, args, cycles);
  process.stdout.write(Buffer.from(reply).toString("hex") + "\n");
}
if (import.meta.main) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
