# Contribution Gateway

A GitHub Action that checks pull requests against a short policy file written by the maintainers, then tells contributors in plain words what to fix.

It exists because maintainers are flooded with low-effort and AI-generated pull requests (in a 2026 Linux Foundation survey, maintainers estimated about a quarter of incoming PRs). In [GitHub's community discussion](https://github.com/orgs/community/discussions/185387) on the problem, they asked for:

- a limit on open PRs per new contributor
- a linked issue before a PR is opened
- checklist validation
- AI-use disclosure

They also rejected "AI detectors" because of false positives. This action does the first four and deliberately not the last one: **every rule is deterministic, and every failure message says exactly how to fix it.**

## What it checks

| Rule | Passes when | Default |
|---|---|---|
| `linked_issue` | The description references an issue in this repo (`#12`, `owner/repo#12` or an issue URL) that exists, is open and, optionally, has a label such as `accepted` | on |
| `open_pr_limit` | A first-time contributor has no more than `max` open PRs here | on, max 1 |
| `checklist` | Every `- [ ]` item in the description is ticked, and at least `min_items` exist | on |
| `disclosure` | A line or section called "AI usage" (configurable) has an answer | off |
| `workflow_changes` | The PR doesn't touch `.github/workflows/` or `.github/actions/` (configurable). Such PRs could switch off or impersonate this check, so they need maintainer review | on |

Exempt by default:

- the repo owner
- organization members (`MEMBER`, even without access to this repo)
- invited collaborators (`COLLABORATOR`, with any role, including read-only)
- bots
- users listed by login
- PRs labelled `skip-gateway`

Narrow `exempt.associations` if that's too broad for you.

For `linked_issue`, set `require_label` (for example `accepted`). Without it, a contributor can satisfy the rule by linking any open issue, including one they just opened.

When a PR breaks the policy, the action:

1. posts a single comment that it keeps up to date
2. adds a `needs-policy-fixes` label
3. marks the PR's check red (the `contribution-gateway` status, or the job's own check in single-workflow mode)
4. closes the PR, only if you ask it to

When the contributor fixes the description, the comment changes to "passed" and the label is removed.

## Setup

### 1. Pick a mode

**Two-workflow mode (recommended, required for most public repos from December 2, 2026)**

From [December 2, 2026](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/), GitHub blocks `pull_request_target` by default in public repositories. This mode doesn't use that trigger at all.

Add both files from [examples/two-workflow/](examples/two-workflow/) to `.github/workflows/`:

- `contribution-gateway-trigger.yml` runs on `pull_request` with no permissions. It does nothing except finish.
- `contribution-gateway.yml` starts when the trigger finishes (`workflow_run`). It runs this repository's own workflow file with a write token, looks the PR up through the API, comments and labels, and sets a commit status named `contribution-gateway`.

The gate workflow also runs every 15 minutes as a **sweep**. It re-checks open PRs that have no `contribution-gateway` result yet, which is how PRs that disabled the trigger workflow still get a red status. GitHub turns off scheduled workflows in public repos after 60 days without activity, so check the Actions tab now and then. You can also re-check one PR by hand from the Actions tab ("Run workflow", with the PR number).

To block merging until it passes, make `contribution-gateway` a required status check. A PR can add its own passing check with that name, but GitHub then requires *both* to pass, and the gateway's own status is red:

- right away if the trigger still runs, because of `workflow_changes`
- within one sweep if the PR disabled the trigger

There's a gap of up to one sweep interval in the second case, so don't merge a PR that changes workflows without reading those changes.

**Single-workflow mode**

Add [examples/single-workflow.yml](examples/single-workflow.yml) as `.github/workflows/contribution-gateway.yml`. It runs on `pull_request_target`. That's simpler, but it's blocked in public repositories from December 2, 2026 unless an Actions event policy allows it for this workflow file (Settings → Actions → Policies). Private repositories aren't affected.

The result is the job's own check (`gate`). A PR can add a job with the same name, so don't use `gate` as a required status check. There's also no sweep and no per-PR update limit in this mode.

### 2. Policy and template

1. Optionally add [examples/contribution-gateway.yml](examples/contribution-gateway.yml) as `.github/contribution-gateway.yml` and adjust it. Without it, the defaults above apply. Start with `mode: dry-run` to see results in the workflow log without touching any PR.
2. Optionally use [examples/pull_request_template.md](examples/pull_request_template.md) so contributors see the checklist and the "AI usage" section up front.

Tips for the template:

- Text inside `<!-- -->` comments is ignored, so put instructions there.
- Boxes under the disclosure heading are treated as a pick-one answer, not as checklist items.

