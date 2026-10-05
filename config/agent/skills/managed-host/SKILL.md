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
- `conversation.delete` permanently retires the identity and cleans up its exact
  owned resources. It preserves saved Pi/Matrix history and workspace files.
  The coordinator cannot be stopped or deleted.
- Bulk deletion and worktree/Space changes use preview, inspect, then apply the
  returned `previewId`. One approval covers only those frozen targets. Changed
  scope requires a new preview and new consent. Branch deletion is separate.
- Use a fresh creation key for a genuinely new conversation; a retry must retain
  its original identity. Creation is not permission to scaffold or publish files.
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
