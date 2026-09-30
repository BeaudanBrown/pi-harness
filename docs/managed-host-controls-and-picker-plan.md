# Managed host controls and instant tmux conversation picker

## Status and purpose

**Status:** Historical design input, consolidated into [the approved live-workspaces plan](managed-live-workspaces-plan.md). Implementation not started. The consolidated plan takes precedence, especially for all-model-mutation approvals, leave/forget retirement, retained failed windows, session generations, and automatic room lifecycle. Retain this document for investigation evidence, not as a competing implementation specification.

This document consolidates the investigation and subsequent design interview for improvements spanning:

- `pi-harness`: managed-conversation lifecycle, host control interfaces, agent tools, approvals, persistence, and packaging.
- `~/documents/nix-dotfiles`: the `tmux_project` launcher, picker, tmux placement, and host configuration.

It is intended to be merged with another design document before implementation. Agreed requirements below should survive that merge unless explicitly reconsidered with the user. Suggested internal APIs, storage layouts, command grammar, and work sequencing are recommendations rather than existing functionality.

This document is design input, not a second task tracker. After consolidation, implementation work should be tracked through the owning repositories' issue workflows. No issue publication, deployment, process restart, or implementation is authorized by this document alone.

## 1. Goals

1. Make the project picker show existing managed Matrix conversations, including dormant conversations.
2. Make Enter open the exact selected conversation's tmux window, resuming it when necessary.
3. Allow the user to watch Pi startup instead of waiting in the picker for full adapter attachment.
4. Make the picker appear immediately and actually reduce discovery work, rather than merely hiding latency behind a loading screen.
5. Provide one coherent host-management backend usable from the shell, Pi terminals, Matrix rooms, and models.
6. Allow natural-language workspace and lifecycle management from project conversations, without requiring a trip to the coordinator room.
7. Gate selected actions automatically during tool execution through a centrally configured approval policy.
8. Provide explicit irreversible conversation deletion while preserving project files and historical transcripts.
9. Keep the coordinator accessible and protected, while aligning its lifecycle capabilities with project agents.

## 2. Current implementation and observed behavior

### 2.1 Existing picker

Relevant dotfiles sources:

- `modules/cli/tmux/tmux-project-go/main.go`
  - `managedLauncherWindows()` lists marked live windows.
  - `candidates()` combines root sessions, managed windows, and discovered paths.
  - `launcher()` finishes all candidate discovery before starting `fzf`.
  - `launcherPopup()` resolves the requesting client and opens the popup.
  - `projectPaths()` scans project roots and validates each repository with a separate Git subprocess.
  - `switchToManagedWindow()` switches the requesting client.
- `modules/cli/tmux/tmux-project-go/managed.go`
  - Creates managed windows and marks them with conversation ID and concept options.
- `modules/cli/tmux/common.nix`
  - Owns keybindings, hooks, and launcher integration.
- `modules/cli/tmux/tmux_project.nix`
  - Packages the Go launcher and runtime dependencies.

Live managed-window discovery already works. At investigation time the relay reported 25 conversations: one active and 24 dormant. The deployed picker exposed the active conversation but not the dormant ones.

This is intentional in the current design: ADR 0002 and both repositories' runbooks state that the picker only switches to existing managed windows and never resumes dormant conversations. This plan changes that contract.

Existing picker targets encode session/window/pane indexes. The implementation should move toward stable IDs plus conversation-marker revalidation because window indexes can change while a picker is open.

### 2.2 Measured performance

Repeated `tmux_project candidates` invocations took approximately **0.343–0.399 seconds** on the investigated host. These are candidate-generation timings, not end-to-end keypress-to-render measurements.

A process-execution trace showed 48 exec calls, including:

- 29 Git invocations;
- two `fd` invocations;
- multiple tmux and wrapper invocations.

The main costs are:

- recursive discovery beneath `~/documents` and `~/monash` to depth six;
- sequential `git rev-parse --show-toplevel` for each discovered `.git` entry;
- repeated tmux snapshots;
- repeatedly reopening the autojump database.

