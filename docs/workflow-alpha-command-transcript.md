# Workflow Alpha Command Transcript Skeleton

This is the stable command-sequence outline for the workflow-alpha manual test
run.

Keep it narrow:

- operator-visible commands only
- operator-visible checkpoints only
- normal `ssh agent` plus tmux environment only
- no recovery branches, troubleshooting, or deep expected-output capture yet

## Starting Assumption

The operator is already in the normal agent VM path:

1. `ssh agent`
2. attached to the shared tmux environment
3. running `ph` from `/home/beau/host/projects/pi-harness` or from `PATH`

## Scenario Matrix

This matrix defines the minimum successful operator flows that workflow alpha
must cover before the later acceptance-criteria slice turns them into a stricter
done gate.

| Scenario | Entry path | Successful checkpoint |
| --- | --- | --- |
| Zero-context workstream | `ph new workflow-alpha` | Creates the workstream, switches into `ph:<workstream-id>`, and keeps the attachment summary at `no paths` until a context is added. |
| Outside-tmux menu entry | `ph menu` from a shell outside tmux | Prints `Outside tmux: joining the shared default tmux session, then opening the workstream menu.` and opens the popup in the shared `default` tmux session. |
| Git-backed attachment | `ph add-context <workstream-id> /home/beau/host/projects/pi-harness` | Attaches the repo through isolated-by-default git-backed behavior and reports the new context id plus target path. |
| Plain-directory attachment | `ph add-context <workstream-id> /tmp/workflow-alpha-notes` | Attaches the directory directly without requiring git metadata or worktree provisioning. |
| Reattach inside tmux | `ph attach <workstream-id>` after switching away | Returns the operator to the requested `ph:<workstream-id>` session by exact workstream id. |
| Reattach from outside tmux | `ph attach <workstream-id>` from a shell outside tmux | Prints `Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).` and lands directly in the requested workstream session. |

## Session-Control Decision Table

This table makes the bootstrap contract explicit enough to implement without
reopening the operator interaction model during the later tmux-control slice.

| Command | Invocation context | Bootstrap action | Successful checkpoint |
| --- | --- | --- | --- |
| `ph menu` | inside tmux | open the popup in the current tmux client | the selector opens over the current client and can switch directly to another workstream session |
| `ph menu` | outside tmux from the default `ssh agent` entry path | join the shared `default` tmux session first, then open the popup there | the command prints `Outside tmux: joining the shared default tmux session, then opening the workstream menu.` and the operator lands in `default` with the popup open |
| `ph menu` | outside tmux from any other shell in the VM | use the same bootstrap as the default `ssh agent` path | the outside-tmux menu path still lands in the shared `default` tmux session instead of opening a popup from the bare shell |
| `ph attach <workstream-id>` | inside tmux | switch the current client directly into `ph:<workstream-id>` | the operator lands in the requested workstream session without a `default`-session stop |
| `ph attach <workstream-id>` | outside tmux from the default `ssh agent` entry path | join tmux and attach directly to `ph:<workstream-id>` | the command prints `Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).` and the operator lands in the requested workstream session |
| `ph attach <workstream-id>` | outside tmux from any other shell in the VM | use the same bootstrap as the default `ssh agent` path | the outside-tmux attach path remains a direct workstream attach rather than a two-step hop through `default` |

## Transcript

### 1. Create a new workstream

Command:

```sh
ph new workflow-alpha
```

Checkpoint:

- the command prints `created <workstream-id> (ph:<workstream-id>)`
- the created workstream id is available for the next steps

### 2. Attach to the new workstream session

Command:

```sh
ph attach <workstream-id>
```

Checkpoint:

- the operator lands in the tmux session for `ph:<workstream-id>`
- if the session did not exist yet, the command prints `bootstrapped <workstream-id> (ph:<workstream-id>)`

### 3. Add one isolated git-backed attachment

Command:

```sh
ph add-context <workstream-id> /home/beau/host/projects/pi-harness
```

Checkpoint:

- the command prints `attached <context-id> to <workstream-id> at <path> (...)`
- the attachment label indicates isolated worktree behavior for a git-backed path

### 4. Create a second workstream for menu switching

Command:

```sh
ph new workflow-alpha-peer
```

Checkpoint:

- the command prints `created <workstream-id> (ph:<workstream-id>)`
- a second durable workstream now exists for menu selection

### 5. Open the menu and switch workstreams

Command:

```sh
ph menu
```

Checkpoint:

- a tmux popup selector opens inside the current tmux client
- the selector shows at least the two workflow-alpha workstreams
- the selector uses the same attachment-summary contract as `ph list`, for
  example:

```text
workflow-alpha       waiting     Workflow Alpha       no paths
workflow-alpha-peer  processing  Workflow Alpha Peer  2 paths
```

- choosing the other workstream closes the popup and switches the client into its tmux session

### 6. Reattach directly by workstream id

Command:

```sh
ph attach <first-workstream-id>
```

Checkpoint:

- the operator returns to the requested tmux session by exact workstream id
- the command works as the direct reentry path after menu-based switching

## Scope Boundary For The Later Runbook

Before expanding or rerunning this flow, satisfy the environment contract in
[`docs/agent-vm-verification-prerequisites.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-prerequisites.md)
and use
[`docs/agent-vm-verification-runbook.md`](/home/beau/host/projects/pi-harness/docs/agent-vm-verification-runbook.md)
for the concrete ordered operator sequence.

The later verification runbook can expand this skeleton with:

- exact sample ids captured from a real run
- step-by-step evidence capture for the scenario-matrix rows above
- `ph list` and status checks, including output such as:

```text
ID                  STATUS      TITLE                ATTACHMENTS
workflow-alpha      waiting     Workflow Alpha       no paths
workflow-alpha-peer processing  Workflow Alpha Peer  2 paths
```

- stale-runtime and dead-session verification
