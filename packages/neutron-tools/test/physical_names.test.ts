import { expect, test } from "bun:test";
import {
  CANISTER_METHOD_MAX_LENGTH,
  PHYSICAL_APP_METHOD_MAX_LENGTH,
  PHYSICAL_PUBLIC_INGRESS_METHOD_MAX_LENGTH,
  appPhysicalStem,
  physicalAppMethodName,
  physicalPublicIngressMethodName,
  scopedPhysicalStem,
} from "../src/physical_names.ts";

test("physical app method names include an unambiguous app boundary", () => {
  expect(physicalAppMethodName("mail", "recipient_key_v1")).toBe(
    "app_mail__recipient_key_v1",
  );
  expect(physicalAppMethodName("aaaa_b", "c")).not.toBe(
    physicalAppMethodName("aaaa", "b_c"),
  );
});

test("scoped physical stems remain unique when callers append suffixes", () => {
  expect(appPhysicalStem("mail")).toBe("a4_mail");
  expect(scopedPhysicalStem("mail", "inbox")).toBe(
    "a4_mail_r5_inbox",
  );
  expect(scopedPhysicalStem("aaaa_b", "c_d")).not.toBe(
    scopedPhysicalStem("aaaa", "b_c_d"),
  );
});

test("physical-name helpers reject non-identifier input", () => {
  expect(() => physicalAppMethodName("Mail", "read")).toThrow(
    "Invalid app id",
  );
  for (const appId of ["_mail", "mail_", "mail__box", "abc"]) {
    expect(() => physicalAppMethodName(appId, "read")).toThrow(
      "Invalid app id",
    );
  }
  expect(() => physicalAppMethodName("mail", "read.status")).toThrow(
    "Invalid local id",
  );
  expect(() => physicalAppMethodName("mail", "1read")).toThrow(
    "Invalid local id",
  );
  expect(() => scopedPhysicalStem("mail", "")).toThrow("Invalid local id");
});

test("the longest physical app method fits the canister transport bound", () => {
  const method = physicalAppMethodName("a".repeat(30), "m".repeat(128));
  expect(method).toHaveLength(PHYSICAL_APP_METHOD_MAX_LENGTH);
  expect(method.length).toBeLessThanOrEqual(CANISTER_METHOD_MAX_LENGTH);
  expect(() => physicalAppMethodName("a".repeat(31), "read")).toThrow(
    "Invalid app id",
  );
  expect(() => physicalAppMethodName("mail", "m".repeat(129))).toThrow(
    "Invalid local id",
  );
});

test("public ingress names bind app, protocol, and call mode without collisions", () => {
  expect(physicalPublicIngressMethodName("mail", "mail_v1", "query")).toBe(
    "app_mail__mail_v1_query",
  );
  expect(
    physicalPublicIngressMethodName("aaaa_b", "cccc", "update"),
  ).not.toBe(physicalPublicIngressMethodName("aaaa", "b_cccc", "update"));
  expect(physicalPublicIngressMethodName("mail", "mail_v1", "query")).not.toBe(
    physicalPublicIngressMethodName("mail", "mail_v1", "update"),
  );
});

test("public ingress names enforce the closed protocol and transport bounds", () => {
  const method = physicalPublicIngressMethodName(
    "a".repeat(30),
    "p".repeat(63),
    "update",
  );
  expect(method).toHaveLength(PHYSICAL_PUBLIC_INGRESS_METHOD_MAX_LENGTH);
  expect(method.length).toBeLessThanOrEqual(CANISTER_METHOD_MAX_LENGTH);
  expect(() => physicalPublicIngressMethodName("mail", "Mail", "query")).toThrow(
    "Invalid public ingress protocol",
  );
  expect(() =>
    physicalPublicIngressMethodName("mail", "p".repeat(64), "query"),
  ).toThrow("Invalid public ingress protocol");
  expect(() =>
    physicalPublicIngressMethodName(
      "mail",
      "mail_v1",
      "stream" as "query",
    ),
  ).toThrow("Invalid public ingress mode");
});
