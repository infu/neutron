/**
 * Contract verification against a real Taggr canister.
 *
 * Opt-in, not part of `npm test`: it needs a Taggr wasm and the PocketIC binary.
 *
 *   TAGGR_WASM=/path/to/taggr.wasm.gz bun scripts/verify_contract.ts
 *
 * It starts its own PocketIC instance on free ports, so it neither needs nor
 * disturbs the Neutron provisioner's fixed gateway on 8000.
 *
 * It drives the **shipped client** — `src/taggr_client.ts` behind
 * `src/taggr_api.ts` — with a real Ed25519 identity, which is exactly what the
 * resident background does in a browser. So it checks the code that ships
 * rather than a re-implementation of it: the argument encoding, the Candid
 * `add_post` boundary, the reply parsers, and the conversation view.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnonymousIdentity, HttpAgent, polling } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
import { resolvePocketIcBinary } from "neutron-provision/src/pocketic_binary.ts";
import { PocketIcRestClient } from "neutron-provision/src/pocketic_rest.ts";
import { createTaggrClient, type TaggrClient } from "../src/taggr_client.ts";
import {
  addPost,
  browseRealms,
  conversation,
  createUser,
  domains as loadDomains,
  feed as loadFeed,
  FEED_PAGE_SIZE,
  react as sendReaction,
  recentTags,
  search as runSearch,
  setTaggrTransport,
  stats as loadStats,
  mintCreditsWithIcp,
  user as loadUser,
  userPosts as loadUserPosts,
} from "../src/taggr_api.ts";
import { resolveDomain } from "../src/domain.ts";
import { invoiceAccountText, principalToSubaccount } from "../src/wallet.ts";

const POCKET_IC = process.env.POCKET_IC;
const TAGGR_WASM = process.env.TAGGR_WASM ?? "";
const ICP_LEDGER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const MANAGEMENT = Principal.fromText("aaaaa-aa");
const DOMAIN = "localhost";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (name: string) => console.log(`\n${name}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

/** Runs an action and returns either "ok" or the message the UI would show. */
const outcome = async (action: () => Promise<unknown>): Promise<string> => {
  try {
    await action();
    return "ok";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port === 0) throw new Error("Could not reserve a free port for the gateway");
  return port;
}

const subnet = () => ({
  state_config: "New",
  instruction_config: "Production",
  subnet_admins: null,
  cost_schedule: "Normal",
});

