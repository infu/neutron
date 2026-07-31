const DEFAULT_REVOKE_DELAY_MS = 60_000;

export type FilesBlobUrlPort = Readonly<{
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}>;

/**
 * Tracks every private-download URL so authority changes and shutdown revoke
 * them synchronously. A successful browser handoff uses delayed revocation;
 * immediate revocation races the browser's download consumer.
 */
export class FilesBlobUrlRegistry {
  readonly #urls = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor(
    private readonly port: FilesBlobUrlPort = URL,
    private readonly revokeDelayMs = DEFAULT_REVOKE_DELAY_MS,
  ) {
    if (
      !Number.isSafeInteger(revokeDelayMs) ||
      revokeDelayMs < 1_000 ||
      revokeDelayMs > 10 * 60_000
    ) {
      throw new Error("Files Blob URL revocation delay is invalid");
    }
  }

  create(blob: Blob): string {
    const url = this.port.createObjectURL(blob);
    if (typeof url !== "string" || url.length === 0 || this.#urls.has(url)) {
      throw new Error("Files could not allocate a unique Blob URL");
    }
    this.#urls.set(url, null);
    return url;
  }

  releaseAfterHandoff(url: string): void {
    if (!this.#urls.has(url) || this.#urls.get(url) !== null) return;
    const timer = setTimeout(() => this.revoke(url), this.revokeDelayMs);
    this.#urls.set(url, timer);
  }

  revoke(url: string): boolean {
    const timer = this.#urls.get(url);
    if (timer === undefined) return false;
    if (timer !== null) clearTimeout(timer);
    this.#urls.delete(url);
    this.port.revokeObjectURL(url);
    return true;
  }

  revokeAll(): void {
    for (const url of [...this.#urls.keys()]) this.revoke(url);
  }

  get size(): number {
    return this.#urls.size;
  }
}
