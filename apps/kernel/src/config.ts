import { getRuntimeDeployment } from "./runtime_deployment.ts";

export function getNeutronId(): string {
  return getRuntimeDeployment().canisterId;
}
