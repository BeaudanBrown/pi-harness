# Always-connected live workspaces, host controls, and instant picker

## Status, authority, and precedence

User-approved consolidated design, 2026-09-30. Issue publication and creation of a dedicated implementation worktree/managed room are authorized. **Implementation, deployment, host activation, and service restarts are not authorized by this planning session.** GitHub Issues are the task source of truth; this document is the design/specification, not a parallel tracker.

This plan consolidates the complete design interview with `managed-host-controls-and-picker-plan.md`. That document remains useful investigation evidence, but the decisions here supersede its conflicting approval, deletion, membership, startup-failure, and coordinator-only workflow suggestions. Existing ADR 0002 describes current behavior, not the target behavior; amend it during implementation through the contract work package.

Publication is scoped to `BeaudanBrown/pi-harness`. Work owned by `nix-dotfiles` is represented by explicit cross-repository handoff issues here, not by moving its implementation into the harness or silently publishing in another repository.

Implementation was authorised in the epic conversation on 2026-10-01, with
logical commits and no push/deployment authorisation. The planning-only limits
above describe the original approval boundary. The target implementation seams
are pinned in [the foundation contract](managed-live-workspaces-contract.md).

## 1. Product model and scope

- Matrix is the phone/desktop interface to **current live work**, not an archive of every historical session.
- Hierarchy: **host Space → project Space → worktree Space → conversation rooms**. A root checkout is a worktree workspace for grouping purposes.
- Multiple independent conversations may share one worktree. Their model contexts are separate; their filesystem edits are not isolated.
- One managed conversation owns one stable room and a sequence of Pi session generations, with at most one live writer/attachment to its active session.
- Immutable conversation IDs, host/project/checkout identities, creation keys, and Matrix IDs remain authority. Mutable human titles do not select targets.
- Worktree identity stays distinct from common-directory project identity and from relative working directories within a checkout.
- The coordinator remains neutral, guaranteed, protected from managed stop/delete, visible in the picker, and reopenable against its persisted session.
- A disposable live hierarchy with three nested Spaces and two rooms was created, verified through Matrix state, and confirmed usable by the operator in Element X. All five test objects were subsequently unlinked and left; this was navigation evidence, not full feature acceptance.

### Eligible default launches

On an enabled host, ordinary **human-facing interactive engineering** launches automatically connect when the trusted host launcher resolves a Git checkout within configured workspace roots, including validated linked worktrees. Non-Git/out-of-root launches remain local with a brief explanation. Do not silently expand configured root authority.

A fresh launch creates a new conversation; an explicit launcher resume reuses its existing active binding and window. If it is dormant, resume the saved session. Concurrent resume/open requests reuse the same launch. An explicit resume of preserved history after retirement gets a new creation/conversation identity and room; it never resurrects the retired identity or projects old history.

Exclude SDK/review/diagnostic workers, evaluations, headless jobs, and experimental launchers from ambient auto-connection. Intentional managed RPC execution is not an accidental headless enrollment. Distinguish internal dispatch from interactive entry to prevent recursion.

Provide **`pi-local-only`** as the explicit local-only alias/entrypoint. It creates no room and transmits no messages. Refuse local-only resume of a session with an active Matrix binding; require closing that binding or making an unbound local fork first.

Disable Pi-R and AgentGraph extensions, tools, skills, prompt guidance, and automatic activation in all normal harness launches, including local-only, by explicit default-off configuration switches. Preserve source/packaging and deliberate future opt-in. Keep the dedicated `pi-r-local` launcher and its evaluation contracts intact. This does not add either experiment to managed sessions.

## 2. Process lifetime and availability

