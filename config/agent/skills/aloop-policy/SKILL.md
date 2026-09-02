---
name: aloop-policy
description: Create or review a repository-owned .aloop.json verification policy for GitHub-native aloop without generating one automatically.
---

# Aloop verification policy

Use this skill when a project needs to create, migrate, or review `.aloop.json`.
The project owns the file. Never generate or silently rewrite it merely because
`/aloop` was invoked.

## Schema

Declare one required canonical acceptance command as an argv array:

```json
{
  "canonicalCommand": {
    "argv": ["nix", "run", ".#verify"],
    "timeoutMs": 1800000
  }
}
```

`timeoutMs` is optional and defaults to 30 minutes. Commands are executed
directly, without an implicit shell. Use an explicit argv such as
`["bash", "-lc", "..."]` only when the project deliberately requires shell
syntax.

Optional fields are:

```json
{
  "workerFeedbackCommand": {
    "argv": ["nix", "run", ".#test-fast"]
  },
  "productionIntegration": {
    "frequency": "issue",
    "command": {
      "argv": ["nix", "build", "--no-link", ".#default"]
    }
  },
  "workerResources": {
    "extensions": [".pi/extensions/project-worker.ts"],
    "tools": ["project_lookup"]
  }
}
```

- `workerFeedbackCommand` is advisory guidance for implementation workers.
- `canonicalCommand` is mandatory and supervisor-owned.
- `productionIntegration.frequency` is `issue` or `epic` and controls when the
  optional integration command runs.
- `workerResources` is an explicit opt-in to repository-contained worker
  extensions and their tool names. Do not use it to grant supervisor mutation,
  communication, or local-interaction tools.

## Review checklist

1. Read `AGENTS.md` and the repository's documented verification entrypoints.
2. Confirm every command is an exact argv array and can run from repository root.
3. Keep canonical acceptance deterministic and comprehensive.
4. Add worker feedback only when a cheaper focused check helps iteration.
5. Choose issue-frequency production integration only when every accepted child
   must prove it; otherwise use epic frequency.
6. Set explicit timeouts only when the 30-minute default is inappropriate.
7. Run each configured command manually before committing the policy.
8. Review project worker resources as code with the same trust as the repository.

Legacy shell-string fields such as `"canonicalCommand": "make test"` and
`productionIntegrationCommand` are invalid and must be migrated explicitly.
