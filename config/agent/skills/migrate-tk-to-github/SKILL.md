---
name: migrate-tk-to-github
description: Inspect a tk-backed project, review stale tickets with the user, and prepare an approved one-way migration plan to GitHub Issues.
disable-model-invocation: true
---

# Migrate tk To GitHub

Run a one-way `tk` to GitHub Issues migration. Inventory and user approval always come before publication; `.tickets/` is never removed until a later reconciliation phase succeeds.

Use this skill only in a project that has elected GitHub Issues as its sole future task source of truth. Run it as `/skill:migrate-tk-to-github`.

## 1. Establish the migration boundary

Read the project instructions and inspect:

- `git remote -v` and `gh repo view --json nameWithOwner,url,hasIssuesEnabled`
- `gh auth status`
- `.tickets/` and `tk help`
- existing GitHub issues, labels, and relevant pull requests
- `AGENTS.md`, `CLAUDE.md`, `docs/agents/`, `CONTEXT.md`, and relevant ADRs
- the working tree state

Confirm that the user wants a one-way migration. State that GitHub mutation and local cleanup occur only in later phases after approval and reconciliation.

**Completion:** the GitHub repository, tk source directory, and repository guidance are identified; any missing prerequisite is reported with its remedy.

## 2. Build a complete source inventory

Use `tk query .` to enumerate ticket IDs and metadata. It may omit fields such as titles and full notes, so run `tk show <id>` for every ticket and normalize the complete graph.

For each ticket capture the fields in [the inventory schema](references/inventory-schema.md): identity, lifecycle state, hierarchy, dependencies, links, scope, design, acceptance criteria, notes, tags, and timestamps when available.

Also gather evidence that may affect disposition:

- current code, tests, and documentation related to the ticket;
- commits, branches, and pull requests that mention its ID or describe its work;
- open and closed GitHub issues that already represent the work;
- parent and dependent tickets whose state changes its meaning.

Write temporary inventory artifacts only under `.pi/tmp/tk-to-github/`. Do not add them to Git and do not treat them as a tracker.

**Completion:** every `.tickets/*.md` ticket has one normalized inventory record and every parent/dependency/link target resolves or is reported missing.

## 3. Classify every ticket

Assign exactly one proposed disposition from [the disposition guide](references/disposition-guide.md):

1. **migrate-open** — still actionable work;
2. **migrate-closed** — durable historical context worth preserving;
3. **already-complete** — acceptance behavior is present but tk was left open;
4. **superseded-or-duplicate** — replaced by another ticket, issue, or settled decision;
5. **irrelevant** — no longer belongs in the future tracker;
6. **needs-user-decision** — available evidence cannot safely decide.

Never use age as the sole stale signal. Cite concrete evidence for every non-open recommendation. A ticket that is merely unclear belongs in `needs-user-decision`, not an archival bucket.

**Completion:** every ticket has a proposed disposition and an evidence-backed rationale.

## 4. Review stale and ambiguous work with the user

Present recommendations in small, coherent batches, grouped by parent effort or shared rationale. Start with tickets that look stale, completed-but-open, duplicate, or ambiguous; do not make the user review plainly active tickets one by one.

For each recommendation show:

```text
<ticket ID> — <title>
Recommendation: <disposition>
Evidence:
- <observable evidence>
Effect: <whether a GitHub issue will be open, closed historical context, or omitted>
```

Ask for one of: approve the batch, review a named ticket, change a disposition, preserve historical context, or stop. Record user decisions in the temporary inventory.

When a recommendation depends on a product decision rather than repository evidence, ask one focused question with a recommended answer. Do not infer the user's intent from ticket age or wording alone.

**Completion:** the user has approved a disposition for every ticket that will be omitted, migrated as historical context, or migrated as active work.

## 5. Present the migration map

Create `.pi/tmp/tk-to-github/report.md` and a machine-readable `.pi/tmp/tk-to-github/migration.json` that contain:

- all source IDs and approved dispositions;
- proposed GitHub title, body summary, labels, and state for each migrated ticket;
- proposed parent, blocker, and related-ticket mappings;
- an explicit list of omitted tickets and the approved reason;
- unresolved capability or data-quality warnings.

Show the map to the user. Obtain explicit approval before publishing it.

**Completion:** the user has an approved, reviewable migration map or has asked to revise it.

## 6. Publish the approved map

Use the typed GitHub tools; never reconstruct raw `gh api` commands in a migration run.

1. Dry-run `github_issue_mutate` for every missing migration and triage label, then apply only the approved label set.
2. Convert approved `migrate-open` and `migrate-closed` records into one `github_issue_plan`. Use a stable plan key derived from the repository and migration run; use the source `tk` ID as each plan issue key. The tool adds a stable hidden provenance marker and returns the source-key-to-GitHub mapping.
3. Dry-run the complete plan. Confirm that its titles, labels, states, and omitted tickets match the approved report. Then apply it.
4. Re-run the same plan after any interruption. Existing provenance markers must resolve to existing issues rather than create duplicates.
5. Use `github_issue_relationship` to create approved parent/sub-issue and blocker edges from the returned mapping. Dry-run each relation before applying it. Preserve valuable non-blocking `tk link` context as reciprocal issue comments.
6. For a closed historical issue, add a concise migration comment explaining that it was imported from the listed tk ticket; do not copy transient command logs.

If label, issue, or relationship publication partially fails, leave `.tickets/` untouched, record the failed source IDs in the temporary manifest, and resume from the same stable keys.

**Completion:** every approved source record has either one mapped GitHub issue or an approved omission, and the temporary manifest records every resulting URL, state, label, and relationship result.

## Handoff

Report the source-ticket count, disposition totals, approved stale/omitted tickets, unresolved decisions, and paths to temporary artifacts. Point to the later publication and reconciliation workflow; do not claim migration is complete while `.tickets/` remains authoritative.
