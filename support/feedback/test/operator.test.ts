import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { ADMINISTRATOR, parseOptions, runOperator, type Options, type Run } from "../scripts/operator.ts";

const canister = "233tv-xiaaa-aaaay-aacta-cai";
const neutron = "3rurp-vyaaa-aaaay-aacua-cai";
const host = "https://icp-api.io";
const options: Options = { command: "grant", canister, neutron, host };

// Exercise the same result projection as the repository's documented npm
// operator command. The converter is exported by this installed module but
// not by the package's public entry point, so resolve its sibling by URL.
const blastEntry = new URL(import.meta.resolve("icblast"));
const { explainer, convertBack } = await import(new URL("./icb_node.js", blastEntry).href);
const blastVersion = JSON.parse(await readFile(new URL("../package.json", blastEntry), "utf8")).version;
const operatorIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const error = IDL.Record({ code: IDL.Text, message: IDL.Text });
  const moderator = IDL.Record({ id: IDL.Nat64, neutron: IDL.Principal, active: IDL.Bool, updatedAtNs: IDL.Int });
  const page = IDL.Record({ items: IDL.Vec(moderator), nextCursor: IDL.Opt(IDL.Nat64) });
  return IDL.Service({
    feedback_info: IDL.Func([], [IDL.Record({ administrator: IDL.Principal, protocolVersion: IDL.Nat, schemaVersion: IDL.Nat })], ["query"]),
    moderators: IDL.Func([IDL.Record({ cursor: IDL.Opt(IDL.Nat64), limit: IDL.Nat })], [IDL.Variant({ ok: page, err: error })], ["query"]),
    moderator_set: IDL.Func([IDL.Record({ neutron: IDL.Principal, active: IDL.Bool })], [IDL.Variant({ ok: IDL.Null, err: error })], []),
  });
};
const explanation = explainer(operatorIdl);
const candidInfo = { administrator: Principal.fromText(ADMINISTRATOR), protocolVersion: 1n, schemaVersion: 1n };

function projectedFixture(replies: unknown[] = [candidInfo, { ok: null }]) {
  const calls: string[][] = [];
  const output: string[] = [];
  const run: Run = async args => {
    calls.push(args);
    if (calls.length === 1) return ADMINISTRATOR + "\n";
    const response = replies[calls.length - 2];
    if (response === undefined) throw new Error("Unexpected additional Blast command");
    const projected = JSON.stringify(convertBack(response, explanation[args[2]!].output));
    output.push(projected);
    return projected;
  };
  return { calls, output, run };
}

function fixture(replies: unknown[] = [{ administrator: ADMINISTRATOR }, { ok: null }]) {
  const calls: string[][] = [];
  const run: Run = async args => {
    calls.push(args);
    if (calls.length === 1) return ADMINISTRATOR + "\n";
    const response = replies[calls.length - 2];
    if (response === undefined) throw new Error("Unexpected additional Blast command");
    return JSON.stringify(response);
  };
  return { calls, run };
}

describe("Feedback moderator operator", () => {
  test("wrong Blast identity stops before querying or mutating a canister", async () => {
    const calls: string[][] = [];
    await expect(runOperator(options, async args => {
      calls.push(args);
      return "2vxsx-fae\n";
    })).rejects.toThrow("Blast identity 0");
    expect(calls).toEqual([["principal", "--id", "0"]]);
  });

  test("wrong target administrator stops before a moderator mutation", async () => {
    const mock = fixture([{ administrator: "2vxsx-fae" }]);
    await expect(runOperator(options, mock.run)).rejects.toThrow("different administrator");
    expect(mock.calls).toEqual([
      ["principal", "--id", "0"],
      ["call", canister, "feedback_info", "[]", "--host", host, "--id", "0"],
    ]);
  });

  for (const command of ["grant", "revoke"] as const) {
    test(`${command} passes exactly the requested Neutron, active state, host and identity`, async () => {
      const mock = fixture();
      const configuredHost = "http://127.0.0.1:4943";
      expect(await runOperator({ ...options, command, host: configuredHost }, mock.run)).toBeNull();
      expect(mock.calls).toEqual([
        ["principal", "--id", "0"],
        ["call", canister, "feedback_info", "[]", "--host", configuredHost, "--id", "0"],
        ["call", canister, "moderator_set", JSON.stringify([{ neutron, active: command === "grant" }]), "--host", configuredHost, "--id", "0"],
      ]);
    });
  }

  test("listing preserves Nat64 cursor precision and returns the protocol page", async () => {
    const page = { items: [{ id: "1", neutron, active: true }], nextCursor: null };
    const mock = fixture([{ administrator: ADMINISTRATOR }, { ok: page }]);
    const parsed = parseOptions(["list", "--canister", canister, "--cursor", "18446744073709551615"]);
    expect(await runOperator(parsed, mock.run)).toEqual(page);
    expect(mock.calls[2]).toEqual([
      "call", canister, "moderators", JSON.stringify([{ cursor: "18446744073709551615", limit: "30" }]), "--host", host, "--id", "0",
    ]);
    const initial = fixture([{ administrator: ADMINISTRATOR }, { ok: page }]);
    await runOperator(parseOptions(["list", "--canister", canister]), initial.run);
    expect(JSON.parse(initial.calls[2]![3]!)).toEqual([{ cursor: null, limit: "30" }]);
  });

  test("protocol errors are reported instead of being printed as a success", async () => {
    const mock = fixture([{ administrator: ADMINISTRATOR }, { err: { code: "administrator_required", message: "Not the administrator" } }]);
    await expect(runOperator(options, mock.run)).rejects.toThrow("administrator_required: Not the administrator");
    expect(mock.calls).toHaveLength(3);
    const malformed = fixture([{ administrator: ADMINISTRATOR }, { accepted: true }]);
    await expect(runOperator(options, malformed.run)).rejects.toThrow("unexpected Feedback result");
  });

  test("arguments identify one operation and valid canister principals before executing", () => {
    expect(parseOptions(["grant", "--canister", canister, "--neutron", neutron])).toEqual(options);
    const invalid = [
      [], ["grant", "--canister", canister], ["grant", "list", "--canister", canister],
      ["list", "--canister", "2vxsx-fae"], ["grant", "--canister", canister, "--neutron", ADMINISTRATOR],
      ["list", "--canister", canister, "--neutron", neutron],
      ["revoke", "--canister", canister, "--neutron", neutron, "--cursor", "1"],
      ["list", "--canister", canister, "--cursor", "18446744073709551616"],
      ["list", "--canister", canister, "--cursor", "-1"],
      ["list", "--canister", canister, "--cursor", "1.2"],
      ["list", "--canister", canister, "--canister", neutron],
    ];
    for (const args of invalid) expect(() => parseOptions(args)).toThrow();
  });
});