const instanceConfig = (stateDir: string, gatewayPort: number) => ({
  subnet_config_set: {
    nns: subnet(),
    sns: subnet(),
    ii: subnet(),
    fiduciary: subnet(),
    bitcoin: null,
    test_threshold_keys: subnet(),
    system: [],
    application: [subnet()],
    cloud_engine: [],
    verified_application: [],
  },
  http_gateway_config: {
    ip_addr: "127.0.0.1",
    port: gatewayPort,
    domains: null,
    https_config: null,
    domain_custom_provider_local_file: null,
  },
  state_dir: stateDir,
  icp_config: null,
  log_level: null,
  bitcoind_addr: null,
  dogecoind_addr: null,
  // Taggr needs the ICP ledger for its invoices and the CMC for the XDR rate.
  icp_features: {
    registry: "DefaultConfig",
    cycles_minting: "DefaultConfig",
    icp_token: "DefaultConfig",
    cycles_token: "DefaultConfig",
    nns_governance: "DefaultConfig",
    sns: null,
    ii: "DefaultConfig",
    nns_ui: null,
    bitcoin: null,
    dogecoin: null,
    canister_migration: null,
  },
  incomplete_state: "Disabled",
  initial_time: { AutoProgress: { artificial_delay_ms: null } },
  mainnet_nns_subnet_id: true,
  disable_ingress_validation: false,
});

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (!TAGGR_WASM || !existsSync(TAGGR_WASM)) {
    throw new Error(
      "Set TAGGR_WASM to a taggr.wasm.gz built from a Taggr checkout (FEATURES=dev bash build.sh taggr).",
    );
  }
  const binary = POCKET_IC ?? (await resolvePocketIcBinary({
    cacheDirectory: path.resolve(import.meta.dir, "../../../.neutron/cache/bin"),
  })).path;
  if (!existsSync(binary)) {
    throw new Error(`PocketIC binary not found at ${binary}; set POCKET_IC.`);
  }

  const workdir = await mkdtemp(path.join(os.tmpdir(), "taggr-verify-"));
  const stateDir = path.join(workdir, "state");
  await mkdir(stateDir, { recursive: true });
  const portFile = path.join(workdir, "pocketic.port");
  const gatewayPort = await freePort();

  const server = spawn(
    binary,
    ["--ttl", "900", "--port-file", portFile, "--log-levels", "error"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let serverError = "";
  server.stderr?.on("data", (chunk) => { serverError = (serverError + String(chunk)).slice(-8192); });
  server.on("error", (error) => { serverError = error.message; });
  let control: string | undefined;
  let instanceId: number | undefined;

  try {
    let controlPort = "";
    for (let attempt = 0; attempt < 200 && !controlPort; attempt += 1) {
      if (server.exitCode !== null || !server.pid) throw new Error(`PocketIC startup failed: ${serverError}`);
      controlPort = await readFile(portFile, "utf8")
        .then((raw) => raw.trim())
        .catch(() => "");
      if (!controlPort) await sleep(250);
    }
    if (!controlPort) throw new Error("PocketIC never reported its control port");
    control = `http://127.0.0.1:${controlPort}`;

    const created = await fetch(`${control}/instances`, {
      method: "POST",
      signal: AbortSignal.timeout(15 * 60_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(instanceConfig(stateDir, gatewayPort)),
    });
    const body = (await created.json()) as { Created?: { instance_id: number } };
    if (!created.ok || !body.Created) throw new Error(`PocketIC refused the instance: ${json(body)}`);
    instanceId = body.Created.instance_id;

    const topology = (await (
      await fetch(`${control}/instances/${instanceId}/read/topology`)
    ).json()) as { default_effective_canister_id: { canister_id: string } };
    const effective = Principal.fromUint8Array(
      Uint8Array.from(atob(topology.default_effective_canister_id.canister_id), (character) =>
        character.charCodeAt(0),
      ),
    );

    const host = `http://127.0.0.1:${gatewayPort}`;
    let gatewayReady = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ok = await fetch(`${host}/api/v2/status`, { signal: AbortSignal.timeout(2_000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (ok) { gatewayReady = true; break; }
      await sleep(250);
    }
    if (!gatewayReady) throw new Error(`PocketIC gateway never became ready at ${host}`);
    console.log(`PocketIC ready: instance ${instanceId}, gateway ${host}`);

    await verify(host, effective);
  } finally {
    try {
      if (control && instanceId !== undefined) {
        await new PocketIcRestClient(`${control}/`).deleteInstance(instanceId);
        console.log(`Deleted owned PocketIC instance ${instanceId}`);
      }
    } finally {
      if (server.exitCode === null) {
        server.kill("SIGTERM");
        const deadline = Date.now() + 5_000;
        while (server.exitCode === null && Date.now() < deadline) await sleep(25);
        if (server.exitCode === null) server.kill("SIGKILL");
      }
      await rm(workdir, { recursive: true, force: true });
    }
  }

  console.log(
    failures === 0 ? "\nAll contract checks passed." : `\n${failures} contract check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */

async function verify(host: string, effective: Principal): Promise<void> {
  const wasm = new Uint8Array(await readFile(TAGGR_WASM));
  console.log(`Taggr Wasm: ${wasm.length} bytes, sha256=${createHash("sha256").update(wasm).digest("hex")}`);
  const operator = Ed25519KeyIdentity.generate();
  const agent = await HttpAgent.create({ host, identity: operator, shouldFetchRootKey: true });
  const anonymous = await HttpAgent.create({
    host,
    identity: new AnonymousIdentity(),
    shouldFetchRootKey: true,
  });

  const managementCall = async (
    method: string,
    argTypes: IDL.Type[],
    argValues: unknown[],
    retTypes: IDL.Type[],
    effectiveCanisterId: Principal,
  ): Promise<unknown> => {
    const { requestId } = await agent.call(MANAGEMENT, {
      methodName: method,
      arg: IDL.encode(argTypes, argValues),
      effectiveCanisterId,
    });
    const { reply } = await polling.pollForResponse(agent, effectiveCanisterId, requestId);
    return retTypes.length === 0 ? null : IDL.decode(retTypes, reply)[0];
  };

  const settingsType = IDL.Record({
    controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
    compute_allocation: IDL.Opt(IDL.Nat),
    memory_allocation: IDL.Opt(IDL.Nat),
    freezing_threshold: IDL.Opt(IDL.Nat),
    reserved_cycles_limit: IDL.Opt(IDL.Nat),
    log_visibility: IDL.Opt(IDL.Variant({ controllers: IDL.Null, public: IDL.Null })),
    wasm_memory_limit: IDL.Opt(IDL.Nat),
    wasm_memory_threshold: IDL.Opt(IDL.Nat),
  });

  const created = (await managementCall(
    "provisional_create_canister_with_cycles",
    [
      IDL.Record({
        amount: IDL.Opt(IDL.Nat),
        settings: IDL.Opt(settingsType),
        specified_id: IDL.Opt(IDL.Principal),
        sender_canister_version: IDL.Opt(IDL.Nat64),
      }),
    ],
    [
      {
        amount: [1_000_000_000_000_000n],
        settings: [
          {
            controllers: [[operator.getPrincipal()]],
            compute_allocation: [],
            memory_allocation: [],
            freezing_threshold: [],
            reserved_cycles_limit: [],
            log_visibility: [],
            wasm_memory_limit: [],
            wasm_memory_threshold: [],
          },
        ],
        specified_id: [],
        sender_canister_version: [],
      },
    ],
    [IDL.Record({ canister_id: IDL.Principal })],
    effective,
  )) as { canister_id: Principal };
  const taggr = created.canister_id;

  await managementCall(
    "install_code",
    [
      IDL.Record({
        mode: IDL.Variant({
          install: IDL.Null,
          reinstall: IDL.Null,
          upgrade: IDL.Opt(IDL.Null),
        }),
        canister_id: IDL.Principal,
        wasm_module: IDL.Vec(IDL.Nat8),
        arg: IDL.Vec(IDL.Nat8),
        sender_canister_version: IDL.Opt(IDL.Nat64),
      }),
    ],
    [
      {
        mode: { install: null },
        canister_id: taggr,
        wasm_module: wasm,
        arg: new Uint8Array(),
        sender_canister_version: [],
      },
    ],
    [],
    taggr,
  );
  console.log(`Taggr installed at ${taggr.toText()}`);

  /** Builds the shipped client for one identity, the way the background does. */
  const clientFor = (identity: Ed25519KeyIdentity): Promise<TaggrClient> =>
    createTaggrClient({ canisterId: taggr.toText(), identity, host, local: true });

  const alice = Ed25519KeyIdentity.generate();
  const aliceClient = await clientFor(alice);
  const useAlice = () => setTaggrTransport(aliceClient);
  useAlice();

  /* ---- 1. reads through the shipped client ---- */

  section("Reads — src/taggr_client.ts querying the real canister");

  check(
    "the client signs with its own generated Ed25519 identity",
    aliceClient.principal === alice.getPrincipal().toText(),
    aliceClient.principal,
  );

  const config = JSON.parse(await aliceClient.query("config")) as {
    feed_page_size: number;
    reactions: Array<[number, number]>;
    post_cost: number;
  };
  check(
    "feed_page_size still matches the client's FEED_PAGE_SIZE",
    config.feed_page_size === FEED_PAGE_SIZE,
    `canister says ${config.feed_page_size}`,
  );
  check(
    "the reaction ids still match the client's palette",
    json(config.reactions.map(([id]) => id).sort((left, right) => left - right)) ===
      json([1, 10, 11, 12, 50, 51, 52, 53, 100, 101]),
    json(config.reactions),
  );
  check(
    "a post still costs the 2 credits the composer advertises",
    config.post_cost === 2,
    `canister says ${config.post_cost}`,
  );

  const stats = await loadStats();
  check("stats parses", Number.isFinite(stats.users) && Number.isFinite(stats.posts));
  const configuredDomains = await loadDomains();
  check(
    "every configured domain parses into a scope the client can filter with",
    configuredDomains.length > 0 &&
      configuredDomains.every(
        (domain) =>
          Number.isFinite(domain.maxDownvotes) &&
          ["blacklist", "whitelist", "journal"].includes(domain.scope.kind),
      ),
    json(configuredDomains),
  );
  check(
    "a fresh deployment resolves to a domain it actually registered",
    configuredDomains.some(
      (domain) =>
        domain.name ===
        resolveDomain({ canister: taggr.toText(), domains: configuredDomains }),
    ),
    json(configuredDomains.map((domain) => domain.name)),
  );
  check("the hot feed reads", Array.isArray(await loadFeed({ domain: DOMAIN, mode: "hot" })));
  check("the new feed reads", Array.isArray(await loadFeed({ domain: DOMAIN, mode: "new" })));
  check(
    "an unknown domain yields an empty feed rather than an error",
    (await loadFeed({ domain: "nope.invalid", mode: "new" })).length === 0,
  );
  check("recent tags read", Array.isArray(await recentTags({ domain: DOMAIN })));
  check("search reads", Array.isArray(await runSearch(DOMAIN, "taggr")));
  check("realm discovery reads", Array.isArray(await browseRealms({ domain: DOMAIN })));
  check("an unknown handle has no profile", (await loadUser(DOMAIN, "nobody")) === null);

  /* ---- 2. onboarding ---- */

  section("Onboarding — ICP invoice, credits, account");

  const fundInvoice = async (owner: Principal, amount = 20_000_000_000n): Promise<boolean> => {
    const account = IDL.Record({
      owner: IDL.Principal,
      subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    });
    // The shipped derivation, not a copy of it: this is the destination the
    // Wallet route would hand to Wallet, so paying it here proves Taggr credits
    // that exact account.
    const subaccount = principalToSubaccount(owner.toText());
    const arg = IDL.encode(
      [
        IDL.Record({
          to: account,
          fee: IDL.Opt(IDL.Nat),
          memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          created_at_time: IDL.Opt(IDL.Nat64),
          amount: IDL.Nat,
        }),
      ],
      [
        {
          to: { owner: taggr, subaccount: [subaccount] },
          fee: [],
          memo: [],
          from_subaccount: [],
          created_at_time: [],
          amount,
        },
      ],
    );
    // PocketIC's ICP feature mints from the anonymous principal, which is how
    // the Neutron provisioner funds local balances too.
    const { requestId } = await anonymous.call(ICP_LEDGER, {
      methodName: "icrc1_transfer",
      arg,
    });
    const { reply } = await polling.pollForResponse(anonymous, ICP_LEDGER, requestId);
    const result = IDL.decode([IDL.Variant({ Ok: IDL.Nat, Err: IDL.Unknown })], reply)[0] as
      | { Ok: bigint }
      | { Err: unknown };
    return "Ok" in result;
  };

  const onboard = async (
    identity: Ed25519KeyIdentity,
    client: TaggrClient,
    handle: string,
  ): Promise<boolean> => {
    setTaggrTransport(client);
    if (!(await fundInvoice(identity.getPrincipal()))) return false;
    // The XDR rate arrives from the CMC on Taggr's init timer.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const minted = await client.update("mint_credits_with_icp", "1");
      if (!minted.includes("Err")) break;
      await sleep(1000);
    }
    await createUser(handle, "");
    return (await loadUser(DOMAIN, handle)) !== null;
  };

  check("a generated key registers as @alice", await onboard(alice, aliceClient, "alice"));
  useAlice();
  const me = await loadUser(DOMAIN, null);
  check("the account reads back with no handle argument", me?.name === "alice", json(me?.name));
  check(
    "the Taggr account is the client's own key, not a Neutron principal",
    me?.principal === aliceClient.principal,
    `${me?.principal} vs ${aliceClient.principal}`,
  );

  const bob = Ed25519KeyIdentity.generate();
  const bobClient = await clientFor(bob);
  check("a second key registers as @bob", await onboard(bob, bobClient, "bob"));

  /* ---- 2b. the registration price the Wallet route reads ---- */

  section("Registration price — the invoice the Wallet route pays");

  // A fresh key, so the invoice has never been touched.
  const carol = Ed25519KeyIdentity.generate();
  const carolClient = await clientFor(carol);
  setTaggrTransport(carolClient);

  // `mint_credits_with_icp(0)` is the quote: Taggr gates its `Err` arm behind
  // `kilo_credits > 0`, so it prices an untouched invoice instead of failing.
  // If that ever changes, "Check the price" has no way to work.
  const quote = await mintCreditsWithIcp(0);
  check(
    "an unpaid invoice can be priced without paying anything",
    quote.paid === false && /^[1-9][0-9]*$/.test(quote.amountAtoms),
    json(quote),
  );

  const carolAccount = invoiceAccountText({
    taggrCanister: taggr.toText(),
    principal: carolClient.principal,
  });
  check(
    "the destination handed to Wallet is a well-formed ICRC account",
    // Wallet's own `directRouteSchema` pattern.
    /^[a-z0-9.-]{5,160}$/.test(carolAccount),
    carolAccount,
  );

  // The whole Wallet route, with Wallet's part played by a plain ledger
  // transfer of exactly the quoted amount to exactly that account.
  const quoted = BigInt(quote.amountAtoms);
  check("paying the quoted amount is accepted by the ledger", await fundInvoice(carol.getPrincipal(), quoted));

  let settled = false;
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) {
    settled = await mintCreditsWithIcp(1)
      .then((invoice) => invoice.paid)
      .catch(() => false);
    if (!settled) await sleep(1000);
  }
  check("the quoted payment settles the invoice Taggr checks", settled);
  await createUser("carol", "");
  check(
    "the account is created once that invoice is paid",
    (await loadUser(DOMAIN, "carol")) !== null,
  );

  /* ---- 3. publishing ---- */

  section("Publishing — the shipped Candid encoder against the real canister");

  useAlice();
  const postId = await addPost({ body: "hello from a Neutron #neutron" });
  check("addPost returns a post id", Number.isSafeInteger(postId) && postId >= 0, `${postId}`);

  const feed = await loadFeed({ domain: DOMAIN, mode: "new" });
  const posted = feed.find((entry) => entry.post.id === postId);
  check("the post appears in the feed", posted !== undefined);
  check("the feed entry carries the author from Meta", posted?.meta.authorName === "alice");
  check(
    "the client parses the post body",
    posted?.post.body.includes("hello from a Neutron") === true,
  );
  check(
    "Taggr extracted the hashtag the client renders",
    posted?.post.tags.includes("neutron") === true,
    json(posted?.post.tags),
  );
  check(
    "user posts read back",
    (await loadUserPosts({ domain: DOMAIN, handle: "alice" })).some(
      (entry) => entry.post.id === postId,
    ),
  );
  check(
    "search finds the post",
    (await runSearch(DOMAIN, "Neutron")).some((result) => result.id === postId),
  );

  const replyId = await addPost({ body: "a reply", parent: postId });
  check("addPost accepts a parent for replies", Number.isSafeInteger(replyId));

  // Taggr's `thread` is the ancestor chain, so the conversation view has to
  // fetch the replies separately. This proves both halves line up.
  const view = await conversation(postId);
  check(
    "the conversation view shows the root and its reply",
    view.focus === postId &&
      view.entries.some((entry) => entry.post.id === postId) &&
      view.entries.some((entry) => entry.post.id === replyId),
    view.entries.map((entry) => entry.post.id).join(", "),
  );
  const replyView = await conversation(replyId);
  check(
    "opening the reply shows its ancestor chain, root first",
    replyView.entries[0]?.post.id === postId &&
      replyView.entries.some((entry) => entry.post.id === replyId),
    replyView.entries.map((entry) => entry.post.id).join(" -> "),
  );

  /* ---- 4. reactions ---- */

  section("Reactions");

  const ownReaction = await outcome(() => sendReaction(postId, 11));
  check(
    "Taggr rejects a reaction to your own post and the reason reaches the client",
    ownReaction.includes("reactions to own posts are forbidden"),
    ownReaction.slice(0, 160),
  );

  setTaggrTransport(bobClient);
  const peerReaction = await outcome(() => sendReaction(postId, 11));
  check("a second account can react", peerReaction === "ok", peerReaction.slice(0, 160));

  useAlice();
  const afterReaction = await loadFeed({ domain: DOMAIN, mode: "new" });
  check(
    "the reaction reads back through the client's parser",
    afterReaction
      .find((entry) => entry.post.id === postId)
      ?.post.reactions.some((reaction) => reaction.id === 11) === true,
    json(afterReaction.find((entry) => entry.post.id === postId)?.post.reactions),
  );

  /* ---- 5. failure surfaces ---- */

  section("Failure surfaces the client renders");

  const malformed = await outcome(() =>
    aliceClient.query("last_posts", '"not the argument shape"'),
  );
  check(
    "a malformed payload is rejected rather than silently accepted",
    malformed !== "ok",
    malformed.slice(0, 160),
  );

  const unknownMethod = await outcome(() => aliceClient.query("no_such_method", "null"));
  check(
    "an unknown method fails rather than returning empty text",
    unknownMethod !== "ok",
    unknownMethod.slice(0, 160),
  );

  const emptyPost = await outcome(() => addPost({ body: "   " }));
  check(
    "an empty post is refused before it costs a call",
    emptyPost.includes("needs a body"),
    emptyPost.slice(0, 160),
  );
}

await main();
