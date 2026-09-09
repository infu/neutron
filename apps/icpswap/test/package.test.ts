import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { unpackNeutronPackage } from "neutron-compiler/src/install.ts";
import { generateAppMethodSchemaArtifact } from "neutron-scripts/src/method_schema.js";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.ts";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const clientUrl = new URL("../backend/icpswap/Client.mo", import.meta.url);
const liquidityClientUrl = new URL("../backend/icpswap/LiquidityClient.mo", import.meta.url);
/**
 * The packer names the archive after the manifest version, so derive it rather
 * than pinning it — a version bump should not have to touch this file.
 */
const packageUrl = new URL(
  `../icpswap.v${packedVersionToSemver(
    JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")).version,
  )}.neutron`,
  import.meta.url,
);

/** `major * 10000 + minor * 100 + patch` back to `major.minor.patch`. */
function packedVersionToSemver(packed: number): string {
  return `${Math.floor(packed / 10000)}.${Math.floor((packed % 10000) / 100)}.${packed % 100}`;
}
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const decoder = new TextDecoder();

/** The two fixed canisters this app is allowed to read. */
const SWAP_FACTORY = "4mmnk-kiaaa-aaaag-qbllq-cai";
const TOKEN_LIST = "k37c6-riaaa-aaaag-qcyza-cai";

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

function assertAllowedPackagePath(path: string): void {
  const allowed =
    path === "neutron.json" ||
    path === "neutron.lock.json" ||
    path === "schema.json" ||
    path === "web/index.html" ||
    path === "web/main.css" ||
    path === "web/main.js" ||
    path === "web/service.html" ||
    path === "web/service.js" ||
    path === "web/static/icon.svg" ||
    path === "legal/APPLICATION-NOTICE.txt" ||
    path === "legal/package-record.v1.json" ||
    path === "legal/LICENSE.APP.USE.txt" ||
    path === "legal/THIRD_PARTY_NOTICES.md" ||
    path === "legal/third-party/EXACT-MATERIALS.v1.txt" ||
    path === "third-party-build.json" ||
    /^legal\/third-party\/[a-f0-9]{64}\.txt$/u.test(path) ||
    /^\.neutron\/browser-surface-origins\.v1\.json$/.test(path) ||
    /^mo\/[a-f0-9]{64}\.mo$/.test(path);

  expect(allowed, `unexpected package path ${path}`).toBe(true);
  expect(path).not.toMatch(/(?:^|\/)(?:node_modules|\.sass-cache)(?:\/|$)/);
  expect(path).not.toMatch(/\.(?:scss|map|neutron)$/);
}

test("the manifest validates against the shared schema", async () => {
  const manifest = await readManifest();
  const result = validate_neutron_conf(manifest);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
  expect(manifest.format).toBe(3);
  expect(manifest.id).toBe("icpswap");
  expect(manifest.version).toBe(207);
  expect(manifest.update_source).toBe("233tv-xiaaa-aaaay-aacta-cai");
});

test("the app declares exactly one tile and one resident background", async () => {
  const manifest = await readManifest();
  expect(manifest.tiles).toHaveLength(1);
  expect(manifest.tiles?.[0]?.id).toBe("main");
  expect(manifest.tiles?.[0]?.path).toBe("index.html");
  expect(manifest.background?.path).toBe("service.html");
  expect(manifest.tray).toBeUndefined();
});

test("Wallet integration declares only the exact metadata, reviewed funding and account-history tools", async () => {
  const manifest = await readManifest();
  const declarations = manifest.capabilities?.frontend_tools;
  expect(declarations).toEqual({ api: 1, targets: [{ app: "wallet", tools: [
    "wallet_token_info_v1", "wallet_add_ledger_v1", "wallet_fund_v1", "wallet_account_transactions_v1", "wallet_transaction_v1",
  ] }] });
  // Root-only funding remains an instruction for the depth-zero Agent;
  // declaring routing access must not turn ICPSwap into that caller.
  expect(declarations?.targets.flatMap((target) => target.tools)).not.toContain("wallet_fund_root_v1");
  const plan = buildCapabilityPlan(manifest);
  expect(plan.entries.find((entry) => entry.id === "frontend_tools")).toBeDefined();
});

