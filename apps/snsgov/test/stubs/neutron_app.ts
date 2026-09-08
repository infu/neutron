/**
 * Stand-in for `neutron-tools/app` in browser tests.
 *
 * The real module talks to the Kernel over a postMessage bus whose handshake is
 * derived from a gateway-shaped URL, which a local test server cannot present.
 * Aliasing the module is enough: every Kernel touchpoint in the UI goes through
 * these three functions.
 *
 * The canned data is reachable from the page as `window.__snsgovStub` so a test
 * can vary it, and every call is recorded so a test can assert what was sent.
 */

export interface StubState {
  hotkey: { principal: string; can_manage_neuron: boolean };
  snses: {
    sns: string;
    governance: string;
    voting_enabled: boolean;
    agent_voting_enabled: boolean;
    label_text: string;
  }[];
  calls: { method: string; args: unknown[] }[];
}

declare global {
  interface Window {
    __snsgovStub: StubState;
  }
}

function state(): StubState {
  if (!window.__snsgovStub) {
    window.__snsgovStub = {
      hotkey: { principal: "aaaaa-aa", can_manage_neuron: true },
      snses: [],
      calls: [],
    };
  }
  return window.__snsgovStub;
}

export async function querySelf<T>(method: string, args: unknown[] = []): Promise<T> {
  const current = state();
  current.calls.push({ method, args });
  if (method === "snsgov_hotkey") return current.hotkey as T;
  if (method === "snsgov_config") return { snses: current.snses } as T;
  return {} as T;
}

export async function updateSelf<T>(method: string, args: unknown[] = []): Promise<T> {
  const current = state();
  current.calls.push({ method, args });
  if (method === "snsgov_sns_upsert") {
    const row = args[0] as StubState["snses"][number];
    const at = current.snses.findIndex((entry) => entry.sns === row.sns);
    if (at >= 0) current.snses[at] = row;
    else current.snses.push(row);
    return {} as T;
  }
  if (method === "snsgov_sns_remove") {
    const sns = args[0] as string;
    current.snses = current.snses.filter((entry) => entry.sns !== sns);
    return {} as T;
  }
  return {} as T;
}

export async function copyToClipboard(value: string): Promise<void> {
  state().calls.push({ method: "copyToClipboard", args: [value] });
}
