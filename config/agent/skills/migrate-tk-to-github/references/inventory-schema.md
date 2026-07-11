# tk Migration Inventory Schema

One record exists for every source ticket. Keep the record in `.pi/tmp/tk-to-github/migration.json`; it is temporary operational evidence, not a committed tracker.

```json
{
  "source": {
    "id": "ph-ab12",
    "path": ".tickets/ph-ab12.md",
    "title": "...",
    "status": "open|in_progress|closed",
    "type": "epic|feature|task|bug|chore",
    "priority": "0",
    "tags": ["..."],
    "parent": "ph-parent",
    "dependencies": ["ph-prerequisite"],
    "related": ["ph-related"],
    "created": "ISO-8601 or null",
    "updated": "ISO-8601 or null",
    "description": "...",
    "design": "...",
    "acceptance": "...",
    "notes": ["..."]
  },
  "evidence": {
    "code": ["path or observed behavior"],
    "tests": ["test path or result"],
    "git": ["commit, branch, or PR"],
    "github": ["existing issue URL"],
    "documentation": ["path or ADR"]
  },
  "proposedDisposition": "migrate-open",
  "rationale": ["observable evidence"],
  "userDisposition": null,
  "github": {
    "proposedTitle": "...",
    "proposedLabels": ["..."],
    "proposedState": "open|closed",
    "issueNumber": null,
    "url": null
  }
}
```

Keep source text sufficient to preserve decisions and acceptance criteria. Summarize repetitive command logs and transient handoffs rather than copying them as issue body noise.