- Closing Ghostty does not stop tmux. Manually killing a managed tmux window/session kills Pi and leaves its conversation dormant/resumable; do not protect or recreate that window merely because it was killed.
- A new authorized ordinary Matrix message wakes the same dormant conversation. Stop cancellation must prevent old unfinished input from waking it again.
- `!start` starts without a model prompt; `!stop` terminates the exact managed process/window and preserves room/binding/history; `!abort` interrupts the current agent run but leaves Pi running.
- Matrix unavailability does not block local work. Persist pending provisioning/projection and catch up after recovery; display remote-setup/disconnected state accurately. Account auto-join failure likewise leaves local managed work usable, with durable retry.
- A missing/unavailable **local relay** is different: refuse a new managed launch with a concise diagnostic and local-only alternative. Existing Pi processes continue; do not silently create an unmanaged duplicate.
- Missing worktree paths are unavailable, not proof of intentional deletion. Never auto-close based on absence/inactivity.
- Retain failed startup windows with a clear error for inspection. A failed/dead window is not running Pi. An explicit retry replaces only that failed managed window; never an unrelated window or the shared tmux server.

### Open versus resume

`open` returns as soon as an exact marked managed window exists; `resume` waits for adapter attachment or bounded failure. Both share a durable launch identity, ownership, and single-writer protections. A local picker switches as soon as the window exists so direnv/Pi startup is visible. Remote open/start must not switch a desktop tmux client.

Revalidate stable tmux window/pane IDs and conversation markers immediately before switching or killing. Index reuse/renumbering or target disappearance must never redirect to an unrelated window. Accepted launches are not cancelled because the picker closes. Keep bounded attachment monitoring after open returns. Coordinator open uses its existing protected bootstrap/ensure path.

## 3. Pi session navigation while bound

- `/new`, `/fork`, and `!new --confirm` **retain the room**, durably changing its Matrix-active session generation. Preserve prior Pi files and do not replay their history.
- Block saved-session switching while bound, including `/resume`, `/sesh`, and equivalent switching entrypoints. Explain that another conversation is selected through the launcher.
- Keep `/tree` for branches of the current session. Project a silent branch-change marker and new activity only, without rearranging/replaying the linear Matrix timeline.
- Retain explicit reset confirmation and existing safe busy/transition preconditions. Invalidate stale attachments/generations, and serialize changes with stop/delete/input acceptance.
- Titles follow `/name` and manual Matrix renames. Status prefixes are presentation, not part of the saved title. Serialize observed title changes, suppress self-echo loops, and preserve the last accepted title.
- Use a short unique human-readable fallback until named. Display-name collisions must never create identity collisions.

## 4. Transcript and notification contract

Project persisted local-user messages promptly, completed assistant commentary messages as they occur, final answers, explicit checkpoints, and existing bounded activity summaries. Map Matrix-origin user entries to their original events without echo. Do not project thinking, tool arguments/results, raw logs, partial token streams, internal/compaction entries, or pre-binding history. Tools remain visible only through existing bounded activity/status presentation.

Send each completed commentary text once using persisted entry identities and stable transactions. Do not repeat commentary as a final answer. Preserve source ordering, chunk idempotency, origin/generation/branch boundaries, and crash/reconnect behavior. Treat notification disposition as durable delivery metadata, not content guessing.

| Event | Initial default |
| --- | --- |
| Local user text, completed commentary, activity edits | Silent |
| Every final assistant answer | Notify |
| Explicit unanswered question/blocker/checkpoint | Notify |
| Approval poll needing operator action | Notify |
| Persistent terminal failure needing intervention | Notify once |
| Setup/join/name/branch/reset/lifecycle housekeeping and transient retry | Silent |
| Recovered historical final answers/commentary | Silent |
| Recovery with attention still required | At most one actionable alert per conversation |

Coalesce a checkpoint/final describing the same attention event into one notification-bearing message. Recovery revalidates unanswered questions, unresolved blockers, and unexpired/live approvals before its one alert. Do not blindly replay old completion notifications or expire an accepted frozen send into a different payload on retry.

The NAS account automation initializes rules **once for new rooms**. Manual Element X/desktop settings are authoritative thereafter, including across resume/restart/reconnect. Existing migrated rooms retain all notification preferences. There are **no `!notify` commands**. Muting never disables synchronization or room control. Event requests, Matrix account push rules, and phone/OS delivery are separate layers; test real clients rather than claiming delivery guarantees from server fixtures.

