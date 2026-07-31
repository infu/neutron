import {
  isPlainStorageRootedInput,
  normalizePlainFilesPath,
  validatePlainFilesName,
} from "../protocol/plain_paths.ts";
import {
  filesPathRoutingMode,
  type FilesPathRouting,
} from "./path_routing.ts";
import {
  normalizeFilesPath,
  validateFilesName,
} from "./paths.ts";

export function normalizeFilesPathForRouting(
  input: string,
  routing?: FilesPathRouting,
): string {
  if (
    filesPathRoutingMode(routing) === "policy_v3" &&
    isPlainStorageRootedInput(input)
  ) {
    return normalizePlainFilesPath(input).path;
  }
  return normalizeFilesPath(input).path;
}

export function normalizeFilesPolicyPath(input: string): string {
  return isPlainStorageRootedInput(input)
    ? normalizePlainFilesPath(input).path
    : normalizeFilesPath(input).path;
}

export function validateFilesNameForFolder(
  folderPath: string,
  name: string,
  routing?: FilesPathRouting,
): string {
  if (
    filesPathRoutingMode(routing) === "policy_v3" &&
    isPlainStorageRootedInput(folderPath)
  ) {
    return validatePlainFilesName(name);
  }
  return validateFilesName(name);
}

export function validateFilesPolicyName(
  folderPath: string,
  name: string,
): string {
  return isPlainStorageRootedInput(folderPath)
    ? validatePlainFilesName(name)
    : validateFilesName(name);
}
