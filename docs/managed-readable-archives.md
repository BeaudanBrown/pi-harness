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

This remains only the negative-authority foundation. Fresh external process
absence, account membership checks, archive hierarchy effects, shared ancestor
cleanup, public archive tools and final cumulative epic review are unfinished.
Do not deploy or describe this partial change as an available archive workflow.
