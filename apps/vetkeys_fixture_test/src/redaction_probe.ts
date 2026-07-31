import {
  DerivedPublicKey,
  EncryptedVetKey,
  TransportSecretKey,
} from "@dfinity/vetkeys";
import {
  approveVetKeyDerivation,
  deriveVetKey,
  getVetKeyPublicKey,
  isVetKeysError,
  listVetKeys,
  type VetKeyDeriveChallenge,
  type VetKeyDeriveResult,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/app";
import {
  FIXTURE_SLOT,
  fixtureSlot,
  isFixtureAppId,
  samePublicBinding,
  type FixtureAppId,
} from "./evidence";

const TRANSPORT_SECRET_BYTES = 32;
const TRANSPORT_PUBLIC_KEY_BYTES = 48;
const REQUEST_NONCE_BYTES = 32;
const ENCRYPTED_VETKEY_BYTES = 192;
const DERIVED_PRIVATE_KEY_BYTES = 48;
const CONTEXT_PUBLIC_KEY_BYTES = 96;
const DERIVATION_INPUT_BYTES = 32;
const MAX_APP_PLAINTEXT_BYTES = 256;

type RedactionSuccessInput = {
  appPlaintext: string;
  requestNonce: number[];
  transportSecret: number[];
};

type RedactionFailureInput = {
  requestNonce: number[];
  transportPublicKey: number[];
};

export type RedactionSuccessEvidence = {
  appId: FixtureAppId;
  appPlaintext: string;
  challengeId: string;
  derivedPrivateKey: number[];
  encryptedKey: number[];
  requestNonce: number[];
  transportPublicKey: number[];
  transportPublicKeyHash: number[];
  transportSecret: number[];
  publicInfo: VetKeyPublicInfo;
};

export type RedactionFailureEvidence = {
  appId: FixtureAppId;
  canonicalCode: "management_failure";
  canonicalMessage: string;
  challengeId: string;
  requestNonce: number[];
  transportPublicKey: number[];
};

type RedactionProbeApi = {
  runFailure(input: RedactionFailureInput): Promise<RedactionFailureEvidence>;
  runSuccess(input: RedactionSuccessInput): Promise<RedactionSuccessEvidence>;
};

declare global {
  interface Window {
    __NEUTRON_VETKEYS_REDACTION_PROBE_V1__?: RedactionProbeApi;
  }
}

/**
 * Install a deliberately sharp proof surface only on a loopback fixture
 * origin. The fixture is not a product app: this method exists so the local
 * verifier can name exact volatile bytes and prove they never entered a
 * persistent/kernel projection. No production hostname receives the export.
 */
export function installLocalRedactionProbe(appId: FixtureAppId): void {
  if (!isFixtureAppId(appId) || !isLoopbackBrowserHost(window.location.hostname)) {
    return;
  }
  const probe = new LocalRedactionProbe(appId);
  Object.defineProperty(window, "__NEUTRON_VETKEYS_REDACTION_PROBE_V1__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      runFailure: (input: RedactionFailureInput) => probe.runFailure(input),
      runSuccess: (input: RedactionSuccessInput) => probe.runSuccess(input),
    }),
  });
}

class LocalRedactionProbe {
  readonly #appId: FixtureAppId;
  #running = false;

  constructor(appId: FixtureAppId) {
    this.#appId = appId;
  }

  async runSuccess(input: RedactionSuccessInput): Promise<RedactionSuccessEvidence> {
    return this.#exclusive(async () => {
      const appPlaintext = exactPlaintext(input.appPlaintext);
      const transportSecret = exactBytes(
        input.transportSecret,
        TRANSPORT_SECRET_BYTES,
        "transport secret",
      );
      const requestNonce = exactBytes(
        input.requestNonce,
        REQUEST_NONCE_BYTES,
        "request nonce",
      );
      const transport = TransportSecretKey.deserialize(transportSecret);
      const transportPublicKey = exactBytes(
        transport.publicKeyBytes(),
        TRANSPORT_PUBLIC_KEY_BYTES,
        "transport public key",
      );
      const current = await enabledSlot(this.#appId);
      const publicInfo = await getVetKeyPublicKey({
        slot: FIXTURE_SLOT,
        generation: current.currentGeneration,
      });
      const { challengeId, result } = await deriveAndApprove({
        generation: current.currentGeneration,
        requestNonce,
        transportPublicKey,
      });
      if (!samePublicBinding(result.publicInfo, publicInfo)) {
        throw new Error("Redaction proof binding changed during derivation");
      }
      const encryptedKey = exactBytes(
        result.encryptedKey,
        ENCRYPTED_VETKEY_BYTES,
        "encrypted VetKey",
      );
      const derivedPrivateKey = exactBytes(
        EncryptedVetKey.deserialize(encryptedKey).decryptAndVerify(
          transport,
          DerivedPublicKey.deserialize(exactBytes(
            result.publicInfo.publicKey,
            CONTEXT_PUBLIC_KEY_BYTES,
            "context public key",
          )),
          exactBytes(
            result.publicInfo.derivationInput,
            DERIVATION_INPUT_BYTES,
            "derivation input",
          ),
        ).serialize(),
        DERIVED_PRIVATE_KEY_BYTES,
        "derived private key",
      );
      const transportPublicKeyHash = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        transportPublicKey.slice().buffer as ArrayBuffer,
      ));

