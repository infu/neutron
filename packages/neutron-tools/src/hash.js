import { sha256 } from "js-sha256";

export function hashContent(content) {
  const hash = sha256.create();
  hash.update(content);
  return hash.hex();
}
