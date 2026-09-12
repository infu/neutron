// All rights reserved. See ../LICENSE.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Principal } from "@dfinity/principal";

export const ADMINISTRATOR = "y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe";
const execFile = promisify(execFileCallback);
export type Options = { canister: string; host: string; command: "grant" | "revoke" | "list"; neutron?: string; cursor?: string };
export type Run = (args: string[]) => Promise<string>;
const runBlast: Run = async args => (await execFile("blast", args, { encoding: "utf8" })).stdout;

function canister(value: string): string {
  const principal = Principal.fromText(value);
  const bytes = principal.toUint8Array();
  if (bytes.length === 0 || bytes.at(-1) !== 1) throw new Error("Use a canister principal.");
  return principal.toText();
}

export function parseOptions(args: readonly string[]): Options {
  const options: Partial<Options> = { host: "https://icp-api.io" };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "grant" || argument === "revoke" || argument === "list") {
      if (options.command) throw new Error("Select one operator command.");
      options.command = argument;
    } else if (argument === "--canister" || argument === "--host" || argument === "--neutron" || argument === "--cursor") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`A value is required for ${argument}.`);
      const key = argument.slice(2) as "canister" | "host" | "neutron" | "cursor";
      if (key !== "host" && options[key] !== undefined) throw new Error(`${argument} was supplied twice.`);
      options[key] = value;
    } else throw new Error(`Unknown operator argument: ${argument}`);
  }
  if (!options.command || !options.canister) throw new Error("Usage: operator <grant|revoke|list> --canister <feedback-id> [--neutron <neutron-id>] [--cursor <id>] [--host <url>]");
  options.canister = canister(options.canister);
  if (options.command === "list") {
    if (options.neutron) throw new Error("Use --neutron only with grant or revoke.");
  } else {
    if (!options.neutron) throw new Error("Grant and revoke require --neutron.");
    options.neutron = canister(options.neutron);
    if (options.cursor) throw new Error("Use --cursor only with list.");
  }
  if (options.cursor !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(options.cursor) || BigInt(options.cursor) > (1n << 64n) - 1n)) throw new Error("The cursor must be a Nat64 decimal identifier.");
  return options as Options;
}

/** Explicit operator action; no secret export or generic mutation interface. */
export async function runOperator(options: Options, run: Run = runBlast): Promise<unknown> {
  const principal = (await run(["principal", "--id", "0"])).trim();
  if (principal !== ADMINISTRATOR) throw new Error(`Blast identity 0 is ${principal}; this protocol's administrator is ${ADMINISTRATOR}.`);
  const call = async (method: string, args: unknown[]) => JSON.parse(await run([
    "call", options.canister, method, JSON.stringify(args), "--host", options.host, "--id", "0",
  ]));
  const info = await call("feedback_info", []);
  if (info.administrator !== ADMINISTRATOR) throw new Error("This Feedback canister is assigned to a different administrator.");
  const result = options.command === "list"
    ? await call("moderators", [{ cursor: options.cursor === undefined ? null : options.cursor, limit: "30" }])
    : await call("moderator_set", [{ neutron: options.neutron, active: options.command === "grant" }]);
  // Global Blast 4.2 retains lowercase Candid Result variants. The workspace's
  // Blast 4.3 unwraps them (and omits absent record options), so the documented
  // npm command receives a page directly or null for a successful assignment.
  let value = result;
  if (result && typeof result === "object" && Object.keys(result).length === 1) {
    if (Object.hasOwn(result, "err")) {
      if (typeof result.err?.code !== "string" || typeof result.err?.message !== "string") throw new Error("Blast returned an unexpected Feedback result.");
      throw new Error(`${result.err.code}: ${result.err.message}`);
    }
    if (Object.hasOwn(result, "ok")) value = result.ok;
  }
  if (options.command === "list") {
    if (!value || typeof value !== "object" || !Array.isArray(value.items) ||
        (value.nextCursor !== undefined && value.nextCursor !== null &&
          (typeof value.nextCursor !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.nextCursor)))) {
      throw new Error("Blast returned an unexpected Feedback result.");
    }
  } else if (value !== null) throw new Error("Blast returned an unexpected Feedback result.");
  return value;
}

if (import.meta.main) {
  runOperator(parseOptions(process.argv.slice(2))).then(value => {
    console.log(JSON.stringify(value, null, 2));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
