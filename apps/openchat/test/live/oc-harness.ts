/**
 * Live OpenChat wire harness — DEV ONLY, talks to OpenChat mainnet.
 *
 * It exercises the exact `src/oc/*` client modules (transport, sign-in-with-email,
 * identity/user canisters, msgpack codec, variant + delegation helpers) outside
 * the browser and Neutron, so wire bugs surface immediately instead of via
 * package → install → console. The only manual step is pasting the emailed link.
 *
 * The browser app uses a non-extractable ECDSA key in IndexedDB; here we use an
 * Ed25519 key persisted to a gitignored file so `start` and `finish` (separate
 * processes) share it. The OpenChat wire is identical for either key type.
 *
 *   bun test/live/oc-harness.ts start  <email>
 *   bun test/live/oc-harness.ts finish "<pasted link>" [username]
 *   bun test/live/oc-harness.ts whoami
 *   bun test/live/oc-harness.ts chats
 *
 * State (session key + delegation) lives in test/live/.session.json — dev
 * credential, gitignored, safe to delete to start over.
 */
import { AnonymousIdentity } from "@dfinity/agent";
import { DelegationChain, DelegationIdentity, Ed25519KeyIdentity } from "@dfinity/identity";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { OcTransport } from "../../src/oc/transport.ts";
import { SignInWithEmailClient } from "../../src/oc/sie.ts";
import {
  CommunityClient,
  GroupClient,
  GroupIndexClient,
  IdentityCanisterClient,
  LocalUserIndexClient,
  UserClient,
  UserIndexClient,
} from "../../src/oc/clients.ts";
import { OC_CANISTERS } from "../../src/oc/constants.ts";
import { buildDelegationIdentity } from "../../src/oc/identity.ts";
import { decodeMsgpack } from "../../src/oc/msgpack.ts";
import {
  asBytes,
  directChatVM,
  messagePreview,
  principalText,
  toBigInt,
  userCanisterId,
  variantIs,
  variantPayload,
  variantTag,
  variantValue,
} from "../../src/oc/view.ts";

const STATE = new URL("./.session.json", import.meta.url);
const anon = new AnonymousIdentity();
const transport = new OcTransport();
const sie = new SignInWithEmailClient(transport);
const identityClient = new IdentityCanisterClient(transport);
const userIndex = new UserIndexClient(transport);
const user = new UserClient(transport);
const lui = new LocalUserIndexClient(transport);
const groupIndex = new GroupIndexClient(transport);
const community = new CommunityClient(transport);
const group = new GroupClient(transport);