Rooms remain under the current unencrypted transport contract. Refuse/report unsupported encrypted rooms; never disable encryption or downgrade an existing room silently.

## 5. NAS account automation

Extend the existing NAS `bridge-chat` owner-account Matrix transport with a separate deterministic account-management policy. Reuse its dedicated revocable secret-managed owner login; no new model integration and no owner credentials in Pi agents, tool payloads, logs, or host-adapter IPC. Existing `!pi` question selection, sender policy, execution isolation, and uncertain-send behavior stay separate.

The token has broad account authority; application room restrictions are not a server-enforced sandbox. The operator has accepted that boundary.

- Configure explicit trusted host bot MXIDs and stable host identities. Verify management provenance/hierarchy as well as inviter identity; room names alone never establish authority. Freeze authenticated machine-readable host/account action and acknowledgment contracts in the foundation task; no arbitrary endpoints or caller-provided authority strings.
- Handle existing pending and new invitations for verified managed rooms and Spaces, leave unrelated invitations alone, and initialize new-room notification rules before ordinary projected traffic can create unwanted default alerts where feasible. Make setup state observable and design retry without overwriting later manual settings.
- Notification setup uncertainty amendment (operator-approved 2026-10-01): persist each initialization attempt before its first rule mutation. After an uncertain result, reconcile read-only and never automatically repeat a potentially applied rule write that could overwrite a later manual choice. Continue synchronization using current client settings and display a setup warning; do not block local work or transcript projection on this uncertainty.
- Persist intentional departure/retirement state so auto-join cannot undo deliberate leave/close. Reopening a retired conversation uses a genuinely new identity/room.
- For confirmed cleanup, leave and forget the operator's room and acknowledge progress durably. Bot departure and account departure are independent effects; retain enough verified identity to finish even if the other actor already left. No model calls are involved.
- NAS failure delays account setup/cleanup, not existing host session execution. Per-host bot relays continue owning local processes, identities, and status.

## 6. Unified host operations and approvals

One strict typed dispatcher serves `pi-managed-session`, `/host`, `!host`, the compact `managed_host` model tool/skill, and the coordinator. Project agents gain lifecycle tools, not coordinator credential or arbitrary shell/Matrix authority. Keep the coordinator's narrow neutral profile.

Operation coverage: host status; bounded conversation list/status/create/open/resume/stop/refresh/delete; workspace inventory/local project creation; worktree inventory/create and constructive bundles; safe worktree removal and bundled cleanup; separately confirmed merged local-branch deletion; Space reconciliation preview/apply and obsolete-Space cleanup. Reuse current validated Git/path rules; no force deletion, root-checkout removal, fetch/push, remotes, arbitrary paths, shell strings, or user-selected tmux targets.

Keep compact room-local aliases `!start`, `!stop`, `!abort`, `!status`, `!close --confirm` and existing supported model/thinking/compaction/reset controls. Keep `pi-managed-session-status` as a compatibility wrapper. All conversation-delete aliases, including legacy `/remote delete`, map to the same retirement semantics.

CLI grammar uses noun/action families (`host status`, `conversation open <conv-id>`, `worktree ...`, `space ...`). Exact existing conversation IDs are required, not concepts or prefixes. Provide help in each interface and one bounded, versioned JSON result for `--json`; diagnostics go to stderr. Pin distinct exit/error categories, pagination, precise operation fields, and legacy compatibility in the contract task. Flat provider-compatible model schema is acceptable only with strict operation-specific validation.

### Authority/policy matrix

