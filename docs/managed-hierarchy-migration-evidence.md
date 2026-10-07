# Existing hierarchy migration (#117)

Status: migration implementation and focused checks pass; broader checks, review
and final verification remain pending. No live migration is authorized.

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

No live state, shared tmux server, service, deployed alias or NAS account is touched
by source edits and disposable tests. Logical commits record preflight, code,
focused evidence, review remediation and final verification separately.
