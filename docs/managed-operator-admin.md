# Operator admin migration (#129)

The configured operator should have room-management power in each bot-owned
conversation and Space. Inviting the operator with `private_chat` does not grant
that power. Matrix membership/agent access and Matrix administration are separate.

## Commands after deployment

```sh
pi-managed-session conversation admin preview --conversation-ids conv_<exact-id> --include-spaces --json
pi-managed-session conversation admin apply --preview-id preview_<returned-id> --confirmed --json
```

Comma-separated IDs select a batch. The preview deduplicates shared Spaces and
lists exact affected conversations/Spaces plus uncertainty warnings. Select smaller
batches if the frozen state exceeds the bounded approval frame. `--include-spaces`
is optional; room permissions never inherit from Space permissions. The same
syntax is available under `!host` and `/host`; models must use the typed tool with
independent approval. Only known current bindings are eligible; retired identities,
unjoined/uninvited operators, foreign rooms and inaccessible state fail closed.
No membership is restored, no friend is removed, and no existing participant's
power is lowered. Ordinary admin is not immutable creator status or authority to
remove equal/higher-powered administrators. Some v12 creator-only operations such
as room upgrades can remain above ordinary admin power.

## Scope and acceptance

| Requirement | Source change | Evidence |
| --- | --- | --- |
| Only configured operator, known host-owned rooms/Spaces | Host-derived preview; bot provenance/type/membership checks | Target and ownership tests |
| Preserve all other powers/settings/members | Change only operator entry; keep higher existing level | Power planning tests |
| No guessed authority in v12 | Verify immutable creator; never add a creator to users | Version/creator tests |
| Explicit consent, stale target rejection | Existing host approval preview/apply | Frontend/owner tests |
| No blind retry after uncertain external writes | Durable attempted-write receipt, fresh preview/approval on retry | Fault tests |
| Readback before success | Verify complete expected power content | Readback/conflict tests |

Matrix state writes have no compare-and-swap. Fresh before-write comparison and
readback detect many races but cannot guarantee an unrelated edit made between
GET and PUT is preserved. The approval must disclose this limitation. Coordinate
room-permission editing during migration; do not advertise transactional safety.

## Crash boundaries

- Preview and consent: no Matrix writes; frozen state expires on restart/change.
- Before PUT: durable attempt record; no background replay.
- Unknown PUT outcome: stop this apply. New preview reads current state; already
  elevated rooms need no write. A new attempt requires fresh consent.
- After PUT: verify exact expected state before recording success.
- Partial batch: retain per-room audit; do not roll back or expand scope. A fresh
  preview can complete remaining targets without rewriting completed rooms.

## Runtime transition plan (independent of admin permissions)

Inventory at planning time: two exact-owned active chats; 16 dormant chats with
absent legacy windows; nine project chats with retained legacy windows; one
legacy coordinator; six dormant chats without saved windows. Counts can change.
Prioritize ihp-roster development (three queued messages and a launch failure).
Do not treat absence of a window as proof of process exit. Require closure
confirmation, uncertainty acceptance, fresh preview and per-call approval for
already-closed chats. For retained windows capture migration evidence before
controlled closure. Attached/busy work stays untouched. Coordinator recovery is
separate and must not use the project recovery path. No bulk reset or shared tmux
restart. Room hierarchy changes are not part of runtime recovery.

## Verification and review

- Focused admin/Matrix/frontend/schema tests passed; TypeScript test compilation
  passed. Broader affected suites: 217 passed, seven packaged checks skipped.
- Local test commands unset inherited `PI_MANAGED_SESSION_MODEL` and
  `PI_MANAGED_SESSION_THINKING`: one lifecycle fixture otherwise inherits this
  live chat's model and fails its unrelated model expectation. The same failure
  reproduced on the pre-admin compiled baseline; neutralizing only those two
  test-process variables restored the affected suite. No live environment changed.
- Standards and Spec reviewed the pinned worktree against `c77d5b8`, with no
  findings. Local review artifacts:
  `.pi/tmp/reviews/2026-10-29T02-47-16-222Z-worktree-ff2c118a6bc9-37b1c93d898f/`.
- No LSP errors. Canonical Nix verification, package/module builds, deployment,
  actual room power inspection/mutation and live acceptance remain pending under
  the existing no-build/no-activation boundary.

## Future-room policy plan (#130)

Use explicit admin level 100 for the exact configured operator at creation.
Keep ordinary invitees at normal member power. Preserve legacy bot creator power;
for room v12 do not put any immutable creator in the `users` map. Negotiate and
pin a supported room version before constructing the creation request so server
default changes cannot invalidate that distinction. Include both rooms and Spaces,
verify the resulting rights, and keep provisioning incomplete if rights cannot be
verified. Never use `trusted_private_chat` as a shortcut: on v12 that can grant
immutable creator status, which is a different policy from ordinary admin access.
Existing rooms must never be replaced to obtain co-creator status.

This future provisioning change is a separate implementation slice; the migration
must be available for existing rooms regardless. No NAS account impersonation or
server-admin token is needed: each owning bot updates its own rooms. Missing bot
authority, unsupported room versions and unusual thresholds require investigation.
Member removal and loss of already-downloaded history are separate concerns.

Deployment and individual live permission/recovery applications require separate
approval. No host builds, service activation, or automatic fleet-wide writes.
