import { describe, expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import {
  LOCAL_CANISTER_CYCLES,
  normalizeLocalProvisionGateway,
  principalFromCanonicalBase64,
} from "../src/local_client.ts";

describe("direct PocketIC deployment client", () => {
  test("decodes the supervised raw effective canister ID", () => {
    const expected = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
    const encoded = Buffer.from(expected.toUint8Array()).toString("base64");
    expect(
      principalFromCanonicalBase64(encoded, "effective canister ID").toText(),
    ).toBe(expected.toText());
  });

  test("rejects empty and non-canonical base64 IDs", () => {
    expect(() => principalFromCanonicalBase64("", "ID")).toThrow(
      "canonical base64",
    );
    expect(() => principalFromCanonicalBase64("YQ", "ID")).toThrow(
      "canonical base64",
    );
  });

  test("creates local canisters with a useful fixed cycle balance", () => {
    expect(LOCAL_CANISTER_CYCLES).toBe(100_000_000_000_000n);
  });

  test("accepts canonical IPv4 loopback gateway aliases", () => {
    expect(normalizeLocalProvisionGateway("http://localhost:8000")).toBe(
      "http://localhost:8000/",
    );
    expect(normalizeLocalProvisionGateway("http://127.0.0.1:8000/")).toBe(
      "http://127.0.0.1:8000/",
    );
    expect(normalizeLocalProvisionGateway("http://127.0.0.2:8000")).toBe(
      "http://127.0.0.2:8000/",
    );
    expect(
      normalizeLocalProvisionGateway("http://127.255.255.254:41000"),
    ).toBe("http://127.255.255.254:41000/");
  });

  test("rejects non-loopback and ambiguous IPv4 gateway spellings", () => {
    for (const gateway of [
      "http://128.0.0.1:8000/",
      "http://10.0.0.1:8000/",
      "http://127.1:8000/",
      "http://2130706433:8000/",
      "http://0x7f000001:8000/",
      "http://127.000.000.002:8000/",
      "http://0177.0.0.2:8000/",
    ]) {
      expect(() => normalizeLocalProvisionGateway(gateway)).toThrow();
    }
  });

  test("rejects gateway authority and URL surface expansion", () => {
    for (const gateway of [
      "https://127.0.0.2:8000/",
      "http://user@127.0.0.2:8000/",
      "http://127.0.0.2:8000/path",
      "http://127.0.0.2:8000/?query",
      "http://127.0.0.2:8000/#fragment",
    ]) {
      expect(() => normalizeLocalProvisionGateway(gateway)).toThrow(
        "bare loopback HTTP origin",
      );
    }
  });
});