type State = {
  sessionKey?: string; // Ed25519KeyIdentity toJSON
  email?: string;
  userKey?: string; // hex
  expiration?: string; // nanos
  code?: string;
  ocChain?: unknown; // DelegationChain toJSON
  ocUserId?: string;
  ocUsername?: string;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

function load(): State {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {};
}
function save(s: State): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function sessionKey(s: State): Ed25519KeyIdentity {
  if (s.sessionKey) return Ed25519KeyIdentity.fromJSON(s.sessionKey);
  const key = Ed25519KeyIdentity.generate();
  s.sessionKey = JSON.stringify(key.toJSON());
  save(s);
  return key;
}
const der = (k: Ed25519KeyIdentity): Uint8Array => new Uint8Array(k.getPublicKey().toDer());

function linkQuery(link: string): string {
  const q0 = link.includes("?") ? link.slice(link.indexOf("?") + 1) : link;
  const q = q0.split("#")[0]!;
  // append &c=<code from m> if absent
  if (/(^|&)c=/.test(q)) return q;
  const m = q.split("&").find((p) => p.startsWith("m="))?.slice(2);
  if (!m) return q;
  try {
    const decoded = decodeMsgpack<{ code?: unknown }>(unhex(decodeURIComponent(m)));
    if (typeof decoded.code === "string") return `${q}&c=${decoded.code}`;
  } catch {
    /* ignore */
  }
  return q;
}

async function start(email: string): Promise<void> {
  const s = load();
  const key = sessionKey(s);
  console.log("session principal:", key.getPrincipal().toText());
  const res = await sie.generateMagicLink(anon, email, der(key));
  console.log("generate_magic_link:", res.kind);
  if (res.kind !== "success") return;
  s.email = email;
  s.userKey = hex(res.userKey);
  s.expiration = res.expiration.toString();
  s.code = res.code;
  save(s);
  console.log(`\n  email sent to ${email}. code = ${res.code}`);
  console.log(`  open the email, then run:\n  bun test/live/oc-harness.ts finish "<paste the link>" [username]\n`);
}

async function finish(link: string, username?: string): Promise<void> {
  const s = load();
  const key = sessionKey(s);
  if (!s.email || !s.userKey || !s.expiration) throw new Error("run `start <email>` first");
  const sessionKeyDer = der(key);

  const hm = await sie.handleMagicLink(anon, linkQuery(link));
  console.log("handle_magic_link:", hm.kind);
  if (hm.kind !== "success") return;

  const del = await sie.getDelegation(anon, s.email, sessionKeyDer, BigInt(s.expiration));
  console.log("sie.get_delegation:", del.kind);
  if (del.kind !== "success") return;
  const emailIdentity = buildDelegationIdentity(
    key,
    unhex(s.userKey),
    del.delegationPubkey,
    del.expiration,
    del.signature,
  );
  console.log("email principal:", emailIdentity.getPrincipal().toText());

  const exists = await identityClient.checkAuthPrincipal(emailIdentity);
  const isNew = !variantIs(exists, "Success");
  console.log("check_auth_principal:", variantTag(exists), "(new account:", isNew, ")");
  const prepared = isNew
    ? await identityClient.createIdentity(emailIdentity, new Uint8Array(emailIdentity.getPublicKey().toDer()), sessionKeyDer)
    : await identityClient.prepareDelegation(emailIdentity, sessionKeyDer);
  console.log(isNew ? "create_identity:" : "prepare_delegation:", variantTag(prepared));
  const okp = variantPayload(prepared, "Success");
  const ocUserKey = asBytes(okp.user_key);
  const ocExp = toBigInt(okp.expiration);
  if (!ocUserKey || ocExp === null) throw new Error("no user_key/expiration from identity canister");

  const ocDel = await identityClient.getDelegation(emailIdentity, sessionKeyDer, ocExp);
  console.log("identity.get_delegation:", variantTag(ocDel));
  const dr = variantPayload(ocDel, "Success");
  const pubkey = asBytes(variantPayload(dr, "delegation").pubkey);
  const sig = asBytes(dr.signature);
  if (!pubkey || !sig) throw new Error("identity get_delegation not ready");
  const ocIdentity = buildDelegationIdentity(key, ocUserKey, pubkey, ocExp, sig);
  console.log("OpenChat principal:", ocIdentity.getPrincipal().toText());

  let current = await userIndex.currentUser(ocIdentity);
  console.log("current_user:", variantIs(current, "Success") ? "registered" : variantTag(current));
  if (!variantIs(current, "Success")) {
    if (!username) {
      console.log("\n  new account — re-run finish with a username:\n  bun test/live/oc-harness.ts finish \"<link>\" <username>\n");
      return;
    }
    const reg = await lui.registerUser(ocIdentity, OC_CANISTERS.localUserIndex, username, ocUserKey);
    const tag = variantTag(reg);
    console.log("register_user:", tag);
    if (tag !== "Success" && tag !== "RegistrationInProgress" && tag !== "AlreadyRegistered") {
      console.log("  register error payload:", JSON.stringify(variantPayload(reg, "Error")));
      return;
    }
    // Registration is async (creates the user canister); poll current_user.
    for (let i = 0; i < 20 && !variantIs(current, "Success"); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      current = await userIndex.currentUser(ocIdentity);
      console.log(`  waiting for account… current_user: ${variantTag(current)}`);
    }
    if (!variantIs(current, "Success")) {
      console.log("  registration did not complete in time; re-run whoami later.");
      return;
    }
  }
  const cu = variantPayload(current, "Success");
  s.ocChain = ocIdentity.getDelegation().toJSON();
  const uid = principalText(cu.user_id);
  if (uid) s.ocUserId = uid;
  if (typeof cu.username === "string") s.ocUsername = cu.username;
  save(s);
  console.log(`\n  SIGNED IN as @${s.ocUsername} (userId ${s.ocUserId})\n`);
}

function ocIdentityFromState(s: State): DelegationIdentity {
  if (!s.ocChain) throw new Error("not signed in — run start/finish first");
  return DelegationIdentity.fromDelegation(sessionKey(s), DelegationChain.fromJSON(s.ocChain as never));
}

async function whoami(): Promise<void> {
  const s = load();
  const id = ocIdentityFromState(s);
  const cu = variantPayload(await userIndex.currentUser(id), "Success");
  console.log("principal:", id.getPrincipal().toText());
  console.log("userId:", principalText(cu.user_id), "username:", cu.username);
}

async function chats(): Promise<void> {
  const s = load();
  const id = ocIdentityFromState(s);
  const cu = variantPayload(await userIndex.currentUser(id), "Success");
  const userId = principalText(cu.user_id);
  if (!userId) throw new Error("no user id");
  const initial = variantPayload(await user.initialState(id, userCanisterId(userId)), "Success");
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const directs = rec(initial.direct_chats).summaries;
  const groups = rec(initial.group_chats).summaries;
  console.log("direct chats:", Array.isArray(directs) ? directs.length : 0);
  console.log("group chats:", Array.isArray(groups) ? groups.length : 0);
  for (const d of (Array.isArray(directs) ? directs : []).slice(0, 5)) {
    const vm = directChatVM(rec(d));
    if (vm) console.log("  DM", vm.title, "-", vm.lastMessage?.text ?? "");
  }
  for (const g of (Array.isArray(groups) ? groups : []).slice(0, 10)) {
    const gid = principalText(rec(g).chat_id);
    if (!gid) continue;
    const full = variantPayload(await group.summary(id, gid), "Success").summary as Record<string, unknown>;
    console.log("  GROUP", String(full.name ?? gid), "-", messagePreview(full.latest_message)?.text ?? "");
  }
}

async function discover(kind: string, term?: string): Promise<void> {
  const resp =
    kind === "groups"
      ? await groupIndex.exploreGroups(anon, term ?? null, 0, 10)
      : await groupIndex.exploreCommunities(anon, term ?? null, 0, 10);
  const payload = variantPayload(resp, "Success");
  const matches = Array.isArray(payload.matches) ? payload.matches : [];
  console.log(`${kind} (${matches.length} of total ${String(payload.total)}):`);
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  for (const raw of matches) {
    const m = rec(raw);
    console.log(
      `  ${principalText(m.id)}  ${String(m.name)}  (${String(m.member_count)} members${m.verified ? ", verified" : ""})`,
    );
  }
}

async function luiOf(kind: string, id: string): Promise<void> {
  const resp = kind === "group"
    ? await group.localUserIndex(anon, id)
    : await community.localUserIndex(anon, id);
  console.log("tag:", variantTag(resp), "local_user_index:", principalText(variantValue(resp, "Success")));
}

const [cmd, ...rest] = process.argv.slice(2);
const run =
  cmd === "start"
    ? start(rest[0]!)
    : cmd === "finish"
      ? finish(rest[0]!, rest[1])
      : cmd === "whoami"
        ? whoami()
        : cmd === "chats"
          ? chats()
          : cmd === "discover"
            ? discover(rest[0] ?? "communities", rest[1])
            : cmd === "lui"
              ? luiOf(rest[0] ?? "community", rest[1]!)
              : Promise.reject(
                new Error(
                  `usage: start <email> | finish "<link>" [username] | whoami | chats | discover [communities|groups] [term]`,
                ),
              );

run.catch((e: unknown) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
