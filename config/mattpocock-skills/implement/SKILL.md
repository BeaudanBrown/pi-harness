---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

## Preflight

Before editing, read the issue and its parent, blockers, dependents, repository guidance, relevant domain documentation, and applicable ADRs. Create an acceptance-to-evidence matrix that maps each criterion to the intended change and focused proof. State what belongs to the current issue versus a dependent issue, deployment-only work, or justified deferral. Ask the operator before materially expanding scope; an implementation request approves the stated issue scope only.

For persistent state, retries, concurrency, or external side effects, create a crash-boundary matrix covering state before each operation, side effects, durable writes/idempotency, interruption and retry behavior, and evidence. Do not require this for ordinary stateless work. Prefer deterministic fault injection and table-driven recovery tests when useful.

## Implement and verify

Use /tdd where possible, at pre-agreed seams. Run focused tests, type/LSP checks, and other small affected checks during development. Before review, run broader affected checks and update the acceptance-to-evidence matrix with actual evidence.

Then use /code-review once for one exhaustive Standards and Spec review of a pinned snapshot. Use `review_agents` worktree mode for uncommitted changes or committed diff mode for an already committed branch. Require every finding to classify severity and ownership as current issue, dependent issue, deployment-only, or justified deferral.

Triage all findings together and batch accepted current-issue remediation. Document subjective deferrals. Do not routinely re-run review unless remediation materially changes the design or invalidates the review.

After remediation, run the repository's canonical verification gate once and applicable production builds once. A trivial isolated post-gate change may use focused verification when the reason is documented; otherwise repeat the affected final gate.

Commit your work to the current branch when repository and operator policy permit it. Report the acceptance evidence, review disposition, final verification/build evidence, caveats, and Git state.