Tracing also showed substantial filesystem traversal. Traced syscall durations are not normal wall-clock timings and must not be presented as such.

No full cold-cache, desktop keybinding, terminal-rendering, or post-change performance validation has been performed.

### 2.3 Existing managed lifecycle

Relevant harness sources:

- `config/agent/extensions/managed-sessions/contracts.ts`
- `config/agent/extensions/managed-sessions/relay/host-lifecycle.ts`
- `config/agent/extensions/managed-sessions/relay/registry.ts`
- `config/agent/extensions/managed-sessions/relay/ipc-server.ts`
- `config/agent/extensions/managed-sessions/relay/main.ts`
- `config/agent/extensions/managed-sessions/adapter/extension.ts`
- `nix/module.nix`
- `docs/architecture/decisions/0002-managed-session-contracts.md`
- `docs/managed-matrix-sessions.md`

Existing capabilities include conversation lifecycle, project creation, worktree management, and project-Space reconciliation/cleanup. Coordinator adapters currently own the host-wide lifecycle tool surface.

The existing resume operation waits for adapter attachment. Cold startup has a bounded attachment deadline, currently 60 seconds.

Current deletion is bridge deletion, not the stronger deletion in this plan. It clears managed window markers and removes binding state, but intentionally preserves the live process/window. It also attempts to restore deleted registry state if leaving Matrix fails. Both behaviors need deliberate revision for irreversible stop-and-delete semantics.

## 3. Agreed product behavior

### 3.1 Picker is navigation-only

The final picker has one primary action:

- **Enter:** open the selected entry.

**Ctrl-X deletion was explicitly shelved.** There are no picker stop, refresh, or delete actions in this plan.

Earlier discussion of Ctrl-X, its `Y/n` prompt, returning to the picker after deletion, and deleting the window underneath the popup is superseded. Do not implement those discarded interactions.

### 3.2 Opening a managed conversation

Enter means:

| Conversation condition | Behavior |
| --- | --- |
| Live managed window exists | Switch to that exact window. |
| Dormant | Ask the relay to resume; switch as soon as the marked window exists. |
| Already starting | Reuse the existing startup; switch when its window exists. |
| Deleted | Refuse; never recreate the identity. |
| Coordinator dormant | Recreate its managed window against its existing persisted coordinator session, then switch. |

The user does not want to remain in a popup until Pi finishes loading. Once a target window exists, close the picker and switch to it so `direnv` and Pi startup are visible.

Do not switch merely to a project session's previously selected window. Several conversations can share one workspace/session; Enter must display the selected conversation.

Window creation necessarily precedes exact-window switching. Do not introduce a temporary shell window solely to claim that the popup closes before any target exists.

### 3.3 Open and resume have different completion points

Both operations are required:

- **Open:** ensure the managed window exists and return its exact identity promptly; adapter attachment may still be pending.
- **Resume:** wait until Pi attaches, or return a bounded startup failure.

The picker uses open. Automation that needs a ready Pi process can use resume.

These operations must reuse one launch implementation and one launch-in-progress identity. They must not create competing processes or session writers.

### 3.4 Candidate inclusion and deduplication

Show:

- managed project conversations in active, dormant, and starting states;
- the coordinator, including when dormant;
- ordinary project tmux sessions;
- cached and newly discovered raw project paths.

Never show deleted managed identities in ordinary results.

If a workspace has one or more managed conversations:

- suppress its raw folder/path candidate;
- retain its ordinary tmux project-session candidate;
- show each managed conversation separately.

Deduplicate by canonical workspace identity, not concept or display-name equality. Distinct checkouts/worktrees must not collapse merely because they share a Git project identity. Relative working directories within a workspace do not create additional raw workspace rows.

Use the existing mixed autojump-score ordering rather than mandatory type groups. Break equal scores by name and show clear state/type indicators. A snapshot of the autojump database is sufficient; conversation-specific recency tracking is not part of this plan.

### 3.5 Manual window closure

Manually killing a managed tmux window leaves the conversation **dormant and resumable**. It is not deletion and must not create a tombstone.