test("backend call authority is exactly the declared reservation set", async () => {
  const manifest = await readManifest();
  const calls = manifest.capabilities?.backend_calls;
  expect(calls).toBeDefined();
  // `method` scope is required because pools and token ledgers are discovered
  // at runtime and cannot be named by an exact reservation. No reservation ever
  // grants a whole principal.
  expect(calls?.reservation_scopes).toEqual(["exact", "method"]);
  // No cycles may ever be attached.
  expect(calls?.max_cycles_per_call).toBe(0);
  expect(calls?.max_cycles_per_day).toBe(0);

  const reservations = calls?.install_reservations ?? [];
  expect(reservations).toEqual([
    { kind: "exact", principal: SWAP_FACTORY, method: "getPools" },
    { kind: "exact", principal: TOKEN_LIST, method: "getList" },
    { kind: "method", method: "metadata" },
    { kind: "method", method: "quote" },
    { kind: "method", method: "getPool" },
    { kind: "method", method: "getCachedTokenFee" },
    { kind: "method", method: "getAvailabilityState" },
    { kind: "method", method: "depositFromAndSwap" },
    { kind: "method", method: "getUserUnusedBalance" },
    { kind: "method", method: "getUserPositionsByPrincipal" },
    { kind: "method", method: "getUserPosition" },
    { kind: "method", method: "getUserWithdrawQueue" },
    { kind: "method", method: "getTransactionsByOwner" },
    { kind: "method", method: "mint" },
    { kind: "method", method: "increaseLiquidity" },
    { kind: "method", method: "decreaseLiquidity" },
    { kind: "method", method: "claim" },
    { kind: "method", method: "deposit" },
    { kind: "method", method: "depositFrom" },
    { kind: "method", method: "withdraw" },
  ]);

  // The load-bearing assertion in this whole file. Token ledgers belong to the
  // Wallet, entirely. This app may instruct an ICPSwap pool, but it cannot
  // move a token, read a balance, read a fee, inspect an allowance, or even
  // ask a ledger its decimals — all of that arrives from the Wallet. Any
  // ledger method appearing here means custody has started leaking out.
  const granted = new Set(reservations.map((entry) => entry.method));
  const ledgerMethods = [...granted].filter(
    (method) => method !== undefined && /^(icrc\d+_|transfer)/.test(method),
  );
  expect(ledgerMethods, "this app may reserve no ledger method at all").toEqual(
    [],
  );
  // Protocol calls operate as this Neutron; Wallet remains the sole funding
  // provider. No admin recovery method or caller-chosen recipient is granted.
  for (const method of ["depositAllAndMint", "deleteFailedTransaction", "restartWithdrawQueueProcessing", "transferPosition"]) {
    expect(granted.has(method)).toBe(false);
  }
  for (const reservation of reservations) {
    expect(["exact", "method"]).toContain(reservation.kind);
    expect(typeof reservation.method).toBe("string");
    expect(reservation.kind, "a whole principal is never granted").not.toBe(
      "principal",
    );
  }
});

