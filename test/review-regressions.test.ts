// Regression tests for findings from the first code review.
import { describe, expect, it } from "vitest";
import { parsePolicy } from "../src/config";
import { evaluate, MAX_ISSUE_LOOKUPS, type IssueInfo, type PullRequestInfo, type RepoData } from "../src/evaluate";
import { findIssueRefs, hasDisclosure, readChecklist, withoutSection } from "../src/markdown";
import { failureComment, MAX_COMMENT_LENGTH, truncate } from "../src/report";

const openIssue: IssueInfo = { state: "open", isPullRequest: false, labels: [] };

function repo(issues: Record<number, IssueInfo> = {}): RepoData & { lookups: number } {
  const r = {
    owner: "acme",
    repo: "widgets",
    lookups: 0,
    getIssue: async (n: number) => {
      r.lookups++;
      return issues[n] ?? null;
    },
    countOpenPullRequests: async () => 1,
  };
  return r;
}

const pr = (over: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 100,
  author: "newbie",
  authorType: "User",
  association: "NONE",
  body: "Fixes #1",
  labels: [],
  ...over,
});

describe("API and size limits", () => {
  it("looks up at most MAX_ISSUE_LOOKUPS issue references", async () => {
    const body = Array.from({ length: 5000 }, (_, i) => `#${i + 2}`).join(" ");
    const r = repo();
    const result = await evaluate(pr({ body }), parsePolicy("").policy, r);
    expect(r.lookups).toBe(MAX_ISSUE_LOOKUPS);
    const message = result.violations[0]!.message;
    expect(message).toContain(`only the first ${MAX_ISSUE_LOOKUPS} references were checked`);
    expect(message.length).toBeLessThan(1000);
  });

  it("truncates comments below GitHub's limit", () => {
    expect(truncate("x".repeat(100_000)).length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(truncate("short")).toBe("short");
  });
});

describe("no author text in bot output", () => {
  it("does not echo checklist item text", async () => {
    const evil = "- [ ] @octocat <img src=x> [Verify](https://evil.example) **Approved** #42";
    const policy = parsePolicy("").policy;
    const result = await evaluate(pr({ body: `Fixes #1\n${evil}` }), policy, repo({ 1: openIssue }));
    const comment = failureComment("newbie", result, policy, false);
    for (const bad of ["@octocat", "<img", "evil.example", "Approved", "#42"]) expect(comment).not.toContain(bad);
    expect(comment).toContain("1 of 1 checklist item is not ticked yet");
  });
});

describe("disclosure section matching", () => {
  const untouched = (heading: string) => `${heading}\n<!-- say how -->\n- [ ] None\n- [ ] Some\n\n## Testing\nran it`;

  it("treats extra words in the heading as part of the heading, not an answer", () => {
    expect(hasDisclosure(untouched("## AI usage disclosure"), "AI usage").answered).toBe(false);
    expect(hasDisclosure(untouched("## AI usage (required)"), "AI usage").answered).toBe(false);
    expect(hasDisclosure("**AI usage:** none", "AI usage").answered).toBe(true);
  });

  it("ignores list items that mention the heading", () => {
    const body = `- [x] I filled in the AI usage section\n- [x] Tests pass\n${untouched("## AI usage")}`;
    expect(hasDisclosure(body, "AI usage")).toEqual({ found: true, answered: false });
    expect(readChecklist(withoutSection(body, "AI usage")).checked).toHaveLength(2);
  });

  it("only matches the heading at the start of a line, at a word boundary", () => {
    expect(hasDisclosure("No AI usage here.", "AI usage").found).toBe(false);
    expect(hasDisclosure("AI usageless", "AI usage").found).toBe(false);
  });

  it("does not strip plain lines from the checklist when disclosure is off", async () => {
    const policy = parsePolicy("").policy;
    const body = "Fixes #1\nAI usage: none\n- [ ] Tests pass\n- [ ] Read guide";
    const result = await evaluate(pr({ body }), policy, repo({ 1: openIssue }));
    expect(result.violations.map((v) => v.rule)).toEqual(["checklist"]);
  });

  it("handles setext headings and thematic breaks", () => {
    expect(hasDisclosure("AI usage\n--------\n- [ ] None\n\nTesting\n-------\nran it", "AI usage").answered).toBe(false);
    expect(hasDisclosure("## AI usage\n---\n## Next", "AI usage").answered).toBe(false);
    expect(hasDisclosure("AI usage\n========\nI used Copilot.", "AI usage").answered).toBe(true);
  });

  it("works with CRLF line endings", () => {
    expect(hasDisclosure("## AI usage\r\n- [ ] None\r\n- [x] Some\r\n", "AI usage").answered).toBe(true);
  });
});

describe("labels are case-insensitive", () => {
  it("exempt labels and required issue labels ignore case", async () => {
    const policy = parsePolicy("rules: { linked_issue: { require_label: accepted } }").policy;
    const exempt = await evaluate(pr({ labels: ["Skip-Gateway"] }), policy, repo());
    expect(exempt.exemptReason).toMatch(/skip-gateway/);
    const labelled = await evaluate(pr(), policy, repo({ 1: { ...openIssue, labels: ["Accepted"] } }));
    expect(labelled.violations).toEqual([]);
  });
});

describe("parser gaps", () => {
  it("ignores ~~~ fences and CRLF ``` fences", () => {
    expect(readChecklist("~~~\n- [ ] x\n#5\n~~~\n- [x] y").unchecked).toEqual([]);
    expect(findIssueRefs("```\r\n#5\r\n```\r\nFixes #6", "acme", "widgets")).toEqual([{ number: 6 }]);
  });

  it("requires a space after the box and reads blockquoted tasks", () => {
    expect(readChecklist("- [ ]foo\n> - [ ] quoted").unchecked).toEqual(["quoted"]);
  });

  it("recognises www.github.com and Enterprise Server URLs", () => {
    expect(findIssueRefs("https://www.github.com/acme/widgets/issues/7", "acme", "widgets")).toEqual([{ number: 7 }]);
    expect(findIssueRefs("https://git.corp.example/acme/widgets/issues/8", "acme", "widgets", "git.corp.example")).toEqual([{ number: 8 }]);
    expect(findIssueRefs("https://evil.example/acme/widgets/issues/9", "acme", "widgets")).toEqual([]);
  });
});

describe("config validation", () => {
  it("rejects a violation label that is also an exempt label", () => {
    expect(() => parsePolicy("on_violation: { label: Skip-Gateway }")).toThrow(/exempt/);
  });

  it("rejects very short disclosure headings even when disclosure is off", () => {
    expect(() => parsePolicy("rules: { disclosure: { heading: AI } }")).toThrow(/3 characters/);
  });
});
