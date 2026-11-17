# Fresh-project creation (#175)

`create_project` adds a narrow variant to the existing approved task-creation
workflow. It is not a coordinator, execution queue or session manager. Native Pi
owns the saved session; the existing host bridge owns its room and organization.

## Interface

```json
{
  "name": "bridge-example",
  "description": "A disposable acceptance project.",
  "handoff_summary": "Wait for a separate fresh human instruction."
}
```

Available alongside `create_task_workspace` in eligible, enrolled interactive
engineering sessions. Workers/headless/local-only profiles are not granted it.
The source needs a registered native session but need not be a Git repository.
The isolated owner `!pi` assistant does not acquire this tool.

The name is a single 1–64-character ASCII component: first character alphanumeric,
remaining characters alphanumeric, `_` or `-`. No caller-supplied host, arbitrary
root, shell script, approval flag, base, remote, template or dependency command.
The destination parent is `services.pi-harness.matrixBridge.projectRoot`, separate
from the enrollment `roots`. Set it to an absolute canonical directory, such as
`/home/operator/documents/projects`, within an enrollment root. Sessions under
other enrollment roots can still use Matrix and propose a fresh project; creation
goes only to the configured destination. This does not move or disable existing
projects, sessions or rooms. The root must exist and be owned by the executing
user. A changed root invalidates an approved creation's frozen destination.

The option defaults to null: a sole enrollment root remains the compatibility
fallback; multiple roots without an explicit destination refuse creation rather
than guessing. No caller-supplied root is added to the tool. Creation is
current-host only.

## Independent approval and effects

Preparation freezes the destination, description/README, native identity, saved
history path and timestamp. Local UI or the current configured Matrix operator
must approve that exact request. The approval displays host, repository path,
`main`, initial commit message, repository-local author, full README and explicit
handoff. Oversized approval text is refused rather than truncated. An ordinary
joined participant may propose but cannot approve resource creation. Cancelled,
stale, expired and changed-operator requests cannot grant creation.

The approved operation creates:
- `ROOT/NAME`, a standalone Git repository, not a linked worktree;
- `README.md` containing the name and supplied description;
- one `Initialize project` commit on `main`, authored/committed by
  `Pi Project <pi-project@localhost>`, with frozen creation time;
- repository-local Git author configuration (no global configuration changes);
- one saved native Pi session with enrollment/ownership/binding metadata, the
  explicit visible handoff, and its native title;
- a child binding in the existing host-local bridge ledger, followed by ordinary
  asynchronous Matrix conversation/Space/invitation setup.

No Pi process, terminal, tmux window or model execution is started. The source
session is not switched, and its history, uncommitted files and approvals are not
copied. Use the existing picker or `!start` to open the child idle later. Existing
native naming does not imply continuous Matrix title synchronization (#174).

Git creation uses a minimal environment, no global/system config, no templates,
no hooks or signing, and no inherited project `direnv`. It never creates a remote,
pushes, clones, installs dependencies or deploys. This is intentional for a new
minimal repository, distinct from task worktrees using a trusted source project.

Approval is a workflow gate, not a cryptographic authorization boundary against
an adversarial process with the same Unix user's unrestricted shell/filesystem
access. Matrix sender identity is authenticated through the homeserver; local
confirmation comes from native UI, not model tool arguments.

## Persistence and crash boundaries

The existing task records in the **same bridge SQLite ledger** hold the explicit
project intent variant, frozen plan, approval, effect progress and child receipt.
Old task plans remain readable without new required fields. There is no new
runtime database, general mutation catalogue or cleanup authority.

| Boundary | Behavior |
| --- | --- |
| Before approval | No project directory or native child history is created |
| Concurrent same destination | Existing host-local kernel setup lease serializes creators; a different intent cannot adopt the winner |
| Git staging | Unique private `.pi-project-staging-*` directory; README/repo/commit and proof completed before publication. Git children cannot publish the final destination if their helper dies |
| Public repository publication | Atomic no-replace rename; matching immutable-plan proof in `.git` and initial commit receipt. Lost reply reuses owned repository, never creates another public path |
| Incomplete repository edited | Refuse completion if branch/HEAD/worktree changed before the native handoff. Preserve edits, no reset or deletion |
| Native history publication | Existing native writer seam, SDK-generated entries and atomic no-replace file publication; exact native identity reused |
| Completed creation | Preserve subsequent human work; missing/foreign native history is not overwritten. Existing matching history can recover the same receipt |
| Bridge registration/Matrix setup | Existing idempotent child binding and output transactions; Matrix failure leaves local success intact and reports pending setup |

Unpublished staging can remain after an interruption. It is evidence, not an
extra live project or retry authority; do not automatically delete or adopt it.
Directory/branch/history collisions are refusals, not invitations to overwrite.
No cleanup or synchronization change is part of this tool.

## Acceptance evidence

`tests/bridge-project.test.ts` exercises real disposable Git and saved native SDK
history through the finite worker and existing approval/organization interfaces:
non-Git source, absent-path preparation, clean initial repository, explicit-only
idle handoff, foreign/symlink/name refusal, duplicate and conflicting intents,
lost receipts, actual helper SIGKILL at publication boundaries, changed partial
work refusal, inherited Git config/hook isolation, local decline/stale decision,
ambiguous root refusal and independent Matrix setup. Multi-root tests cover an
explicit destination with a source in another enrolled folder, unchanged enrollment
roots, changed-policy refusal, foreign/symlink destinations, actual Pi local and
Matrix approvals, and evaluated Nix daemon config/assertion wiring.

`tests/bridge-adapter-real-pi.test.ts` exercises the actual packaged Pi tool with
a fake provider: local UI cancel/approve, Matrix-origin proposal with no stranded
local dialog, rejected nonoperator vote, accepted operator vote, saved idle
children and zero launcher calls. Existing task/relay/archive/media tests remain
required. These tests do not access a live Matrix account or real provider.

Canonical gate: `nix run .#verify`. Publication/pinning, live host activation and
an approved disposable NAS canary remain separate operator decisions. Existing
#172 synchronization holds and retained histories are unchanged by development.
