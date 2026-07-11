---
name: migrate-tk-to-github
description: Inspect a tk-backed project, review stale tickets with the user, and prepare an approved one-way migration plan to GitHub Issues.
disable-model-invocation: true
---

# Migrate tk To GitHub

Run the **inventory** phase of a one-way `tk` to GitHub Issues migration. This phase establishes the approved disposition of every source ticket; it does not create, edit, close, or label GitHub issues, and it does not remove `.tickets/`.

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

Show the map to the user. Obtain explicit approval before continuing to a later publication phase. Do not create GitHub issues from this skill phase.

**Completion:** the user has an approved, reviewable migration map or has asked to revise it.

## Handoff

Report the source-ticket count, disposition totals, approved stale/omitted tickets, unresolved decisions, and paths to temporary artifacts. Point to the later publication and reconciliation workflow; do not claim migration is complete while `.tickets/` remains authoritative.
