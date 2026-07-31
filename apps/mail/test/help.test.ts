import { expect, test } from "bun:test";
import { MAIL_HELP_TOPICS, getMailHelp } from "../src/help.ts";

test("every Mail help topic is bounded, explicit, and returns a fresh result", () => {
  for (const topic of MAIL_HELP_TOPICS) {
    const guide = getMailHelp(topic);
    expect(guide.topic).toBe(topic);
    expect(guide.title.length).toBeGreaterThan(0);
    expect(guide.summary.length).toBeGreaterThan(0);
    expect(guide.points.length).toBeGreaterThan(0);
    expect(JSON.stringify(guide).length).toBeLessThan(8_192);
  }
  const first = getMailHelp("privacy");
  first.points.length = 0;
  expect(getMailHelp("privacy").points.length).toBeGreaterThan(0);
});

test("help states the non-attachment, copy-only, metadata, and kernel-tool boundaries", () => {
  expect(getMailHelp("markdown").points.join(" ")).toContain("no attachments");
  expect(getMailHelp("markdown").points.join(" ")).toContain("copy-only");
  expect(getMailHelp("privacy").points.join(" ")).toContain("principals");
  expect(getMailHelp("privacy").points.join(" ")).toContain(
    "Every principal currently authorized",
  );
  expect(getMailHelp("privacy").points.join(" ")).toContain("decrypts on demand");
  expect(getMailHelp("privacy").points.join(" ")).toContain("30 days");
  expect(getMailHelp("privacy").points.join(" ")).toContain("cannot recall");
  expect(getMailHelp("agents").points.join(" ")).toContain(
    "handles cross-app tool permission",
  );
  expect(getMailHelp("agents").points.join(" ")).not.toContain("OpenRouter");
  expect(getMailHelp("agents").points.join(" ")).not.toContain("model");
  expect(getMailHelp("agents").points.join(" ")).toContain("mail_retry");
  expect(getMailHelp("agents").points.join(" ")).toContain("in-memory tool audit");
  expect(getMailHelp("limits").points.join(" ")).toContain("2,048");
});
