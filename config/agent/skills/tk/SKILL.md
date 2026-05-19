---
description: Use tk, the git-backed ticket system, for task planning, dependency tracking, and /aplan or /aloop workflows.
---

# tk Ticket Workflow

Use this skill when working with tasks, tickets, issues, implementation plans, `/aplan`, or `/aloop` in this project.

This project uses `tk`, a git-backed ticket system. Tickets are Markdown files with YAML frontmatter under `.tickets/`. Treat `tk` as the durable task source of truth.

## Quick Reference

```bash
tk help                  # command reference
tk ls                    # open tickets
tk ready                 # open/in-progress tickets with dependencies resolved
tk blocked               # tickets blocked by unresolved dependencies
tk closed --limit=10     # recently closed tickets
tk show <id>             # full ticket details
tk start <id>            # mark in_progress
tk close <id>            # mark closed
tk add-note <id> "..."   # append timestamped note
tk dep <id> <dep-id>     # id depends on dep-id
tk dep tree <id>         # dependency tree
tk link <id1> <id2>      # related tickets
```

## Planning Workflow

For larger work, create one epic ticket and child tickets:

```bash
epic=$(tk create "Feature name" -t epic -d "Objective" --design "Decisions and context" --acceptance "Success criteria" --tags agent-loop)
tk create "Implement first chunk" --parent "$epic" -d "Specific scope" --design "Approach" --acceptance "Done criteria" --tags agent-loop,chunk
tk dep <later-ticket> <earlier-ticket>
```

Good child tickets are independently committable and small enough for one fresh `/aloop` worker iteration.

## Implementation Workflow

Before work:
1. Run `tk ready` to find actionable tickets.
2. Read the ticket with `tk show <id>`.
3. Start it with `tk start <id>`.

During work:
- Keep scope limited to the selected ticket.
- If prerequisite work is discovered, create/link a ticket and add a dependency instead of silently expanding scope.
- Add notes for important discoveries: `tk add-note <id> "..."`.

After work:
1. Run relevant verification.
2. Close the ticket only when acceptance criteria are satisfied: `tk close <id>`.
3. If this closes the final child under an epic, verify the epic acceptance criteria, add a closeout note, and close the epic.
4. Commit code changes and `.tickets/` updates together.
5. Never push unless the user explicitly asks in the current session.

## Agent Loop Commands

- `/aplan <rough idea>` starts a clarification/specification flow and should create a tk epic plus child tickets after decisions are clear.
- `/aplan create <rough idea>` may create tickets immediately if enough detail is available.
- `/aloop <iterations> <ticket-or-epic-id>` runs fresh-agent implementation iterations over ready tk tickets.
- `/aloop status <ticket-or-epic-id>` summarizes tk state.
