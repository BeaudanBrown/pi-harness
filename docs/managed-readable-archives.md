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
must additionally establish fresh runtime absence before requesting admission.
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

## Crash boundaries

| Boundary | Required result |
| --- | --- |
| Preview, before approval | No archive effects; frozen exact selection and metadata |
| Fresh runtime/queue checks, before fence | Changed state blocks; no implicit discard |
| Archive authority write uncertain | Fail closed in memory until reload; never resume ordinary dispatch |
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

The hierarchy library and account-contract support are implemented, but real
runtime-absence observation, host startup/account wiring, independent public
consent, preview/apply/list/CLI tools remain #142. Nothing is deployed, and no live
conversation was archived. Do not describe this partial change as an available
archive workflow.
