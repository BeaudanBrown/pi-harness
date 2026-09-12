# Stateless !pi assistant (#90)

## Shared implementation, separate policies and accounts

The managed engineering relay and chat assistant share `matrix-shared/http.ts`:
HTTPS authentication, bounded JSON streaming, cancellation, deadlines, safe
retry mechanics and sync requests. They keep separate account credentials,
sync cursors, room authorization, message selection and delivery state.
The managed relay retains its room guards, media handling and bounded history
recovery; chat never imports that history recovery or engineering lifecycle.

Chat's TypeScript `OwnerMatrix` uses one attempt for every request, including
PUT sends. The managed relay retains its existing retry policy. An uncertain
bridge send must not accidentally inherit the engineering relay's retry behavior.
The old standalone Python client and direct-Codex model worker are removed.

A dedicated Matrix login session for the configured owner observes rooms the
account already joins and sends through its existing linked bridge accounts.
It does not join rooms, provision chats or change participants/bridge settings.
The default deployment requires a room allowlist; `allJoinedRooms` is an explicit
expansion, not server-wide access. Encrypted rooms and Spaces are unsupported.

The owner token carries account-wide authority even while processing only an
allowlist. If the owner is a homeserver administrator, its session also inherits
those privileges. Application filtering is not a server-side token scope. The
operator must approve that authority; do not use an appservice token. A stolen
owner token or compromised homeserver/bridge is outside sender authentication.

## Input contract

Only new bounded `m.text` messages beginning exactly `!pi ` (or newline/tab after
`!pi`) from the owner or independently verified owner puppet MXIDs qualify.
Do not discover authority from display names or message metadata. Puppet IDs
are empty by default. Edits, replies/threads, attachments, encrypted messages,
ordinary chatter and generated `Pi:` replies do not become model requests.

Initial sync, newly observed rooms and limited timelines are discard-only.
Durable per-room timestamp floors cover every observed event in skipped batches;
replays at or before a floor remain ineligible after restart. No history fetch
fills a limited timeline. A first command in a new room can therefore be ignored;
only demonstrably subsequent events qualify. Origin timestamps are trusted only
as homeserver/bridge event metadata, not as caller-supplied command arguments.

The transport must see incoming events to filter them. Only the question suffix
crosses the private question/answer Unix socket: no room ID, sender, Matrix token,
attachments or surrounding timeline. Ordinary messages are never retained.

## Pi SDK execution and existing authentication

The worker uses the same pinned Pi SDK as the installed Pi package. Packaging
includes the SDK's runtime dependency tree, not merely its declarations. The
worker runs as the existing Unix Pi user and uses the original `auth.json` through
Pi's `ModelRuntime`; no new login, copied OAuth seed or Codex SOPS secret is needed.
The original agent directory is bound at the same path so interactive Pi and
the worker use the same sibling auth lock. Pi owns refresh and credential writes;
this integration does not implement a second refresh loop or token-copy scheme.

Every question creates a fresh `SessionManager.inMemory()` session and in-memory
settings. A custom empty resource loader prevents discovery of context files,
extensions, skills, templates and themes. Custom model files/catalog refreshes
are disabled. Only the explicit built-in Codex model is selected; no silent
fallback to another model or paid API-key setup. The existing Pi login must
include ChatGPT/Codex for the web-search tool. Entitlement is a live gate.

`noTools: builtin` plus an exact `web_search` allowlist prevents local tools.
The entire registered/active tool set is checked. Search is the same tool
factory used by the normal harness extension, defaulting to `gpt-5.6-luna`
(independent of the answering model), with cancellable Pi-managed authentication
and redacted errors. All callers receive the same 48,000-byte UTF-8 search text
limit, with an explicit truncation notice. There are no additional chat-specific
search call, concurrency, argument or HTTP-body limits. Pi chooses whether
to call it. No request reuses another request's session or previous-response ID.
Plain question text is passed with prompt/template/skill expansion disabled.
Answers must finish normally; aborted/partial responses are never delivered.
Execution is limited to four turns, ninety seconds and bounded text output.

Future tools or directory access are explicit reviewed capability upgrades to
this module, not ambient inheritance from interactive Pi. In particular, adding
file tools requires revisiting the exposed auth-directory seam: it must not make
Pi's credentials model-readable. There is no generic arbitrary-tools option now.

## Process and persistence isolation

The transport remains a systemd DynamicUser with only its Matrix LoadCredential.
The Pi worker runs as the configured existing user, without Matrix credentials.
A shared group permits only the bounded Unix socket. Both have private state,
resource limits, strict filesystem protection, no privilege escalation and no
access to host PostgreSQL sockets. The worker's home is hidden by a tmpfs, except
for its original Pi agent directory, explicitly mounted read/write for auth
locking. That directory is available to trusted SDK auth code, **not** a model
file tool; no settings/resources/models are loaded from it. This is process
isolation, not an assertion that the worker runs under a new Unix identity.

Logs contain bounded operational codes, never questions, answers, credentials or
raw backend error bodies. Node's SQLite experimental warning is benign runtime
metadata. The worker's neutral HOME/working directory is not an engineering
project. It does not launch the ordinary engineering CLI wrapper.

The transport uses SQLite with an exclusive process lock. There is one execution
at a time, at most eight pending requests, five-minute input admission, 8KB
questions, 12KB answers, 5,000 operational records and a 16MiB SQLite page bound.
Question/answer text is erased when its phase finishes; secure_delete is enabled.
Completed tombstones expire after seven days. Saturation drops new commands with
a content-free diagnostic, rather than storing unsolicited history.