| Origin/action | Authorization |
| --- | --- |
| Model list/status/inventory/preview | No approval |
| **Any model-requested host mutation**, including create/open/resume/reconcile | Per-call operator approval |
| Matrix-origin model mutation | Poll in originating conversation |
| Terminal-origin model mutation | Native local Pi confirmation dialog |
| Explicit human launch, picker open, wake message, `!start` | No extra approval |
| Operator-issued direct stop (`!stop` / equivalent explicit host command) | Immediate; coordinator protection still applies |
| Human refresh/delete/destructive/bulk/standalone Space cleanup or reconciliation apply | Explicit confirmation/preview |
| Automatic newly empty ancestor-Space cleanup | Included in authorized conversation closure |

Ordinary joined participants may prompt/steer and propose model actions; lifecycle commands and mutation approval are operator-only. Verified allowlisted operator bridge identities may be configured. Derive identity/routing from accepted input provenance, never model arguments. Mixed-user runs cannot inherit authority from an earlier operator message: all model mutations require approval anyway. Ambiguous presentation origins fail closed rather than selecting an unrelated approver/conversation.

Nix centrally owns action IDs and policy with explicit deployment-time overrides. Defaults require every model mutation to be approved. Unknown operations/fields fail validation; unclassified valid mutations are approval-required. No runtime policy editor. These are workflow safeguards under a same-Unix-user trust boundary, not protection from a malicious shell-capable same-user agent bypassing tools.

### Approval lifecycle

Validate → freeze exact operation/arguments/targets/preconditions → persist pending approval → present → await approve/deny → revalidate → mark consent consumed → attempt execution once → return the observed outcome.

- Expire after **15 minutes**; only configured operator approval counts.
- Every tool call gets its own approval. Existing explicit typed bundles may use one approval describing their complete frozen effects.
- Bulk previews include active runs; confirmation covers them without extra per-room prompts. New targets discovered later are never silently included.
- Denial returns `denied by operator`, does not abort the agent turn, and identical retries may ask again. No blanket or per-turn consent.
- An approval waits inside the tool call; do not reuse checkpoint hard-abort semantics.
- Cancel pending approvals when their requesting run ends, its process stops, or conversation retires. Late votes do nothing. After relay restart, retain only within original expiry and only after revalidating the live requesting run; otherwise cancel.
- Operator amendment, 2026-10-02: accept failure/uncertainty around disconnection timing rather than building durable completed-action receipt retention or automatic mutation replay. An admitted attempt may finish independently of its caller, including self-stop/delete, but relay restart does not resume an uncertain attempt. Report an unknown outcome without retrying; the operator can inspect state and explicitly request another attempt with fresh consent. Suppress duplicate votes while an approval is active. Pending approval expiry remains 15 minutes. This replaces the earlier stable-result/at-most-once guarantee across disconnect/restart; it does not remove existing operation-specific safety checks or unrelated delivery/provisioning receipts.
- Do not hold broad lifecycle locks for the approval wait. Revalidate stale previews without expanding/reinterpreting the approval.

A private peer-UID-checked mode-0600 host-control socket is separate from nonce-authenticated adapter IPC. Disabled hosts expose no socket/control surface. Never impersonate a coordinator attachment or pass secrets/nonces as CLI arguments.

## 7. Close/delete, departure, and cleanup

**Close and delete are one irreversible retirement operation** across CLI, model, Matrix, coordinator, bundles, and legacy aliases. There is no reversible archive state and no implicit unbind-but-keep-running variant.

After the host accepts closure durably:

1. Retire the exact conversation identity and reject new input/open/resume/attachment for it.
2. Cancel unfinished deliveries/pending approvals and stop only its exact managed Pi instance/window.
3. Remove active binding/registry/manifest presence without losing cleanup identity.
4. Have the operator account leave and forget, and the bot leave; retry independently if Matrix/NAS is unavailable.
5. Remove newly empty verified harness-owned worktree/project ancestor Spaces, including relevant operator membership, but retain the host Space.
6. Compact completed cleanup to a minimal permanent tombstone preventing resurrection from retries, stale adapters, creation keys, synchronized manifests, or old backups merged with current retirement state.

