import { test, expect } from "vitest";

import {
  normStatus,
  STATUS_ORDER,
  STEP_BOARD_STATUSES,
  PHASE_BOARD_STATUSES,
  statusLabel,
} from "../src/status";

test("every nos status maps to its own key without a flag", () => {
  for (const s of [
    "open",
    "in-specification",
    "specified",
    "in-progress",
    "implemented",
    "in-review",
    "reviewed",
    "done",
    "on-hold",
  ]) {
    expect(normStatus(s)).toStrictEqual({ key: s, label: s, flagged: false });
  }
});

test("status is matched case- and whitespace-insensitively", () => {
  expect(normStatus("  In-Progress ")).toStrictEqual({
    key: "in-progress",
    label: "in-progress",
    flagged: false,
  });
});

test("an unknown value lands in the flagged other bucket, keeping its text", () => {
  expect(normStatus("blocked")).toStrictEqual({
    key: "other",
    label: "blocked",
    flagged: true,
  });
});

test("an empty or missing value is flagged other with a dash label", () => {
  expect(normStatus("")).toStrictEqual({
    key: "other",
    label: "—",
    flagged: true,
  });
  expect(normStatus(undefined)).toStrictEqual({
    key: "other",
    label: "—",
    flagged: true,
  });
});

test("status order follows the nos lifecycle, off-spec buckets last", () => {
  expect(STATUS_ORDER).toStrictEqual([
    "open",
    "in-specification",
    "specified",
    "in-progress",
    "implemented",
    "in-review",
    "reviewed",
    "done",
    "on-hold",
    "other",
  ]);
});

test("step boards always show the step lifecycle columns", () => {
  expect(STEP_BOARD_STATUSES).toStrictEqual([
    "open",
    "in-specification",
    "specified",
    "in-progress",
    "implemented",
    "in-review",
    "reviewed",
    "done",
  ]);
});

test("phase boards always show the phase lifecycle columns, no specification", () => {
  expect(PHASE_BOARD_STATUSES).toStrictEqual([
    "open",
    "in-progress",
    "implemented",
    "in-review",
    "reviewed",
    "done",
  ]);
});

test("statusLabel reads the human label for a key", () => {
  expect(statusLabel("in-review")).toBe("in review");
  expect(statusLabel("in-specification")).toBe("in specification");
  expect(statusLabel("specified")).toBe("specified");
  expect(statusLabel("other")).toBe("other");
});
