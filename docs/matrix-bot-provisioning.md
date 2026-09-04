# Managed Matrix host-bot provisioning

Managed sessions use one non-admin Matrix bot account per enabled host. The bot is a relay identity, not a human account. It owns that host's private Space and rooms. Every currently joined room member has equal conversation, control, checkpoint, and session-management authority except the relay bot itself and exact service-account MXIDs configured as ignored senders.

The legacy `pi-matrix-whoami` command, per-Pi `remote-session` extension, `/remote on|off`, and `services.pi-harness.remoteSession` option have been removed. Legacy rooms and sidecar state are not imported.

## Provision the account

1. Create one normal, non-admin Matrix account for the host.
2. Record its full MXID as `managedSessions.botUserId` and the initial invited human MXID as `managedSessions.operatorUserId`. Configure exact non-human bridge management accounts in `managedSessions.ignoredSenderUserIds`; never use display names or wildcard “bot” matching.
3. Create a dedicated Matrix login/device and obtain its access token through the homeserver's supported login flow. Do not paste the token into Pi, Git, issues, command arguments, Nix expressions, or tmux.
4. Render a private SOPS-managed file containing exactly:

   ```text
   PI_MATRIX_ACCESS_TOKEN=<opaque-token>
   ```

   The file must be a regular non-symlink owned by the relay user, mode `0400` or `0600`. The token is preserved as opaque bounded single-line data.
5. Configure the host:

   ```nix
   services.pi-harness.managedSessions = {
     enable = true;
     user = "operator";
     environmentFile = config.sops.templates."pi-managed-session.env".path;
     homeserver = "https://matrix.example.com";
     botUserId = "@pi-host:example.com";
     operatorUserId = "@operator:example.com";
     ignoredSenderUserIds = [
       "@signalbot:example.com"
       "@facebookbot:example.com"
     ];
     hostId = "workstation";
     workspaceRoots.projects = "/home/operator/documents/projects";
     launcherPackage = pkgs.tmux_project;
   };
   ```

The homeserver must be a credential-free HTTPS origin. The bot must remain non-admin. Use separate accounts/tokens for separate hosts.

## Activate and verify

After switching the host configuration, run as the relay user:

```sh
pi-managed-session-status
systemctl --user status pi-managed-session-relay.service
journalctl --user -u pi-managed-session-relay.service -n 50
```

The first successful relay start verifies `/account/whoami` against the configured bot MXID, creates or recovers the private host Space and coordinator room, and performs a cursor bootstrap without executing retained historical commands. Send ordinary text to the coordinator room and confirm one normal response. Then use coordinator lifecycle tools to create a disposable project conversation and verify its first Matrix message reaches the persisted Pi session.

Invite another human only when they should receive full authority over that conversation. Before each acceptance batch, the relay obtains one bounded current joined-member snapshot for the room; invited-but-not-joined and departed users cannot act. Accepted operations remain durable if their sender later leaves. Exact ignored service accounts cannot act even while joined. Other joined application-service puppet accounts are treated as human participants with full authority. Matrix invitations, bans, and power levels remain operator-managed and are not changed by the relay. The relay also ignores foreign rooms, malformed relations, unsupported event/media types, stale bootstrap events, and oversized/limited timelines until safe cursor recovery is possible.

## Rotation and recovery

Token rotation does not recreate rooms, manifests, Pi sessions, queues, or projections. Create a replacement login for the same bot MXID, atomically replace the SOPS-rendered token file, restart the user service, run `pi-managed-session-status`, verify an existing room round trip, and only then revoke the old device.

For outage, rate-limit, cursor, registry, lifecycle, transcript, checkpoint, stop/delete, troubleshooting, and deferred-scope details, use the complete [managed Matrix sessions runbook](managed-matrix-sessions.md).