Operator-approved process identity clarification: forced stopping stays inside the existing nix-dotfiles launcher and uses a Linux kernel process handle plus recorded boot/start identity. Never signal a reusable numeric PID or kill a window container that may hold replacement work. Legacy or unverifiable identities remain pending; no new service or general process manager is introduced.

Retain private cleanup intents with exact Matrix IDs, phases, and process observations until effects are confirmed. If stop fails, surface pending cleanup failure; never report a live process as removed. After retirement, network failure never restores resumability. A close sent through Matrix while the host is offline cannot stop it until received.

Preserve local Pi transcripts and project/Git files. Leave other human participants and their history untouched; leave/forget is not server-side history erasure. Concept/title reuse gets new identity/room. Explicit resume of retired Pi history may reuse the preserved history as context under new ownership, without old bindings or history backfill.

The configured operator leaving an individual conversation via either client triggers the same retirement. Prevent re-invitation and distinguish membership removal by others from verified voluntary departure where provenance permits; uncertain/unrelated membership events must not become arbitrary lifecycle authority.

Leaving a **Space** never cascades: members may still see child rooms. Bulk close uses a frozen preview plus confirmation through any managed host-control frontend. Leaving the **coordinator** is also non-retiring: preserve its identity, do not auto-reinvite after deliberate departure, and provide explicit local recovery of membership.

Operator clarification: during offline retirement, freeze only the originally identified ancestor Space IDs and expected ownership. Automatic cleanup after reconnection is authorized under the original closure consent, subject to fresh ownership, emptiness and reference checks on every attempt. Retries must never discover or expand the ancestor target set.

Unexpected/foreign children, references, or permissions block ancestor cleanup rather than removing a non-empty or foreign Space. Standalone cleanup still requires confirmation. Worktree removal keeps its existing cleanliness, lock, identity, branch and confirmation rules; this plan does not authorize deleting projects or force-removing files.

## 8. Room status and naming

- `● title`: Pi running, whether idle or busy. `○ title`: stopped/failed startup. Typing represents active model work; detailed startup/disconnection/ready/busy state is available through `!status`.
- Treat these as **last-known** indicators, not host availability guarantees. No external heartbeat observer/offline monitoring is included.
- On relay start/reconnect and instance connect/disconnect, reconcile **all conversations owned by that host**; also reconcile every **10 seconds**.
- Use a reusable local runtime/tmux snapshot, coalesce triggers and overlapping checks, and send rate-limited Matrix state updates only for changes. Do not contact other hosts or block prompts on reconciliation.
- A marked but failed window or stale attachment alone must not prove running. Define and test conservative process/attachment/launch evidence in the contract layer.
- Graceful shutdown marks stopped where possible; abrupt host loss can leave stale names until reconciliation.
- Reconcile only the status prefix, preserving manual/Pi title changes and avoiding rename loops or notification noise.

## 9. Instant tmux picker (nix-dotfiles ownership)

Preserve all non-conflicting picker decisions/evidence in the source plan:

- Enter is the only action; no Ctrl-X, delete, stop, or refresh UI.
- Include active/dormant/starting managed conversations and coordinator, ordinary project tmux sessions, and raw cached/discovered paths. Exclude retired identities; failed startup remains visible as dormant with error context.
- Suppress a workspace's raw path row when managed conversations exist, but retain its ordinary tmux session row and each distinct conversation. Deduplicate by canonical checkout, not common project or title. Relative subdirectories do not duplicate a workspace row.
- Preserve mixed autojump-score ordering with name tie-breaks and clear type/state indicators; no new conversation-recency subsystem.
- Launch popup/fzf before full discovery; reuse tmux/autojump snapshots, scan independent roots concurrently, avoid per-repository Git validation before initial display, and validate selected paths before launch.
- Load a disposable `XDG_CACHE_HOME` path cache; basic existence check, background refresh each launch, remove missing paths, add new paths, atomic publication, safe concurrent/cancelled writers, malformed cache as miss. No credentials/transcripts in cache.
- Hold raw paths at most **100 ms** for managed inventory. Slow/unavailable inventory must not block live rows/UI. Support tested late removal of duplicates without changing query/selected identity; append-only streaming is insufficient.
- Relay failure leaves ordinary paths/sessions and marked live windows navigable. Do not parse private registry files as an undocumented fallback. Dormant authoritative inventory is unavailable.
- No model call or synchronous Matrix request to populate the picker. Local inventory must not resolve Git for every row.
- Cancel unnecessary discovery on exit without cancelling accepted launches. Never switch to an arbitrary project's last-active window.
- Targets: roughly **50 ms UI**, **100 ms initial live/managed rows** on the normal host, not claimed guarantees. Measure keypress/UI, first selectable row, full discovery separately with cold/warm caches and relay failures. Prior measured 0.343–0.399 s was candidate generation only.

