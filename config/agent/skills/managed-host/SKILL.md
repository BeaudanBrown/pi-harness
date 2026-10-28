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
- `conversation.delete` permanently retires the identity and cleans up its exact
  owned resources. It preserves saved Pi/Matrix history and workspace files.
  The coordinator cannot be stopped or deleted.
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
