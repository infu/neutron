import { FILES_V2_LIMITS } from "../protocol/constants.ts";

export type FilesMetadataLruOptions<Key, Value> = Readonly<{
  maxEntries?: number;
  maxBytes?: number;
  onEvict?: (key: Key, value: Value) => void;
}>;

export type FilesMetadataLruStats = Readonly<{
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
}>;

type MetadataEntry<Value> = {
  value: Value;
  bytes: number;
};

export class FilesMetadataLruError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesMetadataLruError";
  }
}
/** Volatile-only, size-accounted LRU for decrypted metadata. */
export class FilesMetadataLru<Key, Value> {
  readonly #entries = new Map<Key, MetadataEntry<Value>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #onEvict: ((key: Key, value: Value) => void) | undefined;
  #bytes = 0;

  constructor(options: FilesMetadataLruOptions<Key, Value> = {}) {
    this.#maxEntries = positiveInteger(
      options.maxEntries ?? FILES_V2_LIMITS.metadataLruEntries,
      "metadata LRU entry cap",
    );
    this.#maxBytes = positiveInteger(
      options.maxBytes ?? FILES_V2_LIMITS.metadataLruBytes,
      "metadata LRU byte cap",
    );
    this.#onEvict = options.onEvict;
  }

  get(key: Key): Value | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  peek(key: Key): Value | undefined {
    return this.#entries.get(key)?.value;
  }

  has(key: Key): boolean {
    return this.#entries.has(key);
  }

  set(key: Key, value: Value, bytes: number): readonly Key[] {
    const size = nonnegativeInteger(bytes, "metadata LRU entry size");
    if (size > this.#maxBytes) {
      throw new FilesMetadataLruError(
        "A metadata entry exceeds the complete LRU byte cap",
      );
    }
    const evicted: Key[] = [];
    const previous = this.#entries.get(key);
    if (previous) {
      this.#entries.delete(key);
      this.#bytes -= previous.bytes;
    }
    this.#entries.set(key, { value, bytes: size });
    this.#bytes += size;
    while (
      this.#entries.size > this.#maxEntries ||
      this.#bytes > this.#maxBytes
    ) {
      const oldest = this.#entries.entries().next().value as
        | [Key, MetadataEntry<Value>]
        | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
      evicted.push(oldest[0]);
      this.#onEvict?.(oldest[0], oldest[1].value);
    }
    return evicted;
  }

  delete(key: Key): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    this.#onEvict?.(key, entry.value);
    return true;
  }

  clear(): void {
    if (this.#onEvict) {
      for (const [key, entry] of this.#entries) {
        this.#onEvict(key, entry.value);
      }
    }
    this.#entries.clear();
    this.#bytes = 0;
  }

  stats(): FilesMetadataLruStats {
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxEntries: this.#maxEntries,
      maxBytes: this.#maxBytes,
    });
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FilesMetadataLruError(`${label} must be a positive integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FilesMetadataLruError(`${label} must be a nonnegative integer`);
  }
  return value;
}