The same principle applies to manually closing the coordinator window: Enter in the picker can reopen the coordinator against its existing session.

## 4. Unified host-management surface

### 4.1 One backend, multiple frontends

Expose the same supported host operations through:

1. `pi-managed-session` shell CLI;
2. `/host ...` Pi terminal commands;
3. `!host ...` controls in managed Matrix rooms;
4. a compact `managed_host` model tool;
5. the coordinator's natural-language interface, using the same tool/backend/policy as project conversations.

Do not duplicate lifecycle implementations in these frontends. They translate requests into a common typed action dispatcher.

Local tmux navigation is an interface-specific behavior, not a general Matrix lifecycle action. A remote open request may ensure a window exists, but must not arbitrarily switch a local client.

### 4.2 Operation coverage

The final agreed scope is broader than the initially proposed narrow lifecycle CLI:

- host status;
- conversation list/status/open/resume/stop/refresh/delete;
- workspace inventory;
- local project creation;
- conversation creation in an existing workspace;
- worktree inventory and creation;
- bundled worktree/conversation creation;
- worktree removal and bundled conversation cleanup;
- separately confirmed local-branch deletion;
- project-Space reconciliation and obsolete-Space cleanup.

Reuse existing operation-specific safety rules. This plan does not authorize arbitrary shell execution, caller-selected lifecycle paths, arbitrary Matrix endpoints/room operations, Git fetch/push, or weakening existing worktree validation.

Per-conversation model/thinking controls and context-generation resets are not automatically folded into this host lifecycle surface. Their existing behavior remains unless the merged plan explicitly changes it.

### 4.3 CLI structure

Agreed public entrypoint and baseline structure:

```text
pi-managed-session host status
pi-managed-session conversation list
pi-managed-session conversation status <conversation-id>
pi-managed-session conversation open <conversation-id>
pi-managed-session conversation resume <conversation-id>
pi-managed-session conversation stop <conversation-id>
pi-managed-session conversation refresh <conversation-id> [--confirm]
pi-managed-session conversation delete <conversation-id> [--confirm]
```

Extend this consistently with workspace/project/worktree/Space subcommands. Exact argument grammar for the expanded commands should be finalized when merging specifications.

Keep `pi-managed-session-status` as a compatibility wrapper for host status during migration.

Existing conversation targets require exact `conv_...` IDs. Reject concept-name resolution and ambiguous prefixes. Concept names are display metadata, not durable automation identifiers.

Human-readable output is the default. Provide `--json` for reads and mutations:

- one bounded versioned result object per command;
- stable fields;
- diagnostics on stderr;
- no mixed progress text on JSON stdout;
- documented, distinct error categories/exit codes for usage, unavailable relay, missing target, invalid state, and execution failure.

Paginate or otherwise bound inventory responses rather than assuming every possible inventory fits one IPC frame.

### 4.4 Help and skills

Provide discoverable help in every user interface, including `/host help`, `!host help`, and CLI help.

Expose one compact operation-based model tool, `managed_host`, rather than a long collection of separately described lifecycle tools. Keep detailed workflows and examples in a `managed-host` skill.

The skill is guidance and context management, not authorization. Tool arguments remain deterministically validated and actions remain relay-authorized.

Account for providers that require flat tool schemas: keep the model-facing tool compact and provider-compatible while validating exact operation-specific fields in the backend. Do not solve context savings by accepting arbitrary unvalidated command strings.

### 4.5 Coordinator alignment and protection

Keep the coordinator:

- accessible through the picker;
- reopenable against the same persisted session;
- neutral rather than tied to a project workspace;
- protected from stop/delete and other prohibited project lifecycle operations;
- useful for host-level natural-language administration.

Project agents gain the same host-management functionality, removing the need to navigate between chats for lifecycle work. The same approval policy applies to coordinator and project tool calls.

This does **not** imply giving the coordinator every engineering tool or removing its neutral/protected identity. Lifecycle alignment, not indiscriminate profile merging, is the agreed change.

## 5. Authority and approval

### 5.1 Local control transport

Add a separate private host-control Unix socket:

- owned by the managed-session Unix user;
- mode `0600`, within a private runtime directory;
- peer UID checked;
- unavailable when managed sessions are disabled;
- bounded, versioned, typed requests and responses;
- no Matrix credentials or adapter attachment nonces passed as CLI arguments.

Preserve the existing adapter socket's attachment nonce and role authorization model. Do not impersonate a coordinator attachment to implement the CLI.

The host control API may return a freshly observed tmux target for open. This is a host-generated result, not permission for callers to nominate arbitrary lifecycle targets.

### 5.2 Accepted trust boundary

These approvals are **workflow safeguards, not a sandbox**.

Project agents already execute shell commands as the same Unix user and may circumvent supported controls through the CLI, tmux, or direct filesystem operations. The user explicitly accepts that limitation. Do not claim the new policy prevents a deliberately bypassing same-user agent.

Within the supported interfaces, authorization and approval are enforced deterministically. Instruct models to use `managed_host` for lifecycle management.

### 5.3 Origin and operator identity

For Matrix requests:

- only configured operator identities may approve host actions;
- explicitly allowlisted bridge identities representing the operator may be included;
- other currently authorized participants may propose gated actions, because an operator must approve execution;
- ungated mutations require an operator-origin request.

Do not let the model supply or assert its own sender identity. Derive origin and actor information from relay-verified input provenance and the associated execution context.

Local terminal commands/approval dialogs rely on the accepted same-Unix-user boundary.

The implementation must define how tool calls are attributed when several participant messages or steering inputs contribute to one agent run. Do not infer authorization from an unrelated earlier operator message. Ambiguous mutation authority should fail closed or require explicit operator authorization. The exact run/request-scope mechanism is a merge-sensitive implementation detail, not a reason to trust model-provided identity fields.

### 5.4 One declarative policy

Own action identifiers and default approval requirements centrally in `pi-harness`. Expose Nix overrides so `nix-dotfiles` can change policy without editing tool/relay code.

Policy changes require deployment. No mutable runtime policy command is requested.

Initial categories:

| Category | Approval required |
| --- | --- |
| List/status/workspace/worktree inventory | No |
| Open/resume | No |
| Project/conversation/worktree creation, including constructive bundles | No |
| Stop/refresh/delete | Yes |
| Worktree removal, local-branch deletion, destructive bundled cleanup | Yes |
| Space cleanup | Yes |

Reconciliation preview is read-only. Reconciliation apply mutates Matrix structure and should be explicitly classified during the merge; the safe recommended initial classification is approval-required. Unknown/unclassified actions default to requiring approval, but unknown actions still fail schema validation rather than becoming executable through approval alone.

### 5.5 Approval happens inside tool execution

The model does not need to perform a separate permission dialogue or manually call preview and apply tools for ordinary approval gating.

A gated tool call:

1. validates the operation and arguments;
2. resolves actor/origin authority;
3. consults the centralized policy;
4. constructs and persists the exact action preview;
5. presents an approval interaction;
6. waits for approve, deny, expiry, or cancellation;
7. revalidates applicable target preconditions;
8. executes only the approved operation;
9. returns a structured result.

Separate gated tool calls produce separate approvals. There is no blanket approval covering a model's future chain of calls. Existing typed bundled operations may describe their complete effects in one call and therefore one approval; approval must never silently expand beyond that call.

### 5.6 Approval presentation

Route model-tool approvals by input origin:

- Matrix-origin request: Approve/Deny poll in the originating room.
- Terminal-origin request: native Pi confirmation dialog.

The relay remains authoritative for the pending action even when a terminal frontend renders the dialog.

Explicit human interfaces also use the common policy but may express approval differently. In particular, CLI deletion and refresh without confirmation preview only; `--confirm` authorizes application. Apply equivalent explicit confirmation semantics to other gated human commands. Human `/host` and `!host` interactions should provide the interface-appropriate confirmation without requiring the user to invent model prompts.

The former picker `Y/n` decision does not apply: picker deletion was removed.

### 5.7 Approval lifecycle