test("the backend only ever targets its declared canisters and methods", async () => {
  const manifest = await readManifest();
  const client = (await Promise.all([readFile(clientUrl, "utf8"), readFile(liquidityClientUrl, "utf8")])).join("\n");
  const reservations = manifest.capabilities?.backend_calls?.install_reservations ?? [];
  const declared = new Set(
    reservations.flatMap((entry) => (entry.principal ? [entry.principal] : [])),
  );
  const principals = client.match(/[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-cai/g) ?? [];
  expect(principals.length).toBeGreaterThan(0);
  for (const principal of principals) {
    expect(declared.has(principal), `undeclared canister ${principal}`).toBe(true);
  }

  const methods = new Set(reservations.map((entry) => {
    if (entry.method === undefined) throw new Error("A protocol reservation must name its method");
    return entry.method;
  }));
  const constants = new Map(
    [...client.matchAll(/public let ([A-Z_]+) : Text = "([^"]+)"/g)].map(
      (match) => [match[1]!, match[2]!],
    ),
  );
  const requested = [
    ...[...client.matchAll(/method = (?:"([A-Za-z0-9_]+)"|([A-Z_]+))/g)].map((match) =>
      match[1] !== undefined ? match[1] : (constants.get(match[2]!) ?? match[2]!),
    ),
    ...[...client.matchAll(/request\(pool, "([A-Za-z0-9_]+)"/g)].map((match) => match[1]!),
  ];
  expect(requested.length).toBeGreaterThan(0);
  for (const name of requested) {
    expect(methods.has(name), `undeclared method ${name}`).toBe(true);
  }
  expect(new Set(requested)).toEqual(methods);
});

test("the scheduled task points at an internal async* callback", async () => {
  const manifest = await readManifest();
  const tasks = manifest.capabilities?.scheduled_tasks?.tasks ?? [];
  expect(tasks).toHaveLength(1);
  const task = tasks[0]!;
  expect(task.id).toBe("market_snapshot");
  expect(task.method).toBe("icpswap_snapshot_tick");
  expect(task.run_on_start).toBe(true);
  // Six hours: frequent enough to build history, slow enough to stay cheap.
  expect(task.interval_seconds).toBe(21_600);
  // Preserve the installed scheduled refresh contract. Token metadata comes
  // from Wallet or the curated token list; this task does not call ledgers.
  expect(task.max_backend_calls).toBe(100);

  const entry = manifest.func?.[task.method];
  expect(entry?.type).toBe("internal");
  expect(entry?.async).toBe("async*");
  expect(entry?.arg).toEqual(["task_capabilities"]);
});

test("every preapproved self call is an owner-authorized app method", async () => {
  const manifest = await readManifest();
  const methods = manifest.capabilities?.preapproved_self_calls?.methods ?? [];
  expect(methods.length).toBeGreaterThan(0);
  expect(new Set(methods).size).toBe(methods.length);
  for (const method of methods) {
    const entry = manifest.func?.[method];
    expect(entry, `missing func entry for ${method}`).toBeDefined();
    expect(["query", "update"]).toContain(entry?.type ?? "");
  }
  // Internal methods must never be preapproved.
  expect(methods).not.toContain("icpswap_snapshot_tick");
});

test("no app method is publicly callable", async () => {
  const manifest = await readManifest();
  for (const [name, entry] of Object.entries(manifest.func ?? {})) {
    expect(
      (entry as { allow?: string }).allow,
      `${name} must not declare public access`,
    ).toBeUndefined();
  }
  expect(manifest.capabilities?.public_ingress).toBeUndefined();
  expect(manifest.capabilities?.http_routes).toBeUndefined();
});

test("the capability plan normalizes without error", async () => {
  const manifest = await readManifest();
  const plan = buildCapabilityPlan(manifest);
  expect(plan).toBeDefined();
  const ids = new Set(plan.entries.map((entry) => entry.id));
  expect(ids.has("backend_calls")).toBe(true);
  expect(ids.has("scheduled_tasks")).toBe(true);
  expect(ids.has("preapproved_self_calls")).toBe(true);
  expect(ids.has("stable_memory")).toBe(true);
  // Nothing that can move value or reach the network beyond the declaration.
  expect(ids.has("https_outcalls")).toBe(false);
  expect(ids.has("chain_key_signing")).toBe(false);
  expect(ids.has("vetkeys")).toBe(false);
});

test("both deployed roots are retained and the new actions root initializes at v1", async () => {
  const manifest = await readManifest();
  expect(Object.keys(manifest.memory ?? {}).sort()).toEqual(["icpswap", "icpswap_actions", "icpswap_swap"]);
  for (const [id, memory] of Object.entries(manifest.memory ?? {})) {
    expect(memory.version).toBe(1);
    expect(memory.schemas).toEqual({ "1": { src: `memory/${id}/v1.mo` } });
    expect(memory.migrations).toEqual([]);
    expect(memory.retired).toBeUndefined();
  }
});

test("private app methods produce usable JSON schemas", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = await generateAppMethodSchemaArtifact(manifest, backend);
  const names = Object.keys(artifact.methods);
  expect(names).toContain("icpswap_market");
  expect(names).toContain("icpswap_search");
  expect(names).toContain("icpswap_add");
  const actionMethods = [
    "icpswap_account", "icpswap_action_get", "icpswap_action_page", "icpswap_action_status", "icpswap_action_update",
    "icpswap_liquidity_pool", "icpswap_liquidity_preview",
    "icpswap_liquidity_prepare", "icpswap_liquidity_execute", "icpswap_liquidity_reconcile",
    "icpswap_liquidity_recover_prepare", "icpswap_liquidity_recover_execute",
    "icpswap_swap_prepare_v1", "icpswap_swap_execute_v1",
  ];
  for (const name of actionMethods) {
    expect(names).toContain(name);
    expect(artifact.methods[name]?.input).toBeDefined();
    expect(artifact.methods[name]?.output).toBeDefined();
    expect(manifest.capabilities?.preapproved_self_calls?.methods).toContain(name);
  }
  // Internal methods stay out of the public surface.
  expect(names).not.toContain("icpswap_snapshot_tick");

  const market = artifact.methods.icpswap_market;
  expect(market?.input).toBeDefined();
  expect(market?.output).toBeDefined();
});

