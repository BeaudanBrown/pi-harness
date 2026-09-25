# Chat-only project tools

The dedicated `!pi` assistant can opt into a small sandboxed project interface. Ordinary Pi CLI sessions, resource profiles and tools are unchanged. Project access requires an explicit host-configured room binding; asking for it in a prompt cannot grant it.

## Interface

The chat receives two additional tools:

- `workspace`: read/list/search/write/edit/mkdir/rename/delete within the approved project. Write creates or replaces a text file; edit replaces one unique occurrence. No operation IDs, required digests, project locks or mutation journal.
- `project_command`: execute a named host-approved command, with no extra arguments or arbitrary shell text. For dump the host supplies `check`, `publish`, `status`. Other projects can supply different immutable commands.

The agent reads project instructions through `workspace` and chooses how to complete the request. A requested website change may proceed through validation and publication without a second approval. There is no mandatory plan/prepare/commit workflow. The existing publisher still validates a snapshot before activating it.

Assume one editor at a time. GRILL retains normal writable access without a lock protocol. File operations are atomic where practical and reject detected changes/unsafe paths, but do not promise multi-writer transactions. If a command is interrupted, inspect files or publication receipts before retrying; already-completed side effects cannot be rolled back by disconnecting.

## Security, separate from workflow

`nix/chat-workspace-package.nix` packages a credential-free Python server inside Bubblewrap. It has private mount/network/PID/user namespaces, no capabilities, a minimal environment and only approved runtime closures plus project/IPC mounts. Existing `.git`, `.pi`, `.agents`, `.publishing` directories are masked. Generic paths reject hidden/control components except ordinary `.gitignore` and `.editorconfig` support files. Directory-descriptor traversal never follows symlinks; hard-linked/non-regular files are rejected. No ambient project extension, shell configuration or executable is loaded.

The project and IPC directories must be canonical and non-overlapping. Filesystem/command execution never falls back to the host when sandbox setup fails. The service loads no Matrix/model credentials. The outer systemd service also has a private network; route netlink and IPv4 socket families are allowed only because Bubblewrap/libc need them for private loopback setup, not to grant public-network access. Services that launch these Bubblewrap sandboxes leave `ProtectKernelTunables` and `ProtectKernelLogs` disabled: systemd's filesystem form of those settings pre-masks paths below `/proc`, causing Linux to reject Bubblewrap's fresh PID-namespace procfs mount as too revealing. Empty capability sets, `NoNewPrivileges`, the remaining systemd hardening, and Bubblewrap's private namespaces and capability drop remain enforced.

Commands are immutable host argv beginning with a Nix store executable; do not configure project-controlled scripts as trusted commands. Additional host-approved command data mounts appear under `/commands/data/<name>`, outside the generic file tools' workspace. This allows publication queue/status access without giving `workspace` authority to forge ready requests or receipts. Commands run inside the same credential-free sandbox, with bounded output/time and process-group cleanup. Caller disconnection cancels a running command; a queued publication may already have happened and must be checked through status.

The lock-free design does not protect against a hostile host owner/kernel or guarantee race-free concurrent manual editing. Those are not the sandbox's job.

## Configuration

`services.pi-harness.bridgeChat.workspaceExecutor` (disabled by default):

- `projectDirectory`: canonical approved source directory.
- `user`: existing editor identity with access to it; no project ownership changes are made by this module.
- `commands`: mapping from command names to fixed argv.
- `commandMounts`: mapping from names to `{ source, readOnly }`.

The service exposes `/run/pi-chat-workspace/workspace.sock` to trusted group `pi-chat`. Membership grants tool-caller authority; do not grant it to arbitrary users. Only one service is launched. It has no persistent operation state; obsolete state from the earlier unreleased foundation is unused.

The assistant's separate `workspaceRoomIds` list grants the project capability only to listed enabled rooms. `workspaceSocket` and `projectCommands` (name-to-description map) provide the SDK interface. Empty `workspaceRoomIds` grants no project access; separately enabled chat file tools remain available without a project. The transport selects the capability from the verified originating room; the model socket receives only question text and a boolean capability, not arbitrary paths or room IDs.

The model runtime registers web search plus these project tools for approved project questions, and optional chat file tools when explicitly enabled. It disables local built-ins and ambient resources and keeps fresh in-memory sessions. Project turns have a ten-minute/24-turn ceiling; ordinary questions retain their existing smaller budget. Plain CLI profiles are not modified.

## Wire protocol / limits

One bounded JSON object plus LF per Unix connection; keep the connection open while awaiting its response. Exact fields only:

- `read`, `list`, `mkdir`, `delete`: `action`, `path`.
- `search`, `write`: `action`, `path`, `text`.
- `edit`: `action`, `path`, `old`, `new`.
- `rename`: `action`, `path`, `destination` (regular files only; no clobber).
- `command`: `action`, `name`.
- Private attachment bridge `export`: `action`, `path`; returns `filename` and base64 `data` for a bounded regular file.
- Private attachment bridge `import`: `action`, `path`, base64 `data`; creates a new file only, with the same path confinement and no overwrite. The caller validates downloaded content before importing it.

`import`/`export` are used internally by chat file tools, not exposed as actions in the model's `workspace` schema. Binary bytes never enter model context. Binary files are limited to 25 MiB; rename/delete can operate on such files, while ordinary read/write/edit retain the text limit.

Text files/arguments: 1 MiB; wire frame: 36 MiB (to carry bounded base64 attachments); list: at most 2,000 examined entries and 1 MiB encoded results, with explicit truncation; literal search: 8 MiB scanned and 100 results. Files for media delivery belong to the separate attachment path, not these text tools. Commands: 360 seconds/64 KiB output. No automatic retry of mutations or commands.

## Verification

- `nix build .#checks.x86_64-linux.chat-workspace .#checks.x86_64-linux.bridge-chat --no-link`
- `nix run .#verify-chat-workspace-live`: real packaged sandbox against disposable files, namespace/mount/environment checks, no real project or host service change.
- `nix run .#verify`: canonical deterministic gate.

Downloads/attachments (#100) use this private binary bridge; their delivery policy is documented in [the assistant contract](bridge-chat-assistant.md). Final input pin and NAS activation/live checks (#101) remain separate work. Local tests do not establish deployed Note to Self acceptance.
