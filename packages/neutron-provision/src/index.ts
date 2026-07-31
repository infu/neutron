#!/usr/bin/env bun

import { main } from "./cli.ts";

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main } from "./cli.ts";
export { runAdopt } from "./adopt.ts";
export * from "./deployed_kernel_observation.ts";
export * from "./deployment_evidence.ts";
export * from "./ic_registry_evidence.ts";
export { runProvision } from "./provision.ts";
export { runReinstall } from "./reinstall.ts";
