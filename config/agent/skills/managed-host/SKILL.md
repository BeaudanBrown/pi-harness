---
name: managed-host
description: Manage host-owned Pi conversations, projects and worktrees through typed controls. Use for listing, opening, resuming, stopping, retiring, creating or explicitly reconciling managed resources.
---

# Managed host controls

Use `managed_host` with `operation: "help"` for operation names and fields. This
also works in the neutral coordinator, which has no engineering/read/shell tools.
Use list/status to discover exact IDs. Titles are display metadata, not identity.

- Reads and previews are free. Every model mutation requires separate live-tool
  approval, even when `confirmed: true`. Never substitute a shell/CLI invocation
  to avoid the approval gate. Model parameters cannot choose actor or origin.
- `conversation.open` is window-first; `conversation.resume` waits for readiness.
  Neither includes a prompt. Reuse the saved conversation rather than creating a
  replacement after a timeout. Inspect uncertain outcomes before any explicit retry.
- For legacy windows still present, `conversation.migrate` captures exit evidence
  before manual closure and verifies it on a separately confirmed repeat.
  For already-closed legacy windows, use `conversation.recover.preview`, inspect
  its mode and uncertainty warnings, then `conversation.recover.apply` with the
  returned preview ID, `confirmed`, `operatorClosed`, and `acceptIncompleteInspection`
  all true. Obtain the operator's actual closure confirmation; never invent it.
  Each model apply still needs independent live approval. Detected conflicts block;
  changed observations need fresh preview and consent. Recovery records operator
  attestation, not verified exit. It never stops or launches Pi. For a retired target,
  it only resolves the stop obligation; account cleanup remains independent.
- `conversation.admin.preview` takes exact `conversationIds` and optional
  `includeSpaces=true`. Its separately approved apply grants only the configured
  operator room admin power, not arbitrary users. Inspect all frozen targets and
  concurrency warnings. Avoid concurrent permission edits: Matrix has no conditional
  state writes. Inspect uncertain outcomes with a new preview; never blindly replay.
  This neither restarts Pi nor removes participants. Do not use shell/API calls to
  bypass the approval gate.
- `conversation.archive.preview` selects 1–16 exact `conversationIds`; its
  separately approved apply preserves original rooms, history and membership under
  host -> Archive -> historical project -> worktree. It disables managed execution
  without deleting/restoring checkouts. No reactivation is supported. Known active
  runtimes, unfinished inputs, controls and publications block; never cancel them
  implicitly. If exact exit evidence is unavailable, `legacyClosure=true` requests
  **operator attestation that the old Pi was closed**, with fresh conflict
  screening. By default unreadable process environments block. Only when the operator
  explicitly accepts that uncertainty, add `acceptIncompleteInspection=true` alongside
  `legacyClosure=true` to the archive preview. The warning discloses unreadable counts;
  frozen opaque set evidence and the approved operation reference are audited. Changed
  gaps require fresh preview/consent, including retries. Known conflicts, failed or
  malformed inspection and pending work still block. This never weakens exact-exit,
  stopping/deletion or cleanup checks. This is not verified exit; never assert closure
  or uncertainty acceptance on the operator's behalf.
  Inspect `conversation.archive.list` for archived/archiving status before an explicit
  retry with fresh preview and consent. New Space joins may remain pending while
  original links are preserved. Ancestor cleanup has its own
  `conversation.archive.cleanup.preview/apply` approval; shared/untracked Spaces
  remain preserved, uncertain departure stays pending, and no implicit rejoin occurs.
- `conversation.delete` permanently retires the identity and cleans up its exact
  owned resources. It preserves saved Pi/Matrix history and workspace files.
  The coordinator cannot be stopped or deleted.
- `space.reconcile.preview` accepts optional exact `conversationIds` (1–64).
  Select only intended conversations; missing-workspace blockers require narrowing
  the selection or explicit restoration, never silent skipping/recreation. Apply
  preserves rooms/history and unrelated links. Newly created migration Spaces grant
  the configured operator admin; existing permissions are unchanged. Interrupted
  scoped plans retain their original selection with fresh approval. Older unscoped
  plans permit an explicitly selected subset; excluded entries remain untouched.
  Pre-checkout plans may need a second preview/apply for the checkout hierarchy.
- Bulk deletion and worktree/Space changes use preview, inspect, then apply the
  returned `previewId`. One approval covers only those frozen targets. Changed
  scope requires a new preview and new consent. Branch deletion is separate.
- Use a fresh creation key for a genuinely new conversation; a retry must retain
  its original identity. Creation is not permission to scaffold or publish files.
- To split the current project conversation into a new worktree and Matrix room,
  use `worktree.conversation.fork`. Get the current conversation ID from `help`;
  use its exact `sourceConversationId`, `rootKey` and `workspace`, a new branch,
  explicit committed `baseRef`, creation key, title, and concise `summary`.
  Summarize goals, decisions and relevant context; do not paste raw history,
  thinking, tool logs, credentials or pending approvals. The summary is visible
  in Pi and Matrix. No uncommitted files or execution state are copied. The new
  conversation stays idle until the next message; do not automatically continue
  its task. This is separate from native `/fork` or a same-room context reset.
  Consent displays the summary and frozen base/source generation; oversized
  approval details fail rather than being truncated. Inspect partial results
  before explicitly retrying the same creation identity with fresh consent.
- Coordinator membership recovery requires its own explicit confirmed action;
  leaving the coordinator never retires it or authorizes automatic reinvitation.

Direct operator surfaces are `/host`, `!host` and `pi-managed-session` with noun /
action arguments. Room-local `!start` starts without a prompt, `!stop` makes a
project conversation dormant, and `!close --confirm` retires it. Destructive/apply
operations still require explicit confirmation. No `!notify` command exists.

`remote_session_delete` is a deprecated alias for approved canonical retirement.
Other legacy model lifecycle tool names are replaced by `managed_host`; capability
errors require an upgrade, never a backend-bypassing fallback. Same-Unix-user shell
authority is not a sandbox.

For implementation and maintenance, see `docs/managed-host-tooling-map.md` in the
harness repository: operation owners, authority files, tests and the adding-operation
checklist. Runtime capability errors still require an upgrade, not a bypass.
