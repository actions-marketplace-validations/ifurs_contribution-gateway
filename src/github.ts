import type { getOctokit } from "@actions/github";
import { hasLabel, type IssueInfo, type PullRequestInfo, type RepoData } from "./evaluate";
import { MARKER } from "./report";
import { statusDescription, type TargetLookup } from "./targets";

export type Octokit = ReturnType<typeof getOctokit>;

/** Upper bound on open-PR pages scanned (100 per page), to keep huge repositories fast. */
const MAX_PR_PAGES = 10;

const status = (e: unknown): number | undefined => (e as { status?: number }).status;

export interface LivePullRequest extends PullRequestInfo {
  state: string;
  baseRef: string;
  headSha: string;
}

/** Name of the commit status shown on PRs in two-workflow mode. Can be made a required check. */
export const STATUS_CONTEXT = "contribution-gateway";

export class GitHubRepo implements RepoData, TargetLookup {
  /** Login of the token's own user, when the token can tell us (personal access tokens). */
  private selfLogin: string | null | undefined;

  constructor(
    private readonly octokit: Octokit,
    readonly owner: string,
    readonly repo: string,
    readonly host = "github.com",
    private readonly warn: (msg: string) => void = () => {},
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

  async countOpenPullRequests(login: string): Promise<number> {
    let count = 0;
    let pages = 0;
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    for await (const page of iterator) {
      count += page.data.filter((pr) => pr.user?.login.toLowerCase() === login.toLowerCase()).length;
      if (++pages >= MAX_PR_PAGES) {
        this.warn(`Stopped counting open pull requests after ${MAX_PR_PAGES * 100}; the count may be low.`);
        break;
      }
    }
    return count;
  }

  /** The token's own login for personal access tokens; null for GITHUB_TOKEN and app tokens. */
  private async ownLogin(): Promise<string | null> {
    if (this.selfLogin === undefined) {
      try {
        this.selfLogin = (await this.octokit.rest.users.getAuthenticated()).data.login;
      } catch {
        this.selfLogin = null; // installation tokens cannot call this endpoint
      }
    }
    return this.selfLogin;
  }

  /** Updates the gateway's existing comment, or creates one when `createIfMissing` is true. */
  async upsertComment(issueNumber: number, body: string, createIfMissing: boolean): Promise<void> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const own = await this.ownLogin();
    // Only bots (which PR authors cannot impersonate) or the token's own user count as us.
    const existing = comments.find(
      (c) => c.body?.startsWith(MARKER) && (c.user?.type === "Bot" || (own !== null && c.user?.login === own)),
    );
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
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      head: `${headOwner}:${headBranch}`,
      per_page: 10,
    });
    return data.map((pr) => pr.number);
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
