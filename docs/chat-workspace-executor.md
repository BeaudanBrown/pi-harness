# Isolated chat workspace executor (#98)

This is an opt-in **foundation**, not the complete workspace-enabled !pi assistant. It does not bind chats, register model tools, download/send files or publish websites. Do not enable it as a substitute for #97's complete rollout.

## Enforcement

The Nix-packaged launcher starts a Python Unix-socket worker inside Bubblewrap with private mount, network, PID and user namespaces, no capabilities, no inherited environment, minimal proc/dev/tmp and only required immutable runtime closures. The trusted project, private state and IPC directories must be distinct canonical directories with no containment overlap. Mount sources are open directory descriptors. Sandbox failure never falls back to host execution.

The only host filesystem exposed is the approved project plus private operational state/IPC. Existing `.git`, `.pi`, `.agents`, `.publishing` directories are overmounted empty/read-only. Generic tools reject every dot-prefixed path component; no project extension, config, shell or executable is loaded. File APIs traverse directory descriptors with no symlink following, reject hard-linked/non-regular files and use digest preconditions for edits. File replacement is atomic; create and rename refuse to overwrite an existing destination. There is no general shell or network tool.

The executor holds an exclusive project lease on `.pi-workspace.lock` for its entire lifetime, in addition to the private-state lock. All admitted writers must take that same lease; a second executor with a different state directory is rejected. Host rollout MUST exclude uncooperative writers (including existing GRILL/managed editing sessions) while it is active. The lock is advisory, not a permission boundary against arbitrary host processes. Source digest/identity checks are preconditions, **not atomic compare-and-swap against an uncooperative writer** between the final stat and replace/unlink/rename syscall. #101 owns enforcing exclusive editor access at activation; #99 must participate in the lease protocol. There is no protection against a hostile host owner/kernel or a privileged process moving already-open project directories outside the project. The executor itself cannot move directories or create links.

## Service

`services.pi-harness.bridgeChat.workspaceExecutor` exposes `enable` (default false), `projectDirectory` and `user`. The user must already exist and have required project ownership; this module does not change project permissions. A service user with only the intended project authority is preferable when ownership permits it. The service uses group `pi-chat` for its socket; membership is trusted tool-caller authority. Do not grant it to arbitrary users.

The system service starts the sandbox with `/var/lib/pi-chat-workspace` state and `/run/pi-chat-workspace/workspace.sock`. It loads no credentials, allows only Unix sockets and limits tasks/memory/CPU. These host paths are not model-configurable. Project admission (room/owner/profile checks) belongs to the trusted caller in #101.

## Protocol

One UTF-8 JSON object plus LF per Unix connection; bounded to 7 MiB, with a ten-second socket deadline. The worker is serial. Only exact declared fields are accepted:

- `read`: `path`; returns UTF-8 `text` and `sha256`.
- `list`: `path` (`.` means root); streams at most 2,000 examined entries (including hidden entries), returning visible entries and an explicit `truncated` flag. Encoded entries are bounded to 1 MiB before response framing.
- `search`: `path`, literal `text`; scans up to 8 MiB, returns at most 100 matching lines.
- `write`: `id`, `path`, `text`, `expected` (SHA-256 or `absent`).
- `edit`: `id`, `path`, `old`, `new`, `expected`; old text must match exactly once.
- `mkdir`: `id`, `path`; one new directory, parents must exist.
- `rename`: `id`, `path`, `destination`, `expected`; regular files only, no clobber.
- `delete`: `id`, `path`, `expected`; regular files only, no recursive deletion.
- `status`: `id`; returns stored phase/result or `unknown`.

Files/text are bounded to 1 MiB here. Large binary downloads/export require the separate #100 data path rather than lifting this text-tool bound. `id` is a lowercase 64-character hex identity allocated by the trusted caller, not the model. A caller must retain the ID before dispatch and must not turn an uncertain response into a new operation.

## Recovery / privacy

SQLite persists identity and argument digest before mutations, then bounded result metadata before acknowledgement. No file text is retained. A matching retry returns its stored result; changed arguments under the same identity are rejected. Semantic precondition failures are terminal `failed`; an OS failure that might follow an effect is `uncertain`. Restart converts any `running` entry to `uncertain`. Any uncertainty blocks new mutations while read/status remain available. Operator reconciliation is required; no automatic reset/retry is exposed. Do not delete the journal to clear uncertainty.

The journal is exclusive, capped at 10,000 operations and 16 MiB, and never silently evicts retry identities. Reconciliation/archival integration is owned by #101; until then a full/uncertain journal is a deliberate stop. No success is inferred from a missing response. Socket errors return bounded error codes, not file contents or host exception messages.

## Verification

- `nix build .#checks.x86_64-linux.chat-workspace --no-link`: deterministic protocol/path/journal/race tests and module contract.
- `nix run .#verify-chat-workspace-live`: real packaged sandbox/IPC against disposable files, outside/control denial, namespace/mount/environment inspection and invalid-configuration fail-closed check. Requires Linux user namespaces; never skips on unavailable isolation. No real project or host service is changed.
- `nix run .#verify`: canonical deterministic gate (includes workspace check).

Live sandbox checks on GRILL do not replace deployment checks under NAS's configured service identity and systemd restrictions. #99 owns automatic publication, #100 media, #101 model routing/configuration and final rollout.
