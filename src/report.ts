import type { Policy } from "./config";
import type { Evaluation, RuleId } from "./evaluate";

/** Hidden marker that identifies the gateway's own comment so it is edited instead of duplicated. */
export const MARKER = "<!-- contribution-gateway -->";

export const RULE_TITLES: Record<RuleId, string> = {
  linked_issue: "Linked issue",
  open_pr_limit: "Open pull requests",
  checklist: "Checklist",
  disclosure: "Disclosure",
  workflow_changes: "Workflow files",
};

/** GitHub rejects comments over 65,536 characters; stay safely below. */
export const MAX_COMMENT_LENGTH = 60_000;

export function truncate(text: string, max = MAX_COMMENT_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 40)}\n\n…(truncated)`;
}

export function failureComment(author: string, evaluation: Evaluation, policy: Policy, closed: boolean): string {
  return truncate(buildFailureComment(author, evaluation, policy, closed));
}

function buildFailureComment(author: string, evaluation: Evaluation, policy: Policy, closed: boolean): string {
  const lines = [MARKER, "### Contribution checks: changes needed", ""];
  if (policy.on_violation.intro.trim()) lines.push(policy.on_violation.intro.trim(), "");
  lines.push(`Thanks for the pull request, @${author}! Before a maintainer reviews it, please fix the following:`, "");
  for (const v of evaluation.violations) lines.push(`- **${RULE_TITLES[v.rule]}:** ${v.message}`);
  lines.push("");
  if (closed) {
    lines.push("This pull request was closed automatically. Once the points above are fixed, reopen it (or ask a maintainer to) and the checks will run again.");
  } else {
    lines.push("The checks run again when you edit the description or push a commit, and this comment will update.");
  }
  lines.push("", "<sub>Posted by contribution-gateway, using the rules in this repository's policy file.</sub>");
  return lines.join("\n");
}

/** Replaces an earlier failure comment once the PR passes or becomes exempt. */
export function passComment(exemptReason: string | null = null): string {
  const text = exemptReason
    ? `The contribution checks no longer apply to this pull request because ${exemptReason}.`
    : "Thanks for the updates! Everything required is in place, and a maintainer will review this pull request.";
  return [MARKER, exemptReason ? "### Contribution checks skipped" : "### Contribution checks passed", "", text].join("\n");
}

/** Plain-text summary for logs. */
export function summarize(evaluation: Evaluation): string {
  if (evaluation.exemptReason) return `Skipped: ${evaluation.exemptReason}.`;
  if (evaluation.violations.length === 0) {
    return evaluation.passed.length ? `All checks passed (${evaluation.passed.join(", ")}).` : "No rules are enabled.";
  }
  return [
    `${evaluation.violations.length} check(s) failed:`,
    ...evaluation.violations.map((v) => `- ${RULE_TITLES[v.rule]}: ${v.message}`),
  ].join("\n");
}