- Approval expires after **15 minutes**.
- Expiry performs no mutation and returns an expired result when the caller can receive it.
- Late votes cannot execute an expired action.
- Only operator votes authorize execution.
- Bind approval to the frozen operation, arguments, targets, origin, and preview preconditions.
- Revalidate before execution; do not silently reinterpret stale approvals.
- Duplicate votes and retries cannot duplicate mutation.
- Denial returns `denied by operator`; do not automatically abort the agent turn.
- The agent may continue with alternatives.
- Identical retries after denial are allowed and may produce a new approval poll, even in the same turn. No per-turn denial suppression was approved.
- Coordinator and project tools use identical rules.
- Self-stop and self-delete are supported; the relay must complete independently of the calling Pi process.

Reuse appropriate existing poll mechanisms—opaque answers, durable identities, authorized voting, restart handling—but do not blindly reuse checkpoint behavior. Checkpoints currently end a run; an approval waits within a tool call and has a different continuation contract.

Persist enough approval/execution state to handle relay restart, caller disconnection, uncertain Matrix delivery, and execution followed by lost response. Never re-execute solely because the caller did not receive its result.

## 6. Irreversible deletion

### 6.1 User-visible contract

Deletion:

- is immediately irreversible once accepted/committed;
- may stop an active conversation and cancel unfinished input;
- removes the conversation from normal lists and prevents open/resume;
- terminates its exact managed window/process, not the entire tmux session;
- removes the active relay/Matrix binding;
- causes the bot to leave the Matrix room;
- preserves Pi session files and transcripts;
- preserves project/workspace/Git files;
- preserves Matrix history and human membership;
- never deletes the guaranteed coordinator.

Do not claim ordinary Matrix room departure erases the room. Other members may retain and view history.

Preserving local transcript files does not restore the old managed identity. Any local history browsing/resume must not reactivate its deleted binding.

### 6.2 Tombstones and cleanup intents

Maintain a minimal permanent tombstone to prevent resurrection through synchronized manifests, retries, stale adapters, or repeated creation keys.

Final retained tombstone data should be limited to conversation identity and deletion time, plus only identifiers demonstrably necessary to reject resurrection.

While cleanup is incomplete, a separate private deletion intent—or equivalent pending tombstone payload—must retain the information needed to complete it safely. This includes the Matrix room identity and exact managed-window observations where applicable. A phase label alone is not enough to leave the room after its manifest has been removed.

Suggested sequence:

1. Validate target, operator/approval, and coordinator protection.
2. Serialize against launch/refresh/generation/worktree operations.
3. Persist irreversible deletion acceptance and required cleanup identity.
4. Reject new opens/resumes, attachments, and input for that identity.
5. Cancel pending deliveries and stop only the exact managed process/window.
6. Remove active binding/registry/manifest state consistently.
7. Leave Matrix and complete related binding cleanup with durable retries.
8. Compact the completed intent to the permanent minimal tombstone.

After the irreversible boundary, a Matrix outage must not restore the conversation to resumable state. Report deleted-with-cleanup-pending where appropriate.

If stopping the exact process fails, retain a visible pending cleanup failure; do not report that all resources have been removed. The identity remains retired.

Determine tombstone placement and synchronization behavior against the existing manifest/runtime storage model. Deletion must dominate stale synchronized manifests after restart. Do not expand this into cross-host resume/failover.

### 6.3 Name reuse

Concept names can be reused after deletion, but only through a new creation key, conversation ID, Pi session, and Matrix binding/room.

Review deterministic room alias derivation and creation retry behavior so name reuse cannot recover the deleted room or old identity by accident. This is an implementation audit requirement, not an assertion that current alias derivation is faulty.

### 6.4 One deletion semantics across entrypoints

Audit coordinator delete, ordinary self-delete (`/remote delete`), host commands, CLI, model tools, and bundled cleanup. They must not expose conflicting meanings for “delete conversation.”

Any retained legacy “unbind but leave Pi running” capability would need a distinct explicit name and separate approval decision. It is not part of the agreed canonical deletion behavior.

