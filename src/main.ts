import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { ConfigError, parsePolicy } from "./config";
import { evaluate } from "./evaluate";
import { GitHubRepo, httpStatus } from "./github";
import { failureComment, passComment, summarize } from "./report";

export async function run(): Promise<void> {
  const number = (context.payload.pull_request as { number?: number } | undefined)?.number;
  if (!number) {
    core.setFailed("contribution-gateway must run on pull_request_target events (it found no pull request in the event).");
    return;
  }

  const token = core.getInput("github-token", { required: true });
  const configPath = core.getInput("config-path") || ".github/contribution-gateway.yml";
  const { owner, repo } = context.repo;
  const host = new URL(context.serverUrl || "https://github.com").hostname;
  const gh = new GitHubRepo(getOctokit(token), owner, repo, host, core.warning);

  // Use the pull request as it is now, not the (possibly replayed or stale) event payload.
  const pr = await gh.getPullRequest(number);
  if (pr.state !== "open") {
    core.info(`PR #${pr.number} is ${pr.state}; nothing to check.`);
    return;
  }

  // The policy is read from the base branch through the API, never from the PR's own files,
  // so a contributor cannot loosen the rules inside their pull request.
  const configText = await gh.readFile(configPath, pr.baseRef);
  if (configText === undefined) core.info(`No ${configPath} on ${pr.baseRef}; using the default policy.`);
  const { policy, warnings } = parsePolicy(configText);
  warnings.forEach((w) => core.warning(w));

  const result = await evaluate(pr, policy, gh);
  const summary = summarize(result);
  core.info(summary);
  const passed = result.violations.length === 0;
  core.setOutput("passed", String(passed));
  core.setOutput("violations", JSON.stringify(result.violations));
  await core.summary.addHeading("Contribution gateway", 3).addCodeBlock(summary).write();

  if (policy.mode === "dry-run") {
    core.info("Dry-run mode: no comments, labels or status changes were made.");
    return;
  }

  const act = policy.on_violation;
  try {
    if (passed) {
      // Also covers PRs that became exempt (e.g. a maintainer added the skip label):
      // an earlier failure comment and label must not linger.
      if (act.comment) await gh.upsertComment(pr.number, passComment(result.exemptReason), false);
      if (act.label) await gh.setLabel(pr.number, act.label, false, pr.labels);
      return;
    }
    if (act.comment) await gh.upsertComment(pr.number, failureComment(pr.author, result, policy, act.close), true);
    if (act.label) await gh.setLabel(pr.number, act.label, true, pr.labels);
    if (act.close) await gh.closePullRequest(pr.number);
  } catch (e) {
    if (httpStatus(e) === 403) {
      throw new Error(
        "GitHub refused a write (403). For pull requests from forks, run this action on `pull_request_target` and grant `issues: write` and `pull-requests: write`.",
        { cause: e },
      );
    }
    throw e;
  }

  if (act.fail_check) core.setFailed(summary);
}

export async function main(): Promise<void> {
  try {
    await run();
  } catch (e) {
    const err = e as Error;
    core.setFailed(err instanceof ConfigError ? `Invalid policy file: ${err.message}` : err.message);
  }
}
