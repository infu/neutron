import type {
  QuickJSContext,
  QuickJSHandle,
} from "quickjs-emscripten-core";

// Two UTF-16 code units per Unicode scalar is the largest possible expansion.
// This keeps every copied host string bounded while preserving enough source
// text for boundedError's 1,000-scalar diagnostic.
const ERROR_TEXT_CODE_UNITS = 2_000;
const QUICKJS_MEMORY_FAILURE =
  /out of bounds memory access|memory access out of bounds|out of memory|allocation/u;

export function isQuickJSMemoryFailure(message: string): boolean {
  return QUICKJS_MEMORY_FAILURE.test(message.toLowerCase());
}

const ERROR_EXTRACTOR_SOURCE = String.raw`
(() => {
  const jsonStringify = JSON.stringify;
  const numberIsSafeInteger = Number.isSafeInteger;
  const stringSlice = Function.prototype.call.bind(String.prototype.slice);
  const readText = (value, key) => {
    try {
      const candidate = value === null || value === undefined
        ? undefined
        : value[key];
      return typeof candidate === "string"
        ? stringSlice(candidate, 0, ${ERROR_TEXT_CODE_UNITS})
        : null;
    } catch (_error) {
      return null;
    }
  };
  const readPosition = (value) => {
    try {
      const candidate = value === null || value === undefined
        ? undefined
        : value.position;
      return numberIsSafeInteger(candidate) && candidate >= 0
        ? candidate
        : null;
    } catch (_error) {
      return null;
    }
  };
  return (value) => jsonStringify([
    readText(value, "name"),
    readText(value, "message"),
    readText(value, "code"),
    readPosition(value),
  ]);
})()
`;

export type BoundedGuestError = Readonly<{
  name: string | null;
  message: string | null;
  code: string | null;
  position: number | null;
}>;

/** Compile one host-retained extractor before untrusted code can alter intrinsics. */
export function createGuestErrorExtractor(
  context: QuickJSContext,
): QuickJSHandle {
  const evaluated = context.evalCode(
    ERROR_EXTRACTOR_SOURCE,
    "blast-error-extractor.js",
    { type: "global", strict: true, backtraceBarrier: true },
  );
  if (evaluated.error) {
    evaluated.error.dispose();
    throw new Error("QuickJS error extractor failed to initialize");
  }
  return evaluated.value;
}

/**
 * Extract only a small trusted JSON tuple from QuickJS. The original error may
 * contain multi-megabyte strings or hostile accessors, neither of which is
 * copied into the browser host realm.
 */
export function extractGuestError(
  context: QuickJSContext,
  extractor: QuickJSHandle,
  error: QuickJSHandle,
): BoundedGuestError {
  let extracted: ReturnType<QuickJSContext["callFunction"]>;
  try {
    extracted = context.callFunction(
      extractor,
      context.undefined,
      error,
    );
  } catch {
    return EMPTY_GUEST_ERROR;
  }
  if (extracted.error) {
    // A failed extractor generally means the runtime was interrupted or
    // exhausted. Its one-shot Worker owns reclamation; touching that handle
    // again can enter QuickJS teardown on already-unsafe state.
    return EMPTY_GUEST_ERROR;
  }
  try {
    if (context.typeof(extracted.value) !== "string") {
      return EMPTY_GUEST_ERROR;
    }
    const parsed: unknown = JSON.parse(context.getString(extracted.value));
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      return EMPTY_GUEST_ERROR;
    }
    const [name, message, code, position] = parsed;
    return {
      name: boundedNullableText(name),
      message: boundedNullableText(message),
      code: boundedNullableText(code),
      position:
        Number.isSafeInteger(position) && (position as number) >= 0
          ? (position as number)
          : null,
    };
  } catch {
    return EMPTY_GUEST_ERROR;
  } finally {
    extracted.value.dispose();
  }
}

const EMPTY_GUEST_ERROR: BoundedGuestError = Object.freeze({
  name: null,
  message: null,
  code: null,
  position: null,
});

function boundedNullableText(value: unknown): string | null {
  return typeof value === "string" && value.length <= ERROR_TEXT_CODE_UNITS
    ? value
    : null;
}
