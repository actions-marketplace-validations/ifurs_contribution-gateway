# Contributing

Thanks for helping. This repository checks its own pull requests with Contribution Gateway, so you'll see the same bot comment and `contribution-gateway` status that the action gives other projects.

## Before you open a pull request

1. **Open or pick an issue first.** Describe the bug or the change you'd like, so we can agree on the approach before you write code. Your PR should say `Fixes #123`.
2. **Keep it focused.** One change per PR is easier to review.
3. **Security problems** go through private reporting, not issues. See [SECURITY.md](SECURITY.md).

## Making the change

```bash
npm ci
npm test           # unit and integration tests
npm run typecheck
npm run build      # rebuilds dist/index.mjs and dist/licenses.txt; commit both
npm run e2e        # runs the built bundle against a mock GitHub API
```

CI runs the same commands and fails if `dist/` doesn't match the source. New behavior needs a test, and the policy reference in `examples/contribution-gateway.yml` and the README should match it.

## The pull request

Fill in the template:

- **`Fixes #<issue>`**, linking an open issue
- **the checklist**, with every item ticked
- **AI usage**: using AI is fine, just tell us how

If the gateway asks for changes, edit the description. It re-checks within a minute or two. A maintainer can wave a PR through with the `skip-gateway` label.

Changes to `.github/workflows/` or `.github/actions/` always need a maintainer's review.
