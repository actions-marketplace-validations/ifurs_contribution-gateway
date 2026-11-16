import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, parsePolicy, type Policy } from "../src/config";
import { evaluate, type IssueInfo, type PullRequestInfo, type RepoData } from "../src/evaluate";
import { failureComment, MARKER } from "../src/report";

function fakeRepo(issues: Record<number, IssueInfo>, openPrs = 1, files: string[] = []): RepoData {
  return {
    owner: "acme",
    repo: "widgets",
    getIssue: async (n) => issues[n] ?? null,
    countOpenPullRequests: async () => openPrs,
    listChangedFiles: async () => files,
  };
}

const openIssue: IssueInfo = { state: "open", isPullRequest: false, labels: [] };

function pr(over: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 100,
    author: "newbie",
    authorType: "User",
    association: "FIRST_TIME_CONTRIBUTOR",
    body: "Fixes #1\n\n- [x] Tests pass",
    labels: [],
    ...over,
  };
}

const policy = (yaml = ""): Policy => parsePolicy(yaml).policy;

describe("evaluate", () => {
  it("passes a well-formed PR", async () => {
    const r = await evaluate(pr(), policy(), fakeRepo({ 1: openIssue }));
    expect(r.violations).toEqual([]);
    expect(r.passed).toEqual(["workflow_changes", "linked_issue", "open_pr_limit", "checklist"]);
  });

  it("exempts maintainers, bots, listed users and labels", async () => {
    const p = policy("exempt: { users: [Friend] }");
    const repo = fakeRepo({});
    expect((await evaluate(pr({ association: "MEMBER", body: "" }), p, repo)).exemptReason).toMatch(/member/);
    expect((await evaluate(pr({ author: "dependabot[bot]", authorType: "Bot" }), p, repo)).exemptReason).toMatch(/bot/);
    expect((await evaluate(pr({ author: "friend" }), p, repo)).exemptReason).toMatch(/exempt list/);
    expect((await evaluate(pr({ labels: ["skip-gateway"] }), p, repo)).exemptReason).toMatch(/skip-gateway/);
  });

  it("requires a linked issue that exists, is open, is not a PR and has the label", async () => {
    const p = policy("rules: { linked_issue: { require_label: accepted } }");
    const repo = fakeRepo({
      2: { ...openIssue, state: "closed" },
      3: { ...openIssue, isPullRequest: true },
      4: openIssue,
      5: { ...openIssue, labels: ["accepted"] },
    });
    const msg = async (body: string) => (await evaluate(pr({ body }), p, repo)).violations.find((v) => v.rule === "linked_issue")?.message;
    expect(await msg("no reference")).toMatch(/Link the issue/);
    expect(await msg("Fixes #2")).toMatch(/`#2` is closed/);
    expect(await msg("Fixes #3")).toMatch(/`#3` is a pull request/);
    expect(await msg("Fixes #4")).toMatch(/`#4` does not have the "accepted" label/);
    expect(await msg("Fixes #9")).toMatch(/`#9` does not exist/);
    expect(await msg("Fixes #4 and #5")).toBeUndefined();
  });

  it("does not count the PR's own number as a linked issue", async () => {
    const r = await evaluate(pr({ body: "This is #100" }), policy(), fakeRepo({}));
    expect(r.violations.map((v) => v.rule)).toContain("linked_issue");
  });

  it("limits open PRs only for the configured associations", async () => {
    const tooMany = fakeRepo({ 1: openIssue }, 3);
    const r = await evaluate(pr(), policy(), tooMany);
    expect(r.violations).toEqual([{ rule: "open_pr_limit", message: expect.stringContaining("has 3") }]);
    const returning = await evaluate(pr({ association: "CONTRIBUTOR" }), policy(), tooMany);
    expect(returning.violations).toEqual([]);
  });

  it("checks the checklist and the disclosure section", async () => {
    const p = policy("rules: { checklist: { min_items: 2 }, disclosure: { enabled: true } }");
    const repo = fakeRepo({ 1: openIssue });
    const rules = async (body: string) => (await evaluate(pr({ body }), p, repo)).violations.map((v) => v.rule);
    expect(await rules("Fixes #1\n- [x] a")).toEqual(["checklist", "disclosure"]);
    expect(await rules("Fixes #1\n- [x] a\n- [ ] b\nAI usage: none")).toEqual(["checklist"]);
    expect(await rules("Fixes #1\n- [x] a\n- [x] b\nAI usage: none")).toEqual([]);
  });

  it("does not count the disclosure section's pick-one boxes as checklist items", async () => {
    const template = readFileSync(new URL("../examples/pull_request_template.md", import.meta.url), "utf8");
    const filled = template
      .replace("Fixes #<!-- issue number -->", "Fixes #1")
      .replaceAll("- [ ] I", "- [x] I")
      .replace("- [ ] None", "- [x] None");
    const p = policy("rules: { checklist: { min_items: 3 }, disclosure: { enabled: true } }");
    const repo = fakeRepo({ 1: openIssue });
    expect((await evaluate(pr({ body: filled }), p, repo)).violations).toEqual([]);
    const untouched = (await evaluate(pr({ body: template }), p, repo)).violations.map((v) => v.rule);
    expect(untouched).toEqual(["linked_issue", "checklist", "disclosure"]);
  });

  it("skips disabled rules", async () => {
    const p = policy("rules: { linked_issue: { enabled: false }, open_pr_limit: { enabled: false }, checklist: { enabled: false }, workflow_changes: { enabled: false } }");
    const r = await evaluate(pr({ body: "" }), p, fakeRepo({}, 5));
    expect(r).toEqual({ exemptReason: null, violations: [], passed: [] });
  });
});

describe("parsePolicy", () => {
  it("uses defaults for an empty or missing file", () => {
    expect(parsePolicy(undefined).policy.mode).toBe("enforce");
    expect(parsePolicy("").policy.rules.open_pr_limit.max).toBe(1);
  });

  it("warns about unknown keys", () => {
    expect(parsePolicy("rules: { typo_rule: {} }").warnings).toEqual(['Unknown config key "rules.typo_rule" ignored']);
  });

  it("rejects wrong types and values", () => {
    expect(() => parsePolicy("mode: loud")).toThrow(ConfigError);
    expect(() => parsePolicy("rules: { open_pr_limit: { max: 0 } }")).toThrow(/max/);
    expect(() => parsePolicy("rules: { checklist: { enabled: yes please } }")).toThrow(/boolean/);
    expect(() => parsePolicy("exempt: { associations: [ADMIN] }")).toThrow(/ADMIN/);
    expect(() => parsePolicy("rules: [")).toThrow(/YAML/);
  });
});

describe("failureComment", () => {
  it("starts with the marker and lists every violation", () => {
    const text = failureComment(
      "newbie",
      { exemptReason: null, passed: [], violations: [{ rule: "checklist", message: "Tick it." }] },
      policy("on_violation: { intro: 'Please read CONTRIBUTING.md.' }"),
      false,
    );
    expect(text.startsWith(MARKER)).toBe(true);
    expect(text).toContain("Please read CONTRIBUTING.md.");
    expect(text).toContain("- **Checklist:** Tick it.");
  });
});
