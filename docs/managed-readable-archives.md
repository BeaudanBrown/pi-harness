# Readable archives (#139)

Implementation in progress; not deployed and not yet a public operation.

An archive preserves the original Matrix room, history and operator membership,
but removes the conversation from active runtime/input management. It is neither
stop (resumable) nor retirement (leave/forget). No reactivation is included.
Historical grouping is host -> Archive -> project -> worktree -> conversation.
Missing checkout folders are not restored or resolved. Stable saved metadata,
not a live filesystem lookup, establishes historical grouping.

## Ownership and acceptance evidence

| Scope | Owner | Evidence |
| --- | --- | --- |
| Durable negative authority, retained manifest/history, restart and stale nonce/creation rejection | #140 | Archive store and real-registry tests |
| Preserve existing room and membership; restart-safe create/link/unlink; shared empty-ancestor checks | #141 | Matrix fault injection and sibling fixtures |
| Preview/apply, independent consent, explicit blockers, bounded archive inventory | #142 | Host/frontend/CLI contracts and approval tests |
| Cumulative verification, review and publication | #143 | Full affected tests, package-source compilation, paired epic reviews |

Runtime closure, unfinished inputs, controls, polls, exports and projection work
must be resolved before admission; null/missing runtime observations are not
proof of closure. The registry enforces known durable blockers; the archive owner
must additionally establish fresh runtime closure evidence before requesting admission.
Exact recorded process exit is used where available. The operator approved a
separate legacy path: explicit confirmation that the old Pi was closed, combined
with fresh complete conflict screening. This is recorded as operator attestation,
not verified exit; known conflicts or unreadable processes cannot be waived.
Missing operator membership is a blocker, not implicit permission to reinvite.
Coordinator archival, filesystem deletion, implicit message cancellation,
reactivation and membership restoration are outside this implementation.

## Hierarchy implementation acceptance (#141)

| Criterion | Implementation seam | Focused evidence |
| --- | --- | --- |
| Deleted checkout, stable historical grouping | Archive hierarchy derives identity from saved checkout ID or saved root/workspace tuple; no workspace resolver | Missing-directory fixtures, shared sibling grouping |
| Preserve original room and membership | Read-only private-room/provenance and operator-join verification; no room creation/reinvite for conversations | Original room unchanged; missing membership blocks |
| Durable create/link/unlink recovery | Frozen journal precedes admission/effects; saved create-attempt and stable aliases; forward recovery | Inject failure after remote acceptance and local write failures |
| No premature unlink | Verify archive path and actual operator membership before selected source unlink | Pending joins preserve old links |
| Shared ancestor safety | Existing live-hierarchy project exclusion and owned/empty/unreferenced cleanup | Active reservations, unrelated children/members, account outage |
| Account integration | Archive Space provenance and matching account proof contract | Strict parent-chain validation and notification preservation |

Public consent, exact-selection host tools, loaded-runtime wiring and final epic
acceptance remain #142/#143. The hierarchy owner accepts only host-frozen plans;
its caller must possess independent operator approval. It requires fresh runtime
absence evidence before first admission. Merely lacking an attachment is not
that evidence. Matrix has no compare-and-swap: immediate pre-write checks and
readback detect observed conflicts, but cannot eliminate an external same-key
write between those checks.

## Tooling/refactoring acceptance (#142)

| Criterion | Owning change | Evidence |
| --- | --- | --- |
| One bounded preview implementation | `host-preview-store.ts`; existing mutation owner delegates retention/expiry/correlation | New preview-store tests and all existing operation-family tests |
| Thin adapters, feature-owned archive orchestration | `archive-host-controls.ts`, schema-derived tool/CLI, shared approval owner | Catalog, frontend, policy and real registry/archive-owner tests |
| Exact exit vs explicit legacy attestation | `archive-runtime.ts`, strict read-only observer; closure receipt before admission | Live/changed/replacement and incomplete-inspection regressions; Python observer tests |
| Approval scope/expiry and no model bypass | Shared frozen preview; explicit legacy disclosure; operation-reference receipt | Approval question, expiry, changed inspection, cross-operation handle and receipt tests |
| Archived inventory and coherent persistence | Paginated archive-only inventory; startup/shutdown/account wiring; live-workspaces relocation | Active inventory exclusion, account tests, relocation tests and package checks |
| Navigability | `managed-host-tooling-map.md`, linked README/skill; no central lifecycle rewrite | Trace entrypoint -> policy/consent -> feature owner -> authority/tests |

The refactor moves cache/bounds mechanics out of the mutation orchestrator and
keeps archive behavior out of the central lifecycle class (apart from a narrow
fixed-observer invocation). A new preview/apply operation reuses the same storage
and schema-driven adapters, rather than copying another cache or argument parser.
No registry writer split or new plugin framework is introduced.

## Crash boundaries