A durable `sending` phase precedes the sole Matrix PUT. Any uncertain HTTP outcome
or restart in that phase becomes terminal `uncertain`; no automatic resend.
Matrix acceptance is not proof of downstream bridge delivery. Interrupted model
work becomes a fixed failure reply, not a new model run. Membership/encryption is
checked before execution and again before sending. Configuration/token changes
establish a new discard-only watermark and discard pending work. The TypeScript
upgrade does so once too, retaining compatible SQLite state/tombstones without
replaying the old Python client's events.

## Acceptance-to-evidence matrix

| Requirement | Deterministic proof | Live gate |
|---|---|---|
| shared Matrix mechanics, distinct policies | shared-client account/filter/retry tests and managed regressions | engineering relay remains healthy |
| owner-only question selection | forged sender, relation/media, age, Unicode and echo tests | Signal self echo identity |
| no ambient capabilities/history | real SDK fake-provider tests, poisoned context/models/extension fixtures, exact registered tools | actual Pi login/model/search |
| shared auth, no credential copying | two-process Pi auth-store locking test preserving unrelated providers; packaged worker startup | original NAS Pi login still works |
| room scope and replay defense | first/new/limited/rejoin watermark tests across restart | repaired Note to Self only initially |
| bounded durable recovery | SQLite phase/uncertain-send/expiry/capacity tests | approved outage/restart test |
| linked-account replies | fixed destination/prefix, no PUT retries | Signal/Facebook ordinary DM/group tests later |

The operator approved owner-token authority, supplied the replacement Note to
Self room, and reports the Matrix secret pushed to the private secrets input.
Read-only NAS metadata confirms installed Pi and a mode0600 auth file owned by
its existing user. No credential contents were inspected. This does not prove
model entitlement or an automated assistant round trip. Broader rooms and
Facebook remain outside initial activation scope.

## Crash-boundary matrix

| Boundary | Recovery |
|---|---|
| sync before acceptance | replay previous cursor; deterministic identity |
| acceptance/cursor/discard floors | one SQLite transaction |
| queued before model | fresh only; expire to fixed reply; discard after policy change |
| running before result commit | fixed failure, never repeat model |
| ready before send | recheck scope, membership and encryption |
| sending before/after acknowledgment | terminal uncertain, no blind retry |
| completed before next sync | tombstone suppresses duplicate; prefix suppresses echo |
| shared auth refresh | Pi's original sibling lock; no copied credential; ordinary Pi recovery if interrupted |

## Operator activation

Only one new SOPS secret is needed: `pi-chat/matrix-token`, containing just the
access token from the approved dedicated owner Matrix login. Do not paste it into
Matrix. **Remove any old `codexAuthFile` option/declaration; it is no longer used.**
Do not create a second Codex login or copy an interactive `auth.json`.

Example NAS declaration (use the supplied replacement room ID in private dotfiles):

```nix
services.pi-harness.bridgeChat.assistant = {
  enable = true;
  homeserver = "https://matrix.bepis.lol";
  ownerUserId = "@beau:matrix.bepis.lol";
  matrixTokenFile = config.sops.secrets."pi-chat/matrix-token".path;
  modelUser = config.hostSpec.username;
  piAgentDirectory = "${config.hostSpec.home}/.pi/agent";
  roomIds = [ "!REPLACEMENT_NOTE_TO_SELF_ROOM:matrix.bepis.lol" ];
  remoteOwnerUserIds = [ ];
  allJoinedRooms = false;
  model = "gpt-5.4";
};
```

Ensure the consuming private secrets input includes the new Matrix secret, then
activate through the normal operator-controlled NAS workflow. The agent must not
inspect the private secrets repository or evaluate/build/restart host configs.

The transport accepts owner-only credential permissions and systemd's `0440`
credentials when the file group matches the process's effective group (the unit
uses `Group=pi-chat`). Group write/execute, all other-user permissions, and
foreign-group read access remain forbidden. Symlinks, non-regular files and files
over 4097 bytes remain rejected. Do not change the source secret permissions to
work around the permissions on systemd's runtime credential copy.

Check `pi-chat-model.service` and `pi-chat-transport.service`. Transport startup
emits `transport_stage` events before `configuration`, `credential_read`,
`matrix_client`, `identity_request`, `identity_validation`, `database_open`,
`policy_initialization`, and `running`. A fatal `transport_failed` event identifies
the last stage, an allowlisted error code (or `unknown`), and a bounded HTTP status
when available. Stages indicate entry, not successful completion; `running` does
not prove sync or model readiness. These diagnostics never include error messages,
stacks, causes, credentials, paths, response bodies, or conversation contents.
They do not alter retry, authorization, or state handling. Inspect them with:

```bash
sudo journalctl -u pi-chat-transport.service --since "15 minutes ago" --no-pager -o cat
```

Wait for `watermark_initialized` before testing. `model_socket_ready` means only local SDK
readiness, not provider verification. `matrix_reply_accepted` does not prove
remote delivery. Start with a Matrix-origin !pi in Note to Self, then one from
Signal, then direct/search/forbidden-tool/cancellation/restart cases. If the
Signal command has a self-puppet sender, verify its exact owner mapping before
configuring it; do not accept all bridge senders to make a test pass.

Do not widen room scope until acceptance. Do not reset bridge logins or delete
portals as assistant recovery. Keep #90 open until approved live acceptance;
memory, history, workspace tools, encrypted Matrix and general group provisioning
remain deferred.

## Verification

`nix build .#checks.x86_64-linux.bridge-chat --no-link` exercises the actual SDK,
chat store, private socket, shared login locking and packaged worker using only
fake credentials/model output. Shared Matrix tests belong to unit-tests; managed
regressions cover existing consumers. All are included in `nix run .#verify`.
`nix build .#bridge-chat --no-link` builds the production pair without activation.
