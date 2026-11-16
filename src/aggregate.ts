import type { Violation } from "./evaluate";
import { RULE_TITLES } from "./report";

/** The result for one PR, as needed to decide the commit status of its head commit. */
export interface PrOutcome {
  number: number;
  headSha: string;
  passed: boolean;
  /** Policy is in enforce mode with fail_check on, so a failure should turn the status red. */
  enforced: boolean;
  dryRun: boolean;
  violations: Violation[];
  exemptReason: string | null;
}

export interface CommitStatus {
  state: "success" | "failure";
  description: string;
}

const titles = (violations: Violation[]) => [...new Set(violations.map((v) => RULE_TITLES[v.rule]))].join(", ");

/**
 * A commit status belongs to a commit, not a PR, and several open PRs can share a head commit
 * (for example, someone opens a second PR from the same commit). All PRs on one commit are
 * judged together and the status fails if any of them fails: otherwise a compliant PR could
 * turn a non-compliant one green. This fails closed: a bad PR on a shared commit turns the
 * others red too, and the status names which PR is the problem.
 */
export function statusesByCommit(outcomes: PrOutcome[]): Map<string, CommitStatus> {
  const groups = new Map<string, PrOutcome[]>();
  for (const o of outcomes) groups.set(o.headSha, [...(groups.get(o.headSha) ?? []), o]);

  const result = new Map<string, CommitStatus>();
  for (const [sha, group] of groups) {
    const shared = group.length > 1;
    const failing = group.filter((o) => !o.passed && o.enforced);
    const unenforced = group.filter((o) => !o.passed && !o.enforced);
    let status: CommitStatus;
    if (failing.length) {
      status = {
        state: "failure",
        description: shared
          ? `Needs changes in ${failing.map((o) => `PR #${o.number}`).join(", ")} (these PRs share this commit)`
          : `Needs changes: ${titles(failing[0]!.violations)} (see the PR comment)`,
      };
    } else if (unenforced.length) {
      const dry = unenforced.some((o) => o.dryRun);
      status = {
        state: "success",
        description: `${dry ? "Dry run, not enforced" : "Not enforced"}: ${titles(unenforced.flatMap((o) => o.violations))}`,
      };
    } else if (!shared && group[0]!.exemptReason) {
      status = { state: "success", description: `Skipped: ${group[0]!.exemptReason}` };
    } else {
      status = { state: "success", description: "All contribution checks passed" };
    }
    result.set(sha, status);
  }
  return result;
}
