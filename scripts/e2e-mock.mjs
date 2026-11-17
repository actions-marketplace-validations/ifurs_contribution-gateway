// End-to-end checks for v0.2.0 against a mock GitHub API.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const actionDir = process.argv[2];
const GOOD = "Fixes #1\n- [x] tests";

/** prs: { [number]: { body, sha, files?, author? } } */
function scenario(name, { prs, eventName, payload, recentStatuses = 0, latestDescription = "", sweep = [], inputPr = "", expect }) {
  const calls = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      calls.push(`${req.method} ${p}${url.searchParams.get("head") ? "?head=" + url.searchParams.get("head") : ""}${data && req.method !== "GET" ? " " + data : ""}`);
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      let m;
      if (p === "/graphql") return json(200, { data: { repository: { pullRequests: { nodes: sweep.map((n) => typeof n === "number" ? ({ number: n, updatedAt: new Date().toISOString(), commits: { nodes: [{ commit: { status: null } }] } }) : ({ number: n.number, updatedAt: n.updatedAt, commits: { nodes: [{ commit: { status: { context: n.ctx } } }] } })) } } } });
      if (p.startsWith("/repos/acme/widgets/contents/")) return json(404, { message: "Not Found" });
      if (p === "/repos/acme/widgets/issues/1") return json(200, { state: "open", labels: [] });
      if ((m = p.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)$/)) && prs[m[1]]) {
        const pr = prs[m[1]];
        return json(200, { number: +m[1], state: "open", body: pr.body, author_association: "NONE", user: { login: pr.author ?? `user${m[1]}`, type: "User" }, labels: [], base: { ref: "main" }, head: { sha: pr.sha } });
      }
      if ((m = p.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)\/files$/))) return json(200, (prs[m[1]]?.files ?? ["src/x.ts"]).map((f) => ({ filename: f })));
      if (p === "/repos/acme/widgets/pulls" && url.searchParams.get("head")) return json(200, [{ number: 100, head: { ref: "fix", repo: { owner: { login: "forker" } } } }]);
      if (p === "/repos/acme/widgets/pulls") return json(200, Object.entries(prs).map(([n, pr]) => ({ number: +n, user: { login: pr.author ?? `user${n}` }, head: { sha: pr.sha } })));
      if ((m = p.match(/^\/repos\/acme\/widgets\/commits\/(\w+)\/statuses$/))) {
        const now = Date.now();
        return json(200, Array.from({ length: recentStatuses }, (_, i) => ({ context: "contribution-gateway", created_at: new Date(now - i * 60_000).toISOString(), description: i === 0 ? latestDescription : "x" })));
      }
      if (p.match(/\/issues\/\d+\/comments$/) && req.method === "GET") return json(200, []);
      if (req.method === "POST" || req.method === "PATCH") return json(201, {});
      if (req.method === "DELETE") return json(200, []);
      return json(404, { message: "Not Found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg2-"));
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify(payload ?? {}));
    writeFileSync(join(dir, "summary.md"), "");
    writeFileSync(join(dir, "output.txt"), "");
    const child = spawn(process.execPath, [join(actionDir, "dist/index.mjs")], {
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/widgets", GITHUB_RUN_ID: "9",
        GITHUB_SERVER_URL: "https://github.com", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_GRAPHQL_URL: `http://127.0.0.1:${server.address().port}/graphql`,
        "INPUT_GITHUB-TOKEN": "ghs_fake", "INPUT_PULL-REQUEST": inputPr, GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "output.txt") },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      server.close();
      const writes = calls.filter((c) => !c.startsWith("GET"));
      const problems = expect({ code, calls, writes, out });
      console.log(`${problems.length ? "FAIL" : "ok  "} ${name}  (exit ${code}, ${calls.length} API calls)`);
      for (const pb of problems) console.log(`      - ${pb}`);
      if (problems.length) { console.log(out.split("\n").filter((l) => !l.startsWith("::debug")).map((l) => "      | " + l).join("\n")); console.log("      calls:\n        " + calls.join("\n        ")); }
      resolve(problems.length);
    });
  }));
}

const has = (list, re) => list.some((c) => re.test(c));
const forkRun = { workflow_run: { event: "pull_request", pull_requests: [], head_branch: "fix", head_repository: { owner: { login: "forker" } } } };
let failures = 0;