## 10. Compatibility and rollout

- Existing managed conversations migrate under worktree Spaces while retaining room/session IDs, pending work, current processes, titles, and notification preferences. Explicit preview/apply only; no surprise startup reparenting.
- Persist forward-recoverable hierarchy migration phases, link target before retiring old parent relationships, and validate host ownership/aliases. Preserve existing provisioning IDs; never adopt a foreign Space by name.
- Existing ordinary local sessions are not automatically adopted/restarted. Default enrollment applies to new eligible launches and explicit resumes after deployment; explicit promotion remains possible.
- Freeze version/capability and migration strategy before landing behavior that assumes new fields. Old adapters must not be silently given unsafe new semantics; capability checks and clear upgrade requirements are preferable to a restart. Document unsupported downgrade and recovery/backup boundaries.
- Integrate with existing guarded relay rollout/runtime retention. Never restart shared tmux or busy Pi merely to verify/deploy this work. Existing automatic idle-only runtime maintenance is not a model-requested mutation and retains its established authority.
- Host settings, trusted bot lists, roots, package pin/aliases, and picker remain in nix-dotfiles. Read its current instructions before work. Its build/activation restrictions remain in force.
- Deployment, migration application, real-client push/approval/cleanup tests, and ordinary-session promotion are separately operator-authorized live acceptance, not consequences of issue publication.

## 11. Implementation contracts to pin before dependent work

The foundation task owns a reviewed exact contract, not another product interview:

- action IDs, strict per-operation fields, actor/run and approval routing, command grammar, pagination and JSON error codes;
- host/project/checkout/conversation/generation/title identities and state/protocol version compatibility;
- durable single-launch milestones, process-status evidence, retirement precedence, approval phases and cleanup intents;
- typed authenticated NAS host-account requests/acks with no broad endpoint capabilities; hierarchy provenance available even before invitation acceptance;
- once-only notification initialization, frozen notify/silent dispositions, recovery watermark and actionable-alert identity;
- upgrade/migration sequencing against pending #63 V2 and existing #68/#83/#90/#96 functionality; do not duplicate work already present.

Implementation details may be selected within these constraints. A material product/authority change requires operator approval, not an implementer's convenient interpretation.

## 12. Verification and acceptance ownership

Each issue supplies acceptance-to-evidence and, for persistent/external effects, crash-boundary matrices. Prefer public behavioral tests and deterministic fault injection. Cover interrupted provisioning, projection, approval, launch, generation transition, retirement, account setup/cleanup, migration and lost acknowledgments. Bounded schemas, no credential leakage, idempotent effects, and unrelated-resource preservation are required throughout.

Focused checks use existing test classifications in `docs/verification.md`: managed-session tests, bridge-chat tests, shared Matrix/unit tests, package/module/source contracts, and dedicated pi-r/eval regression tests as affected. Do not add redundant verification frameworks. At the completed epic boundary, run both pinned Standards and Spec review axes with severity/ownership, batch remediation, then `nix run .#verify` and applicable production builds. LSP live gate is additional only if LSP behavior changes.

