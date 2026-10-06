# Matrix v12 provisioning compatibility and recovery (#126)

## Approved scope

Implement/test only; pause before push, consuming pin update, host rebuild or live
recovery. Eventual recovery belongs to grill and reuses the existing bot-owned
Space and earliest retained creation intent. Preserve the other four intents.
No registry/cursor reset, alias deletion, room duplication, NAS recovery or
background replay is authorized.

## Acceptance-to-evidence plan

| Acceptance | Change | Evidence |
| --- | --- | --- |
| Legacy and v12 room IDs are accepted, malformed IDs rejected | Shared bounded room-ID validator used by Matrix client and reconciliation reader | Positive/negative room-ID tests; v12 directory/provisioning fixture |
| v12 creator authority is verified without weakening ownership | Fetch/validate immutable create event by ID; authenticate sender and content; creator infinite power only for v12 | Owned/foreign/noncreator/mismatched event fixtures; legacy power regressions |
| Domainless rooms have valid Space routing | Derive a joined host's server from verified bot membership, rather than room ID, for domainless rooms | Space child routing and inspection tests |
| Pre-manifest operations are inspectable | Coordinator-only bounded provisioning list with host ID, stable creation key and phase; no paths or secrets | Lifecycle/schema/profile tests |
| Selected retained creation key can resume | Confirmed coordinator retry operation requiring an existing intent and exact concept/workspace/session identity | Failure-before-checkpoint/restart/adoption tests; other intents unchanged; absent/conflicting intent rejected |
| Actual failure is diagnosable | Redacted typed Matrix error reason plus provisioning phase, no response body/token/path | Error sanitization and lifecycle fault tests |

## Crash-boundary plan

| Boundary | Durable authority | Retry |
| --- | --- | --- |
| Before Matrix creation | Existing prepared session and provisioning intent | Confirmed retry uses exact original creation key |
| Space created before checkpoint | Deterministic host/project alias | Read authority and adopt same owned Space; no new alias |
| Space link/room creation before checkpoint | Existing idempotent alias/link operations | Continue forward using same intent and session |
| Manifest saved before attachment | Manifest creation key | Repeat returns/resumes same conversation, not a new room |
| Inspection/error reporting | Read-only metadata / redacted error | No implicit resume, cleanup or mutation |

## Live diagnosis (read-only)

NAS Synapse 1.162.0 creates room-version-12 rooms. Both relays use harness 1a21bfa.
The quoted calls and five incomplete tabpfn-test intents were found on grill, not
NAS. All five prepared sessions exist; no intent checkpointed projectSpaceId.
A single deterministic project Space alias resolves HTTP 200 to a domainless v12
room ID, with the grill bot as immutable create-event sender, joined membership,
and zero children. All five conversation aliases return 404. Current code rejects
the valid ID, then independently rejects its creator's implicit infinite power.
Space routing/inspection also assumes legacy colon-bearing room IDs. Generic IPC
errors hide these validation reasons; repeated new tool calls allocate new keys,
so they are not retries of the original operation.

Reference: https://spec.matrix.org/v1.18/rooms/v12/

## Eventual recovery

After checks and separate rollout approval, inspect retained operations on grill,
select the earliest tabpfn-test intent, and explicitly resume its stable key with
the original workspace and concept. Verify adoption of the existing Space, exactly
one conversation room/manifest, attachment, and preservation of other intents.
Cleanup is a separately approved operation and is not part of this implementation.

The new coordinator tools are `remote_session_provisioning_list` (read-only) and
`remote_session_provisioning_resume` (original creationKey, concept, workspace and
literal confirmation). New intents checkpoint their exact portable workspace tuple
and reject alternate root aliases even when they resolve to the same cwd. Legacy
intents (including the five retained grill attempts) did not store that tuple:
confirmation must use the approved original workspace, verified against the
prepared session's canonical cwd and host-resolved project/checkout identity. The
first successful validation checkpoints that tuple before more Matrix work;
inspection includes it when available. This is a compatibility fallback, not proof
of a portable tuple absent from the historical record. In-flight creation is fenced
by conversation identity: only identical requests coalesce; competing tuples or
other workspace lifecycle work are rejected, not joined as another creation.

Inspection is host-labelled and sorted by the immutable
prepared-session timestamp; phase names identify the next incomplete step. Other
unbound intents remain inspectable but are never retried automatically.

Deploy the relay before new coordinator resources. An already-running coordinator
retains its old Nix-store tool profile; after separate rollout approval it needs an
idle, exact replacement to expose the new tools. Existing project sessions need
not be interrupted for this compatibility fix. Preserve registered manifests and
legacy Matrix IDs. Do not downgrade after new provisioning checkpoints or
v12-managed identities are in use.
