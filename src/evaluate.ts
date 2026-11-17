import type { Policy } from "./config";
import { findIssueRefs, hasDisclosure, readChecklist, withoutSection } from "./markdown";

/**
 * At most this many issue references are looked up, so a description stuffed with `#1 #2 ...`
 * cannot burn through the repository's API quota.
 */
export const MAX_ISSUE_LOOKUPS = 3;

export interface PullRequestInfo {
  number: number;
  author: string;
  /** "User", "Bot" or "Organization". */
  authorType: string;
  association: string;
  body: string;
  labels: string[];
  /** Draft PRs are skipped when `exempt.drafts` is on. */
  draft?: boolean;
}

export interface IssueInfo {
  state: "open" | "closed";
  isPullRequest: boolean;
  labels: string[];
}

/** What the rules need to look up. Implemented with the GitHub API in github.ts and with fakes in tests. */
export interface RepoData {
  owner: string;
  repo: string;
  /** Host name of the GitHub server, for recognising issue URLs. Defaults to github.com. */
  host?: string;
  getIssue(number: number): Promise<IssueInfo | null>;
  /** Open pull requests in this repository authored by `login`, including the current one. */
  countOpenPullRequests(login: string): Promise<number>;
  /** Paths the PR adds, changes, removes or renames (both old and new names for renames). */
  listChangedFiles(number: number): Promise<string[]>;
}

export type RuleId = "linked_issue" | "open_pr_limit" | "checklist" | "disclosure" | "workflow_changes";

/**
 * A failed rule. Messages are built only from the policy, numbers and the author's login,
 * never from text the PR author wrote, because they are posted under the bot's name.
 */
export interface Violation {
  rule: RuleId;
  /** One sentence telling the contributor what to change. */
  message: string;
}

export interface Evaluation {
  /** Why the PR was skipped, or null when the rules ran. */
  exemptReason: string | null;
  violations: Violation[];
  /** Rules that ran and passed. */
  passed: RuleId[];
}

const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const hasLabel = (labels: string[], label: string) => labels.some((l) => sameLabel(l, label));

export function exemptReason(pr: PullRequestInfo, policy: Policy): string | null {
  const { exempt } = policy;
  if (exempt.drafts && pr.draft) return "the PR is a draft (it will be checked when it's marked ready for review)";
  if (exempt.bots && (pr.authorType === "Bot" || pr.author.endsWith("[bot]"))) return `@${pr.author} is a bot`;
  if (exempt.users.some((u) => u.toLowerCase() === pr.author.toLowerCase())) return `@${pr.author} is on the exempt list`;
  if ((exempt.associations as string[]).includes(pr.association)) return `@${pr.author} is a ${pr.association.toLowerCase()}`;
  const label = exempt.labels.find((l) => hasLabel(pr.labels, l));
  if (label) return `the PR has the "${label}" label`;
  return null;
}

async function checkLinkedIssue(pr: PullRequestInfo, policy: Policy, data: RepoData): Promise<Violation | null> {
  const rule = policy.rules.linked_issue;
  const refs = findIssueRefs(pr.body, data.owner, data.repo, data.host).filter((r) => r.number !== pr.number);
  if (refs.length === 0) {
    return {
      rule: "linked_issue",
      message: "Link the issue this PR addresses, for example by adding `Fixes #123` to the description. If there is no issue yet, please open one first so the change can be discussed.",
    };
  }
  const problems: string[] = [];
  for (const { number } of refs.slice(0, MAX_ISSUE_LOOKUPS)) {
    const issue = await data.getIssue(number);
    // Numbers are shown in code spans so the bot doesn't cross-reference issues the PR author picked.
    const ref = `\`#${number}\``;
    if (!issue) problems.push(`${ref} does not exist`);
    else if (issue.isPullRequest) problems.push(`${ref} is a pull request, not an issue`);
    else if (rule.require_open && issue.state !== "open") problems.push(`${ref} is closed`);
    else if (rule.require_label && !hasLabel(issue.labels, rule.require_label)) problems.push(`${ref} does not have the "${rule.require_label}" label yet`);
    else return null; // one valid issue is enough
  }
  if (refs.length > MAX_ISSUE_LOOKUPS) problems.push(`only the first ${MAX_ISSUE_LOOKUPS} references were checked`);
  const needs = [rule.require_open && "open", rule.require_label && `labelled "${rule.require_label}"`].filter(Boolean).join(" and ");
  return {
    rule: "linked_issue",
    message: `Link an ${needs ? `${needs} ` : ""}issue in this repository. Checked: ${problems.join("; ")}.`,
  };
}

