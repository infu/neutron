import type { FilesResidentFilePort } from "./service_contract.ts";
import { DefaultFilesPlainPort } from "./plain_port.ts";
import { FilesRootedResidentPort } from "./rooted_port.ts";
import {
  createDefaultFilesResidentPort as createVaultResidentPort,
} from "../vault/resident_port.ts";

/**
 * The service boundary is a thin typed adapter; all crypto, backend, transfer,
 * and reconciliation work is owned by the concrete vault resident port.
 */
export function createDefaultFilesResidentPort(): FilesResidentFilePort {
  return new FilesRootedResidentPort({
    vault: createVaultResidentPort(),
    plain: new DefaultFilesPlainPort(),
  });
}