## 7. Fast picker architecture

### 7.1 Immediate UI and reduced work

Implement both responsiveness and actual performance improvements:

- start the popup/fzf before complete discovery;
- stream candidates as available;
- use a reusable tmux inventory snapshot;
- parse autojump once per picker;
- scan independent roots concurrently;
- remove per-repository Git validation from initial display;
- validate selected raw paths before launching;
- stop unnecessary discovery when the picker closes;
- avoid starting a model or contacting Matrix over the network to populate the picker.

A local relay inventory query must be inexpensive and must not synchronously perform workspace resolution/Git discovery for every conversation. Expose enough display/placement data to combine inventory efficiently with the host's configured roots.

### 7.2 Project-path cache

Use a disposable cache under `XDG_CACHE_HOME`, not synchronized managed state:

- load cached paths immediately;
- check basic existence before display;
- refresh discovery in the background on every launch;
- add newly found paths to the current picker;
- remove missing paths during refresh;
- replace cache atomically;
- treat malformed/missing cache as a cache miss;
- never store credentials, prompts, or session contents.

Account for concurrent picker invocations and cancelled scans so partial/stale writers cannot replace a newer complete cache incorrectly.

Cache inventory is advisory. Selection must validate the actual path, and managed identity must remain authoritative for lifecycle actions.

### 7.3 Deduplication timing

Hold raw path rows for at most **100 ms** while managed inventory arrives. The UI and available live tmux candidates must not wait.

If managed inventory is slower/unavailable:

- show raw paths anyway;
- remove duplicate raw rows if managed inventory arrives later;
- preserve the selected candidate's stable identity during list updates where possible.

An append-only stream cannot remove candidates already displayed. Choose a tested fzf reload/update strategy that supports late deduplication without losing the query or accidentally selecting a different row.

### 7.4 Degraded mode

When the relay is unavailable:

- ordinary tmux sessions and cached/discovered paths still work;
- marked live managed windows remain visible and switchable using tmux metadata;
- authoritative dormant inventory is unavailable;
- lifecycle requests return a concise relay-unavailable error;
- do not fabricate state or parse full private registry files as an undocumented fallback API.

### 7.5 Performance targets

Engineering targets discussed during planning:

- UI visible in roughly **50 ms** on the normal host;
- live tmux/managed candidates available in roughly **100 ms**;
- cached paths available promptly after the bounded inventory hold;
- fresh discovery never blocks interaction.

These are targets, not demonstrated guarantees. Measure keypress-to-UI, first-selectable-row, and complete-discovery latency independently, including cold/warm cache and relay failure. Keep environment-sensitive benchmarks separate from deterministic correctness gates.

## 8. Launch and failure boundaries

Implement a launch record with distinct window-created and adapter-attached milestones. Open and resume join the same underlying launch.

Recommended behavior:

- persist launch ownership before external launch effects;
- mark the window before exposing it as the selected conversation's target;
- use stable window/pane IDs and verify the conversation marker immediately before switching;
- handle a target disappearing between response and switch without falling back to an unrelated window;
- retain existing single-launch, attachment nonce, and session-writer protections;
- do not restart active Pi simply because open was requested;
- do not cancel an accepted launch merely because the picker exits;
- continue bounded attachment monitoring after open returns;
- make startup failure observable in host status and the terminal/Matrix interface as appropriate.

The final plan does not authorize changing all existing timeout cleanup behavior to retain dead windows. Decide that detail during implementation/merge: watching launch is required, but persistent dead-window retention is not yet a locked requirement.

For the coordinator, route open through the existing coordinator ensure/bootstrap ownership rather than pretending it is a project conversation.

Serialize or explicitly reject conflicting open/resume/stop/delete/refresh/generation/worktree operations. In particular, deletion must win over stale queued launches, and an approved action cannot escape coordinator protection.

## 9. Cross-repository ownership

### pi-harness owns