describe("Feedback operator with the actual installed Blast result converter", () => {
  test("the regression fixture uses repository-installed icblast 4.3.3", () => {
    expect(blastVersion).toBe("4.3.3");
    expect(typeof explainer).toBe("function");
    expect(typeof convertBack).toBe("function");
  });

  test("lowercase Result pages unwrap and absent optional cursors disappear from CLI JSON", async () => {
    const mock = projectedFixture([candidInfo, { ok: { items: [], nextCursor: [] } }]);
    expect(await runOperator({ command: "list", canister, host }, mock.run)).toEqual({ items: [] });
    expect(JSON.parse(mock.output[0]!)).toEqual({ administrator: ADMINISTRATOR, protocolVersion: "1", schemaVersion: "1" });
    expect(mock.output[1]).toBe('{"items":[]}');
    expect(mock.calls[2]).toEqual(["call", canister, "moderators", JSON.stringify([{ cursor: null, limit: "30" }]), "--host", host, "--id", "0"]);
  });

  test("present cursors and moderator identifiers retain full Nat64 precision after CLI projection", async () => {
    const largest = 18_446_744_073_709_551_615n;
    const timestamp = 1_789_237_816_123_456_789n;
    const mock = projectedFixture([candidInfo, { ok: {
      items: [{ id: largest, neutron: Principal.fromText(neutron), active: true, updatedAtNs: timestamp }], nextCursor: [largest],
    } }]);
    const expected = { items: [{ id: largest.toString(), neutron, active: true, updatedAtNs: timestamp.toString() }], nextCursor: largest.toString() };
    expect(await runOperator({ command: "list", canister, host }, mock.run)).toEqual(expected);
    expect(JSON.parse(mock.output[1]!)).toEqual(expected);
  });

  for (const command of ["grant", "revoke"] as const) {
    test(`${command} accepts the converter's void success while serializing only the requested assignment`, async () => {
      const mock = projectedFixture();
      expect(await runOperator({ ...options, command }, mock.run)).toBeNull();
      expect(mock.output[1]).toBe("null");
      expect(mock.calls[2]).toEqual([
        "call", canister, "moderator_set", JSON.stringify([{ neutron, active: command === "grant" }]), "--host", host, "--id", "0",
      ]);
    });
  }

  test("projected target identity still blocks a moderator mutation", async () => {
    const mock = projectedFixture([{ ...candidInfo, administrator: Principal.anonymous() }]);
    await expect(runOperator(options, mock.run)).rejects.toThrow("different administrator");
    expect(mock.calls).toHaveLength(2);
  });

  test("the installed converter's rejected Result propagates without reporting success", async () => {
    const error = { code: "administrator_required", message: "No longer the administrator" };
    const mock = projectedFixture([candidInfo, { err: error }]);
    await expect(runOperator(options, mock.run)).rejects.toEqual(error);
    expect(mock.calls).toHaveLength(3);
    expect(mock.output).toHaveLength(1);
  });

  test("command validation rejects unrelated successful JSON in both CLI output formats", async () => {
    for (const value of [true, 1, "accepted", {}, { accepted: true }, [], { items: [] }]) {
      await expect(runOperator(options, fixture([{ administrator: ADMINISTRATOR }, value]).run)).rejects.toThrow();
      await expect(runOperator(options, fixture([{ administrator: ADMINISTRATOR }, { ok: value }]).run)).rejects.toThrow();
    }
    const list: Options = { command: "list", canister, host };
    for (const value of [null, [], { items: null }, { items: [], nextCursor: [] }, { items: [], nextCursor: 1 }, { items: [], nextCursor: "-1" }, { items: [], nextCursor: "1.5" }]) {
      await expect(runOperator(list, fixture([{ administrator: ADMINISTRATOR }, value]).run)).rejects.toThrow();
      await expect(runOperator(list, fixture([{ administrator: ADMINISTRATOR }, { ok: value }]).run)).rejects.toThrow();
    }
  });
});
