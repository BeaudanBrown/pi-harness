# Synthetic evaluation schema v2 migration

Version 2 changes only the scenario/UI-policy contract needed by the strict Pi
RPC engine. Other contract documents remain on their v1 schemas.

## Why v2

Pi RPC extension UI requests expose a request ID, method, title, and
method-specific fields. They do not expose the originating extension ID. The v1
UI policy modeled an unobservable `extensionId` and action abstraction, so it
cannot safely drive the RPC protocol.

## Migration

For a scenario using extension dialogs:

1. Change `schemaVersion` from `1.0.0` to `2.0.0` and validate with
   `v2/scenario.schema.json`.
2. Replace each v1 dialog's `extensionId`, `requestType`, and `title` fields with
   `request`, containing the exact observable RPC payload except `type` and
   request `id`.
3. Replace `{ "action": "deny" }` with `{ "cancelled": true }` (or
   `{ "confirmed": false }` for confirmation denial).
4. Replace approved responses with the method-compatible RPC response:
   `{ "confirmed": true|false }` for `confirm`, or `{ "value": "..." }`
   for `select`, `input`, and `editor`.
5. Keep `defaultAction: "deny"`.

The v1 schemas remain unchanged for compatibility. The RPC engine accepts only
the v2 observable request/response shape; a loader must reject live execution
of a v1 dialog policy with a migration error rather than claiming it can match
an extension identity Pi does not emit.