- shared typed action contracts and dispatcher;
- central approval policy defaults and Nix options;
- operator/bridge identity configuration;
- host-control server and packaged CLI;
- approval intents, poll integration, and recovery;
- terminal approval request/result integration;
- shared model tool and skill;
- `/host` and `!host` frontend semantics;
- irreversible deletion, tombstones, and cleanup recovery;
- open-versus-resume lifecycle milestones;
- coordinator reopen integration;
- protocol/schema compatibility and migration decisions;
- managed-session documentation and deterministic tests.

### nix-dotfiles owns

- `tmux_project` picker UI and candidate handling;
- progressive inventory/reload, sorting, cache, and path validation;
- exact requesting-client/window switching;
- host-owned tmux window creation/observation support;
- host-specific managed roots and policy/operator overrides;
- consuming the harness CLI/API;
- package/keybinding deployment and host acceptance checks.

The harness must not absorb the general tmux project/session manager. The dotfiles picker must not become a second relay state authority.

## 10. Suggested implementation sequence

These are work packages for later issue planning, not published tasks.

1. **Merge contracts and decisions**
   - Reconcile this document with the parallel plan.
   - Pin action identifiers, operator provenance rules, storage schemas, and compatibility strategy.
   - Amend ADR 0002's coordinator-only, live-only picker, and deletion contracts.

2. **Central dispatcher and policy**
   - Extract shared operations without changing existing semantics prematurely.
   - Add policy classification and authority context.
   - Preserve existing coordinator and worktree restrictions.

3. **Host control socket and CLI**
   - Add versioned/bounded transport, peer checks, stable JSON, help, and compatibility status wrapper.
   - Implement reads first and test degraded operation.

4. **Durable approvals and agent/frontends**
   - Add operation-bound approval records and result recovery.
   - Integrate Matrix polls and terminal dialogs.
   - Introduce `managed_host`, skill, `/host`, and `!host`.
   - Align coordinator/project capabilities without broad profile merging.

5. **Irreversible deletion**
   - Add tombstone and cleanup-intent handling.
   - Unify all delete entrypoints.
   - Test active self-delete, Matrix outages, and name reuse.

6. **Open lifecycle**
   - Separate window-created from attached completion.
   - Share launches with resume and add protected coordinator reopen.
   - Expose exact target identity for local navigation.

7. **Picker correctness**
   - Merge managed inventory with live windows and existing session/path candidates.
   - Implement exact-window open, path suppression, state display, and degraded mode.
   - Do not add Ctrl-X.

8. **Picker performance**
   - Add immediate UI, snapshots, cache, parallel discovery, selected-path validation, and cancellable work.
   - Verify late deduplication and stable selection behavior.

9. **Cross-repository verification and rollout**
   - Run focused checks followed by repository-required gates.
   - Review the full pinned feature boundary across both repositories.
   - Update harness input and activate only with explicit user deployment authorization.
   - Perform live acceptance without terminating unrelated sessions.

Performance-only improvements may proceed independently once the picker snapshot/cache interfaces are agreed. Approval-sensitive model tools must not be deployed before their relay policy/approval backend.

## 11. Acceptance and test matrix

### Picker and opening

- Active, dormant, and starting conversations are listed exactly once.
- Coordinator is listed and can reopen its existing session.
- Deleted identities never appear or resume.
- Multiple conversations in one workspace remain individually selectable.
- Raw workspace path is hidden; ordinary tmux session remains.
- Distinct linked checkouts remain distinct.
- Enter switches the invoking client to the exact selected window.
- Window renumbering cannot redirect selection.
- Open returns at window creation; resume waits for attachment.
- Concurrent open/resume requests launch only one process/session writer.
- Manual window kill yields dormant, not deleted.
- Relay outage preserves ordinary navigation and live managed-window switching.
- No Ctrl-X behavior is introduced.

### Performance and discovery

- Slow filesystem discovery does not delay fzf startup.
- tmux inventory and autojump are not repeatedly re-read per candidate.
- Initial cached listing does not spawn Git once per repository.
- Cold, warm, missing, malformed, and stale caches behave safely.
- Concurrent refreshes and cancellation preserve valid cache data.
- Late inventory removes raw-path duplicates while preserving query/selection identity.
- Picker close does not leak discovery processes.
- Selected raw paths are validated before session creation.
- Record real host timing distributions rather than only a single warm run.

