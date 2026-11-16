import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { retry } from "@octokit/plugin-retry";
import { statusesByCommit, type PrOutcome } from "./aggregate";
import { ConfigError, parsePolicy, type Policy } from "./config";
import { evaluate, type Evaluation } from "./evaluate";
import { GitHubRepo, httpStatus, PAUSED_PREFIX, type LivePullRequest } from "./github";
import { failureComment, passComment, summarize } from "./report";
import { resolveTargets } from "./targets";

/**
 * Per-PR budget in two-workflow mode: after this many results on one commit within an hour,
 * further updates are not evaluated; the PR is marked paused (red) until the scheduled sweep
 * re-checks it. This stops one contributor from spending the repository's API quota.
 */
export const MAX_RESULTS_PER_HOUR = 20;

interface Evaluated {
  pr: LivePullRequest;
  policy: Policy;
  result: Evaluation;
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const configPath = core.getInput("config-path") || ".github/contribution-gateway.yml";
  const { owner, repo } = context.repo;
  const serverUrl = context.serverUrl || "https://github.com";
  // GitHub occasionally answers with a 5xx; retry those (with backoff) so one blip doesn't
  // leave a PR with a stale comment or status. 4xx answers such as 404 are not retried.
  const octokit = getOctokit(token, { retry: { retries: 3 } }, retry);
  const gh = new GitHubRepo(octokit, owner, repo, new URL(serverUrl).hostname, core.warning, token.startsWith("ghs_"));
  const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;

  const targets = await resolveTargets(context.eventName, context.payload, core.getInput("pull-request"), gh);
  if (targets.skip) {
    core.info(`Nothing to check: ${targets.skip}.`);
    return;
  }
  const useStatus = targets.report === "status";

  // 1. Load the targets as they are now, pausing over-active ones (two-workflow mode only).
  const live = new Map<number, LivePullRequest>();
  const load = async (n: number) => {
    if (!live.has(n)) live.set(n, await gh.getPullRequest(n));
    return live.get(n)!;
  };
  const toCheck = new Set<number>();
  for (const n of targets.numbers) {
    const pr = await load(n);
    if (pr.state !== "open") {
      core.info(`PR #${n} is ${pr.state}; nothing to check.`);
      continue;
    }
    if (useStatus && !targets.sweep) {
      const recent = await gh.recentStatusCount(pr.headSha, new Date(Date.now() - 3600_000));
      if (recent.count >= MAX_RESULTS_PER_HOUR) {
        core.warning(`PR #${n} was checked ${recent.count} times in the last hour; pausing it until the scheduled sweep.`);
        if (!(recent.latestDescription ?? "").startsWith(PAUSED_PREFIX)) {
          await gh.setStatus(pr.headSha, "failure", `${PAUSED_PREFIX} updated too often; it will be re-checked by the scheduled sweep`, runUrl);
        }
        continue;
      }
    }
    toCheck.add(n);
    // 2. Other open PRs on the same commit share its status, so judge them together.
    if (useStatus) for (const other of await gh.pullRequestsWithHead(pr.headSha)) toCheck.add(other);
  }

  // 3. Evaluate every PR with the policy from its own base branch. The policy is read through
  //    the API, never from the PR's files, so a contributor cannot loosen it in their PR.
  const policies = new Map<string, Policy>();
  const evaluated: Evaluated[] = [];
  for (const n of toCheck) {
    const pr = await load(n);
    if (pr.state !== "open") continue;
    if (!policies.has(pr.baseRef)) {
      const text = await gh.readFile(configPath, pr.baseRef);
      if (text === undefined) core.info(`No ${configPath} on ${pr.baseRef}; using the default policy.`);
      const { policy, warnings } = parsePolicy(text);
      warnings.forEach((w) => core.warning(w));
      policies.set(pr.baseRef, policy);
    }
    const policy = policies.get(pr.baseRef)!;
    const result = await evaluate(pr, policy, gh);
    core.info(`PR #${pr.number}: ${summarize(result)}`);
    evaluated.push({ pr, policy, result });
  }

  core.summary.addHeading("Contribution gateway", 3);
  for (const { pr, result } of evaluated) core.summary.addHeading(`PR #${pr.number}`, 4).addCodeBlock(summarize(result));
  await core.summary.write();

  // 4. Comments, labels and closing, per PR.
  try {
    for (const { pr, policy, result } of evaluated) {
      if (policy.mode === "dry-run") continue;
      const act = policy.on_violation;
      const passed = result.violations.length === 0;
      if (passed) {
        // Also covers PRs that became exempt: an earlier failure comment and label must not linger.
        if (act.comment) await gh.upsertComment(pr.number, passComment(result.exemptReason), false);
        if (act.label) await gh.setLabel(pr.number, act.label, false, pr.labels);
      } else {
        if (act.comment) await gh.upsertComment(pr.number, failureComment(pr.author, result, policy, act.close), true);
        if (act.label) await gh.setLabel(pr.number, act.label, true, pr.labels);
      }
    }

    // 5. One status per head commit (two-workflow mode).
    const outcomes: PrOutcome[] = evaluated.map(({ pr, policy, result }) => ({
      number: pr.number,
      headSha: pr.headSha,
      passed: result.violations.length === 0,
      enforced: policy.mode === "enforce" && policy.on_violation.fail_check,
      dryRun: policy.mode === "dry-run",
      violations: result.violations,
      exemptReason: result.exemptReason,
    }));
    if (useStatus) {
      for (const [sha, s] of statusesByCommit(outcomes)) await gh.setStatus(sha, s.state, s.description, runUrl);
    }

    for (const { pr, policy, result } of evaluated) {
      if (policy.mode === "enforce" && policy.on_violation.close && result.violations.length) await gh.closePullRequest(pr.number);
    }
  } catch (e) {
    if (httpStatus(e) === 403) {
      throw new Error(
        "GitHub refused a write (403). Grant `issues: write`, `pull-requests: read` (or `write` to close PRs) and, for workflow_run, `statuses: write`. " +
          "For pull requests from forks, run this action on `pull_request_target` or `workflow_run`, not `pull_request`.",
        { cause: e },
      );
    }
    throw e;
  }

  core.setOutput("passed", String(evaluated.every((e) => e.result.violations.length === 0)));
  core.setOutput(
    "violations",
    JSON.stringify(evaluated.flatMap((e) => e.result.violations.map((v) => ({ pull_request: e.pr.number, ...v })))),
  );

  // In single-workflow mode the job's own check is what the PR shows. In two-workflow mode the
  // commit status carries the result, so this job only fails on real errors.
  const failing = evaluated.filter((e) => e.result.violations.length && e.policy.mode === "enforce" && e.policy.on_violation.fail_check);
  if (!useStatus && failing.length) core.setFailed(failing.map((e) => `PR #${e.pr.number}: ${summarize(e.result)}`).join("\n"));
}

export async function main(): Promise<void> {
  try {
    await run();
  } catch (e) {
    const err = e as Error;
    core.setFailed(err instanceof ConfigError ? `Invalid policy file: ${err.message}` : err.message);
  }
}
