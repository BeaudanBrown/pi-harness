# Managed host tooling: agent navigation map

Use this map to trace a feature before changing it. Paths below are relative to
`config/agent/extensions/managed-sessions/` unless stated otherwise. One
`managed_host` tool exposes typed operations, not independent copies of every
workflow. Operator surfaces share the same contracts and owners.

## Trace an operation

1. **Arguments and results:** `live-workspace-contracts.ts` is the exact operation
   catalog and response schema. `host-tool.ts` derives the flat agent tool schema
   and help. `host-command.ts` and `relay/host-cli-args.ts` translate operator text.
2. **Authenticated admission:** `relay/host-dispatcher.ts` checks frontend-supplied
   actor identity and `relay/host-policy.ts` enforces the deployed
   `config/agent/managed-host-policy.json`. Model mutations always need approval.
   Only read requests use the dispatcher's replay cache.
3. **Preview handles:** `relay/host-preview-store.ts` owns bounded retention,
   detachment, expiry, operation correlation and response bounds. A preview ID is
   neither consent nor a durable execution receipt. Feature snapshots are opaque
   to this module; it never executes them.
4. **Consent:** `relay/host-mutation-owner.ts` freezes feature snapshots and routes
   revalidation/execution. `relay/host-approval-{runtime,record,store,prompts}.ts`
   owns independent approval, durable scope and presentation. Frontend adapters
   must not enforce a weaker policy or create an alternative mutation route.
5. **Feature implementation:** use the table below. Keep feature orchestration in
   its module rather than extending the central lifecycle class for every feature.
6. **Production wiring:** `relay/main.ts` supplies real adapters, starts background
   account/runtime observation, and drains owners on shutdown. A tested library
   that is not wired here is not an available feature.

## Feature owners and tests

Tests are under `tests/`; most names have the prefix `managed-session-`.

| Operation family | Owning modules under `relay/` | Starting tests |
| --- | --- | --- |
| List/status/workspaces | `host-read-model`, `host-inventory-pages`, `runtime-observer` | `host-read-model`, `runtime-observer`, `host-cli` |
| Create/open/resume/stop/fork/worktree | `host-lifecycle`, `exact-window-client`; fixed launcher operations | `exact-lifecycle`, `host-mutation-owner`, `live-hierarchy` |
| Legacy migration/recovery | `legacy-window-migration`, `manual-legacy-recovery`; fixed `scripts/managed-legacy-observe.py` | `exact-lifecycle`, `legacy-observe`, `test_managed_legacy_observe.py` |
| Permission changes | `operator-admin`, lifecycle's narrow approval methods | `operator-admin`, `migration-space-admin` |
| Retirement | `conversation-retirement`, `retirement-store`, `retirement-cleanup`, `retirement-ancestor-owner` | `retirement-registry`, `host-mutation-owner` |
| Live hierarchy/reconciliation | `live-hierarchy`, `project-reconciliation`, `live-space-cleanup` | `live-hierarchy`, `reconciliation` |
| Readable archival | `archive-host-controls`, `archive-runtime`, `archive-hierarchy`, `archive-store` | `archive-hierarchy`, `archive-registry`, `host-preview-store` |
| Account membership/notification setup | `host-account-owner`, `host-account-client`; `config/agent/extensions/bridge-chat/account-{proof,worker,store}.ts` | `host-account-client`, `live-hierarchy`, `bridge-chat-account` |

Exact filenames can differ from a family label: use `rg --files tests` to locate
all affected coverage. Frontend/policy coverage is shared in `host-frontends`,
`host-cli`, `live-workspace-contracts`, `host-approvals` and `host-mutation-owner`.

## Archive walkthrough

`conversation.archive.preview` enters the shared mutation owner's preview route,
then `ArchiveHostControls.snapshot`. `ArchiveRuntimeChecks` screens runtime/work
state; `ArchiveHierarchy.preview` reads historical grouping/Matrix ownership without
resolving deleted checkouts. The shared preview store returns a bounded handle.

`conversation.archive.apply` goes through shared independent consent and fresh
snapshot revalidation. The archive hierarchy writes the intent, obtains fresh
closure evidence, records its consent reference, and asks the registry to admit
negative archive authority. Only then can it create/link archive Spaces and unlink
original links. Actual operator membership across the archive path is required.
A separate cleanup operation uses the same live-Space cleanup module as ordinary
reconciliation; it never grants permission to retire the conversation room.

`legacyClosure=true` requests an explicit, disclosed operator closure attestation.
The complete conflict screen is **not** a proof of historical process exit. Exact
process checks are used where recorded birth identity exists; known conflicts
cannot fall back to attestation. Unknown/incomplete inspection and pending work
block both modes. Archiving the agent's own active conversation is blocked too.

`conversation.archive.list` is a separate bounded inventory. Active inventories
exclude admitted archives. `readable-archive-v1` in host capabilities advertises
installed controls, not fleet health, account readiness or completed archival.

## Authority and persistence

- `registry.json`: serialized runtime projection. Do not split its writer merely
  to reduce file size; concurrent admission/rollback invariants live here.
- `archives.json` plus `archives.json.initialized`: independent negative archive
  authority, surviving restoration of an older runtime projection.
- `live-workspaces/archive-hierarchy.json`: frozen source/grouping, closure receipt
  (including approved operation reference for legacy attestation), creation
  attempts, link/unlink progress and independently retryable cleanup.
- `live-workspaces/hierarchy.json`: live reservations and retired Space fences.
- `retirements/`, `host-approvals/`, `account/`: their respective independent owners.

Back up these coherently with manifests/history. Do not restore one old authority
file or reconstruct lost receipts from room names. Missing authority fails closed.
No startup path automatically resumes an archive mutation; continued archival
needs a fresh preview and approval. New account setup can process already-created
archive Spaces through its existing account-only policy.

Unadmitted archive drafts have made no archive Matrix effects. A fresh preview may
replan them, but only a newly approved apply can replace the draft; no uncertain
creation receipt may be discarded. Admitted intents remain immutable.

## Adding an operation checklist

- Identify the owning module and its interface. Prefer locality over a new generic
  registry/plugin layer or a pass-through module.
- Add exact input/result schemas and read/mutation classification; update policy.
  Test unknown fields, bounds, coordinator protection and actor spoofing.
- Keep adapters schema-driven. Exercise tool, CLI and Matrix parsing/presentation;
  never silently truncate a preview into an apparently applicable token.
- Specify frozen scope, consent disclosures, expiry and revalidation. Use the
  shared preview store, not a second cache. Metadata-only actions need not acquire
  unrelated active-run proofs; runtime-changing actions must prove their own safety.
- Record acceptance/evidence and crash matrices. Decide who owns negative authority,
  whether uncertainty poisons the owner, and how recovery avoids duplicate effects.
- Test through callers' interfaces with real durable owners and narrow effect
  adapters. Exercise affected existing operations as well as the new feature.
- Wire startup, account integration and shutdown. Check both relay and bridge
  package source selection when contracts cross the NAS seam. Do not confuse
  recipe-selected compilation with actual Nix/package verification.
- Update help/skills and this map; run the required gates and cumulative epic review.
  Publication, activation and live effects remain distinct approvals.

The large `host-lifecycle.ts` and `registry.ts` remain intentional follow-up
candidates, not targets for an unbounded rewrite. This change separates reusable
preview mechanics and archive orchestration while retaining their safety owners.
