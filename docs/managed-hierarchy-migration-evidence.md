# Existing hierarchy migration (#117)

Status: migration implementation, focused and broader affected checks pass;
review and final verification remain pending. No live migration is authorized.

## Ownership

Extend `ProjectReconciler` and its existing durable link/store/unlink phases,
not startup adoption or a second migration service. Public `space.reconcile`
preview/apply and per-call model approval remain the only new-control ingress.
Preserve old #68 intents for explicit recovery. #63 still owns the breaking V2
store cutover; this issue does not activate it. #118/#119 own picker work;
#120/#121 own deployment and separately authorized real-client acceptance.

## Acceptance → evidence

| Acceptance | Intended change | Focused evidence |
| --- | --- | --- |
| Exact confirmed placement/IDs | Extend existing preview with host-resolved checkout identity and frozen legacy source/target grouping | Placement drift, target drift, confirmation and model approval tests |
| Link before store before unlink | Extend existing reconciliation phases to checkout Spaces, reusing reservations and saved rooms | Fault injection after each remote/store boundary, restart with identical IDs |
| Preserve current work | Grouping-only manifest update, preserving current generations/runtime/queues; no launcher or adapter shutdown | Old-state fixtures with active generations, input and projection records |
| Safe old adapters | No migration-triggered refresh; existing capability guards remain | Legacy capability refusal plus unchanged attachment/process evidence |
| Preserve policies | Existing adopted objects explicitly preserve account notification policy | Account request assertions and no push-rule calls |
| Safe cleanup/retirement | Existing project-scoped hierarchy exclusion and retirement fences; exact separately authorized cleanup | Concurrent retirement/provisioning and nonempty/foreign target refusals |
| Recovery and versions | Runbook and explicit sidecar backup/downgrade boundary | Strict persisted-state fixtures and documentation review |

## Crash boundaries

| Boundary | Durable identity/state | Recovery |
| --- | --- | --- |
| Preview → consent | Frozen source grouping and canonical placement, target IDs or deterministic provisioning identity | Drift refuses before mutation; no implicit startup apply |
| Intent → target provisioning | Existing reconciliation journal plus hierarchy reservation | Recover saved IDs/alias, never replace uncertain or foreign targets |
| Ownership proof/link → journal | Exact saved room IDs and expected provenance | Read/verify current proof and replay only matching idempotent links |
| New links → manifest grouping | New parent present, old parent retained | Atomically merge only grouping into current manifest; retain generation/queues |
| Manifest → old unlink | Durable current grouping | Retry exact old edge; retirement wins before any further effect |
| Cleanup → account completion | Existing exact Space retirement fence | Fresh ownership/emptiness/reference checks; no kick or policy reset |

## Implementation notes and focused evidence

The existing journal now optionally freezes canonical checkout placement and its
host Space. Live reconciliation exposes that plan through the existing consent
owner. Existing room IDs enter the ordinary hierarchy reservation/provisioning
owner; conversation creation is never used for these saved rooms. Ownership proof
is additive only after private bot ownership checks, and conflicting proof is not
overwritten. Adopted objects explicitly preserve notification policy.

Grouping commits merge only grouping fields under the registry queue. Generation
activation now uses the same queue for its complete read/write transaction: the
previous read-before-queue pattern could overwrite concurrently committed grouping.
Tests exercise both call orders plus preference writes and reload.

An admitted old #68 plan retains its original phases and targets. After completion,
a fresh preview can authorize checkout grouping; apply preserves the old plan and
its cleanup IDs as a private receipt before publishing the new journal. Unmarked
obsolete legacy Spaces are retained rather than gaining cleanup authority or being
kicked through the modern interface. Modern verified empty Spaces use the existing
separately confirmed NAS cleanup path. Retirement terminates a pending migration
item without resurrecting its manifest or expanding retired cleanup scope.

Focused evidence: **39 passed, zero skips**, including link/proof/store/unlink
faults, restart, exact old project target reuse, archived receipt retention,
placement/foreign refusal, retirement before/during apply, legacy attachments,
pending input/history, policy preservation, and grouping/generation concurrency:
`.pi/tmp/workers/2026-10-07T19-07-05-663Z-hierarchy-migration-focused-fixed-8ae70ed8a6d0/`.
The preceding failed run exposed an invalid test retirement fixture (omitted
required exact cleanup); the corrected fixture uses real owner-derived targets.

Broader affected checks passed: **566 managed + 87 bridge-chat**, zero skips,
and module contracts. Initial log:
`.pi/tmp/workers/2026-10-07T19-08-34-935Z-hierarchy-migration-affected-4412b2615f63/`.
After the final legacy-consent/receipt guards and status-wrapper portability fix,
managed **566/566** plus module contracts passed again:
`.pi/tmp/workers/2026-10-07T19-24-24-857Z-migration-legacy-scope-affected-8cf840ec30c7/`.
The finalized fixture also proves an unfinished #68 plan completes only its old
scope under the first consent, then requires a second preview for checkout
migration. Current host/placement and ownership are revalidated before that old
scope is admitted. Changed old full-manifest hashes remain held for explicit
recovery rather than being silently rebased. Completed batches never expand to
new arrivals without another preview/consent; their receipts survive rollover.
A retained retirement flag without its tombstone fails closed before rollover.

## Review and remediation

Paired exhaustive #117 review:
`.pi/tmp/reviews/2026-10-07T19-26-31-589Z-worktree-c2c2b0afbd8f-2eeddb665307/`.

### Standards

One **high / current issue** finding: migration still generated legacy
`cleanupSpaces`, and the retained legacy cleanup entrypoint could kick/leave.
Accepted: new migration records now retain old IDs only as journal/receipt data,
never derive destructive cleanup authority, and legacy cleanup unconditionally
refuses with modern-preview guidance. The kick/leave implementation was removed.

### Spec

One **high / current issue** finding identified the same unsafe cleanup path.
Accepted with the same remediation. Regression tests call the legacy entrypoint
directly (not only through frontend policy), assert no Matrix effects, and assert
new journals have no legacy cleanup candidates. Modern verified Space cleanup
continues to use the existing separately confirmed NAS flow and its prior tests.
Historical cleanup records remain readable for backup but are not execution consent.

No additional review loop is planned: remediation removes the unsafe path without
adding a new owner or changing the reviewed migration design. Focused remediation
checks and the final canonical gate/build follow.

No live state, shared tmux server, service, deployed alias or NAS account is touched
by source edits and disposable tests. Logical commits record preflight, code,
focused evidence, review remediation and final verification separately.
