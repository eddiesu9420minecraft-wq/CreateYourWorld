// Feedback status transition table (API.md "Allowed transitions").
import type { Status } from "./validate";

/**
 * Transitions a developer+ may perform through PATCH / close:
 * open→triaged→in_progress→fixed, fixed→in_progress, any→closed, closed→open.
 * `released` is reachable only through POST /v1/releases (or a maintainer's release.published webhook).
 */
const MANUAL: Record<Status, readonly Status[]> = {
  open: ["triaged", "closed"],
  triaged: ["in_progress", "closed"],
  in_progress: ["fixed", "closed"],
  fixed: ["in_progress", "closed"],
  released: ["closed"],
  closed: ["open"],
};

export function canTransition(from: Status, to: Status): boolean {
  return MANUAL[from].includes(to);
}

/** Statuses that a recorded release moves to `released`. */
export const RELEASABLE: readonly Status[] = ["fixed", "in_progress", "triaged"];

/** The full table, including the release-only step fixed→released (for documentation and tests). */
export function canTransitionViaRelease(from: Status): boolean {
  return RELEASABLE.includes(from);
}
