const CONTENT_ADDRESS = /^[a-f0-9]{64}$/u;

type MotokoImport = Readonly<{
  name: string;
  path: string;
}>;

function* motokoImportEntries(content: string): Generator<MotokoImport> {
  const importPattern = /^[^\S\r\n]*import ([^"\r\n]+) "([^"\s]+)"/gmu;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    const [, name, path] = match;
    if (!name || !path) continue;
    yield { name, path };
  }
}

/** Parse the canonical one-line import declarations emitted by Motoko packaging. */
export function parseMotokoImports(content: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const { name, path } of motokoImportEntries(content)) {
    // Import aliases are package input. Define an own data property so names
    // such as `__proto__` cannot invoke Object.prototype setters or disappear
    // from Object.values(), while preserving the historical plain-record API.
    Object.defineProperty(imports, name, {
      configurable: true,
      enumerable: true,
      value: path,
      writable: true,
    });
  }
  return imports;
}

/** Return only the content-addressed dependencies allowed in packaged modules. */
export function contentAddressedMotokoImports(
  content: string,
  maximumImports = Number.MAX_SAFE_INTEGER,
): string[] {
  if (!Number.isSafeInteger(maximumImports) || maximumImports < 0) {
    throw new Error("Motoko import limit is invalid");
  }
  const imports = new Set<string>();
  for (const { path } of motokoImportEntries(content)) {
    if (path === "mo:prim" || path === "mo:⛔") continue;
    if (!CONTENT_ADDRESS.test(path)) {
      // Do not copy an untrusted, potentially module-sized import path into an
      // error that may cross the frontend message bus or enter diagnostics.
      throw new Error(
        "Installed Motoko module has an unsupported non-content-addressed import",
      );
    }
    if (!imports.has(path) && imports.size >= maximumImports) {
      throw new Error("Installed Motoko module has too many imports");
    }
    imports.add(path);
  }
  return [...imports].sort();
}
