// Tests for the fixes from the production security review (v0.2.0).
import { describe, expect, it } from "vitest";
import { statusesByCommit, type PrOutcome } from "../src/aggregate";
import { parsePolicy } from "../src/config";
import { evaluate, type PullRequestInfo, type RepoData } from "../src/evaluate";
import { failureComment } from "../src/report";
import { resolveTargets, SWEEP_LIMIT } from "../src/targets";

const repo = (files: string[] = []): RepoData => ({
  owner: "acme",
  repo: "widgets",
  getIssue: async () => ({ state: "open", isPullRequest: false, labels: [] }),
  countOpenPullRequests: async () => 1,
  listChangedFiles: async () => files,
});

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 5,
  author: "outsider",
  authorType: "User",
  association: "NONE",
  body: "Fixes #1\n- [x] done",
  labels: [],
  ...over,
});

describe("workflow_changes rule", () => {
  const policy = parsePolicy("").policy;

  it("flags PRs that touch workflow or action files, without echoing file names", async () => {
    const files = ["src/a.ts", ".github/workflows/contribution-gateway-trigger.yml", ".GITHUB/Actions/x/action.yml"];
    const result = await evaluate(pr(), policy, repo(files));
    const v = result.violations.find((x) => x.rule === "workflow_changes");
    expect(v?.message).toContain("2 workflow or action files");
    expect(v?.message).not.toContain("trigger.yml");
    expect(failureComment("outsider", result, policy, false)).toContain("**Workflow files:**");
  });

  it("passes PRs that don't touch those paths, and never applies to maintainers", async () => {
    expect((await evaluate(pr(), policy, repo(["README.md", ".github/ISSUE_TEMPLATE/bug.md"]))).violations).toEqual([]);
    const maintainer = await evaluate(pr({ association: "MEMBER" }), policy, repo([".github/workflows/ci.yml"]));
    expect(maintainer.exemptReason).toMatch(/member/);
  });

  it("can be configured or disabled", async () => {
    const custom = parsePolicy("rules: { workflow_changes: { paths: [scripts/] } }").policy;
    expect((await evaluate(pr(), custom, repo(["scripts/release.sh"]))).violations.map((v) => v.rule)).toEqual(["workflow_changes"]);
    const off = parsePolicy("rules: { workflow_changes: { enabled: false } }").policy;
    expect((await evaluate(pr(), off, repo([".github/workflows/x.yml"]))).violations).toEqual([]);
  });
});

describe("bot comments don't cross-reference issues", () => {
  it("renders checked issue numbers as code", async () => {
    const r: RepoData = { ...repo(), getIssue: async () => null };
    const result = await evaluate(pr({ body: "Fixes #77" }), parsePolicy("").policy, r);
    expect(result.violations[0]!.message).toContain("`#77` does not exist");
  });
});

describe("statusesByCommit", () => {
  const outcome = (over: Partial<PrOutcome>): PrOutcome => ({
    number: 1,
    headSha: "aaa",
    passed: true,
    enforced: true,
    dryRun: false,
    violations: [],
    exemptReason: null,
    ...over,
  });
  const fail = [{ rule: "checklist" as const, message: "x" }];

  it("fails a shared commit if any PR on it fails, naming that PR", () => {
    const s = statusesByCommit([outcome({ number: 1 }), outcome({ number: 2, passed: false, violations: fail })]);
    expect(s.get("aaa")).toEqual({ state: "failure", description: "Needs changes in PR #2 (these PRs share this commit)" });
  });

  it("an exempt or passing PR can't turn a failing PR on the same commit green", () => {
    const s = statusesByCommit([outcome({ number: 1, exemptReason: "@x is a member" }), outcome({ number: 2, passed: false, violations: fail })]);
    expect(s.get("aaa")!.state).toBe("failure");
  });

  it("keeps separate commits separate", () => {
    const s = statusesByCommit([outcome({ headSha: "aaa" }), outcome({ number: 2, headSha: "bbb", passed: false, violations: fail })]);
    expect(s.get("aaa")).toEqual({ state: "success", description: "All contribution checks passed" });
    expect(s.get("bbb")).toEqual({ state: "failure", description: "Needs changes: Checklist (see the PR comment)" });
  });

  it("reports dry runs and unenforced failures as green but says so", () => {
    expect(statusesByCommit([outcome({ passed: false, enforced: false, dryRun: true, violations: fail })]).get("aaa")).toEqual({
      state: "success",
      description: "Dry run, not enforced: Checklist",
    });
    expect(statusesByCommit([outcome({ passed: false, enforced: false, violations: fail })]).get("aaa")!.description).toBe("Not enforced: Checklist");
  });

  it("shows the exemption reason for a single exempt PR", () => {
    expect(statusesByCommit([outcome({ exemptReason: "the PR has the \"skip-gateway\" label" })]).get("aaa")!.description).toMatch(/^Skipped:/);
  });
});

describe("scheduled sweep targets", () => {
  const lookup = (sweep: number[]) => ({
    findOpenPullRequests: async () => [],
    sweepCandidates: async (limit: number) => (limit === SWEEP_LIMIT ? sweep : []),
  });

  it("checks open PRs with no result yet, outside the per-PR budget", async () => {
    expect(await resolveTargets("schedule", {}, "", lookup([4, 9]))).toEqual({ numbers: [4, 9], report: "status", sweep: true });
  });

  it("does nothing when every PR already has a result", async () => {
    expect((await resolveTargets("schedule", {}, "", lookup([]))).skip).toMatch(/already has a result/);
  });
});
