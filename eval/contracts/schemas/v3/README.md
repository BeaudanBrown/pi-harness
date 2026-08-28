# Synthetic evaluation scenario schema v3 migration

Version 3 keeps the v2 observable RPC UI policy and adds two deterministic
grading assertion types required by issue #31:

- `stale-tool-forbidden`, requiring `tool`;
- `max-blocked-attempts`, requiring non-negative `maximum`.

## Migration from v2

1. Change the scenario `schemaVersion` from `2.0.0` to `3.0.0`.
2. Validate with `v3/scenario.schema.json`.
3. Add either new assertion only when the scenario needs that check.

All existing v2 scenarios remain valid and retain their prior meaning. The v1
and v2 assertion schemas are unchanged; consumers must not reinterpret those
versions as accepting the new assertion enum values. Other top-level contract
document types remain on v1.
