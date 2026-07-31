import { Ed25519KeyIdentity } from "@dfinity/identity";
import { activateIdentity, useAuthStore } from "./reducer/auth.ts";
import { getRuntimeDeployment } from "./runtime_deployment.ts";

async function loginLocalPlaywright(
  identitySeed: number,
): Promise<string> {
  const deployment = getRuntimeDeployment();
  if (
    deployment.target !== "pocketic" ||
    !isLocalBrowserHost(window.location.hostname)
  ) {
    throw new Error(
      "The Playwright identity is available only in loopback PocketIC",
    );
  }
  if (
    !Number.isInteger(identitySeed) ||
    identitySeed < 0 ||
    identitySeed > 255
  ) {
    throw new Error(
      "The local Playwright identity seed must be an integer from 0 to 255",
    );
  }

  const seed = new Uint8Array(32);
  seed[31] = identitySeed;
  await activateIdentity(Ed25519KeyIdentity.generate(seed), true);

  const state = useAuthStore.getState();
  if (!state.authorized) {
    throw new Error(
      `Local Playwright principal ${state.principal} is not authorized`,
    );
  }
  return state.principal;
}

function isLocalBrowserHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

declare global {
  interface Window {
    __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (
      identitySeed: number,
    ) => Promise<string>;
  }
}

if (
  getRuntimeDeployment().target === "pocketic" &&
  isLocalBrowserHost(window.location.hostname)
) {
  Object.defineProperty(window, "__NEUTRON_PLAYWRIGHT_LOGIN_AS__", {
    configurable: false,
    enumerable: false,
    value: (identitySeed: number) => loginLocalPlaywright(identitySeed),
    writable: false,
  });
}
