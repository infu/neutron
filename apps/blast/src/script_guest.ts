import { BLAST_LIMITS } from "./limits.ts";

export const SCRIPT_GUEST_BOOTSTRAP = String.raw`
"use strict";
(() => {
  const host = globalThis.__blastHost;
  const arrayIsArray = Array.isArray;
  const arrayPop = Array.prototype.pop.call.bind(Array.prototype.pop);
  const arrayPrototype = Array.prototype;
  const arrayPush = Array.prototype.push.call.bind(Array.prototype.push);
  const createObject = Object.create;
  const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const getPrototypeOf = Object.getPrototypeOf;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const mathMin = Math.min;
  const numberFrom = Number;
  const numberIsFinite = Number.isFinite;
  const numberIsSafeInteger = Number.isSafeInteger;
  const objectFreeze = Object.freeze;
  const objectHasOwn = Object.hasOwn;
  const objectPrototype = Object.prototype;
  const ownKeys = Reflect.ownKeys;
  const promiseReject = Promise.reject.bind(Promise);
  const promiseResolve = Promise.resolve.bind(Promise);
  const promiseThen = Promise.prototype.then.call.bind(Promise.prototype.then);
  const setPrototypeOf = Object.setPrototypeOf;
  const stringCharCodeAt = String.prototype.charCodeAt.call.bind(
    String.prototype.charCodeAt,
  );
  const stringFrom = String;
  const typeError = TypeError;
  const weakSet = WeakSet;
  const weakSetAdd = WeakSet.prototype.add.call.bind(WeakSet.prototype.add);
  const weakSetDelete = WeakSet.prototype.delete.call.bind(WeakSet.prototype.delete);
  const weakSetHas = WeakSet.prototype.has.call.bind(WeakSet.prototype.has);

  const strictJsonEncode = (
    value,
    label,
    maximumBytes,
    additionalDepth = 0,
    additionalNodes = 0,
  ) => {
    const ancestors = new weakSet();
    const holder = createObject(null);
    const stack = [{ value, parent: holder, key: "value", depth: 0, exit: false }];
    let nodes = 0;

    while (stack.length > 0) {
      const frame = arrayPop(stack);
      if (frame.exit) {
        weakSetDelete(ancestors, frame.value);
        continue;
      }
      nodes += 1;
      if (nodes > ${BLAST_LIMITS.jsonNodes} + additionalNodes) {
        throw new typeError(label + " contains too many values");
      }
      if (frame.depth > ${BLAST_LIMITS.jsonDepth} + additionalDepth) {
        throw new typeError(label + " is nested too deeply");
      }

      const item = frame.value;
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean"
      ) {
        frame.parent[frame.key] = item;
        continue;
      }
      if (typeof item === "number") {
        if (!numberIsFinite(item)) {
          throw new typeError(label + " must be JSON-compatible");
        }
        frame.parent[frame.key] = item;
        continue;
      }
      if (typeof item !== "object") {
        throw new typeError(label + " must be JSON-compatible");
      }
      if (weakSetHas(ancestors, item)) {
        throw new typeError(label + " must not contain cycles");
      }

      const isArray = arrayIsArray(item);
      const prototype = getPrototypeOf(item);
      if (
        (isArray && prototype !== arrayPrototype) ||
        (!isArray && prototype !== objectPrototype && prototype !== null)
      ) {
        throw new typeError(label + " must contain only plain JSON values");
      }

      const keys = ownKeys(item);
      const descriptors = getOwnPropertyDescriptors(item);
      const clone = isArray ? [] : createObject(null);
      if (isArray) setPrototypeOf(clone, null);
      frame.parent[frame.key] = clone;
      weakSetAdd(ancestors, item);
      arrayPush(stack, { value: item, depth: frame.depth, exit: true });

      if (isArray) {
        const length = item.length;
        const lengthDescriptor = descriptors.length;
        if (
          keys.length !== length + 1 ||
          lengthDescriptor === undefined ||
          !objectHasOwn(lengthDescriptor, "value") ||
          lengthDescriptor.value !== length ||
          lengthDescriptor.enumerable
        ) {
          throw new typeError(label + " arrays must not contain holes or extra properties");
        }
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (key === "length") continue;
          if (typeof key !== "string") {
            throw new typeError(label + " must not contain symbol properties");
          }
          const index = numberFrom(key);
          if (
            !numberIsSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            stringFrom(index) !== key
          ) {
            throw new typeError(label + " arrays must not contain holes or extra properties");
          }
        }
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[stringFrom(index)];
          if (
            descriptor === undefined ||
            !objectHasOwn(descriptor, "value") ||
            !descriptor.enumerable
          ) {
            throw new typeError(label + " arrays must contain plain enumerable values");
          }
          arrayPush(stack, {
            value: descriptor.value,
            parent: clone,
            key: index,
            depth: frame.depth + 1,
            exit: false,
          });
        }
        continue;
      }

      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (typeof key !== "string") {
          throw new typeError(label + " must not contain symbol properties");
        }
        if (key === "toJSON") {
          throw new typeError(label + " must not define toJSON");
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !objectHasOwn(descriptor, "value") ||
          !descriptor.enumerable
        ) {
          throw new typeError(label + " must contain plain enumerable values");
        }
        arrayPush(stack, {
          value: descriptor.value,
          parent: clone,
          key,
          depth: frame.depth + 1,
          exit: false,
        });
      }
    }

    const encoded = jsonStringify(holder.value);
    if (typeof encoded !== "string") {
      throw new typeError(label + " must be JSON-compatible");
    }
    let bytes = 0;
    for (let index = 0; index < encoded.length; index += 1) {
      const unit = stringCharCodeAt(encoded, index);
      if (unit <= 0x7f) bytes += 1;
      else if (unit <= 0x7ff) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < encoded.length) {
        const next = stringCharCodeAt(encoded, index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
      if (bytes > maximumBytes) {
        throw new typeError(label + " is too large");
      }
    }
    return encoded;
  };

  const observedResponseIds = [];
  const observedThenable = (settled, observe) => {
    const then = (onFulfilled, onRejected) => {
      const next = promiseThen(
        settled,
        (entry) => {
          if (typeof onFulfilled !== "function") return entry;
          observe(entry.responseId);
          return promiseThen(
            promiseResolve(onFulfilled(entry.value)),
            (value) => ({ value, responseId: null }),
          );
        },
        (error) => {
          if (typeof onRejected !== "function") throw error;
          return promiseThen(
            promiseResolve(onRejected(error)),
            (value) => ({ value, responseId: null }),
          );
        },
      );
      return observedThenable(next, observe);
    };
    const finish = (onFinally) => {
      if (typeof onFinally !== "function") {
        return observedThenable(promiseThen(settled), observe);
      }
      const next = promiseThen(
        settled,
        (entry) => promiseThen(promiseResolve(onFinally()), () => entry),
        (error) => promiseThen(promiseResolve(onFinally()), () => {
          throw error;
        }),
      );
      return observedThenable(next, observe);
    };
    return objectFreeze({
      then,
      catch: (onRejected) => then(undefined, onRejected),
      finally: finish,
    });
  };
  const call = (operation, args) => {
    let pending;
    try {
      const encodedArguments = strictJsonEncode(
        args ?? {},
        "Script host request",
        ${BLAST_LIMITS.scriptHostRequestBytes},
        ${BLAST_LIMITS.jsonEnvelopeDepth},
        ${BLAST_LIMITS.jsonEnvelopeNodes},
      );
      pending = host(
        operation,
        encodedArguments,
        strictJsonEncode(
          observedResponseIds,
          "Script host response receipts",
          ${BLAST_LIMITS.scriptHostCalls * 16 + 2},
        ),
      );
    } catch (error) {
      pending = promiseReject(error);
    }
    const settled = promiseThen(pending, (encoded) => {
      const response = jsonParse(encoded);
      if (
        !arrayIsArray(response) ||
        response.length !== 2 ||
        !numberIsSafeInteger(response[0]) ||
        response[0] < 1 ||
        typeof response[1] !== "string"
      ) {
        throw new typeError("Invalid Script host response receipt");
      }
      return { value: jsonParse(response[1]), responseId: response[0] };
    });
    let observed = false;
    return observedThenable(settled, (responseId) => {
      if (responseId === null || observed) return;
      observed = true;
      arrayPush(observedResponseIds, responseId);
    });
  };
  const api = Object.freeze({
    identity: () => call("blast.identity", {}),
    scan: (request) => call("blast.scan", request),
    schema: (request) => call("blast.schema", request),
    validateInput: (request) => call("blast.validate_input", request),
    query: (request) => call("blast.query", request),
    update: (request) => call("blast.update", request),
  });
  const readCollectionPages = (id, options = {}) => {
    const limit = options.limit ?? ${BLAST_LIMITS.collectionBatchPages};
    if (
      !numberIsSafeInteger(limit) ||
      limit < 1 ||
      limit > ${BLAST_LIMITS.collectionBatchPages}
    ) {
      throw new typeError(
        "Collection page batch limit must be an integer from 1 through ${BLAST_LIMITS.collectionBatchPages}",
      );
    }
    return call("collections.pages", {
      id,
      cursor: options.cursor ?? null,
      limit,
    });
  };
  const collectionsApi = Object.freeze({
    create: (metadata) => call("collections.create", metadata),
    putPage: (id, key, value) =>
      call("collections.put_page", { id, key, value }),
    append: (id, value, key) =>
      call("collections.append", { id, value, ...(key === undefined ? {} : { key }) }),
    readPages: readCollectionPages,
    pages: async function* (id, options = {}) {
      let cursor = options.cursor ?? null;
      let remaining = options.limit ?? null;
      if (
        remaining !== null &&
        (!numberIsSafeInteger(remaining) || remaining < 0)
      ) {
        throw new typeError("Collection page limit must be a non-negative safe integer");
      }
      if (remaining === 0) return;
      do {
        const page = await readCollectionPages(id, {
          cursor,
          limit:
            remaining === null
              ? ${BLAST_LIMITS.collectionBatchPages}
              : mathMin(remaining, ${BLAST_LIMITS.collectionBatchPages}),
        });
        for (const value of page.values) {
          yield value;
          if (remaining !== null) {
            remaining -= 1;
            if (remaining <= 0) return;
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    },
    complete: (id, summary = null) =>
      call("collections.complete", { id, summary }),
    fail: (id, summary) => call("collections.fail", { id, summary }),
  });
  const runApi = Object.freeze({
    checkpoint: (value) => call("run.checkpoint", { value }),
    progress: (value) => call("run.progress", { value }),
  });
  Object.defineProperties(globalThis, {
    blast: { value: api, writable: false, enumerable: true, configurable: false },
    collections: { value: collectionsApi, writable: false, enumerable: true, configurable: false },
    run: { value: runApi, writable: false, enumerable: true, configurable: false },
    __blastEncodeResult: {
      value: (value, maximumBytes) =>
        strictJsonEncode(value, "Script result", maximumBytes),
      writable: false,
      enumerable: false,
      configurable: false,
    },
  });
  delete globalThis.__blastHost;
})();
`;

export function scriptEvaluationSource(
  source: string,
  input: unknown,
  resultBytes = BLAST_LIMITS.scriptResultBytes,
): string {
  const encodedInput = JSON.stringify(JSON.stringify(input));
  return `${SCRIPT_GUEST_BOOTSTRAP}\n(async () => globalThis.__blastEncodeResult(\n  await (async (input) => {\n${source}\n})(JSON.parse(${encodedInput})),\n  ${resultBytes}\n))();`;
}
