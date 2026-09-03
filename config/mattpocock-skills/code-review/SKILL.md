---
name: code-review
description: Review one pinned committed diff or uncommitted worktree snapshot along Standards and Spec axes in parallel.
---

Run one exhaustive two-axis review after focused and broader affected checks have passed:

- **Standards** — conformance to repository standards plus the smell baseline below.
- **Spec** — fidelity to the originating issue, PRD, or spec.

## 1. Choose and pin the change

Use `review_agents` exactly once with both available axes.

- For uncommitted work, use `mode: "worktree"` with the user-supplied fixed point. The tool captures staged, unstaged, untracked, and binary files in one immutable synthetic snapshot without mutating source files.
- For an already committed branch, use `mode: "diff"` with the fixed point. This preserves the merge-base-to-HEAD comparison.
- Use audit mode only when intentionally auditing a pinned HEAD with no change diff.

If no fixed point was supplied for a change review, ask for it. Confirm it resolves. A truly empty changed snapshot should fail before reviewer model calls.

## 2. Identify sources

Find the spec from issue references, a user-provided path, or a matching repository spec. If none exists and the user confirms that, run Standards only.

Find repository standards such as `AGENTS.md`, `CONTRIBUTING.md`, and relevant domain or ADR documents. Repository standards override the heuristic smell baseline. Skip concerns already enforced by tooling.

Smell baseline: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, and Refused Bequest. These are judgement calls, never hard violations.

## 3. Submit both exhaustive tasks together

Call `review_agents` once with both tasks so they inspect the identical pinned snapshot concurrently.

The Standards brief must request every documented-standard violation and applicable baseline smell, with standard citations and file/hunk evidence. Distinguish hard violations from judgement calls.

The Spec brief must request every missing or partial requirement, scope addition, and apparently implemented but incorrect requirement, quoting the source requirement and file/hunk evidence.

Both briefs must require each finding to state:

- severity: critical, high, medium, or low;
- ownership: current issue, dependent issue, deployment-only, or justified deferral;
- actionable correction, or explicit rationale for a subjective justified deferral.

If there are no findings, the reviewer must say so. Ask for concise but exhaustive reports; do not impose a word limit that would suppress findings.

## 4. Report without reranking

Present reports under `## Standards` and `## Spec`. Do not merge or rerank the axes. Summarize finding counts and worst severity within each axis.

The implementation owner batches accepted remediation. Do not routinely invoke another subjective review; re-review only when remediation materially changes the design or invalidates this pinned review.
