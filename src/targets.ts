/**
 * Works out which pull requests a run should check, for each supported trigger:
 *
 * - `pull_request_target` (single-workflow mode): the PR in the payload. Comments and
 *   labels are written directly, and the job's own check shows the result.
 * - `workflow_run` (two-workflow mode): a read-only `pull_request` workflow ran for the PR;
 *   this run finds that PR through the API and reports with a commit status. Nothing from
 *   the untrusted run (artifacts, outputs) is used, only which branch it ran for.
 * - `workflow_dispatch`: a maintainer re-checks one PR by number.
 */

export type ReportStyle = "job" | "status";

export interface Targets {
  numbers: number[];
  /** "job": fail this job on violations. "status": set a commit status on the PR instead. */
  report: ReportStyle;
  /** Why there is nothing to do, for the log. */
  skip?: string;
}

interface WorkflowRunPayload {
  event?: string;
  head_branch?: string | null;
  head_repository?: { owner?: { login?: string } } | null;
  pull_requests?: { number: number }[];
}

export interface TargetLookup {
  /** Open PRs in this repository whose head is `owner:branch`. */
  findOpenPullRequests(headOwner: string, headBranch: string): Promise<number[]>;
}

export async function resolveTargets(
  eventName: string,
  payload: Record<string, unknown>,
  inputNumber: string,
  lookup: TargetLookup,
): Promise<Targets> {
  const requested = inputNumber.trim();
  if (requested) {
    const n = Number(requested);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`pull-request input must be a PR number, got "${requested}"`);
    return { numbers: [n], report: eventName === "pull_request_target" ? "job" : "status" };
  }

  if (eventName === "pull_request_target" || eventName === "pull_request") {
    const n = (payload.pull_request as { number?: number } | undefined)?.number;
    if (!n) return { numbers: [], report: "job", skip: "the event has no pull request" };
    return { numbers: [n], report: "job" };
  }

  if (eventName === "workflow_run") {
    const run = payload.workflow_run as WorkflowRunPayload | undefined;
    if (!run) return { numbers: [], report: "status", skip: "the event has no workflow run" };
    if (run.event !== "pull_request" && run.event !== "pull_request_target") {
      return { numbers: [], report: "status", skip: `the triggering run was for "${run.event}", not a pull request` };
    }
    // Same-repository PRs are listed in the payload; PRs from forks are not, so look them up.
    const listed = (run.pull_requests ?? []).map((p) => p.number);
    if (listed.length) return { numbers: [...new Set(listed)], report: "status" };
    const owner = run.head_repository?.owner?.login;
    if (!owner || !run.head_branch) return { numbers: [], report: "status", skip: "the triggering run has no head branch" };
    const found = await lookup.findOpenPullRequests(owner, run.head_branch);
    if (!found.length) return { numbers: [], report: "status", skip: `no open pull request from ${owner}:${run.head_branch}` };
    return { numbers: found, report: "status" };
  }

  if (eventName === "workflow_dispatch") {
    return { numbers: [], report: "status", skip: "manual runs need the pull-request input" };
  }

  throw new Error(
    `"${eventName}" events are not supported; use pull_request_target, or workflow_run with a pull_request trigger workflow`,
  );
}

/** Commit status descriptions are limited to 140 characters. */
export function statusDescription(text: string): string {
  return text.length <= 140 ? text : `${text.slice(0, 139)}…`;
}
