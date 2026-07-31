import { expect, test } from "bun:test";
import { cx, nt, sizeClass, toneClass } from "neutron-design-system";

test("cx composes strings, arrays, and conditional records", () => {
  expect(
    cx("nt-button", ["extra", null, ["deep"]], {
      "is-active": true,
      "is-hidden": false,
    })
  ).toBe("nt-button extra deep is-active");
});

test("class helper constants expose stable nt-prefixed names", () => {
  expect(nt.app).toBe("nt-app");
  expect(nt.buttonDanger).toBe("nt-button nt-button--danger");
  expect(nt.alertCritical).toBe("nt-alert nt-alert--critical");
  expect(nt.copyField).toBe("nt-copy-field");
  expect(nt.formGridTwo).toBe("nt-form-grid nt-form-grid--two");
  expect(nt.metricValue).toBe("nt-metric-value");
  expect(nt.detailGrid).toBe("nt-detail-grid");
  expect(nt.settingsRow).toBe("nt-settings-row");
  expect(nt.disclosureTrigger).toBe("nt-disclosure-trigger");
  expect(nt.tagSelected).toBe("nt-tag nt-tag--selected");
  expect(nt.json).toBe("nt-json");
  expect(nt.preWrap).toBe("nt-pre nt-pre--wrap");
});

test("tone and size helpers preserve neutral defaults", () => {
  expect(toneClass("nt-alert", "neutral")).toBe("nt-alert");
  expect(toneClass("nt-alert", "danger")).toBe("nt-alert nt-alert--danger");
  expect(sizeClass("nt-button", "md")).toBe("nt-button");
  expect(sizeClass("nt-button", "sm")).toBe("nt-button nt-button--sm");
});