| Boundary | Required result |
| --- | --- |
| Preview, before approval | No archive effects; frozen exact selection and metadata |
| Fresh runtime/queue checks, before fence | Changed state blocks; no implicit discard |
| Archive authority write uncertain | Fail closed in memory until reload; never resume ordinary dispatch |
| Attestation receipt before admission | Store basis, checked identity digest and approved operation reference; retry still requires fresh consent/inspection, never replay the receipt as authorization |
| Unadmitted draft becomes stale | Fresh read-only preview may replan; only newly approved apply replaces an effect-free draft; never discard a create-attempt receipt |
| Durable fence before runtime projection write | Separate archive authority wins over runtime rollback/restored old registry |
| Before first Matrix effect | Stable archive targets and creation attempts recorded |
| Create/link accepted before receipt | Inspect exact alias/provenance/state; never allocate a new identity |
| Archive link before active unlink | Preserve room/history, recover forward; temporary duplicate visibility is preferable to lost access |
| Archived room before ancestor cleanup | Archive remains valid; cleanup is separately reported/retryable |
| Shared/unowned/nonempty ancestor | Preserve it; no recursive deletion or membership removal |

The archive record is host-private negative authority. A compatible backup must
include `archives.json` and `archives.json.initialized` together with registry,
manifests and archive hierarchy journals. Initialization writes an empty authority
before its independent presence marker; a missing initialized authority fails
closed even when an older registry without archive markers is restored. Restoring
or deleting *all* authority files from an older backup is not a supported undo.
Relocation copies both archive files and validates them before publication.
Older binaries that ignore archive authority must not be used after live archive
admission. Runtime projections carry an archive marker as an additional strict
reader fence; it does not replace the independently durable authority record.

## Foundation verification (#140)

The foundation includes 18 archive regression cases plus the existing managed
suite. Before the final relocation case was added, cumulative verification was
653 passed, zero failures, 48 packaged/environment skips. TypeScript/LSP and both
relay/bridge recipe-selected source compilations passed (not actual Nix builds).
Review findings were fixed together: independent presence marker for missing
archive authority after old-registry restoration, filtering all poll-publication
readers, and normalizing archived runtime projections to dormant/null attachment.
Tests retain historical queue/publication data rather than erasing or cancelling it.

## Historical hierarchy implementation (#141)

`relay/archive-hierarchy.ts` owns the host-private `archive-hierarchy.json` journal.
It freezes the exact source and ancestors before admission, reserves stable
archive-only Space identities, persists create attempts before remote calls, and
recovers uncertain effects by exact alias/provenance readback. Original room
provenance is retained, not rewritten. Missing or contradictory journal authority
blocks recovery; never restore an older journal in isolation or reconstruct lost
receipts from room names. The runtime owner directory/wiring is supplied by #142.

An existing source-room membership loss blocks archival without an invitation.
New archive Spaces use pinned supported room versions and operator admin, with
account-only archive parent-chain proofs and notification-policy preservation.
Actual operator joins to the whole archive path are required before original
links are removed. Pending joins retain the old links. Automatic joins require
the updated NAS account companion as well as the host; an older companion cannot
accept the new archive Space kinds. This is a deployment requirement, not a live
readiness claim.

`relay/live-space-cleanup.ts` shares the owned/empty/unreferenced project-scoped
cleanup checks with ordinary hierarchy maintenance. Cleanup is separate from
successful archival. Shared/untracked/unowned ancestors are preserved. A lost bot
leave reply leaves cleanup pending: departure and a missing parent link are not
fresh emptiness proof, and the departed bot cannot inspect private current state.
There is no implicit rejoin, kick, or inferred completion. This safety tightening
also applies to existing standalone Space cleanup. An independently verified
repair is required when current ownership/emptiness can no longer be established.

Verification before review: 691 affected tests passed, zero failed, 48 packaged/
environment skips; TypeScript/LSP and relay/bridge recipe-selected compilations
passed. The Standards medium finding on inferred post-departure cleanup completion
was accepted and fixed conservatively as described above; Spec found no current-
issue defects. Regression evidence includes a foreign child/member appearing
after uncertain departure. Final affected verification after remediation: 692
passed, zero failed, 48 packaged/environment skips; both recipe-selected source
compilations passed again. Canonical Nix/package verification and complete-epic
review/publication remain #143; recipe-selected compilation is not a Nix build.

The #142 implementation now wires runtime checks, host/account startup and
shutdown, confirmed archive/cleanup operations and bounded archive inventory.
`legacyClosure=true` on preview opts into a disclosed attestation, not weaker
checks for known active or conflicting runtimes. The closure receipt records the
approved operation ID; admitted archive intents are never replayed on startup.
Retries of admitted archives still require fresh closure/conflict inspection and,
for legacy targets, fresh explicit attestation. The original receipt remains audit
history; a separate last-inspection receipt records the newly approved operation
before further Matrix effects. The archive fence never substitutes for inspection.

#142 verification: the isolated preview-only refactor compiles and passes 31 focused
existing/new tests. The integrated change passes 700 affected tests (48 packaged or
environment skips), 14 Python observer cases, both recipe-selected source compiles,
and diff checks. These are not actual Nix/package builds. Paired review identified
missing fresh inspection on already-admitted retries; this is fixed and covered by
a restart/conflict/incomplete-inspection/audit-receipt regression. Generated Python
bytecode was removed and ignored.

Final verification/review/publication remains #143. Nothing is deployed, and
no live conversation was archived. Do not describe the feature as rebuild-ready
until #143 records canonical verification, cumulative review and publication.
