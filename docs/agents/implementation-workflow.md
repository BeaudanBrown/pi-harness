# Issue implementation workflow

Use this workflow for interactive issue implementation across projects. GitHub and Git remain authoritative; this is a review and verification discipline, not a session manager.

## 1. Preflight and scope ownership

Before editing:

1. Read the selected issue in full and inspect its parent, blockers, and dependents. Read repository guidance, relevant domain documentation, and applicable ADRs.
2. Write an acceptance-to-evidence matrix: for each acceptance criterion, identify the intended code or documentation change and the focused evidence that will prove it. Keep it current when evidence changes.
3. State which work belongs to the current issue and which belongs to a dependent issue, deployment-only follow-up, or justified deferral. The selected issue is the implementation boundary.
4. Ask the operator before materially expanding product behavior, architecture, dependencies, or issue scope. A direct implementation request approves the issue's stated scope, not newly discovered expansion.

For work involving persistent state, retries, concurrency, or external side effects, also prepare a crash-boundary matrix. For each boundary, record the state before the operation, side effect, durable write or idempotency key, interruption/retry behavior, and evidence. This matrix is conditional: do not require it for ordinary stateless work. Prefer deterministic fault injection and table-driven recovery tests when they make those boundaries cheaper to prove.

## 2. Develop with focused evidence

Implement within the stated ownership boundary. During development, run the smallest useful checks: affected unit or integration tests, type/LSP diagnostics, schema validation, and targeted linters. Before review, run the broader affected checks needed to make the change reviewable. Update the acceptance-to-evidence matrix with actual commands and outcomes.

Do not repeatedly run the canonical repository gate or production builds during ordinary edit cycles unless a project-specific constraint requires it.

## 3. One exhaustive review

After focused and broader affected checks pass, call `review_agents` once with both Standards and Spec tasks when both sources are available. For uncommitted work, use `mode: "worktree"` and a fixed point; the tool captures staged, unstaged, untracked, and binary content into one immutable synthetic Git snapshot without changing source files. Use the existing `mode: "diff"` for an already committed branch comparison.

Ask both axes to inspect the complete pinned change. Every finding must include:

- severity: critical, high, medium, or low;
- ownership: current issue, dependent issue, deployment-only, or justified deferral;
- concrete evidence and an actionable correction or explicit deferral rationale.

Treat this as the final exhaustive review, not the first pass in a routine review loop.

## 4. Batch remediation and final gate

Triage all findings together. Fix accepted current-issue findings in one remediation batch. Record dependent, deployment-only, and subjective justified deferrals in the handoff or issue evidence. Do not routinely re-run the subjective review after remediation; re-review only when remediation materially changes the design or invalidates the pinned review.

After remediation, run the canonical repository verification gate once, then each applicable production build once. If a trivial, isolated change is required after that gate, run focused verification for that change and document why the canonical gate was not repeated; otherwise repeat the affected final gate.

Finish with the acceptance-to-evidence matrix, review disposition, canonical verification/build results, remaining caveats, and Git state. Commit and push only according to repository and operator policy.

## Explicit non-goals

Do not introduce cumulative review mode, a dedicated state-machine review mode, generic compilation caching, managed-session-specific verification, or architecture compatibility linting as part of this workflow.
