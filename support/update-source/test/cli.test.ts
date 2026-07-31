import { afterEach, expect, test } from "bun:test";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  parseArguments,
  readOperatorIdentity,
} from "../src/cli.ts";

const canisterId = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("publisher CLI accepts only the direct-agent connection surface", () => {
  const parsed = parseArguments(
    [
      "--canister-id",
      canisterId,
      "--host=https://icp-api.io",
      "--identity-file",
      "/run/secrets/publisher.json",
      "package.neutron",
    ],
    {
      valueFlags: COMMON_VALUE_FLAGS,
    },
  );
  expect(parsed.values.get("host")).toBe("https://icp-api.io");
  expect(parsed.flags.size).toBe(0);
  expect(parsed.positional).toEqual(["package.neutron"]);

  expect(() =>
    parseArguments(["--icp-cli", "icp"], {
      valueFlags: COMMON_VALUE_FLAGS,
    }),
  ).toThrow("Unknown option --icp-cli");
  expect(() =>
    parseArguments(["--fetch-root-key"], {
      valueFlags: COMMON_VALUE_FLAGS,
    }),
  ).toThrow("Unknown option --fetch-root-key");
});

test("operator identity loader accepts only a private canonical Ed25519 file", async () => {
  const directory = await temporaryDirectory();
  const identity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(7));
  const filename = path.join(directory, "identity.json");
  await writeFile(filename, `${JSON.stringify(identity.toJSON())}\n`, {
    mode: 0o600,
  });

  const loaded = await readOperatorIdentity(filename);

  expect(loaded.getPrincipal().toText()).toBe(identity.getPrincipal().toText());

  const publicFile = path.join(directory, "public.json");
  await writeFile(publicFile, JSON.stringify(identity.toJSON()), { mode: 0o644 });
  await expect(readOperatorIdentity(publicFile)).rejects.toThrow(
    "permissions must not grant group or other access",
  );

  const symlinkPath = path.join(directory, "identity-link.json");
  await symlink(filename, symlinkPath);
  await expect(readOperatorIdentity(symlinkPath)).rejects.toThrow(
    "Unable to open identity file",
  );
});

test("operator commands cannot target a local host or source origin", async () => {
  for (const host of [
    "http://localhost:8000",
    "https://localhost:8000",
    "https://fixture.localhost:8000",
    "https://127.0.0.2:8000",
  ]) {
    const parsed = parseArguments(
      ["--canister-id", canisterId, "--host", host],
      { valueFlags: COMMON_VALUE_FLAGS },
    );
    await expect(createCliContext(parsed)).rejects.toThrow(
      /HTTPS origin|cannot target a local host/,
    );
  }

  const localOrigin = parseArguments(
    [
      "--canister-id",
      canisterId,
      "--host",
      "https://icp-api.io",
      "--source-origin",
      "https://source.localhost:8000",
    ],
    { valueFlags: COMMON_VALUE_FLAGS },
  );
  await expect(createCliContext(localOrigin)).rejects.toThrow(
    "--source-origin cannot target a local host",
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "neutron-update-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
