import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { retry } from "@octokit/plugin-retry";
import { ConfigError, parsePolicy } from "./config";
import { evaluate, type Violation } from "./evaluate";
import { GitHubRepo, httpStatus } from "./github";
import { failureComment, passComment, RULE_TITLES, summarize } from "./report";
import { resolveTargets, type ReportStyle } from "./targets";

interface Outcome {
  number: number;
  passed: boolean;
  summary: string;
  violations: Violation[];
  /** The policy asks for a failing check when rules are broken. */
  failCheck: boolean;
}

function statusText(passed: boolean, violations: Violation[], exemptReason: string | null): string {
  if (exemptReason) return `Skipped: ${exemptReason}`;
  if (passed) return "All contribution checks passed";
  return `Needs changes: ${violations.map((v) => RULE_TITLES[v.rule]).join(", ")} (see the PR comment)`;
}

async function checkPullRequest(
  gh: GitHubRepo,
  number: number,
  configPath: string,
  report: ReportStyle,
  runUrl: string,
): Promise<Outcome | null> {
  // Use the pull request as it is now, not the (possibly replayed or stale) event payload.
  const pr = await gh.getPullRequest(number);
  if (pr.state !== "open") {
    core.info(`PR #${pr.number} is ${pr.state}; nothing to check.`);
    return null;
  }

  // The policy is read from the base branch through the API, never from the PR's own files,
  // so a contributor cannot loosen the rules inside their pull request.
  const configText = await gh.readFile(configPath, pr.baseRef);
  if (configText === undefined) core.info(`No ${configPath} on ${pr.baseRef}; using the default policy.`);
  const { policy, warnings } = parsePolicy(configText);
  warnings.forEach((w) => core.warning(w));

  const result = await evaluate(pr, policy, gh);
  const summary = summarize(result);
  const passed = result.violations.length === 0;
  core.info(`PR #${pr.number}: ${summary}`);
  core.summary.addHeading(`PR #${pr.number}`, 4).addCodeBlock(summary);
  const outcome: Outcome = { number: pr.number, passed, summary, violations: result.violations, failCheck: policy.on_violation.fail_check };

  if (policy.mode === "dry-run") {
    core.info("Dry-run mode: no comments, labels or statuses were changed.");
    return outcome;
  }

  const act = policy.on_violation;
  if (passed) {
    // Also covers PRs that became exempt (e.g. a maintainer added the skip label):
    // an earlier failure comment and label must not linger.
    if (act.comment) await gh.upsertComment(pr.number, passComment(result.exemptReason), false);
    if (act.label) await gh.setLabel(pr.number, act.label, false, pr.labels);
  } else {
    if (act.comment) await gh.upsertComment(pr.number, failureComment(pr.author, result, policy, act.close), true);
    if (act.label) await gh.setLabel(pr.number, act.label, true, pr.labels);
  }
  if (report === "status") {
    const state = passed || !act.fail_check ? "success" : "failure";
    await gh.setStatus(pr.headSha, state, statusText(passed, result.violations, result.exemptReason), runUrl);
  }
  if (!passed && act.close) await gh.closePullRequest(pr.number);
  return outcome;
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const configPath = core.getInput("config-path") || ".github/contribution-gateway.yml";
  const { owner, repo } = context.repo;
  const serverUrl = context.serverUrl || "https://github.com";
  // GitHub occasionally answers with a 5xx; retry those (with backoff) so one blip doesn't
  // leave a PR with a stale comment or status. 4xx answers such as 404 are not retried.
  const octokit = getOctokit(token, { retry: { retries: 3 } }, retry);
  const gh = new GitHubRepo(octokit, owner, repo, new URL(serverUrl).hostname, core.warning);

  const targets = await resolveTargets(context.eventName, context.payload, core.getInput("pull-request"), gh);
  if (targets.skip) {
    core.info(`Nothing to check: ${targets.skip}.`);
    return;
  }

  const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  core.summary.addHeading("Contribution gateway", 3);
  const outcomes: Outcome[] = [];
  try {
    for (const number of targets.numbers) {
      const outcome = await checkPullRequest(gh, number, configPath, targets.report, runUrl);
      if (outcome) outcomes.push(outcome);
    }
  } catch (e) {
    if (httpStatus(e) === 403) {
      throw new Error(
        "GitHub refused a write (403). Grant `issues: write`, `pull-requests: write` and (for workflow_run) `statuses: write`. " +
          "For pull requests from forks, run this action on `pull_request_target` or `workflow_run`, not `pull_request`.",
        { cause: e },
      );
    }
    throw e;
  } finally {
    await core.summary.write();
  }

  core.setOutput("passed", String(outcomes.every((o) => o.passed)));
  core.setOutput(
    "violations",
    JSON.stringify(outcomes.flatMap((o) => o.violations.map((v) => ({ pull_request: o.number, ...v })))),
  );

  // In single-workflow mode the job's own check is what the PR shows. In two-workflow mode the
  // commit status carries the result, so this job only fails on real errors.
  const failing = outcomes.filter((o) => !o.passed && o.failCheck);
  if (targets.report === "job" && failing.length) core.setFailed(failing.map((o) => o.summary).join("\n"));
}

export async function main(): Promise<void> {
  try {
    await run();
  } catch (e) {
    const err = e as Error;
    core.setFailed(err instanceof ConfigError ? `Invalid policy file: ${err.message}` : err.message);
  }
}
