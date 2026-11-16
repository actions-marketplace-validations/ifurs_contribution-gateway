import type { getOctokit } from "@actions/github";
import { hasLabel, type IssueInfo, type PullRequestInfo, type RepoData } from "./evaluate";
import { MARKER } from "./report";
import { statusDescription, type TargetLookup } from "./targets";

export type Octokit = ReturnType<typeof getOctokit>;

/** Upper bound on open-PR pages scanned (100 per page), to keep huge repositories fast. */
const MAX_PR_PAGES = 10;
/** The gateway's comment is posted on a PR's first run, so it is among the earliest comments. */
const MAX_COMMENT_PAGES = 3;
/** GitHub's own limit for the PR files list. */
const MAX_FILE_PAGES = 30;

const status = (e: unknown): number | undefined => (e as { status?: number }).status;

export interface LivePullRequest extends PullRequestInfo {
  state: string;
  baseRef: string;
  headSha: string;
}

export interface OpenPullRequest {
  number: number;
  author: string;
  headSha: string;
}

/** Name of the commit status shown on PRs in two-workflow mode. Can be made a required check. */
export const STATUS_CONTEXT = "contribution-gateway";
/** Description prefix of the status set while a PR is paused for too many updates. */
export const PAUSED_PREFIX = "Paused:";

export class GitHubRepo implements RepoData, TargetLookup {
  /** Login of the token's own user, when the token can tell us (personal access tokens). */
  private selfLogin: string | null | undefined;
  private openPrs: Promise<OpenPullRequest[]> | undefined;

  constructor(
    private readonly octokit: Octokit,
    readonly owner: string,
    readonly repo: string,
    readonly host = "github.com",
    private readonly warn: (msg: string) => void = () => {},
    /** GITHUB_TOKEN and app tokens (`ghs_`) cannot call GET /user, so don't spend a request on it. */
    private readonly installationToken = false,
  ) {}

  /**
   * Fetches the pull request as it is now. The event payload can be stale: "Re-run jobs"
   * replays the original payload, and edits can race with a run that is still going.
   */
  async getPullRequest(number: number): Promise<LivePullRequest> {
    const { data } = await this.octokit.rest.pulls.get({ owner: this.owner, repo: this.repo, pull_number: number });
    return {
      number: data.number,
      state: data.state,
      baseRef: data.base.ref,
      headSha: data.head.sha,
      author: data.user.login,
      authorType: data.user.type,
      association: data.author_association,
      body: data.body ?? "",
      labels: data.labels.map((l) => l.name),
    };
  }

  /** Reads a file from a branch; returns undefined when it does not exist. */
  async readFile(path: string, ref: string): Promise<string | undefined> {
    try {
      const res = await this.octokit.rest.repos.getContent({ owner: this.owner, repo: this.repo, path, ref });
      const data = res.data as { type?: string; content?: string; encoding?: string };
      if (data.type !== "file" || typeof data.content !== "string") throw new Error(`${path} is not a file`);
      return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8");
    } catch (e) {
      if (status(e) === 404) return undefined;
      throw e;
    }
  }

