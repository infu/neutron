import { expect, test } from "bun:test";
import { hashContent } from "../src/hash.ts";
import {
  createKernelInstalledArtifactInventory,
  kernelInstalledArtifactPath,
  parseKernelInstalledArtifactInventory,
} from "../src/installed_artifacts.ts";

const digest = "a".repeat(64);

function inventory() {
  return {
    format: 1,
    package: { id: "kernel", version: 100 },
    artifacts: [
      {
        package_path: "web/index.html",
        bytes: 1,
        sha256: digest,
      },
    ],
  };
}

test("accepts the minimal Kernel artifact inventory", () => {
  const parsed = parseKernelInstalledArtifactInventory(inventory());

  expect(parsed.artifacts[0]?.package_path).toBe("web/index.html");
  expect(
    createKernelInstalledArtifactInventory({
      version: 100,
      artifacts: parsed.artifacts,
    }),
  ).toEqual(parsed);
});

test("retains canonical package path rejection", () => {
  for (const packagePath of ["", "/absolute", "double//segment", "../file"]) {
    const value = inventory();
    value.artifacts[0]!.package_path = packagePath;
    expect(() => parseKernelInstalledArtifactInventory(value)).toThrow(
      /package_path/u,
    );
  }
});

test("rejects duplicate, reordered, and invented inventory fields", () => {
  const file = (packagePath: string) => ({
    package_path: packagePath,
    bytes: 1,
    sha256: digest,
  });
  for (const artifacts of [
    [file("b"), file("a")],
    [file("a"), file("a")],
  ]) {
    expect(() =>
      parseKernelInstalledArtifactInventory({ ...inventory(), artifacts }),
    ).toThrow(/ordered/u);
  }
  expect(() =>
    parseKernelInstalledArtifactInventory({
      ...inventory(),
      runtime_paths: [],
    }),
  ).toThrow(/unknown fields/u);
});

test("allows a maximum package path whose installed path is longer", () => {
  const packagePath = [
    "a".repeat(1_024),
    "b".repeat(1_024),
    "c".repeat(1_024),
    "d".repeat(1_021),
  ].join("/");
  expect(new TextEncoder().encode(packagePath)).toHaveLength(4_096);
  expect(
    new TextEncoder().encode(kernelInstalledArtifactPath(packagePath)).length,
  ).toBeGreaterThan(4_096);
  const value = inventory();
  value.artifacts = [
    {
      package_path: packagePath,
      bytes: 1,
      sha256: digest,
    },
  ];

  expect(parseKernelInstalledArtifactInventory(value).artifacts[0]).toEqual(
    value.artifacts[0],
  );
});

test("requires exact inline bytes for HTTP-internal Kernel frontend text", () => {
  const content = "<script>source()</script>\n";
  const systemFile = {
    package_path: "web/system/browser-origin-cleanup.html",
    bytes: new TextEncoder().encode(content).byteLength,
    sha256: hashContent(content),
    inline_text: content,
  };
  const value = inventory();
  value.artifacts = [systemFile];
  expect(parseKernelInstalledArtifactInventory(value).artifacts[0]).toEqual(
    systemFile,
  );

  for (const inlineText of [undefined, "changed"]) {
    const invalid = inventory();
    const invalidFile: Record<string, unknown> = { ...systemFile };
    if (inlineText === undefined) delete invalidFile.inline_text;
    else invalidFile.inline_text = inlineText;
    invalid.artifacts = [invalidFile as typeof systemFile];
    expect(() => parseKernelInstalledArtifactInventory(invalid)).toThrow(
      /inline_text/u,
    );
  }
});
