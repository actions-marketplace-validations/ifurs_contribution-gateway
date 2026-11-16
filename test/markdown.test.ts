import { describe, expect, it } from "vitest";
import { findIssueRefs, hasDisclosure, readChecklist } from "../src/markdown";

const refs = (body: string) => findIssueRefs(body, "acme", "widgets").map((r) => r.number);

describe("findIssueRefs", () => {
  it("finds short, qualified and URL references to the same repo", () => {
    expect(refs("Fixes #12")).toEqual([12]);
    expect(refs("closes acme/widgets#34")).toEqual([34]);
    expect(refs("See https://github.com/acme/widgets/issues/56")).toEqual([56]);
    expect(refs("See https://github.com/ACME/Widgets/issues/56")).toEqual([56]);
  });

  it("ignores other repos, comments, code, entities and words glued to #", () => {
    expect(refs("fixes other/repo#7 and https://github.com/other/repo/issues/8")).toEqual([]);
    expect(refs("<!-- e.g. Fixes #123 -->")).toEqual([]);
    expect(refs("run `git log #5` then\n```\n#6\n```")).toEqual([]);
    expect(refs("color&#123; issue#9")).toEqual([]);
  });

  it("deduplicates", () => {
    expect(refs("#3 #3 https://github.com/acme/widgets/issues/3")).toEqual([3]);
  });
});

describe("readChecklist", () => {
  it("reads ticked and unticked items", () => {
    const list = readChecklist("- [x] Tests pass\n* [ ] Docs updated\n1. [X] Read guide\n<!-- - [ ] hidden -->");
    expect(list.checked).toEqual(["Tests pass", "Read guide"]);
    expect(list.unchecked).toEqual(["Docs updated"]);
  });
});

describe("hasDisclosure", () => {
  it("accepts an inline answer", () => {
    expect(hasDisclosure("**AI usage:** none", "AI usage")).toEqual({ found: true, answered: true });
  });

  it("accepts a ticked box or text in the section", () => {
    expect(hasDisclosure("## AI usage\n- [ ] None\n- [x] Copilot autocomplete\n## Other", "AI usage").answered).toBe(true);
    expect(hasDisclosure("## AI usage\nClaude wrote the tests, I reviewed them.", "ai usage").answered).toBe(true);
  });

  it("rejects an untouched template section", () => {
    const body = "## AI usage\n<!-- Tell us how AI tools were used -->\n- [ ] None\n- [ ] Some\n\n## Testing\nran it";
    expect(hasDisclosure(body, "AI usage")).toEqual({ found: true, answered: false });
  });

  it("reports a missing section", () => {
    expect(hasDisclosure("Just a fix", "AI usage")).toEqual({ found: false, answered: false });
  });
});
