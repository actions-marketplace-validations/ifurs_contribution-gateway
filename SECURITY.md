# Security policy

Contribution Gateway runs with a write token on events that anyone who can open a pull request can trigger. Security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately with GitHub's [private vulnerability reporting](https://github.com/ifurs/contribution-gateway/security/advisories/new) (Security → Advisories → Report a vulnerability).

Please include:

- which mode is affected (two-workflow or single-workflow) and the action version
- the workflow files and policy needed to reproduce it
- what an attacker controls (PR description, branch name, fork, workflow files, …) and what they gain

You'll get an acknowledgement within a week. Fixes are released as a new patch version, and the `v0` tag is moved to it.

## Supported versions

Only the latest `0.x` release gets security fixes. Pin a full commit SHA in production and update it when a fix is released.

## In scope

- running code from a pull request, or getting the workflow's token
- making the gateway report a passing result for a PR that breaks the policy
- making the bot post content chosen by a contributor
- using the gateway to exhaust a repository's API quota or Actions minutes

Known limitations, such as the sweep delay and exemption scope, are listed in the README.
