import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import {
  decodeAddPostReply,
  encodeAddPostArgs,
  encodeArgs,
  isLocalHost,
  MAX_POST_BYTES,
  replicaHost,
  TaggrCallError,
} from "../src/taggr_client.ts";
import { isReadMethod, isWriteMethod, READ_METHODS, WRITE_METHODS } from "../src/methods.ts";

/** Taggr's `add_post` signature from `src/backend/taggr.did`. */
const ADD_POST_ARGS = [
  IDL.Text,
  IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat64, IDL.Nat64)),
  IDL.Opt(IDL.Nat64),
  IDL.Opt(IDL.Text),
  IDL.Opt(IDL.Vec(IDL.Nat8)),
];

type DecodedArgs = [string, unknown[], bigint[], string[], unknown[]];

const decodeArgs = (bytes: Uint8Array): DecodedArgs =>
  IDL.decode(ADD_POST_ARGS, bytes) as unknown as DecodedArgs;

describe("argument encoding", () => {
  test("encodes no arguments as JSON null", () => {
    expect(encodeArgs([])).toBe("null");
  });

  test("encodes a single argument bare rather than wrapped in an array", () => {
    expect(encodeArgs([4242])).toBe("4242");
    expect(encodeArgs([[1, 2, 3]])).toBe("[1,2,3]");
    expect(encodeArgs(["alice"])).toBe('"alice"');
  });

  test("encodes several arguments as a positional array", () => {
    expect(encodeArgs(["localhost", "", 0, 0, false])).toBe('["localhost","",0,0,false]');
  });

  test("drops undefined the way Taggr's own frontend does", () => {
    expect(encodeArgs([undefined, "kept"])).toBe('"kept"');
    expect(encodeArgs([undefined])).toBe("null");
  });

  test("keeps an explicit null as a positional argument", () => {
    expect(encodeArgs(["localhost", null])).toBe('["localhost",null]');
  });
});

describe("add_post encoding", () => {
  test("encodes a realm reply with every optional present", () => {
    const [body, refs, parent, realm, extension] = decodeArgs(
      encodeAddPostArgs({ body: "  hello taggr\n", parent: 7, realm: "NEUTRON" }),
    );
    expect(body).toBe("hello taggr");
    // Attachments live in per-user Taggr bucket canisters; this client writes
    // none, so the file-reference vector must always be empty.
    expect(refs).toEqual([]);
    expect(parent).toEqual([7n]);
    expect(realm).toEqual(["NEUTRON"]);
    expect(extension).toEqual([]);
  });

  test("leaves both options absent for a realmless root post", () => {
    const [body, , parent, realm] = decodeArgs(
      encodeAddPostArgs({ body: "root post", parent: null, realm: null }),
    );
    expect(body).toBe("root post");
    // Taggr reads an absent option as "no parent"/"no realm"; an empty string
    // would be a realm named "".
    expect(parent).toEqual([]);
    expect(realm).toEqual([]);
  });

  test("treats a whitespace-only realm as no realm", () => {
    const [, , , realm] = decodeArgs(encodeAddPostArgs({ body: "x", realm: "   " }));
    expect(realm).toEqual([]);
  });

  test("round-trips a multi-byte body", () => {
    const [body] = decodeArgs(encodeAddPostArgs({ body: "héllo 🏴‍☠️ #taggr" }));
    expect(body).toBe("héllo 🏴‍☠️ #taggr");
  });

  test("refuses an empty body before spending a call", () => {
    expect(() => encodeAddPostArgs({ body: "   " })).toThrow(TaggrCallError);
  });

  test("refuses a body past the size ceiling", () => {
    expect(() => encodeAddPostArgs({ body: "a".repeat(MAX_POST_BYTES + 1) })).toThrow(
      /under 60000 bytes/,
    );
  });

  test("refuses an over-long realm name", () => {
    expect(() => encodeAddPostArgs({ body: "x", realm: "R".repeat(65) })).toThrow(
      /realm name is too long/,
    );
  });
});

describe("add_post reply decoding", () => {
  const encodeResult = (value: { Ok: bigint } | { Err: string }): Uint8Array =>
    IDL.encode([IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Text })], [value]);

  test("reads the new post id", () => {
    expect(decodeAddPostReply(encodeResult({ Ok: 4242n }))).toBe(4242);
  });

  test("raises Taggr's own reason verbatim", () => {
    expect(() => decodeAddPostReply(encodeResult({ Err: "not enough credits" }))).toThrow(
      "not enough credits",
    );
  });

  test("does not mistake undecodable bytes for success", () => {
    expect(() => decodeAddPostReply(new TextEncoder().encode("not candid"))).toThrow(
      TaggrCallError,
    );
    expect(() => decodeAddPostReply(new Uint8Array())).toThrow(TaggrCallError);
  });
});

describe("replica host", () => {
  const location = (href: string) => new URL(href) as unknown as Location;

  test("uses the IC boundary node for a mainnet surface", () => {
    expect(replicaHost(location("https://abcde-aaaaa-aaaaa-aaaaa-cai.icp0.io/app/taggr/"))).toBe(
      "https://icp-api.io",
    );
  });

  test("uses the local gateway for a local surface, whatever the subdomain", () => {
    expect(replicaHost(location("http://x--abcde-cai.localhost:8000/app/taggr/"))).toBe(
      "http://localhost:8000",
    );
  });

  test("recognises local hosts", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("abc.localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("taggr.link")).toBe(false);
    expect(isLocalHost("evil-localhost.example")).toBe(false);
  });
});

describe("method allowlists", () => {
  test("reads and writes do not overlap", () => {
    const reads = new Set(READ_METHODS);
    expect(WRITE_METHODS.filter((method) => reads.has(method))).toEqual([]);
  });

  test("the write list stays small and excludes destructive Taggr methods", () => {
    expect([...WRITE_METHODS]).toEqual([
      "create_user",
      "mint_credits_with_icp",
      "react",
      "toggle_bookmark",
      "toggle_following_user",
      "toggle_realm_membership",
      "update_last_activity",
      "vote_on_poll",
    ]);
    for (const forbidden of [
      "delete_post",
      "edit_post",
      "transfer_credits",
      "set_delegation",
      "toggle_blacklist",
      "create_proposal",
      "vote_on_proposal",
      "set_emergency_release",
      "propose_release",
      "withdraw_rewards",
      "tip",
    ]) {
      expect(WRITE_METHODS).not.toContain(forbidden);
      expect(READ_METHODS).not.toContain(forbidden);
    }
  });

  test("a read method is not reachable through the write path and vice versa", () => {
    expect(isReadMethod("last_posts")).toBe(true);
    expect(isWriteMethod("last_posts")).toBe(false);
    expect(isWriteMethod("react")).toBe(true);
    expect(isReadMethod("react")).toBe(false);
  });

  test("add_post is absent from both text allowlists because it is Candid", () => {
    expect(isReadMethod("add_post")).toBe(false);
    expect(isWriteMethod("add_post")).toBe(false);
  });
});
