// Runs the real main flow (src/main.ts + src/github.ts) against a stateful fake GitHub API,
// including multi-run sequences, both modes, failures and the security protections.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, MAX_RESULTS_PER_HOUR } from "../src/main";
import { MARKER } from "../src/report";
import { gatewayComments, latestStatus, newState, OWNER, REPO, startMockGitHub, type MockServer, type MockState } from "./support/mock-github";

const GOOD = "Fixes #1\n\n- [x] I ran the tests";
const BAD = "Please merge";

let server: MockServer;
let state: MockState;

beforeEach(async () => {
  state = newState({ issues: { 1: { state: "open" } } });
  server = await startMockGitHub(state);
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

interface RunResult {
  failed: boolean;
  log: string;
  outputs: Record<string, string>;
}

async function runGateway(eventName: string, payload: Record<string, unknown>, inputs: Record<string, string> = {}): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "cg-int-"));
  const outFile = join(dir, "out.txt");
  writeFileSync(outFile, "");
  writeFileSync(join(dir, "summary.md"), "");
  const env: Record<string, string> = {
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    "INPUT_GITHUB-TOKEN": "ghs_testtoken",
    "INPUT_CONFIG-PATH": "",
    "INPUT_PULL-REQUEST": "",
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let log = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    log += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  try {
    await main({ eventName, payload, owner: OWNER, repo: REPO, runId: 77, serverUrl: "https://github.com", apiUrl: server.url, retryAfterMs: 1 });
  } finally {
    write.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const failed = process.exitCode === 1;
  process.exitCode = undefined;
  const outputs: Record<string, string> = {};
  for (const m of readFileSync(outFile, "utf8").matchAll(/^(\S+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm)) outputs[m[1]!] = m[3]!;
  return { failed, log, outputs };
}

const forkRun = (owner: string, branch: string) => ({
  workflow_run: { event: "pull_request", pull_requests: [], head_branch: branch, head_repository: { owner: { login: owner } } },
});
const sameRepoRun = (...numbers: number[]) => ({ workflow_run: { event: "pull_request", pull_requests: numbers.map((number) => ({ number })) } });

describe("two-workflow mode: a contributor's journey", () => {
  it("fails, then passes after the fix, reusing one comment and removing the label", async () => {
    state.prs[5] = { body: BAD, headSha: "c1", author: "newbie", headOwner: "newbie", headRef: "fix-typo" };

    const first = await runGateway("workflow_run", forkRun("newbie", "fix-typo"));
    expect(first.failed).toBe(false); // the status carries the result, not the job
    expect(latestStatus(state, "c1")).toMatchObject({ state: "failure", target_url: `https://github.com/${OWNER}/${REPO}/actions/runs/77` });
    expect(latestStatus(state, "c1")!.description).toMatch(/^Needs changes: Linked issue/);
    expect(gatewayComments(state, 5)).toHaveLength(1);
    expect(gatewayComments(state, 5)[0]!.body).toContain("Thanks for the pull request, @newbie!");
    expect(state.prs[5]!.labels).toEqual(["needs-policy-fixes"]);
    expect(first.outputs.passed).toBe("false");
    expect(JSON.parse(first.outputs.violations!)[0]).toMatchObject({ pull_request: 5, rule: "linked_issue" });

    state.prs[5]!.body = GOOD; // the contributor edits the description
    const second = await runGateway("workflow_run", forkRun("newbie", "fix-typo"));
    expect(second.outputs.passed).toBe("true");
    expect(latestStatus(state, "c1")).toMatchObject({ state: "success", description: "All contribution checks passed" });
    expect(gatewayComments(state, 5)).toHaveLength(1);
    expect(gatewayComments(state, 5)[0]!.body).toContain("Contribution checks passed");
    expect(state.prs[5]!.labels).toEqual([]);
  });

  it("posts nothing on a PR that passes the first time", async () => {
    state.prs[6] = { body: GOOD, headSha: "c2" };
    await runGateway("workflow_run", sameRepoRun(6));
    expect(latestStatus(state, "c2")!.state).toBe("success");
    expect(gatewayComments(state, 6)).toHaveLength(0);
    expect(state.calls.some((c) => c.startsWith("DELETE"))).toBe(true); // label removal is attempted, 404 is fine
  });

  it("ignores a marker comment written by a user, and posts its own", async () => {
    state.prs[7] = { body: BAD, headSha: "c3" };
    state.comments[7] = [{ id: 1, body: `${MARKER}\n### Contribution checks passed`, user: { login: "user7", type: "User" } }];
    await runGateway("workflow_run", sameRepoRun(7));
    expect(gatewayComments(state, 7)).toHaveLength(1);
    expect(state.comments[7]![0]!.body).toContain("checks passed"); // the user's comment is untouched
  });

  it("skips drafts with a green status and checks them when ready for review", async () => {
    state.prs[8] = { body: BAD, headSha: "c4", draft: true };
    await runGateway("workflow_run", sameRepoRun(8));
    expect(latestStatus(state, "c4")).toMatchObject({ state: "success" });
    expect(latestStatus(state, "c4")!.description).toMatch(/^Skipped: the PR is a draft/);
    state.prs[8]!.draft = false;
    await runGateway("workflow_run", sameRepoRun(8));
    expect(latestStatus(state, "c4")!.state).toBe("failure");
  });

  it("clears an earlier failure when a maintainer adds the skip label", async () => {
    state.prs[9] = { body: BAD, headSha: "c5" };
    await runGateway("workflow_run", sameRepoRun(9));
    state.prs[9]!.labels = [...state.prs[9]!.labels!, "skip-gateway"];
    await runGateway("workflow_run", sameRepoRun(9));
    expect(latestStatus(state, "c5")!.description).toMatch(/^Skipped: the PR has the "skip-gateway" label/);
    expect(gatewayComments(state, 9)[0]!.body).toContain("Contribution checks skipped");
    expect(state.prs[9]!.labels).toEqual(["skip-gateway"]);
  });
});

describe("policy", () => {
  it("reads the policy from each PR's base branch, never from the PR", async () => {
    state.policy.main = "rules: { checklist: { min_items: 2 } }";
    state.policy.legacy = "rules: { linked_issue: { enabled: false }, checklist: { enabled: false } }";
    state.prs[10] = { body: "Fixes #1\n- [x] one", headSha: "p1", baseRef: "main", files: [".github/contribution-gateway.yml"] };
    state.prs[11] = { body: "no issue", headSha: "p2", baseRef: "legacy" };
    await runGateway("workflow_run", sameRepoRun(10, 11));
    expect(latestStatus(state, "p1")!.description).toMatch(/Checklist/);
    expect(latestStatus(state, "p2")!.state).toBe("success");
  });

  it("dry-run posts a green 'not enforced' status and no comment or label", async () => {
    state.policy.main = "mode: dry-run";
    state.prs[12] = { body: BAD, headSha: "d1" };
    await runGateway("workflow_run", sameRepoRun(12));
    expect(latestStatus(state, "d1")).toMatchObject({ state: "success" });
    expect(latestStatus(state, "d1")!.description).toMatch(/^Dry run, not enforced: /);
    expect(gatewayComments(state, 12)).toHaveLength(0);
    expect(state.prs[12]!.labels ?? []).toEqual([]);
  });

  it("closes failing PRs when the policy says so", async () => {
    state.policy.main = "on_violation: { close: true }";
    state.prs[13] = { body: BAD, headSha: "x1" };
    await runGateway("workflow_run", sameRepoRun(13));
    expect(state.prs[13]!.state).toBe("closed");
    expect(gatewayComments(state, 13)[0]!.body).toContain("closed automatically");
  });

  it("fails the run with a clear message for an invalid policy", async () => {
    state.policy.main = "mode: loud";
    state.prs[14] = { body: GOOD, headSha: "x2" };
    const r = await runGateway("workflow_run", sameRepoRun(14));
    expect(r.failed).toBe(true);
    expect(r.log).toContain("Invalid policy file: mode must be");
  });

  it("enforces the opt-in open-PR limit across the repository", async () => {
    state.policy.main = "rules: { open_pr_limit: { enabled: true } }";
    state.prs[15] = { body: GOOD, headSha: "o1", author: "eager" };
    state.prs[16] = { body: GOOD, headSha: "o2", author: "eager" };
    await runGateway("workflow_run", sameRepoRun(15));
    expect(gatewayComments(state, 15)[0]!.body).toContain("@eager has 2");
  });
});

describe("security protections", () => {
  it("fails a PR that touches workflows, including renaming a workflow away", async () => {
    state.prs[20] = { body: GOOD, headSha: "w1", files: [{ filename: "docs/old-trigger.yml", previous_filename: ".github/workflows/trigger.yml" }] };
    await runGateway("workflow_run", sameRepoRun(20));
    expect(latestStatus(state, "w1")).toMatchObject({ state: "failure", description: "Needs changes: Workflow files (see the PR comment)" });
    expect(gatewayComments(state, 20)[0]!.body).not.toContain("trigger.yml");
  });

  it("judges PRs that share a head commit together", async () => {
    state.prs[21] = { body: GOOD, headSha: "shared", association: "MEMBER" };
    state.prs[22] = { body: BAD, headSha: "shared", author: "copycat", headOwner: "copycat", headRef: "same" };
    await runGateway("workflow_run", sameRepoRun(21)); // the maintainer's PR triggers it
    expect(latestStatus(state, "shared")).toMatchObject({ state: "failure", description: "Needs changes in PR #22 (these PRs share this commit)" });
    expect(gatewayComments(state, 22)).toHaveLength(1);
  });

  it("only acts on the fork PR whose head really matches the run", async () => {
    state.prs[23] = { body: BAD, headSha: "f1", headOwner: "someone", headRef: "patch-1" };
    const r = await runGateway("workflow_run", forkRun("someone", "patch"));
    expect(r.log).toContain("no open pull request from someone:patch");
    expect(state.statuses.f1).toBeUndefined();
  });

  it("pauses a PR after too many results in an hour, without evaluating it", async () => {
    state.prs[24] = { body: GOOD, headSha: "busy" };
    const now = Date.now();
    state.statuses.busy = Array.from({ length: MAX_RESULTS_PER_HOUR }, (_, i) => ({
      state: "success", description: "All contribution checks passed", context: "contribution-gateway", created_at: new Date(now - i * 60_000).toISOString(),
    }));
    await runGateway("workflow_run", sameRepoRun(24));
    expect(latestStatus(state, "busy")!.description).toMatch(/^Paused:/);
    expect(state.calls.some((c) => c.includes("/files"))).toBe(false);
    const calls = state.calls.length;
    await runGateway("workflow_run", sameRepoRun(24)); // already paused: no new writes
    expect(state.calls.slice(calls).filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("writes the status before the comment, so a refused comment still leaves a red check", async () => {
    state.prs[25] = { body: BAD, headSha: "deny" };
    state.failures.push({ method: "POST", path: /\/issues\/25\/comments$/, status: 403, times: Infinity });
    const r = await runGateway("workflow_run", sameRepoRun(25));
    expect(latestStatus(state, "deny")!.state).toBe("failure");
    expect(r.failed).toBe(true);
    expect(r.log).toContain("pull-requests: write");
  });

  it("retries GitHub server errors", async () => {
    state.prs[26] = { body: GOOD, headSha: "flaky" };
    state.failures.push({ method: "POST", path: /\/statuses\/flaky$/, status: 502, times: 2 });
    const r = await runGateway("workflow_run", sameRepoRun(26));
    expect(r.failed).toBe(false);
    expect(latestStatus(state, "flaky")!.state).toBe("success");
  });

  it("with a personal access token, recognises its own comments by login", async () => {
    state.prs[28] = { body: BAD, headSha: "pat" };
    await runGateway("workflow_run", sameRepoRun(28), { "github-token": "ghp_personal" });
    state.prs[28]!.body = GOOD;
    await runGateway("workflow_run", sameRepoRun(28), { "github-token": "ghp_personal" });
    const ours = (state.comments[28] ?? []).filter((c) => c.user.login === "maintainer-pat");
    expect(ours).toHaveLength(1);
    expect(ours[0]!.body).toContain("Contribution checks passed");
  });

  it("reports linked issues that don't exist or are pull requests", async () => {
    state.prs[29] = { body: "Fixes #404 and #28\n- [x] ok", headSha: "refs" };
    state.prs[28] = { body: GOOD, headSha: "other" };
    await runGateway("workflow_run", sameRepoRun(29));
    const body = gatewayComments(state, 29)[0]!.body;
    expect(body).toContain("`#404` does not exist");
    expect(body).toContain("`#28` is a pull request");
  });

  it("doesn't call GET /user with an installation token", async () => {
    state.prs[27] = { body: BAD, headSha: "u1" };
    await runGateway("workflow_run", sameRepoRun(27));
    expect(state.calls.some((c) => c.startsWith("GET /user"))).toBe(false);
  });
});

describe("scheduled sweep", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("checks PRs with no result, paused results, or changes since the result", async () => {
    const result = (description: string, createdMinutesAgo: number) => [
      { state: "success", description, context: "contribution-gateway", created_at: minutesAgo(createdMinutesAgo) },
    ];
    state.prs[30] = { body: BAD, headSha: "none", updatedAt: minutesAgo(5) }; // no result: trigger never ran
    state.prs[31] = { body: BAD, headSha: "stale", updatedAt: minutesAgo(1) }; // edited after its result
    state.statuses.stale = result("All contribution checks passed", 10);
    state.prs[32] = { body: GOOD, headSha: "ours", updatedAt: minutesAgo(9) }; // only our own follow-up writes
    state.statuses.ours = result("All contribution checks passed", 10);
    state.prs[33] = { body: GOOD, headSha: "paused", updatedAt: minutesAgo(30) };
    state.statuses.paused = [...result("Paused: updated too often", 20), ...Array(30).fill(result("x", 25)[0])];

    await runGateway("schedule", {});
    expect(latestStatus(state, "none")!.state).toBe("failure");
    expect(latestStatus(state, "stale")!.state).toBe("failure");
    expect(state.statuses.ours).toHaveLength(1);
    expect(latestStatus(state, "paused")!.description).toBe("All contribution checks passed"); // sweep ignores the budget
  });

  it("does nothing when every PR has an up-to-date result", async () => {
    state.prs[34] = { body: GOOD, headSha: "fine", updatedAt: minutesAgo(10) };
    state.statuses.fine = [{ state: "success", description: "ok", context: "contribution-gateway", created_at: minutesAgo(10) }];
    const r = await runGateway("schedule", {});
    expect(r.log).toContain("already has a result");
  });
});

describe("single-workflow mode and other triggers", () => {
  it("fails the job instead of setting a status", async () => {
    state.prs[40] = { body: BAD, headSha: "j1" };
    const r = await runGateway("pull_request_target", { pull_request: { number: 40 } });
    expect(r.failed).toBe(true);
    expect(r.log).toContain("PR #40:");
    expect(state.statuses.j1).toBeUndefined();
    state.prs[40]!.body = GOOD;
    expect((await runGateway("pull_request_target", { pull_request: { number: 40 } })).failed).toBe(false);
  });

  it("re-checks one PR by hand", async () => {
    state.prs[41] = { body: GOOD, headSha: "m1" };
    await runGateway("workflow_dispatch", {}, { "pull-request": "41" });
    expect(latestStatus(state, "m1")!.state).toBe("success");
  });

  it("skips closed PRs and rejects unsupported events", async () => {
    state.prs[42] = { body: BAD, headSha: "z1", state: "closed" };
    const closed = await runGateway("pull_request_target", { pull_request: { number: 42 } });
    expect(closed.failed).toBe(false);
    expect(closed.log).toContain("PR #42 is closed");
    const push = await runGateway("push", {});
    expect(push.failed).toBe(true);
    expect(push.log).toContain("not supported");
  });
});
