# Native Matrix bridge identity

One non-admin bot account per host owns that host's private native rooms/Spaces.
Pi history and execution remain local and independent of that account's health.
The configured operator approves task creation and archive/restore; other current
joined, non-ignored participants may converse and answer ordinary questions.
A room name, alias, display name or power level is not ownership proof.

**Not rebuild-ready:** source and package checks are not activation permission.
Existing deployments must preserve bot/operator/room/native identities and follow
[offline migration](matrix-pi-migration.md), not create new replacement accounts.
Publication, pin advance, quiescence and cutover are separately approved work.

## Configuration for a separately approved fresh host

- Obtain a normal non-admin host account and dedicated login through the
  homeserver's supported flow. Never put its token in Pi, Git, issues, argv or
  Nix expressions.
- Configure `services.pi-harness.matrixBridge` with exact `hostId`, `botUserId`,
  `operatorUserId`, `homeserver`, `roots`, Unix `user` and `environmentFile`.
  Use exact `ignoredSenderUserIds`, not wildcard or display-name matching.
- The SOPS-rendered file contains only `PI_MATRIX_ACCESS_TOKEN=<opaque-token>`.
  Keep the existing module-local SOPS reference policy. Never inspect the
  private secrets repository. Systemd passes this file as `LoadCredential`;
  the daemon parses it as data and does not export it to Pi/tmux/Git.
- Configure shared tmux/native launcher ownership in the consuming host, not in
  the generic bridge. See the [README](../README.md#optional-native-matrix-bridge).

Startup verifies `/account/whoami` and rejects a different/guest account before
opening runtime state. Recognizable legacy state is refused even earlier, before
credential access or HTTP. Background setup uses immutable create-event proof,
frozen receipts and deterministic aliases. Uncertain creation is observed, never
replaced by another room. Setup or NAS absence cannot gate local Pi.

## Acceptance and rotation boundaries

After separately approved cutover, verify the exact running package, original
room identities, native/local launch and Matrix round trips. A service/socket ACK
is not execution completion, process exit, membership or phone-delivery proof.

A separately approved token rotation must keep the same bot identity and frozen
send transactions. Inspect the original room after rotation before revoking the
old login. Do not clear cursors, discard uncertain sends or recreate rooms to
repair access. Imported bot/operator identity changes are rejected. Broader
membership/account repair and automatic notification changes are not provided.

See [replacement evidence](matrix-pi-bridge-evidence.md) and
[historical incidents](legacy-managed-history.md); replacement tests do not
retroactively resolve deployment failures.
