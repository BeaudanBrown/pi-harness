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

The later verification runbook can expand this skeleton with:

- exact sample ids captured from a real run
- outside-tmux entry coverage for `ph menu`, including `Outside tmux: joining the shared default tmux session, then opening the workstream menu.`
- outside-tmux entry coverage for `ph attach`, including `Outside tmux: joining tmux and attaching <workstream-id> (ph:<workstream-id>).`
- plain-directory attachment coverage
- `ph list` and status checks, including output such as:

```text
ID                  STATUS      TITLE                ATTACHMENTS
workflow-alpha      waiting     Workflow Alpha       no paths
workflow-alpha-peer processing  Workflow Alpha Peer  2 paths
```

- stale-runtime and dead-session verification