test("the built page carries no remote or unsafe resource reference", async () => {
  for (const url of [htmlUrl, cssUrl]) {
    const text = await readFile(url, "utf8");
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/javascript:/i);
    expect(text).not.toMatch(/\bdata:/i);
    expect(text).not.toContain("sourceMappingURL");
  }
});

test("the packaged archive contains exactly the expected files", async () => {
  const bytes = new Uint8Array(await readFile(packageUrl));
  const unpacked = unpackNeutronPackage(bytes);
  const paths = Object.keys(unpacked).sort();

  expect(paths).toContain("neutron.json");
  expect(paths).toContain("neutron.lock.json");
  expect(paths).toContain("schema.json");
  expect(paths).toContain("web/index.html");
  expect(paths).toContain("web/main.css");
  expect(paths).toContain("web/main.js");
  expect(paths).toContain("web/service.html");
  expect(paths).toContain("web/service.js");
  expect(paths).toContain("web/static/icon.svg");

  for (const path of paths) {
    assertAllowedPackagePath(path);
    if (path.endsWith(".html") || path.endsWith(".css")) {
      const text = decoder.decode(unpacked[path]);
      expect(text, `${path} has a remote reference`).not.toMatch(/https?:\/\//i);
      expect(text, `${path} has a script URL`).not.toMatch(/javascript:/i);
    }
    if (path.endsWith(".svg")) {
      const text = decoder.decode(unpacked[path]);
      // A standalone SVG must declare the XML namespace; nothing else remote
      // is allowed, and no script may run inside an icon.
      const remote = (text.match(/https?:\/\/[^"'\s]*/gi) ?? []).filter(
        (value) => value !== "http://www.w3.org/2000/svg",
      );
      expect(remote, `${path} has a remote reference`).toEqual([]);
      expect(text, `${path} has a script URL`).not.toMatch(/javascript:/i);
      expect(text, `${path} embeds script`).not.toMatch(/<script/i);
    }
    if (path.endsWith(".js")) {
      const text = decoder.decode(unpacked[path]);
      expect(text, `${path} leaks a source map`).not.toContain("sourceMappingURL");
      // Three remote origins this app may contact, all read-only: the ICPSwap
      // analytics API, the IC boundary node (anonymous `icrc1_metadata` and
      // `list_deployed_snses` queries behind token icons), and the SNS
      // aggregator that serves an SNS logo when its ledger declares none.
      // Anything else would be an undeclared third-party dependency.
      // The remaining entries are identifiers, not endpoints: the W3C URIs are
      // the XML namespaces React uses for SVG and MathML, json-schema.org is a
      // draft-07 `$schema` identifier inside the bundled validator, and the
      // github.com string is an attribution comment in the bundled SHA-256
      // implementation. None of them is ever fetched.
      const allowedOrigins = new Set([
        "https://api.icpswap.com",
        "https://icp-api.io",
        "https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io",
        "http://www.w3.org",
        "http://json-schema.org",
        "https://json-schema.org",
        "https://github.com",
      ]);
      const origins = new Set(
        (text.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).map((value) =>
          value.toLowerCase(),
        ),
      );
      for (const origin of origins) {
        expect(
          allowedOrigins.has(origin),
          `${path} references ${origin}`,
        ).toBe(true);
      }
      // The analytics API must be reached through the shared client only.
      if (path === "web/main.js" || path === "web/service.js") {
        expect(text).toContain("https://api.icpswap.com/info");
      }
    }
  }
});

test("the packaged manifest keeps its content-addressed backend entry", async () => {
  const bytes = new Uint8Array(await readFile(packageUrl));
  const unpacked = unpackNeutronPackage(bytes);
  const packaged = JSON.parse(
    decoder.decode(unpacked["neutron.json"]),
  ) as NeutronManifest & { entry?: string };
  expect(packaged.entry).toMatch(/^[a-f0-9]{64}$/);
  expect(packaged.id).toBe("icpswap");
  expect(packaged.memory?.icpswap?.schemas?.["1"]?.hash).toMatch(/^[a-f0-9]{64}$/);
});

test("the packed version matches the archive this test reads", () => {
  expect(packedVersionToSemver(101)).toBe("0.1.1");
  expect(packedVersionToSemver(100)).toBe("0.1.0");
  expect(packedVersionToSemver(10203)).toBe("1.2.3");
  expect(packageUrl.pathname).toMatch(/icpswap\.v\d+\.\d+\.\d+\.neutron$/);
});

test("ordinary resident tools use the existing invocation and Wallet review contracts", async () => {
  const manifest = await readManifest();
  // General root agents call Wallet themselves when saved fundingInstructions
  // require a depth-zero caller. ICPSwap need not become a separate agent root.
  expect(manifest.capabilities?.agent_entrypoints).toBeUndefined();
});

test("the release offers complete source and the shared application license", async () => {
  const unpacked = unpackNeutronPackage(new Uint8Array(await readFile(packageUrl)));
  const record = JSON.parse(decoder.decode(unpacked["legal/package-record.v1.json"]!));
  expect(record.package).toMatchObject({ id: "icpswap", version: 207 });
  expect(record.license.id).toBe("LicenseRef-Neutron-Sovereign-Application-Use-License-1.0");
  expect(unpacked["legal/LICENSE.APP.USE.txt"]).toEqual(new Uint8Array(await readFile(new URL("../../../LICENSE.APP.USE", import.meta.url))));
  expect(record.source.kind).toBe("https");
  expect(record.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(record.source.url).toBe(`https://233tv-xiaaa-aaaay-aacta-cai.icp0.io/repo/v1/sources/${record.source.sha256}.source.v1.msgpack.gz`);
  expect(record.source.bytes).toBeGreaterThan(0);
  expect(Object.keys(unpacked).some((path) => path.startsWith("legal/archive-only/") || path.startsWith("legal/source/"))).toBe(false);
});
