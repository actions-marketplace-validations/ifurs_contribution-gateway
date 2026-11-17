/**
 * A small, stateful fake of the GitHub REST and GraphQL APIs, just enough for the gateway.
 * It remembers comments, labels, statuses and PR state across runs, so tests can play out
 * real sequences (fail → contributor fixes → pass). Writes can be made to fail on purpose.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const OWNER = "acme";
export const REPO = "widgets";
export const BOT = { login: "github-actions[bot]", type: "Bot" };

export interface MockPr {
  body: string;
  headSha: string;
  title?: string;
  draft?: boolean;
  state?: "open" | "closed";
  author?: string;
  authorType?: string;
  association?: string;
  labels?: string[];
  baseRef?: string;
  headOwner?: string;
  headRef?: string;
  /** Changed files; `{ filename, previous_filename }` for renames. */
  files?: (string | { filename: string; previous_filename?: string })[];
  updatedAt?: string;
}

export interface MockComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

export interface MockStatus {
  state: string;
  description: string;
  context: string;
  target_url?: string;
  created_at: string;
}

export interface MockFailure {
  method: string;
  path: RegExp;
  status: number;
  /** How many times to fail; Infinity for always. */
  times: number;
}

export interface MockState {
  prs: Record<number, MockPr>;
  issues: Record<number, { state: "open" | "closed"; labels?: string[] }>;
  /** Policy file text per branch. Missing branch → 404 (defaults apply). */
  policy: Record<string, string>;
  comments: Record<number, MockComment[]>;
  /** Per commit, newest first (like GitHub). */
  statuses: Record<string, MockStatus[]>;
  failures: MockFailure[];
  calls: string[];
}

export function newState(partial: Partial<MockState> = {}): MockState {
  return { prs: {}, issues: {}, policy: {}, comments: {}, statuses: {}, failures: [], calls: [], ...partial };
}

let nextCommentId = 1000;

function prJson(n: number, pr: MockPr) {
  return {
    number: n,
    title: pr.title ?? `PR ${n}`,
    state: pr.state ?? "open",
    draft: pr.draft ?? false,
    body: pr.body,
    author_association: pr.association ?? "NONE",
    user: { login: pr.author ?? `user${n}`, type: pr.authorType ?? "User" },
    labels: (pr.labels ?? []).map((name) => ({ name })),
    base: { ref: pr.baseRef ?? "main" },
    head: { sha: pr.headSha, ref: pr.headRef ?? `branch-${n}`, repo: { owner: { login: pr.headOwner ?? pr.author ?? `user${n}` } } },
    pull_request: undefined,
  };
}

export interface MockServer {
  url: string;
  state: MockState;
  close(): Promise<void>;
}