## Security model

**Code and token**

- **This action never checks out or executes PR code**, and the example workflows don't either. Keep it that way: that's what makes `pull_request_target` and `workflow_run` safe here.
- In two-workflow mode, nothing produced by the untrusted `pull_request` run (artifacts, outputs, logs) is used. The gateway only learns which owner and branch the run was for. It confirms the PR it finds really has that head, then reads the PR and policy itself.
- It needs no secrets beyond the built-in `GITHUB_TOKEN`, with these permissions:
  - `contents: read`
  - `issues: write`
  - `pull-requests: read` (`write` only if the policy closes PRs)
  - `statuses: write` (two-workflow mode)
- **Pin the action to a full commit SHA in production.** A tag like `v0` can be moved, and this action runs with a write token on events any outsider can trigger.

**Rules can't be loosened from a PR**

- The policy file is read from the PR's **base branch** through the API, so a contributor can't change the rules inside their own PR.
- A PR that edits workflow files fails `workflow_changes` until a maintainer reviews it. If it disables the trigger, the scheduled sweep still marks it red.
- It reads the pull request live from the API rather than trusting the event payload, so re-running an old job can't act on an outdated description.

**Shared commits**

A commit status belongs to a commit, not a PR. When several open PRs have the same head commit, they're judged together, and the status is red if any of them fails. A compliant PR can't turn a non-compliant one green.

The flip side: an outsider can open a non-compliant PR from someone else's commit and turn that commit red. The status says which PR is the problem. Close that PR and re-check.

**Bot output**

- Bot comments never repeat text the PR author wrote.
- They contain only counts, issue numbers (formatted as code, so the bot doesn't create cross-references) and the policy's own wording.

**API quota**

GitHub allows the built-in token 1,000 requests per hour per repository. A typical run makes about 6–10 requests:

- at most 3 issue lookups
- one shared list of open PRs
- at most 3 pages of comments

In two-workflow mode, a PR that gets more than 20 results within an hour is *paused*. Its status turns red with "Paused:", it isn't evaluated on further updates, and the sweep re-checks it later. A paused run costs about 2 requests.

## Outputs

- `passed`: `"true"` or `"false"`
- `violations`: a JSON list of `{ pull_request, rule, message }`, for follow-up steps

## Inputs

- `github-token`: defaults to the built-in token
- `config-path`: defaults to `.github/contribution-gateway.yml`
- `pull-request`: a PR number to check instead of the one from the event, for manual runs

## Known limits

- References like `step #1` count as issue references. They only pass if issue #1 exists and is open.
- The open-PR count re-runs only when that PR changes. Closing another PR doesn't re-check this one.
- A closed PR isn't reopened automatically after it's fixed.
- Open PRs are listed up to 1,000 per run. In bigger repositories, newcomer counts and shared-commit grouping may be incomplete.
- The sweep looks at the 50 most recently updated open PRs.
- `exempt.users` matches logins. If a listed person renames or deletes their account, someone else could register that login, so keep the list current.
- In two-workflow mode, GitHub may hold the trigger workflow for maintainer approval when a contributor is brand new to GitHub (the default "Approval for running fork pull request workflows" setting). The gateway runs once that's approved, or you can run it by hand for the PR number.
- `exempt.bots: true` trusts any GitHub App account. If you install apps that open PRs you don't want waved through, set it to `false` and list the trusted bots in `exempt.users`.
- GitHub may report org members with *private* membership as `CONTRIBUTOR` or `NONE`, so they aren't exempt. Make the membership public or add them to `exempt.users`.
- Only `GITHUB_TOKEN` and personal access tokens are recognised as the comment's author. With a GitHub App token, any bot comment carrying the marker is treated as the gateway's own.

## Ideas for next versions

- "Possibly related issues" suggestions, which never auto-close
- Re-check a contributor's other PRs when one of them closes
- Optional reopen when a PR closed by the gateway is fixed
- Per-path rules, e.g. stricter for `docs/` vs `src/`

## Development

```bash
npm install
npm test          # unit tests (vitest)
npm run typecheck
npm run build     # bundles to dist/index.mjs, which must be committed
```

Code map:

- `src/config.ts`: policy schema and validation
- `src/markdown.ts`: parsing the PR description
- `src/evaluate.ts`: the rules
- `src/targets.ts`: which PRs a run checks, per trigger
- `src/aggregate.ts`: one commit status for PRs that share a commit
- `src/github.ts`: API calls
- `src/main.ts`: wiring

## License

MIT
