import {
  approveVetKeyDerivation,
  deriveVetKey,
  getVetKeyPublicKey,
  listVetKeys,
} from "neutron-tools/app";
import type {
  VetKeyDeriveChallenge,
  VetKeyDeriveResult,
  VetKeyPublicInfo,
  VetKeysLifecycleRequest,
  VetKeysLifecycleResult,
} from "neutron-tools/app";
import type { FilesVetKeysPort } from "./types.ts";

export const DEFAULT_FILES_VETKEYS_PORT: FilesVetKeysPort = Object.freeze({
  list: () => listVetKeys(),
  request: (
    _request: VetKeysLifecycleRequest,
  ): Promise<VetKeysLifecycleResult> =>
    Promise.reject(
      new Error(
        "Files VetKey lifecycle changes require a focused app tile",
      ),
    ),
  publicKey: (
    request: { slot: string; generation: string },
  ): Promise<VetKeyPublicInfo> => getVetKeyPublicKey(request),
  derive: (
    request: {
      slot: string;
      generation: string;
      transportPublicKey: Uint8Array;
      requestNonce: Uint8Array;
    },
    options: {
      timeout: number;
      onChallenge: (challenge: VetKeyDeriveChallenge) => void;
    },
  ): Promise<VetKeyDeriveResult> => deriveVetKey(request, options),
  approve: (challengeId: string): Promise<void> =>
    approveVetKeyDerivation({ challengeId }),
});
