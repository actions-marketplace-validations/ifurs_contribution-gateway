import { describe, expect, it } from "vitest";
import { resolveTargets, statusDescription, type TargetLookup } from "../src/targets";

function lookup(result: number[] = [], sweep: number[] = []): TargetLookup & { calls: string[] } {
  const l = {
    calls: [] as string[],
    sweepCandidates: async (scan: number) => {
      l.calls.push(`sweep:${scan}`);
      return sweep;
    },
    findOpenPullRequests: async (owner: string, branch: string) => {
      l.calls.push(`${owner}:${branch}`);
      return result;
    },
  };
  return l;
}

describe("resolveTargets", () => {
  it("uses the payload PR for pull_request_target and reports through the job", async () => {
    expect(await resolveTargets("pull_request_target", { pull_request: { number: 7 } }, "", lookup())).toEqual({ numbers: [7], report: "job" });
  });

  it("uses PRs listed in a workflow_run payload (same-repository branches)", async () => {
    const l = lookup();
    const payload = { workflow_run: { event: "pull_request", pull_requests: [{ number: 3 }, { number: 3 }] } };
    expect(await resolveTargets("workflow_run", payload, "", l)).toEqual({ numbers: [3], report: "status" });
    expect(l.calls).toEqual([]);
  });

  it("looks up fork PRs by head owner and branch", async () => {
    const l = lookup([12]);
    const payload = {
      workflow_run: { event: "pull_request", pull_requests: [], head_branch: "fix-typo", head_repository: { owner: { login: "someone" } } },
    };
    expect(await resolveTargets("workflow_run", payload, "", l)).toEqual({ numbers: [12], report: "status" });
    expect(l.calls).toEqual(["someone:fix-typo"]);
  });

  it("skips workflow_run events not caused by a pull request, or with no open PR", async () => {
    const push = await resolveTargets("workflow_run", { workflow_run: { event: "push" } }, "", lookup());
    expect(push.numbers).toEqual([]);
    expect(push.skip).toMatch(/"push"/);
    const gone = await resolveTargets(
      "workflow_run",
      { workflow_run: { event: "pull_request", head_branch: "b", head_repository: { owner: { login: "o" } } } },
      "",
      lookup([]),
    );
    expect(gone.skip).toMatch(/no open pull request from o:b/);
  });

  it("uses the pull-request input for manual runs", async () => {
    expect(await resolveTargets("workflow_dispatch", {}, " 42 ", lookup())).toEqual({ numbers: [42], report: "status" });
    expect((await resolveTargets("workflow_dispatch", {}, "", lookup())).skip).toMatch(/pull-request input/);
    await expect(resolveTargets("workflow_dispatch", {}, "abc", lookup())).rejects.toThrow(/PR number/);
  });

  it("rejects unsupported events", async () => {
    await expect(resolveTargets("push", {}, "", lookup())).rejects.toThrow(/not supported/);
  });
});

describe("statusDescription", () => {
  it("keeps descriptions within GitHub's 140 characters", () => {
    expect(statusDescription("x".repeat(500))).toHaveLength(140);
    expect(statusDescription("short")).toBe("short");
  });
});
