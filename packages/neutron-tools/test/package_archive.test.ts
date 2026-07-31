import { describe, expect, test } from "bun:test";
import { packageArchiveFilename } from "../src/package_archive.ts";

describe("package archive filenames", () => {
  test("matches the canonical sanitized pack filename", () => {
    expect(packageArchiveFilename("mail-app", 101)).toBe(
      "mail_app.v0.1.1.neutron",
    );
    expect(packageArchiveFilename("kernel", 10_000)).toBe(
      "kernel.v1.0.0.neutron",
    );
  });

  test("rejects missing ids and invalid packed versions", () => {
    expect(() => packageArchiveFilename("", 100)).toThrow();
    expect(() => packageArchiveFilename("mail", 1)).toThrow();
  });
});
