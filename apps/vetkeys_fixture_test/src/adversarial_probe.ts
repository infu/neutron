import {
  approveVetKeyDerivation,
  deriveVetKey,
  exec,
  getVetKeyPublicKey,
  isVetKeysError,
  listVetKeys,
  type VetKeyDeriveChallenge,
  type VetKeyDeriveOptions,
  type VetKeyDeriveRequest,
  type VetKeyDeriveResult,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/app";
import { EphemeralDerivationSession } from "./derivation_session";
import {
  FIXTURE_SLOT,
  createSafePublicEvidence,
  fixtureSlot,
  isFixtureAppId,
  samePublicBinding,
  type FixtureAppId,
  type SafePublicEvidence,
} from "./evidence";

const CHALLENGE_WAIT_MS = 15_000;

type JsonPayload = Record<string, string | number | boolean | null | number[]>;

export type RejectionEvidence = {
  operation: string;
  rejected: boolean;
  code: string | null;
  message: string;
};

export const INJECTED_PEER_OPERATIONS = [
  "list",
  "publicKey",
  "derive.begin",
  "lifecycle.enable",
  "lifecycle.disable",
  "lifecycle.rotate",
  "lifecycle.retireGeneration",
  "lifecycle.transfer",
  "lifecycle.retireSlot",
] as const;

export type FixtureProbeChallenge = {
  appId: FixtureAppId;
  challengeId: string;
  expiresAt: string;
};

export type FixtureProbeDependencies = {
  list(): Promise<{ slots: VetKeySlotSummary[] }>;
  publicKey(request: {
    slot: string;
    generation: string;
  }): Promise<VetKeyPublicInfo>;
  derive(
    request: VetKeyDeriveRequest,
    options: VetKeyDeriveOptions,
  ): Promise<VetKeyDeriveResult>;
  approve(challengeId: string): Promise<void>;
  raw(action: string, payload: JsonPayload): Promise<unknown>;
  createSession(): EphemeralDerivationSession;
};

type PendingDerivation = {
  expected: VetKeyPublicInfo;
  session: EphemeralDerivationSession;
  challengeId: string | null;
  result: Promise<VetKeyDeriveResult>;
};

const defaultDependencies: FixtureProbeDependencies = {
  list: () => listVetKeys(),
  publicKey: (request) => getVetKeyPublicKey(request),
  derive: (request, options) => deriveVetKey(request, options),
  approve: (challengeId) => approveVetKeyDerivation({ challengeId }),
  raw: (action, payload) => exec(action, payload, 10),
  createSession: () => new EphemeralDerivationSession(),
};

/** Local installed-app proof surface. It never returns encrypted or private key bytes. */
export class InstalledOriginProbe {
  readonly #appId: FixtureAppId;
  readonly #dependencies: FixtureProbeDependencies;
  #pending: PendingDerivation | null = null;

  constructor(
    appId: FixtureAppId,
    dependencies: FixtureProbeDependencies = defaultDependencies,
  ) {
    this.#appId = appId;
    this.#dependencies = dependencies;
  }

  identity(): { appId: FixtureAppId; slot: typeof FIXTURE_SLOT } {
    return { appId: this.#appId, slot: FIXTURE_SLOT };
  }

  async injectPeerAppId(peerAppId: FixtureAppId): Promise<RejectionEvidence[]> {
    this.#assertPeer(peerAppId);
    const current = await this.#enabledSlot();
    const injected = { appId: peerAppId };
    const attempts: Array<{
      operation: string;
      action: string;
      payload: JsonPayload;
    }> = [
      {
        operation: "list",
        action: "vetkeys.list",
        payload: injected,
      },
      {
        operation: "publicKey",
        action: "vetkeys.publicKey",
        payload: {
          ...injected,
          slot: FIXTURE_SLOT,
          generation: current.currentGeneration,
        },
      },
      {
        operation: "derive.begin",
        action: "vetkeys.derive.begin",
        payload: {
          ...injected,
          slot: FIXTURE_SLOT,
          generation: current.currentGeneration,
          transportPublicKey: Array.from({ length: 48 }, () => 7),
          requestNonce: Array.from({ length: 32 }, () => 11),
        },
      },
      ...(["enable", "disable", "rotate"] as const).map((action) => ({
        operation: `lifecycle.${action}`,
        action: "vetkeys.request",
        payload: { ...injected, action, slot: FIXTURE_SLOT },
      })),
      {
        operation: "lifecycle.retireGeneration",
        action: "vetkeys.request",
        payload: {
          ...injected,
          action: "retireGeneration",
          slot: FIXTURE_SLOT,
          generation: current.previousGeneration ?? current.currentGeneration,
        },
      },
      {
        operation: "lifecycle.transfer",
        action: "vetkeys.request",
        payload: {
          ...injected,
          action: "transfer",
          slot: FIXTURE_SLOT,
          newHolder: current.keyHolder,
        },
      },
      {
        operation: "lifecycle.retireSlot",
        action: "vetkeys.request",
        payload: { ...injected, action: "retireSlot", slot: FIXTURE_SLOT },
      },
    ];
    const results: RejectionEvidence[] = [];
    for (const attempt of attempts) {
      results.push(await this.#rejection(attempt.operation, () =>
        this.#dependencies.raw(attempt.action, attempt.payload),
      ));
    }
    return results;
  }

  async beginOwnDerivation(): Promise<FixtureProbeChallenge> {
    if (this.#pending !== null) {
      throw new Error("Fixture proof already has a pending derivation");
    }
    const current = await this.#enabledSlot();
    const expected = await this.#dependencies.publicKey({
      slot: FIXTURE_SLOT,
      generation: current.currentGeneration,
    });
    const session = this.#dependencies.createSession();
    const transport = session.begin();

    let deliverChallenge!: (challenge: VetKeyDeriveChallenge) => void;
    let rejectChallenge!: (error: Error) => void;
    const challenge = new Promise<VetKeyDeriveChallenge>((resolve, reject) => {
      deliverChallenge = resolve;
      rejectChallenge = reject;
    });
    let acceptResult!: (result: VetKeyDeriveResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<VetKeyDeriveResult>((resolve, reject) => {
      acceptResult = resolve;
      rejectResult = reject;
    });
    const pending: PendingDerivation = {
      expected,
      session,
      challengeId: null,
      result,
    };
    this.#pending = pending;
    void result.catch(() => undefined);

    void this.#dependencies.derive(
      {
        slot: FIXTURE_SLOT,
        generation: current.currentGeneration,
        transportPublicKey: transport.transportPublicKey,
        requestNonce: transport.requestNonce,
      },
      {
        timeout: 90,
        onChallenge: (next) => {
          if (this.#pending !== pending || pending.challengeId !== null) {
            rejectChallenge(new Error("Invalid fixture challenge sequence"));
            return;
          }
          pending.challengeId = next.challengeId;
          deliverChallenge(next);
        },
      },
    ).then(acceptResult, (reason) => {
      const error = asError(reason);
      rejectResult(error);
      rejectChallenge(error);
    });

    try {
      const next = await withTimeout(challenge, CHALLENGE_WAIT_MS);
      return {
        appId: this.#appId,
        challengeId: next.challengeId,
        expiresAt: next.expiresAt,
      };
    } catch (error) {
      if (this.#pending === pending) this.#pending = null;
      session.cancel();
      throw error;
    }
  }

  rejectForeignChallenge(challengeId: string): Promise<RejectionEvidence> {
    return this.#rejection("foreignChallenge.confirm", () =>
      this.#dependencies.approve(challengeId),
    );
  }

  async confirmOwnDerivation(challengeId: string): Promise<SafePublicEvidence> {
    const pending = this.#pending;
    if (pending === null || pending.challengeId !== challengeId) {
      throw new Error("Challenge does not belong to this fixture endpoint");
    }
    try {
      await this.#dependencies.approve(challengeId);
      const derived = await pending.result;
      if (!samePublicBinding(derived.publicInfo, pending.expected)) {
        throw new Error("Fixture binding changed during installed proof");
      }
      pending.session.complete(derived.encryptedKey, derived.publicInfo);
      return createSafePublicEvidence(derived.publicInfo, this.#appId);
    } finally {
      pending.session.clear();
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async #enabledSlot(): Promise<VetKeySlotSummary> {
    const current = fixtureSlot((await this.#dependencies.list()).slots);
    if (current === null || current.status !== "enabled") {
      throw new Error(`${this.#appId}/mailbox must already be reserved and enabled`);
    }
    if (current.environment !== "local") {
      throw new Error(`${this.#appId}/mailbox must use the local environment`);
    }
    const generation = current.generations.find(
      (candidate) => candidate.generation === current.currentGeneration,
    );
    if (!generation || generation.keyName !== "test_key_1") {
      throw new Error(`${this.#appId}/mailbox must use test_key_1`);
    }
    return current;
  }

  async #rejection(
    operation: string,
    attempt: () => Promise<unknown>,
  ): Promise<RejectionEvidence> {
    try {
      await attempt();
      return {
        operation,
        rejected: false,
        code: null,
        message: "Unexpectedly accepted",
      };
    } catch (reason) {
      return {
        operation,
        rejected: true,
        code: isVetKeysError(reason) ? reason.code : null,
        message: asError(reason).message,
      };
    }
  }

  #assertPeer(peerAppId: FixtureAppId): void {
    if (!isFixtureAppId(peerAppId) || peerAppId === this.#appId) {
      throw new Error("Installed proof requires the other exact fixture app id");
    }
  }
}

export type InstalledOriginProbeApi = Pick<
  InstalledOriginProbe,
  | "identity"
  | "injectPeerAppId"
  | "beginOwnDerivation"
  | "rejectForeignChallenge"
  | "confirmOwnDerivation"
>;

declare global {
  interface Window {
    __NEUTRON_VETKEYS_FIXTURE_PROBE_V1__?: InstalledOriginProbeApi;
  }
}

export function installLocalOriginProbe(appId: FixtureAppId): void {
  if (!isLoopbackBrowserHost(window.location.hostname)) return;
  const probe = new InstalledOriginProbe(appId);
  Object.defineProperty(window, "__NEUTRON_VETKEYS_FIXTURE_PROBE_V1__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      identity: () => probe.identity(),
      injectPeerAppId: (peerAppId: FixtureAppId) =>
        probe.injectPeerAppId(peerAppId),
      beginOwnDerivation: () => probe.beginOwnDerivation(),
      rejectForeignChallenge: (challengeId: string) =>
        probe.rejectForeignChallenge(challengeId),
      confirmOwnDerivation: (challengeId: string) =>
        probe.confirmOwnDerivation(challengeId),
    }),
  });
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]"
  );
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for the source-bound challenge"));
    }, milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
