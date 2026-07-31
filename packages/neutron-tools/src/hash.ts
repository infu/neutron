import { sha256 } from "js-sha256";

export type HashableContent =
  | string
  | ArrayBuffer
  | Uint8Array
  | ArrayLike<number>;

export function hashContent(content: HashableContent): string {
  const hash = sha256.create();
  hash.update(normalizeHashContent(content));
  return hash.hex();
}

function normalizeHashContent(
  content: HashableContent
): string | number[] | ArrayBuffer | Uint8Array {
  if (
    typeof content === "string" ||
    content instanceof ArrayBuffer ||
    content instanceof Uint8Array
  ) {
    return content;
  }

  return Array.from(content);
}
