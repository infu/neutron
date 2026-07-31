import { describe, expect, test } from "bun:test";
import {
  profileSaveIsDisabled,
  validateUtf8Field,
} from "../src/app/profile_validation.ts";

describe("profile editor UTF-8 limits", () => {
  test("counts encoded bytes rather than JavaScript characters", () => {
    expect(validateUtf8Field("🐂".repeat(20), "Display name", 80)).toEqual({
      byteLength: 80,
      error: null,
    });
    const oversized = validateUtf8Field(
      "🐂".repeat(21),
      "Display name",
      80,
    );
    expect(oversized.byteLength).toBe(84);
    expect(oversized.error).toContain("84 UTF-8 bytes");
    expect(oversized.error).toContain("maximum is 80");
  });

  test("disables save for either field error instead of silently returning", () => {
    expect(profileSaveIsDisabled({
      saving: false,
      changed: true,
      textError: "Description is too large",
      avatarError: null,
    })).toBeTrue();
    expect(profileSaveIsDisabled({
      saving: false,
      changed: true,
      textError: null,
      avatarError: null,
    })).toBeFalse();
  });
});