export async function startMockGitHub(state: MockState): Promise<MockServer> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const body = raw ? JSON.parse(raw) : undefined;
      state.calls.push(`${method} ${path}${url.search}`);
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(code === 204 ? "" : JSON.stringify(obj));
      };

      const failure = state.failures.find((f) => f.method === method && f.path.test(path) && f.times > 0);
      if (failure) {
        failure.times--;
        return send(failure.status, { message: failure.status === 403 ? "Resource not accessible by integration" : "Server Error" });
      }

      const repoPrefix = `/repos/${OWNER}/${REPO}`;
      let m: RegExpMatchArray | null;

      if (method === "GET" && path === "/user") {
        // Personal access tokens can read their own user; installation tokens can't.
        const auth = String(req.headers.authorization ?? "");
        if (auth.includes("ghp_")) return send(200, { login: "maintainer-pat", type: "User" });
        return send(403, { message: "Resource not accessible by integration" });
      }

      if (method === "POST" && path === "/graphql") {
        const open = Object.entries(state.prs)
          .filter(([, pr]) => (pr.state ?? "open") === "open")
          .sort(([, a], [, b]) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        const nodes = open.slice(0, body.variables.n).map(([n, pr]) => {
          const latest = (state.statuses[pr.headSha] ?? []).find((s) => s.context === body.variables.context);
          return {
            number: Number(n),
            updatedAt: pr.updatedAt ?? new Date().toISOString(),
            commits: { nodes: [{ commit: { status: { context: latest ? { description: latest.description, createdAt: latest.created_at } : null } } }] },
          };
        });
        return send(200, { data: { repository: { pullRequests: { nodes } } } });
      }

      if (!path.startsWith(repoPrefix)) return send(404, { message: "Not Found" });
      const p = path.slice(repoPrefix.length);

      if ((m = p.match(/^\/contents\/(.+)$/)) && method === "GET") {
        const ref = url.searchParams.get("ref") ?? "main";
        const text = state.policy[ref];
        if (text === undefined || decodeURIComponent(m[1]!) !== ".github/contribution-gateway.yml") return send(404, { message: "Not Found" });
        return send(200, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
      }

      if (p === "/pulls" && method === "GET") {
        const head = url.searchParams.get("head");
        let list = Object.entries(state.prs).filter(([, pr]) => (pr.state ?? "open") === "open");
        if (head) {
          const [owner, ref] = head.split(":");
          list = list.filter(([n, pr]) => (pr.headOwner ?? pr.author ?? `user${n}`).toLowerCase() === owner!.toLowerCase() && (pr.headRef ?? `branch-${n}`) === ref);
        }
        return send(200, list.map(([n, pr]) => prJson(Number(n), pr)));
      }

      if ((m = p.match(/^\/pulls\/(\d+)$/))) {
        const pr = state.prs[Number(m[1])];
        if (!pr) return send(404, { message: "Not Found" });
        if (method === "PATCH") {
          if (body.state) pr.state = body.state;
          return send(200, prJson(Number(m[1]), pr));
        }
        return send(200, prJson(Number(m[1]), pr));
      }

      if ((m = p.match(/^\/pulls\/(\d+)\/files$/)) && method === "GET") {
        const files = state.prs[Number(m[1])]?.files ?? ["src/index.ts"];
        return send(200, files.map((f) => (typeof f === "string" ? { filename: f } : f)));
      }

      if ((m = p.match(/^\/issues\/(\d+)$/)) && method === "GET") {
        const n = Number(m[1]);
        const pr = state.prs[n];
        if (pr) return send(200, { number: n, state: pr.state ?? "open", labels: [], pull_request: { url: "x" } });
        const issue = state.issues[n];
        if (!issue) return send(404, { message: "Not Found" });
        return send(200, { number: n, state: issue.state, labels: (issue.labels ?? []).map((name) => ({ name })) });
      }

      if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
        const n = Number(m[1]);
        state.comments[n] ??= [];
        if (method === "GET") return send(200, state.comments[n]);
        const auth = String(req.headers.authorization ?? "");
        const user = auth.includes("ghp_") ? { login: "maintainer-pat", type: "User" } : BOT;
        const comment = { id: nextCommentId++, body: body.body, user };
        state.comments[n]!.push(comment);
        return send(201, comment);
      }

      if ((m = p.match(/^\/issues\/comments\/(\d+)$/)) && method === "PATCH") {
        const comment = Object.values(state.comments).flat().find((c) => c.id === Number(m![1]));
        if (!comment) return send(404, { message: "Not Found" });
        comment.body = body.body;
        return send(200, comment);
      }

      if ((m = p.match(/^\/issues\/(\d+)\/labels$/)) && method === "POST") {
        const pr = state.prs[Number(m[1])]!;
        pr.labels = [...new Set([...(pr.labels ?? []), ...body.labels])];
        return send(200, pr.labels.map((name) => ({ name })));
      }

      if ((m = p.match(/^\/issues\/(\d+)\/labels\/(.+)$/)) && method === "DELETE") {
        const pr = state.prs[Number(m[1])]!;
        const name = decodeURIComponent(m[2]!);
        if (!(pr.labels ?? []).includes(name)) return send(404, { message: "Label does not exist" });
        pr.labels = pr.labels!.filter((l) => l !== name);
        return send(200, []);
      }

      if ((m = p.match(/^\/commits\/([^/]+)\/statuses$/)) && method === "GET") return send(200, state.statuses[m[1]!] ?? []);

      if ((m = p.match(/^\/statuses\/([^/]+)$/)) && method === "POST") {
        const status = { state: body.state, description: body.description, context: body.context, target_url: body.target_url, created_at: new Date().toISOString() };
        (state.statuses[m[1]!] ??= []).unshift(status);
        return send(201, status);
      }

      return send(404, { message: `Mock has no route for ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The latest gateway status on a commit, or undefined. */
export const latestStatus = (state: MockState, sha: string) => (state.statuses[sha] ?? []).find((s) => s.context === "contribution-gateway");

/** The bot's own gateway comments on a PR. */
export const gatewayComments = (state: MockState, n: number) =>
  (state.comments[n] ?? []).filter((c) => c.user.type === "Bot" && c.body.startsWith("<!-- contribution-gateway -->"));
