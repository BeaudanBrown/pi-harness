# Issue tracker: GitHub

GitHub Issues are the sole durable task source of truth for this repository. Use the `gh` CLI or the harness `github_issue_*` tools from this checkout.

## Conventions

- Create, inspect, comment on, and close issues in `BeaudanBrown/pi-harness` only.
- Use native GitHub sub-issues for parent/child work and native issue dependencies for blockers.
- Apply `ready-for-agent` only to fully specified work with no open blockers; it is a prioritization hint, not an execution lock.
- Assignments are advisory ownership metadata. Agent eligibility comes from open leaf and blocker state, while each supervisor serializes its own worker launches.
- Add verification and a concise handoff comment before closing an issue.
- Generated migration issues use a hidden `pi-harness-plan:<plan>/<key>` provenance marker for idempotency.

## Legacy tk migration

Closed tk tickets are retained only in Git history. The approved migration for this repository omits all 24 closed tk tickets rather than recreating closed GitHub issues.
