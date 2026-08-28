/**
 * QuickJS needs its Eval intrinsic enabled for the host's C API to compile
 * trusted source. Run this prelude before untrusted guest code so the guest
 * cannot reach JavaScript's dynamic source constructors afterward.
 */
export const SCRIPT_GUEST_LOCKDOWN = String.raw`
"use strict";
(() => {
  const defineProperty = Object.defineProperty;
  const getPrototypeOf = Object.getPrototypeOf;
  const dynamicFunctionPrototypes = [
    getPrototypeOf(function () {}),
    getPrototypeOf(async function () {}),
    getPrototypeOf(function* () {}),
    getPrototypeOf(async function* () {}),
  ];
  for (const prototype of dynamicFunctionPrototypes) {
    defineProperty(prototype, "constructor", {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
  defineProperty(globalThis, "eval", {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  defineProperty(globalThis, "Function", {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
`;