async function checkOpenPrLimit(pr: PullRequestInfo, policy: Policy, data: RepoData): Promise<Violation | null> {
  const rule = policy.rules.open_pr_limit;
  if (!(rule.applies_to as string[]).includes(pr.association)) return null;
  const open = await data.countOpenPullRequests(pr.author);
  if (open <= rule.max) return null;
  const others = open - 1;
  return {
    rule: "open_pr_limit",
    message: `New contributors can have at most ${rule.max} open pull request${rule.max === 1 ? "" : "s"} here, and @${pr.author} has ${open}. Please wait for your other PR${others === 1 ? "" : "s"} to be reviewed, or close ${others === 1 ? "it" : "some"} first.`,
  };
}

function checkChecklist(pr: PullRequestInfo, policy: Policy): Violation | null {
  const rule = policy.rules.checklist;
  const { disclosure } = policy.rules;
  // The disclosure section usually offers pick-one boxes, so it is not part of the checklist.
  // When disclosure is off, only a real markdown heading with that name is set aside.
  const list = readChecklist(withoutSection(pr.body, disclosure.heading, !disclosure.enabled));
  const total = list.checked.length + list.unchecked.length;
  if (total < rule.min_items) {
    return {
      rule: "checklist",
      message: `The PR description should keep the checklist from the pull request template (found ${total} of at least ${rule.min_items} items).`,
    };
  }
  if (rule.require_all_checked && list.unchecked.length > 0) {
    const n = list.unchecked.length;
    return {
      rule: "checklist",
      message: `${n} of ${total} checklist item${total === 1 ? " is" : "s are"} not ticked yet. Tick each one, or explain in the description why it does not apply.`,
    };
  }
  return null;
}

function checkDisclosure(pr: PullRequestInfo, policy: Policy): Violation | null {
  const { heading } = policy.rules.disclosure;
  const result = hasDisclosure(pr.body, heading);
  if (result.answered) return null;
  return {
    rule: "disclosure",
    message: result.found
      ? `Fill in the "${heading}" section of the description.`
      : `Add a section called "${heading}" to the description saying whether and how AI tools were used (for example \`${heading}: none\`).`,
  };
}

async function checkWorkflowChanges(pr: PullRequestInfo, policy: Policy, data: RepoData): Promise<Violation | null> {
  const prefixes = policy.rules.workflow_changes.paths.map((p) => p.toLowerCase());
  const files = await data.listChangedFiles(pr.number);
  const touched = files.filter((f) => prefixes.some((p) => f.toLowerCase().startsWith(p)));
  if (!touched.length) return null;
  // File names come from the PR author, so they are not repeated in the bot's message.
  return {
    rule: "workflow_changes",
    message: `This PR changes ${touched.length} workflow or action file${touched.length === 1 ? "" : "s"}. Changes like these can alter the repository's automation, including this check, so a maintainer needs to review them first (they can add the skip label once they have).`,
  };
}

export async function evaluate(pr: PullRequestInfo, policy: Policy, data: RepoData): Promise<Evaluation> {
  const reason = exemptReason(pr, policy);
  if (reason) return { exemptReason: reason, violations: [], passed: [] };

  const result: Evaluation = { exemptReason: null, violations: [], passed: [] };
  const run = async (id: RuleId, enabled: boolean, check: () => Promise<Violation | null> | Violation | null) => {
    if (!enabled) return;
    const v = await check();
    if (v) result.violations.push(v);
    else result.passed.push(id);
  };
  const { rules } = policy;
  await run("workflow_changes", rules.workflow_changes.enabled, () => checkWorkflowChanges(pr, policy, data));
  await run("linked_issue", rules.linked_issue.enabled, () => checkLinkedIssue(pr, policy, data));
  await run("open_pr_limit", rules.open_pr_limit.enabled, () => checkOpenPrLimit(pr, policy, data));
  await run("checklist", rules.checklist.enabled, () => checkChecklist(pr, policy));
  await run("disclosure", rules.disclosure.enabled, () => checkDisclosure(pr, policy));
  return result;
}
