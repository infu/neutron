import {
  DerivedPublicKey,
  EncryptedVetKey,
  TransportSecretKey,
  type VetKey,
} from "@dfinity/vetkeys";
import type { VetKeyPublicInfo } from "neutron-tools/app";

const TRANSPORT_PUBLIC_KEY_BYTES = 48;
const REQUEST_NONCE_BYTES = 32;
const ENCRYPTED_VETKEY_BYTES = 192;
const CONTEXT_PUBLIC_KEY_BYTES = 96;
const DERIVATION_INPUT_BYTES = 32;

type OpaqueKeyHandle = VetKey | object;

export type DerivationRequest = {
  transportPublicKey: Uint8Array;
  requestNonce: Uint8Array;
};

export interface OneUseTransport {
  publicKeyBytes(): Uint8Array;
  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): OpaqueKeyHandle;
}

export type DerivationSessionDependencies = {
  createTransport: () => OneUseTransport;
  randomBytes: (length: number) => Uint8Array;
};

class OfficialOneUseTransport implements OneUseTransport {
  #secret: TransportSecretKey | null;
  readonly #publicKey: Uint8Array;

  constructor() {
    this.#secret = TransportSecretKey.random();
    this.#publicKey = fixedBytes(
      this.#secret.publicKeyBytes(),
      TRANSPORT_PUBLIC_KEY_BYTES,
      "transport public key",
    );
  }

  publicKeyBytes(): Uint8Array {
    return this.#publicKey.slice();
  }

  consume(input: {
    encryptedVetKey: Uint8Array;
    contextPublicKey: Uint8Array;
    derivationInput: Uint8Array;
  }): VetKey {
    const secret = this.#secret;
    if (secret === null) throw new Error("Derivation transport was already consumed");
    this.#secret = null;
    return EncryptedVetKey.deserialize(
      fixedBytes(
        input.encryptedVetKey,
        ENCRYPTED_VETKEY_BYTES,
        "encrypted VetKey",
      ),
    ).decryptAndVerify(
      secret,
      DerivedPublicKey.deserialize(
        fixedBytes(
          input.contextPublicKey,
          CONTEXT_PUBLIC_KEY_BYTES,
          "context public key",
        ),
      ),
      fixedBytes(
        input.derivationInput,
        DERIVATION_INPUT_BYTES,
        "derivation input",
      ),
    );
  }
}

const defaultDependencies: DerivationSessionDependencies = {
  createTransport: () => new OfficialOneUseTransport(),
  randomBytes(length) {
    const output = new Uint8Array(length);
    crypto.getRandomValues(output);
    return output;
  },
};

/**
 * Keeps the verified VetKey as an opaque, volatile handle. There is
 * intentionally no getter, serializer, fingerprint, storage, or postMessage
 * projection for the private handle.
 */
export class EphemeralDerivationSession {
  readonly #dependencies: DerivationSessionDependencies;
  #pending: OneUseTransport | null = null;
  #keyHandle: OpaqueKeyHandle | null = null;

  constructor(dependencies: DerivationSessionDependencies = defaultDependencies) {
    this.#dependencies = dependencies;
  }

  get verified(): boolean {
    return this.#keyHandle !== null;
  }

  get pending(): boolean {
    return this.#pending !== null;
  }

  begin(): DerivationRequest {
    if (this.#pending !== null) throw new Error("A derivation is already pending");
    if (this.#keyHandle !== null) throw new Error("The fixture derivation is already verified");
    const transport = this.#dependencies.createTransport();
    const transportPublicKey = fixedBytes(
      transport.publicKeyBytes(),
      TRANSPORT_PUBLIC_KEY_BYTES,
      "transport public key",
    );
    const requestNonce = fixedBytes(
      this.#dependencies.randomBytes(REQUEST_NONCE_BYTES),
      REQUEST_NONCE_BYTES,
      "request nonce",
    );
    this.#pending = transport;
    return {
      transportPublicKey: transportPublicKey.slice(),
      requestNonce: requestNonce.slice(),
    };
  }

  complete(
    encryptedVetKey: readonly number[],
    publicInfo: VetKeyPublicInfo,
  ): void {
    const pending = this.#pending;
    if (pending === null) throw new Error("No fixture derivation is pending");
    // Consume the only fixture reference before verification, so success and
    // every failure are equally non-retryable.
    this.#pending = null;
    this.#keyHandle = pending.consume({
      encryptedVetKey: fixedBytes(
        encryptedVetKey,
        ENCRYPTED_VETKEY_BYTES,
        "encrypted VetKey",
      ),
      contextPublicKey: fixedBytes(
        publicInfo.publicKey,
        CONTEXT_PUBLIC_KEY_BYTES,
        "context public key",
      ),
      derivationInput: fixedBytes(
        publicInfo.derivationInput,
        DERIVATION_INPUT_BYTES,
        "derivation input",
      ),
    });
  }

  cancel(): void {
    this.#pending = null;
  }

  clear(): void {
    this.#pending = null;
    this.#keyHandle = null;
  }
}

function fixedBytes(
  value: ArrayLike<unknown>,
  length: number,
  label: string,
): Uint8Array {
  const bytes = Array.from(value);
  if (
    bytes.length !== length ||
    bytes.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error(`Invalid fixture ${label}`);
  }
  return Uint8Array.from(bytes as number[]);
}