  async getIssue(number: number): Promise<IssueInfo | null> {
    try {
      const { data } = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number: number });
      return {
        state: data.state === "open" ? "open" : "closed",
        isPullRequest: Boolean(data.pull_request),
        labels: data.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      };
    } catch (e) {
      if (status(e) === 404 || status(e) === 410) return null;
      throw e;
    }
  }

  /** All open PRs (up to MAX_PR_PAGES pages), fetched once per run and shared by every check. */
  listOpenPullRequests(): Promise<OpenPullRequest[]> {
    this.openPrs ??= (async () => {
      const result: OpenPullRequest[] = [];
      let pages = 0;
      const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
        owner: this.owner,
        repo: this.repo,
        state: "open",
        per_page: 100,
      });
      for await (const page of iterator) {
        for (const pr of page.data) result.push({ number: pr.number, author: pr.user?.login ?? "", headSha: pr.head.sha });
        if (++pages >= MAX_PR_PAGES) {
          this.warn(`Stopped listing open pull requests after ${MAX_PR_PAGES * 100}; counts and shared-commit checks may be incomplete.`);
          break;
        }
      }
      return result;
    })();
    return this.openPrs;
  }

  async countOpenPullRequests(login: string): Promise<number> {
    return (await this.listOpenPullRequests()).filter((pr) => pr.author.toLowerCase() === login.toLowerCase()).length;
  }

  /** Open PRs whose head is commit `sha`. They share one commit status, so they are judged together. */
  async pullRequestsWithHead(sha: string): Promise<number[]> {
    return (await this.listOpenPullRequests()).filter((pr) => pr.headSha === sha).map((pr) => pr.number);
  }

  async listChangedFiles(number: number): Promise<string[]> {
    const files: string[] = [];
    let pages = 0;
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    for await (const page of iterator) {
      for (const f of page.data) {
        files.push(f.filename);
        // A rename *out of* a protected folder matters as much as an edit inside it.
        if (f.previous_filename) files.push(f.previous_filename);
      }
      if (++pages >= MAX_FILE_PAGES) break;
    }
    return files;
  }

  /** The token's own login for personal access tokens; null for GITHUB_TOKEN and app tokens. */
  private async ownLogin(): Promise<string | null> {
    if (this.installationToken) return null;
    if (this.selfLogin === undefined) {
      try {
        this.selfLogin = (await this.octokit.rest.users.getAuthenticated()).data.login;
      } catch {
        this.selfLogin = null;
      }
    }
    return this.selfLogin;
  }

  /** Updates the gateway's existing comment, or creates one when `createIfMissing` is true. */
  async upsertComment(issueNumber: number, body: string, createIfMissing: boolean): Promise<void> {
    const own = await this.ownLogin();
    // Only bots (which PR authors cannot impersonate) or the token's own user count as us.
    const isOurs = (c: { body?: string; user?: { type?: string; login?: string } | null }) =>
      Boolean(c.body?.startsWith(MARKER)) && (c.user?.type === "Bot" || (own !== null && c.user?.login === own));

    let existing: { id: number; body?: string } | undefined;
    let pages = 0;
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    for await (const page of iterator) {
      existing = page.data.find(isOurs);
      if (existing || ++pages >= MAX_COMMENT_PAGES) break;
    }
    if (existing) {
      if (existing.body !== body) {
        await this.octokit.rest.issues.updateComment({ owner: this.owner, repo: this.repo, comment_id: existing.id, body });
      }
    } else if (createIfMissing) {
      await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number: issueNumber, body });
    }
  }

  /** Adds or removes `label`. Comparison is case-insensitive, like GitHub's labels. */
  async setLabel(issueNumber: number, label: string, present: boolean, current: string[]): Promise<void> {
    if (present) {
      if (!hasLabel(current, label)) {
        await this.octokit.rest.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number: issueNumber, labels: [label] });
      }
      return;
    }
    // Remove whatever casing the repository uses; a missing label is fine.
    const name = current.find((l) => l.toLowerCase() === label.toLowerCase()) ?? label;
    try {
      await this.octokit.rest.issues.removeLabel({ owner: this.owner, repo: this.repo, issue_number: issueNumber, name });
    } catch (e) {
      if (status(e) !== 404) throw e;
    }
  }

  async findOpenPullRequests(headOwner: string, headBranch: string): Promise<number[]> {
    // An empty branch would make GitHub ignore the filter and return every open PR.
    if (!headOwner || !headBranch) return [];
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${headOwner}:${headBranch}`,
      per_page: 10,
    });
    // Defense in depth: keep only PRs whose head really is that owner's branch.
    return data
      .filter((pr) => pr.head.repo?.owner.login.toLowerCase() === headOwner.toLowerCase() && pr.head.ref === headBranch)
      .map((pr) => pr.number);
  }

  /**
   * Open PRs (most recently updated first, up to `limit`) whose head commit has no gateway
   * status yet, or a "paused" one. Used by the scheduled sweep. One GraphQL request.
   */
  async sweepCandidates(limit: number): Promise<number[]> {
    const query = `query($owner: String!, $repo: String!, $n: Int!, $context: String!) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: OPEN, first: $n, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { number commits(last: 1) { nodes { commit { status { context(name: $context) { description } } } } } }
        }
      }
    }`;
    type Node = { number: number; commits: { nodes: { commit: { status: { context: { description: string | null } | null } | null } }[] } };
    const res = await this.octokit.graphql<{ repository: { pullRequests: { nodes: Node[] } } }>(query, {
      owner: this.owner,
      repo: this.repo,
      n: limit,
      context: STATUS_CONTEXT,
    });
    return res.repository.pullRequests.nodes
      .filter((pr) => {
        const ctx = pr.commits.nodes[0]?.commit.status?.context;
        return !ctx || (ctx.description ?? "").startsWith(PAUSED_PREFIX);
      })
      .map((pr) => pr.number);
  }

  /** How many gateway statuses were set on `sha` since `since` (newest 100 statuses checked). */
  async recentStatusCount(sha: string, since: Date): Promise<{ count: number; latestDescription: string | null }> {
    const { data } = await this.octokit.rest.repos.listCommitStatusesForRef({ owner: this.owner, repo: this.repo, ref: sha, per_page: 100 });
    const ours = data.filter((s) => s.context === STATUS_CONTEXT);
    return {
      count: ours.filter((s) => new Date(s.created_at) >= since).length,
      latestDescription: ours[0]?.description ?? null,
    };
  }

  async setStatus(sha: string, state: "success" | "failure", description: string, targetUrl: string): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      owner: this.owner,
      repo: this.repo,
      sha,
      state,
      context: STATUS_CONTEXT,
      description: statusDescription(description),
      target_url: targetUrl,
    });
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.rest.pulls.update({ owner: this.owner, repo: this.repo, pull_number: number, state: "closed" });
  }
}

export { status as httpStatus };
