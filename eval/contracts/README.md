# Synthetic evaluation contracts

The normative architecture and terminology are recorded in
[`docs/architecture/decisions/0001-synthetic-evaluation-contracts.md`](../../docs/architecture/decisions/0001-synthetic-evaluation-contracts.md).

Versioned Draft 2020-12 JSON Schemas live under `schemas/v1/`. Representative
valid and invalid instances live under `fixtures/`; they contain only fabricated
examples. `path-policy.ts` adds canonical filesystem checks that JSON Schema
cannot express, including symlink-escape and hidden-oracle alias rejection.

Validate the complete repository contract through:

```console
nix run .#verify
```

Consumers must reject unsupported `schemaVersion` values rather than selecting
the latest schema implicitly.
