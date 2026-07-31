const ABSOLUTE_WAGYU_RESPONSE_BYTES = 1_048_576;
const MAX_WAGYU_RESPONSE_CHUNKS = 4_096;

/**
 * Reads a Fetch response without ever copying more than `maximumBytes`.
 *
 * Do not replace this with `arrayBuffer()`: neither a missing nor a dishonest
 * Content-Length header is allowed to turn a trusted-runtime or certified
 * object read into an unbounded allocation.
 */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  label = "Response",
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > ABSOLUTE_WAGYU_RESPONSE_BYTES
  ) {
    throw new Error(`${label} has an invalid byte limit`);
  }
  if (response.body === null) return new Uint8Array(0);

  const reader = response.body.getReader();
  const body = new Uint8Array(maximumBytes);
  let length = 0;
  let chunkCount = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      chunkCount += 1;
      if (chunkCount > MAX_WAGYU_RESPONSE_CHUNKS) {
        cancelWithoutWaiting(reader, `${label} chunk limit exceeded`);
        throw new Error(`${label} has too many stream chunks`);
      }
      if (!(next.value instanceof Uint8Array)) {
        cancelWithoutWaiting(reader, `${label} yielded non-byte data`);
        throw new Error(`${label} stream yielded non-byte data`);
      }
      if (next.value.byteLength === 0) continue;
      if (next.value.byteLength > maximumBytes - length) {
        cancelWithoutWaiting(reader, `${label} byte limit exceeded`);
        throw new Error(`${label} exceeds ${maximumBytes} bytes`);
      }
      body.set(next.value, length);
      length += next.value.byteLength;
    }
  } catch (error) {
    if (!complete) cancelWithoutWaiting(reader, `${label} read failed`);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return length === maximumBytes ? body : body.slice(0, length);
}

function cancelWithoutWaiting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): void {
  try {
    // Awaiting cancellation can deadlock when a hostile caller has tee'd the
    // stream and left the other branch unread. Initiating cancellation is
    // sufficient; the bounded reader retains no reference to the stream.
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort after the response has already failed shut.
  }
}
