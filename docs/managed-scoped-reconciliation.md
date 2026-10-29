# Scoped Space reconciliation (#131)

Select exact conversation IDs with `space reconcile preview --conversation-ids <ids>`.
The existing unscoped maintenance preview remains available. Selection does not
restore missing workspaces or memberships, restart Pi, or replace room histories.
Blocked selections must be narrowed or repaired before apply; no silent skipping.

## Acceptance and evidence

| Requirement | Evidence |
| --- | --- |
| Selected conversations and their ancestor links only | Scoped hierarchy tests, frontend/schema tests |
| Missing workspace yields named blocker, no side effects | Selected missing-workspace fixture |
| Exact selection frozen; in-flight plans cannot expand | Consent and interrupted-plan tests |
| Healthy subsets of older broad plans can continue | Broad checkout and pre-checkout journal restart fixtures; excluded entries unchanged |
| Preserve rooms/history and unrelated links | Existing hierarchy migration crash fixtures plus selection assertions |
| New migration Spaces grant configured operator admin | Atomic creation/version tests and hierarchy restart/readback tests |
| Never promote existing rooms without admin consent | Alias recovery/readback failure tests |
| No duplicate Spaces after interruption | Durable hierarchy reservations and alias recovery fixtures |

## Crash boundaries

| Boundary | Recovery |
| --- | --- |
| Preview | Read-only; blockers authorize nothing |
| Durable selected plan before effects | Resume only its original selection with fresh approval |
| Older unscoped plan | An explicitly selected subset updates only its original entries; excluded entries and original plan identity remain unchanged |
| Completed subset needs newer checkout migration | Separate deterministic scoped journal; always recover an existing scoped journal across restart |
| Space reservation/create attempt | Existing alias/provenance recovery; never retry an uncertain create as a new identity |
| Created Space before admin verification | Saved creation policy survives restart; verify before publishing links |
| New links before manifest update | Reuse hierarchy identity and idempotent grouping commit |
| Manifest update before old unlink | Preserve old link until new hierarchy verified; retry only saved effects |

Older unscoped plans can be continued for an explicitly approved subset without
resolving missing excluded workspaces. For pre-checkout plans this may require two
preview/apply rounds: finish the selected old grouping steps, then perform the
selected checkout migration. The original journal is retained; follow-on state
lives under a deterministic `scoped-<digest>/` directory. Excluded entries are not
marked complete or retired. New scoped plans cannot silently change selection.

New hierarchy records persist an optional migration-admin creation-policy flag.
Older binaries that cannot read that flag are not a safe rollback target after
live migration; preserve state and use a compatible build rather than deleting it.

Existing-room admin migration and future conversation-room provisioning (#130)
remain separate. This change grants admin only as part of creation of new migration
Spaces, not by overwriting existing power state. No immutable co-creator grants.
No builds, activation, live reconciliation or missing-workspace restoration are
performed during source implementation.

## Verification and review

TypeScript compilation and 195 affected Node tests passed (seven packaged checks
skipped). Tests cover selected approval forwarding/disclosures, blocked selection,
restart during both broad-plan formats, excluded missing/retired siblings, atomic
admin policy for versions 10/11/12, alias uncertainty, admin readback and hierarchy
link readback failures. Inherited managed model/thinking variables are unset only
for test subprocesses to avoid unrelated lifecycle-fixture contamination.

Standards/Spec review first identified old broad journals blocking selected
continuation; fixed with original-key-bound subset progress and deterministic
follow-on journals. A second review prompted explicit exclusion of unselected
retirement observations and a retired-sibling regression. No other findings.
Canonical `nix run .#verify`, package/module checks and live deployment acceptance
remain pending under the no-build constraint. No LSP errors (one existing async
style hint). An operator rebuild and separately approved scoped migration are
required to validate actual Matrix hierarchy and account/client visibility.
