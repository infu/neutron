import {
  COMMON_VALUE_FLAGS,
  createCliContext,
  failCli,
  parseArguments,
  printJson,
} from "../src/cli.ts";
import { publishPackageFiles } from "../src/publish.ts";

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2), {
    valueFlags: COMMON_VALUE_FLAGS,
  });
  if (parsed.positional.length < 1) {
    throw new Error("Publish requires one or more .neutron package files");
  }
  const { canisterId, origin, port } = await createCliContext(parsed, {
    requireIdentity: true,
  });
  const receipt = await publishPackageFiles(parsed.positional, {
    canisterId,
    origin,
    port,
    progress: (message) => process.stderr.write(`${message}\n`),
  });
  printJson(receipt);
}

main().catch(failCli);