Dotfiles uses focused Go tests and allowed evaluation checks; builds/activation require its operator authorization. Record real picker timings separately from deterministic tests. Live Element X plus desktop acceptance covers auto-join, initial silent state events, notifications/muting/manual-setting preservation, rename, start/stop/wake, multi-room same-worktree navigation, generations, approvals, close/leave/forget, and nested migration without unrelated disruption.

### Existing work interfaces

- #83: reuse existing Git/worktree primitives, preserve validation, supersede only conversation retirement/approval entrypoints.
- #68: extend existing explicit Space reconciliation to the worktree level; do not create a second migration engine.
- #90 and #97: reuse isolated NAS transport/login while keeping assistant/project/file behavior separate.
- #96: preserve first-Pi-window placement and prompt projection behavior; avoid duplicate implementation.
- #63 and #91: respect V2/update and activity/recovery boundaries; assess current code rather than treating open issue state as proof functionality is absent.

### Work-package graph

Published as [epic #103](https://github.com/BeaudanBrown/pi-harness/issues/103), with 18 native sub-issues and 51 native blocker edges. Stable publication key: `managed-live-workspaces-v1`. Every implementation leaf remains unstarted until the operator authorizes implementation.

Issue mapping: contracts #104; experiments #105; hierarchy #106; control-api #107; approvals #108; retirement #109; open #110; projection #111; account #112; frontends #113; generations #114; status #115; default-launch #116; migration #117; picker #118; picker-performance #119; host-integration #120; acceptance #121. The initial unblocked implementation frontier is #104 and #105; neither has been started.

| Key | Owner / scope | Depends on |
| --- | --- | --- |
| contracts | Harness contracts, ADR target amendment, recovery/compatibility specification | — |
| experiments | Default-off Pi-R/AgentGraph, keep pi-r-local | — |
| hierarchy | Worktree Spaces and stable conversation/title placement | contracts |
| control-api | Typed dispatcher, private host socket, bounded CLI inventory/action interface | contracts |
| approvals | Durable all-mutation approval execution, polls/local dialogs, origin/run lifecycle | control-api |
| retirement | Irreversible retirement/tombstones and host cleanup intents | control-api |
| open | Window-first open, ready resume, retained failure, single-launch coordination | control-api, retirement |
| projection | Commentary and deterministic notification/recovery classification | contracts |
| account | NAS trusted autojoin, once-only push rules, leave/forget, action acknowledgments | hierarchy, retirement, projection |
| frontends | managed_host skill/tool, /host/!host, room aliases, protected coordinator recovery | approvals, retirement, open, account |
| generations | Room-preserving new/fork/tree and session-switch restrictions | retirement, hierarchy |
| status | Host-wide 10-second status and two-way title reconciliation | hierarchy, open |
| default-launch | Eligible interactive automatic enrollment and local-only entrypoint | experiments, open, generations, account |
| migration | Explicit non-disruptive worktree-Space migration and compatibility docs | hierarchy, account, generations, status |
| picker | nix-dotfiles handoff: exact-window active/dormant/starting navigation | open, control-api |
| picker-performance | nix-dotfiles handoff: progressive cached discovery and measurements | picker |
| host-integration | nix-dotfiles handoff: package/settings/roots/trust/aliases wiring, no activation | default-launch, frontends, status, migration, picker-performance |
| acceptance | Cumulative reviews/gates and separately authorized migration/live acceptance | all feature/handoff work |

Cross-repository handoffs are marked for human coordination rather than mislabelled as harness implementation. No issue tracker transitions will pretend deployment has occurred.

## 13. Explicit non-goals

No cross-host failover/migration/discovery, custom Element X fork, external heartbeat monitor, forever searchable archive, pre-binding history backfill, per-tool log stream, token-by-token text streaming, arbitrary remote shell/Matrix administration, force Git removal, generic session manager, agent sandbox, runtime-editable approval policy, notification-setting commands, or automatic deletion from inactivity/missing paths/manual window kill. No implementation or deployment during planning/setup.
