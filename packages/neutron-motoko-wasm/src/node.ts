export function compilerAssetDirectory(): string {
  return new URL("../compiler", import.meta.url).pathname;
}