failures += await scenario("PR editing a workflow fails workflow_changes", {
  prs: { 100: { body: GOOD, sha: "aaa", files: ["README.md", ".github/workflows/contribution-gateway-trigger.yml"] } },
  eventName: "workflow_run", payload: forkRun,
  expect: ({ code, writes }) => [
    code !== 0 && "gate job should not fail in status mode",
    !has(writes, /statuses\/aaa .*"state":"failure".*Workflow files/) && "expected red status mentioning Workflow files",
    !has(writes, /comments .*Workflow files/) && "expected comment mentioning Workflow files",
    has(writes, /trigger\.yml/) && "file name leaked into bot output",
  ].filter(Boolean),
});

failures += await scenario("compliant PR can't turn a shared commit green", {
  prs: { 100: { body: GOOD, sha: "shared" }, 101: { body: "nothing", sha: "shared" } },
  eventName: "workflow_run", payload: forkRun,
  expect: ({ writes, calls }) => [
    !has(calls, /GET \/repos\/acme\/widgets\/pulls\/101$/) && "PR #101 on the same commit was not evaluated",
    !has(writes, /statuses\/shared .*"state":"failure".*PR #101/) && "expected red status naming PR #101",
    has(writes, /statuses\/shared .*"state":"success"/) && "a green status was posted for the shared commit",
    writes.filter((w) => w.includes("/statuses/")).length !== 1 && "expected exactly one status write",
  ].filter(Boolean),
});

failures += await scenario("over-active PR is paused without evaluating", {
  prs: { 100: { body: GOOD, sha: "busy" } }, eventName: "workflow_run", payload: forkRun, recentStatuses: 20,
  expect: ({ writes, calls }) => [
    !has(writes, /statuses\/busy .*"state":"failure".*Paused:/) && "expected a Paused: red status",
    has(calls, /\/issues\/1$|\/files$|comments/) && "paused PR was still evaluated",
    calls.length > 5 && `paused run used ${calls.length} calls`,
  ].filter(Boolean),
});

failures += await scenario("already-paused PR costs no writes", {
  prs: { 100: { body: GOOD, sha: "busy" } }, eventName: "workflow_run", payload: forkRun, recentStatuses: 25, latestDescription: "Paused: updated too often",
  expect: ({ writes }) => [writes.length && `expected no writes, got ${writes.length}`].filter(Boolean),
});

failures += await scenario("scheduled sweep checks PRs without a result", {
  prs: { 100: { body: "nothing", sha: "s1" }, 101: { body: GOOD, sha: "s2" } }, eventName: "schedule", sweep: [100, 101], recentStatuses: 50,
  expect: ({ writes, calls }) => [
    !has(calls, /POST \/graphql/) && "sweep did not query candidates",
    !has(writes, /statuses\/s1 .*"state":"failure"/) && "expected red status for #100",
    !has(writes, /statuses\/s2 .*"state":"success"/) && "expected green status for #101 (sweep ignores the budget)",
  ].filter(Boolean),
});

failures += await scenario("single-workflow mode still fails the job", {
  prs: { 100: { body: "nothing", sha: "j1" } }, eventName: "pull_request_target", payload: { pull_request: { number: 100 } },
  expect: ({ code, writes, calls }) => [
    code !== 1 && "job should fail",
    has(writes, /statuses/) && "no status expected in single-workflow mode",
    has(calls, /\/user$/) && "GET /user should be skipped for ghs_ tokens",
  ].filter(Boolean),
});

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
failures += await scenario("sweep re-checks PRs changed after their commit's result", {
  prs: { 100: { body: "nothing", sha: "old" }, 101: { body: GOOD, sha: "fresh" }, 102: { body: GOOD, sha: "pz" } },
  eventName: "schedule",
  sweep: [
    { number: 100, updatedAt: ago(1), ctx: { description: "All contribution checks passed", createdAt: ago(10) } },
    { number: 101, updatedAt: ago(9), ctx: { description: "All contribution checks passed", createdAt: ago(10) } },
    { number: 102, updatedAt: ago(30), ctx: { description: "Paused: updated too often", createdAt: ago(20) } },
  ],
  expect: ({ calls, writes }) => [
    !has(calls, /GET \/repos\/acme\/widgets\/pulls\/100$/) && "stale PR #100 was not re-checked",
    has(calls, /GET \/repos\/acme\/widgets\/pulls\/101$/) && "PR #101 (only our own follow-up writes) should be skipped",
    !has(calls, /GET \/repos\/acme\/widgets\/pulls\/102$/) && "paused PR #102 was not re-checked",
    !has(writes, /statuses\/old .*"state":"failure"/) && "expected red status for stale non-compliant PR #100",
  ].filter(Boolean),
});

console.log(failures ? `\n${failures} scenario(s) failed` : "\nall scenarios passed");
process.exit(failures ? 1 : 0);
