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
3. fails the check
4. closes the PR, only if you ask it to

When the contributor fixes the description, the comment changes to "passed" and the label is removed.

## Setup

1. Add [examples/workflow.yml](examples/workflow.yml) as `.github/workflows/contribution-gateway.yml`.
2. Optionally add [examples/contribution-gateway.yml](examples/contribution-gateway.yml) as `.github/contribution-gateway.yml` and adjust it. Without it, the defaults above apply. Start with `mode: dry-run` to see results in the workflow log without touching any PR.
3. Optionally use [examples/pull_request_template.md](examples/pull_request_template.md) so contributors see the checklist and the "AI usage" section up front.

Tips for the template:

- Text inside `<!-- -->` comments is ignored, so put instructions there.
- Boxes under the disclosure heading are treated as a pick-one answer, not as checklist items.

## Security model

- It runs on `pull_request_target` so it can comment on PRs from forks. That trigger is safe only if the workflow never runs the PR's code. **This action never checks out or executes PR code**, and the example workflow doesn't either. Keep it that way.
- The policy file is read from the PR's **base branch** through the API. A contributor can't change the rules inside their own PR.
- It needs no secrets beyond the built-in `GITHUB_TOKEN`, with `contents: read`, `issues: write` and `pull-requests: write`.
- It reads the pull request live from the API rather than trusting the event payload, so re-running an old job can't act on an outdated description.
- Bot comments never repeat text the PR author wrote, only counts, issue numbers and the policy's own wording, so a description can't make the bot post links, mentions or fake approvals.
- At most 10 issue references are looked up per run, and comments are capped below GitHub's size limit, so a stuffed description can't drain the API quota.

## Outputs

- `passed`: `"true"` or `"false"`
- `violations`: a JSON list of `{ rule, message }`, for follow-up steps

## Known limits (v0)

- References like `step #1` count as issue references. They only pass if issue #1 exists and is open.
- The open-PR count re-runs only when that PR changes. Closing another PR doesn't re-check this one.
- Counting open PRs stops after 1,000 to keep huge repositories fast.
- A closed PR isn't reopened automatically after it's fixed.
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
