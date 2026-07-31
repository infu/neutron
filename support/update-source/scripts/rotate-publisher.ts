import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
} from "../src/cli.ts";
import { rotatePublisher } from "../src/permissions.ts";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2), {
    valueFlags: COMMON_VALUE_FLAGS,
  });
  if (parsed.positional.length !== 2) {
    throw new Error("Expected old and new publisher principals");
  }
  const { canisterId, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  const status = await rotatePublisher(
    port,
    parsed.positional[0]!,
    parsed.positional[1]!,
  );
  printJson({ canister_id: canisterId, action: "rotated", status });
}

main().catch(failCli);
