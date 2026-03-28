# PI Hub Data Model

## Goal

The hub needs one fast merged view of:

- what projects exist
- which projects are exposed into the agent VM
- which projects are actionable right now
- which PI/tmux sessions already exist

Actions are gated by exposure into the agent VM. A project may be known from
tracking metadata, but it is not actionable until it appears in the shared
manifest.

## Source Planes

### 1. Shared Project Plane

Host-managed source exposed into the guest VM:

- Path: `/home/beau/host/.pi-hub/shares.json`
- Source of truth: `agent-share` on the NAS host
- Semantics: security/exposure boundary

Each entry represents a directory intentionally bind-mounted into the shared
root and visible inside the VM.

### 2. Tracking Plane

Imported project metadata:

- initial source: coordinator `state/index.yaml` plus per-project state
- long-term source: repo-local `.pi/project.yaml`
- semantics: naming, tags, default branch, docs, and launch hints

Tracking metadata can exist without a share. Those entries remain visible in
the hub but are not actionable.

### 3. Runtime Plane

Guest-local operational state:

- path: `~/.local/state/pi-hub/`
- semantics: tmux session names, active worktrees, last-opened timestamps,
  runtime status, and recent focus

This plane is machine-local and should not be versioned in git.

## Merge Rule

Each project row in the hub is a merge of:

- zero or one tracked project entry
- zero or one shared project entry
- zero or one repo-local manifest
- zero or one runtime session entry

The key rule is:

- visible if tracked or shared
- actionable only if shared

## Core Records

### SharedProject

Represents one host directory exposed into the VM.

Fields:

- `agentPath`: share key relative to `/home/beau/host`
- `sourcePath`: original host path
- `hostPath`: host-side mounted path under `/home/beau/agent`
- `guestPath`: guest-visible path under `/home/beau/host`

### TrackedProject

Represents imported tracking metadata.

Fields:

- `id`
- `name`
- `defaultBaseBranch`
- `repoPath`
- `stateFile`
- `toolingFile`
- `notesFile`
- `active`

### RepoManifest

Repo-local durable metadata stored in `.pi/project.yaml`.

Fields:

- `id`
- `displayName`
- `tags`
- `defaultWorktreePrefix`
- `docs`
- `preferredEntrypoint`

### SessionRecord

Guest-local runtime session data.

Fields:

- `sessionName`
- `transport` (`tmux`)
- `cwd`
- `state`
- `lastSeenAt`
- `projectId`
- `worktree`

### HubProjectRecord

The merged row shown in the hub.

Fields:

- `key`
- `projectId`
- `displayName`
- `share`
- `tracked`
- `manifest`
- `session`
- `actionable`
- `visibility`

## Initial Status Model

Start simple:

- `missing`
- `idle`
- `running`
- `unknown`

Do not block on perfect automatic "waiting for input" detection. That can be
added later with a small heartbeat file emitted by the harness wrapper.

## Discovery Order

1. Read `shares.json`.
2. Read imported tracking metadata.
3. For each shared repo, look for `.pi/project.yaml`.
4. Read runtime session cache.
5. Produce merged `HubProjectRecord[]`.

## First Commands Supported By This Model

- `ph.projects`
- `ph.find`
- `ph.open <project>`
- `ph.status <project>`

## Deliberate Non-Goals For Phase 1

- writing coordinator state
- cross-project editing from one ambient context
- automatic worktree creation
- agent orchestration beyond session discovery and switching