      // All exact secret/transient values cross only the Playwright evaluation
      // boundary back to the local verifier. They are never posted to another
      // app, logged, placed in DOM/storage, or sent to a fixture backend.
      return {
        appId: this.#appId,
        appPlaintext,
        challengeId,
        derivedPrivateKey: Array.from(derivedPrivateKey),
        encryptedKey: Array.from(encryptedKey),
        requestNonce: Array.from(requestNonce),
        transportPublicKey: Array.from(transportPublicKey),
        transportPublicKeyHash: Array.from(transportPublicKeyHash),
        transportSecret: Array.from(transportSecret),
        publicInfo,
      };
    });
  }

  async runFailure(input: RedactionFailureInput): Promise<RedactionFailureEvidence> {
    return this.#exclusive(async () => {
      const transportPublicKey = exactBytes(
        input.transportPublicKey,
        TRANSPORT_PUBLIC_KEY_BYTES,
        "invalid transport public key",
      );
      const requestNonce = exactBytes(
        input.requestNonce,
        REQUEST_NONCE_BYTES,
        "failure request nonce",
      );
      const current = await enabledSlot(this.#appId);
      let challengeId = "";
      try {
        const outcome = await deriveAndApprove({
          generation: current.currentGeneration,
          requestNonce,
          transportPublicKey,
        });
        challengeId = outcome.challengeId;
        throw new Error("Invalid transport public key was unexpectedly accepted");
      } catch (reason) {
        const tagged = reason as Error & { fixtureChallengeId?: string };
        challengeId = tagged.fixtureChallengeId ?? challengeId;
        if (
          !challengeId ||
          !isVetKeysError(reason) ||
          reason.code !== "management_failure"
        ) {
          throw reason;
        }
        return {
          appId: this.#appId,
          canonicalCode: "management_failure",
          canonicalMessage: reason.message,
          challengeId,
          requestNonce: Array.from(requestNonce),
          transportPublicKey: Array.from(transportPublicKey),
        };
      }
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#running) throw new Error("Redaction proof operation already running");
    this.#running = true;
    try {
      return await operation();
    } finally {
      this.#running = false;
    }
  }
}

async function deriveAndApprove(input: {
  generation: string;
  requestNonce: Uint8Array;
  transportPublicKey: Uint8Array;
}): Promise<{ challengeId: string; result: VetKeyDeriveResult }> {
  let challengeId = "";
  let approveFailure: unknown = null;
  const result = await deriveVetKey(
    {
      slot: FIXTURE_SLOT,
      generation: input.generation,
      transportPublicKey: input.transportPublicKey,
      requestNonce: input.requestNonce,
    },
    {
      timeout: 90,
      onChallenge: (challenge: VetKeyDeriveChallenge) => {
        if (challengeId !== "") {
          approveFailure = new Error("Redaction proof received duplicate challenge");
          return;
        }
        challengeId = challenge.challengeId;
        void approveVetKeyDerivation({ challengeId }).catch((error) => {
          approveFailure = error;
        });
      },
    },
  ).catch((reason) => {
    if (reason instanceof Error && challengeId) {
      Object.defineProperty(reason, "fixtureChallengeId", {
        configurable: false,
        enumerable: false,
        value: challengeId,
        writable: false,
      });
    }
    throw reason;
  });
  if (approveFailure !== null) throw approveFailure;
  if (!challengeId) throw new Error("Redaction derivation omitted its challenge");
  return { challengeId, result };
}

async function enabledSlot(appId: FixtureAppId): Promise<VetKeySlotSummary> {
  const current = fixtureSlot((await listVetKeys()).slots);
  if (
    current === null ||
    current.status !== "enabled" ||
    current.environment !== "local" ||
    current.generations.find(
      (candidate) => candidate.generation === current.currentGeneration,
    )?.keyName !== "test_key_1"
  ) {
    throw new Error(`${appId}/mailbox must be enabled on test_key_1`);
  }
  return current;
}

function exactPlaintext(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 48 ||
    new TextEncoder().encode(value).byteLength > MAX_APP_PLAINTEXT_BYTES ||
    !/^[A-Z0-9-]+$/u.test(value)
  ) {
    throw new Error("Redaction app plaintext must be 48–256 uppercase ASCII bytes");
  }
  return value;
}

function exactBytes(
  value: ArrayLike<unknown>,
  length: number,
  label: string,
): Uint8Array {
  const bytes = Array.from(value);
  if (
    bytes.length !== length ||
    bytes.some((byte) =>
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
  ) {
    throw new Error(`Invalid redaction ${label}`);
  }
  return Uint8Array.from(bytes as number[]);
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]";
}