### Control interfaces

- All frontends dispatch the same action semantics.
- Exact conversation IDs are required.
- JSON output remains parseable on success and failure.
- Unknown fields/actions/versions and oversized frames fail closed.
- Same-user socket access is checked; disabled hosts expose no control surface.
- Help documents commands and policy behavior.
- Existing status command compatibility is maintained.

### Authority and approvals

- Matrix actor provenance cannot be supplied by the model.
- Ungated mutations require operator origin.
- Authorized non-operators may propose gated actions.
- Only configured operator identities approve.
- Coordinator and project calls use the same policy.
- Each gated call triggers its own exact-action approval.
- Matrix and terminal origins render the correct interaction.
- Deny returns a result; repeated attempts may ask again.
- Expiry at 15 minutes rejects late approval.
- Duplicate/competing votes execute at most once.
- Stale target/precondition changes fail without reinterpretation.
- Restart and lost responses do not duplicate actions.
- Self-stop/delete completes without a surviving caller.
- Approval waiting does not accidentally invoke checkpoint hard-abort behavior.
- Gated mutation previews do not hold broad lifecycle locks for the entire approval wait.

### Deletion and crash recovery

- Active deletion stops only the exact managed window and cancels unfinished input.
- Unrelated windows, sessions, workspaces, and Git state survive.
- Pi history files survive without retaining a resumable managed binding.
- Matrix human membership and history remain; bot departure is retried safely.
- Failure after deletion acceptance cannot restore resumability.
- Tombstones defeat stale manifests, stale attachments, and old creation retries.
- Crash injection at each persistence/external-effect boundary recovers forward.
- Missing/already-gone windows are handled idempotently; reused targets are not killed.
- New conversation with a reused concept receives a new identity/session/room.
- Coordinator deletion is rejected through every frontend.

### Verification boundaries

Use the harness's documented focused checks and canonical deterministic gate (`nix run .#verify`) after implementation. LSP live verification is needed only if the work changes the LSP surface.

Dotfiles instructions prohibit builds/activation without explicit user authorization. Use focused Go tests and relevant evaluation-only checks as appropriate, and clearly separate those from deployment acceptance. Do not restart the shared tmux server as a verification shortcut.

## 12. Merge checklist and explicit non-goals

Preserve these settled decisions when combining plans:

- navigation-only picker; Ctrl-X is out;
- exact-window switching before full Pi readiness;
- separate open and resume completion contracts;
- coordinator retained, protected, and reopenable;
- lifecycle capability available to project models, not only coordinator;
- compact shared tool with skill guidance;
- automatic per-tool approval, not model-managed permission conversations;
- policy centralized in Nix;
- operator-only approval, with non-operator proposals allowed for gated actions;
- 15-minute expiry and permitted re-prompting after denial;
- workflow-level trust, not sandboxing;
- immediate irreversible deletion with durable retirement and preserved history/files;
- actual performance optimization plus progressive display and disposable caching.

Resolve during the merge or implementation design:

- exact expanded command grammar and typed tool argument schema;
- run/request-scoped actor provenance under mixed-user steering;
- reconciliation-apply policy classification;
- approval and deletion schema/compatibility strategy;
- tombstone interaction with synchronized manifests and backups;
- bounded inventory pagination and canonical display-placement representation;
- fzf update mechanism for late deduplication;
- terminal behavior on post-open launch failure;
- compatibility/migration of existing coordinator tool names and ordinary delete commands.

Not requested:

- cross-host discovery, failover, or migration;
- agent sandboxing or prevention of deliberate same-user bypass;
- filesystem/project deletion;
- erasing Matrix room history or changing human membership;
- reversible archive/restore state;
- automatic deletion when a window closes;
- a new generic session/workstream manager;
- arbitrary remote shell or arbitrary Matrix administration;
- blanket approval of an agent's future multi-call workflow;
- runtime-editable approval policy;
- implementation or deployment before the merged plan is authorized.
