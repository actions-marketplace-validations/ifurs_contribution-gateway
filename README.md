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

Maintainers, collaborators, bots, listed users and PRs labelled `skip-gateway` are exempt.

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

Mark `contribution-gateway` as a required status check in branch protection if PRs shouldn't be mergeable until it passes. You can also re-check one PR by hand from the Actions tab ("Run workflow", with the PR number).

**Single-workflow mode**

Add [examples/single-workflow.yml](examples/single-workflow.yml) as `.github/workflows/contribution-gateway.yml`. It runs on `pull_request_target`, which is simpler but is blocked in public repositories from December 2, 2026 unless an Actions event policy allows it for this workflow file (Settings → Actions → Policies). Private repositories aren't affected.

### 2. Policy and template

1. Optionally add [examples/contribution-gateway.yml](examples/contribution-gateway.yml) as `.github/contribution-gateway.yml` and adjust it. Without it, the defaults above apply. Start with `mode: dry-run` to see results in the workflow log without touching any PR.
2. Optionally use [examples/pull_request_template.md](examples/pull_request_template.md) so contributors see the checklist and the "AI usage" section up front.

Tips for the template:

- Text inside `<!-- -->` comments is ignored, so put instructions there.
- Boxes under the disclosure heading are treated as a pick-one answer, not as checklist items.

## Security model

- **This action never checks out or executes PR code**, and the example workflows don't either. Keep it that way. That is what makes `pull_request_target` and `workflow_run` safe here.
- In two-workflow mode nothing produced by the untrusted `pull_request` run (artifacts, outputs, logs) is used. The gateway only learns which branch the run was for, then reads the PR and policy itself.
- In two-workflow mode a contributor's PR could edit or delete the trigger workflow, so the gateway never runs for it. The PR then has no `contribution-gateway` status at all. Make that status required to block merging, and treat workflow changes in a PR as a red flag.
- The policy file is read from the PR's **base branch** through the API. A contributor can't change the rules inside their own PR.
- It needs no secrets beyond the built-in `GITHUB_TOKEN`, with `contents: read`, `issues: write`, `pull-requests: write` and, in two-workflow mode, `statuses: write`.
- It reads the pull request live from the API rather than trusting the event payload, so re-running an old job can't act on an outdated description.
- Bot comments never repeat text the PR author wrote, only counts, issue numbers and the policy's own wording, so a description can't make the bot post links, mentions or fake approvals.
- At most 10 issue references are looked up per run, and comments are capped below GitHub's size limit, so a stuffed description can't drain the API quota.

## Outputs

- `passed`: `"true"` or `"false"`
- `violations`: a JSON list of `{ pull_request, rule, message }`, for follow-up steps

## Inputs

- `github-token`: defaults to the built-in token
- `config-path`: defaults to `.github/contribution-gateway.yml`
- `pull-request`: a PR number to check instead of the one from the event, for manual runs

## Known limits (v0)

- References like `step #1` count as issue references. They only pass if issue #1 exists and is open.
- The open-PR count re-runs only when that PR changes. Closing another PR doesn't re-check this one.
- Counting open PRs stops after 1,000 to keep huge repositories fast.
- A closed PR isn't reopened automatically after it's fixed.
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
- `src/github.ts`: API calls
- `src/main.ts`: wiring

## License

MIT
