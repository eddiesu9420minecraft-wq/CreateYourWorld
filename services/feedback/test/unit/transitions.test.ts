import { describe, expect, it } from "vitest";
import { canTransition, canTransitionViaRelease } from "../../src/transitions";
import { STATUSES, type Status } from "../../src/validate";

const allowed = new Set([
  "open>triaged",
  "triaged>in_progress",
  "in_progress>fixed",
  "fixed>in_progress",
  "closed>open",
  "open>closed",
  "triaged>closed",
  "in_progress>closed",
  "fixed>closed",
  "released>closed",
]);

describe("feedback transition table", () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;
      const key = `${from}>${to}`;
      it(key, () => expect(canTransition(from as Status, to as Status)).toBe(allowed.has(key)));
    }
  }
  it("released is never a manual target", () => {
    for (const from of STATUSES) expect(canTransition(from, "released")).toBe(false);
  });
  it("releases move fixed/in_progress/triaged only", () => {
    expect(STATUSES.filter((s) => canTransitionViaRelease(s))).toEqual(["triaged", "in_progress", "fixed"]);
  });
});
