# Stateless !pi assistant (#90)

## Contract and implementation boundary

A separate NAS service observes a dedicated Matrix login session for
its configured owner. It never logs in, joins rooms, provisions chats or changes
bridge configuration. An explicit room allowlist is the deployment default;
`allJoinedRooms` is an intentional expansion to rooms that account already joins.
Encrypted rooms and Spaces are unsupported. The first sync is a discard-only
watermark. Newly observed rooms and limited timelines are also discard-only,
with durable per-room timestamp floors covering every event in the skipped
batch. Replays at or before those floors remain ineligible after restart.

Only new, bounded `m.text` messages beginning exactly `!pi ` (or a newline/tab
after `!pi`) from the owner or explicitly configured remote-owner puppet MXIDs
qualify. Puppet MXIDs must be verified from bridge-owned identity evidence before
configuration; never use display names or discover them from message content.
Edits, replies/threads, attachments, encrypted messages and generated answers
are not commands. The transport sees sync events to filter them; only the question
is sent over a private Unix socket to the model worker. No timeline, room ID,
sender, Matrix credential or operational database is sent to the model.

The model worker uses the pinned Pi Codex OAuth refresh implementation and the
same fixed ChatGPT Codex backend as the existing web-search extension. It does
not start Pi, load an agent session, discover resources or implement local tools.
Each backend request contains a fixed instruction, one question and exactly the
hosted `web_search` tool with automatic selection. No previous response ID or
conversation is reused. A completed response is required; unsupported tool calls
and incomplete responses fail closed. A dedicated OAuth login is required: do
not concurrently reuse a rotating refresh credential from an interactive Pi.
This uses ChatGPT entitlement, not an implicitly provisioned paid API key.

The Matrix transport sends plain `Pi: …` text with no mentions or reply routing.
With an owner login the bridge should use that owner's existing remote login,
not bot relay mode. This remains a live acceptance requirement on each bridge;
Facebook relay being disabled alone does not prove or disprove this path.

## Security and operational boundaries

The two processes run as different systemd DynamicUsers. Only the transport gets
the Matrix token; only the worker gets the Codex credential. Their shared group
permits a bounded question/answer Unix socket, not access to private state or
credentials. Home and host database sockets are hidden. No secrets, ordinary
messages, model questions/answers or remote error bodies are logged.

The owner Matrix token has account-wide authority even during allowlisted tests.
Application filters are not a server-side token scope. If the owner account is a
homeserver administrator, its login token also inherits that authority: a new
session does not downgrade privileges. Prefer a non-admin owner account where
possible; do not supply an application-service token. Provisioning/activation
requires explicit operator acceptance of this authority. A server administrator,
compromised bridge/application service or stolen owner token is outside the
sender-authentication boundary. Unknown puppet attribution must fail closed.

One request executes at a time. Questions, replies, HTTP bodies, sync timelines,
queue size and request age are bounded. Accepted questions/replies are stored
privately only until their operational phase finishes; no conversational memory
or ordinary-message history is stored. Completed tombstones expire after seven
days; the short timestamp admission window prevents old tombstones becoming
fresh requests. Saturation drops new commands with a content-free diagnostic.

Before sending, a durable `sending` state is committed. After an uncertain HTTP
outcome or restart in `sending`, the request becomes terminal `uncertain`; the
service does not resend it, even with the same Matrix transaction. This favors
no duplicate remote replies over guaranteed delivery. Matrix acceptance is not
proof of downstream bridge delivery. Interrupted model work becomes a fixed
failure reply, not a fresh model retry. No background history recovery is used.

## Acceptance-to-evidence matrix

| Requirement | Deterministic proof | Live deployment gate |
|---|---|---|
| owner-only question selection | unauthorized, malformed, metadata, echo, age and relation fixtures | owner outgoing echo identity on each bridge |
| no ambient tools/context | exact native request body, forbidden output and fresh-request tests | supported Codex model/auth and search round trip |
| room scope/encryption | allowlist, initial/new/limited sync, state failures | new Note to Self room and native Matrix |
| minimal durable recovery | SQLite phase/restart and uncertain-send fault injection | outage/restart with approved chats |
| isolation | packaged worker/transport tests and generated unit assertions | NAS credential provisioning and activation |
| linked-account replies | fixed destination and plain prefix tests | Signal/Facebook group and ordinary DM tests |

The operator has repaired Signal's encrypted mirrors and management room and
confirmed Note to Self works manually. Its old room ID is obsolete. Prior
preflight verified one connected login and owner admin permission per bridge.
Those facts do NOT establish automated !pi intake or full bridge acceptance.
No personal test chats beyond the operator-approved targets may be used.

## Crash-boundary matrix

| Boundary | Recovery |
|---|---|
| sync received before acceptance transaction | replay from previous cursor; deterministic event identity |
| accept/advance cursor | one SQLite transaction, no ordinary messages stored |
| queued before model | continue only while fresh; expire to a fixed reply; discard pending work on credential or authorization-policy changes |
| running before result commit | fixed interrupted failure, never repeat the model |
| ready before send | recheck room state and membership, then send once |
| sending before/after HTTP acknowledgement | mark uncertain and erase text; never blind retry |
| done before next sync | tombstone suppresses replay; fixed prefix suppresses echoes |
| OAuth refresh before durable rotation write | reauthentication may be needed; no credential guessing |

Memory, history, workspace tools, chat provisioning, encrypted Matrix, and
unconditional support for arbitrary bridges remain deferred. #90 stays open
until approved live group/DM and native Matrix acceptance.

## Operator activation (not performed by the agent)

1. Approve use of a dedicated login session for the existing Matrix owner account.
   The token can read/send as that account, not merely in the test allowlist; if
   that account is a homeserver admin, it also carries those privileges. This
   is not a new bridge/bot identity and does not add remote participants.
2. Provision `pi-chat/matrix-token`: a file containing only that dedicated
   session's Matrix access token and an optional final newline. Do not use a
   bridge appservice token, a password, a whole environment file, or the token
   belonging to an actively used Element device. Never paste it into Matrix.
3. Create a separate ChatGPT/Codex OAuth login using raw Pi with a dedicated
   `PI_CODING_AGENT_DIR` and `/login`. Do not copy a credential whose refresh
   token will continue to be used/refreshed by interactive Pi elsewhere.
   Provision `pi-chat/codex-auth`: JSON with exactly one `openai-codex` property,
   containing that login's `type: oauth`, `access`, `refresh`, `expires`, and
   provider metadata. No other provider credentials belong in this file.
   Use the normal private SOPS workflow; no secret values enter Nix source.
4. Obtain the NEW Matrix room ID for repaired Note to Self. Start with only
   this approved room and your real owner MXID. Send a synthetic `!pi` from
   Matrix first. Then test the same command from Signal. If it appears from a
   bridge puppet rather than the real owner MXID, verify that exact puppet's
   remote self identity before adding it to `remoteOwnerUserIds`. Do not loosen
   the sender check or configure every bridge sender to make a test pass.
5. Configure the following in the NAS instance, register the two SOPS secret
   names using existing dotfiles conventions, then activate through the normal
   operator-controlled NAS deployment. The snippet is a template, not an
   already applied NAS change:

```nix
services.pi-harness.bridgeChat.assistant = {
  enable = true; # only after approving credential authority and test scope
  homeserver = "https://matrix.bepis.lol";
  ownerUserId = "@beau:matrix.bepis.lol";
  matrixTokenFile = config.sops.secrets."pi-chat/matrix-token".path;
  codexAuthFile = config.sops.secrets."pi-chat/codex-auth".path;
  roomIds = [ "!REPLACEMENT_NOTE_TO_SELF_ROOM:matrix.bepis.lol" ];
  remoteOwnerUserIds = [ ]; # exact independently verified self puppets only
  allJoinedRooms = false;
  model = "gpt-5.4"; # verify this account's entitlement; no silent fallback
};
```

6. Check `pi-chat-model.service` and `pi-chat-transport.service`. Their journals
   contain only bounded operational codes, not prompts, answers or credentials.
   `model_socket_ready` means local readiness, not backend authentication proof;
   wait for `watermark_initialized` before sending test commands. `matrix_reply_accepted`
   means only Matrix accepted the event, not that Signal/Facebook delivered it.
7. Test direct answers, a current-facts question requiring web search, failures,
   forbidden-tool instructions, and owner/other-participant trigger isolation.
   Extend the allowlist only to approved Signal/Facebook groups and ordinary
   DMs and a native unencrypted Matrix room. Only after acceptance consider
   `allJoinedRooms = true`. Neither service invites itself into inaccessible rooms.

Recreating a portal changes its ID: update the allowlist. Changes to credentials
or transport configuration establish a new discard-only watermark and discard
pending work. A first command in a newly observed room is intentionally ignored;
subsequent fresh events are eligible. Limited sync timelines are not backfilled.
Changing to a new Codex seed replaces the worker's saved credential on restart;
otherwise durable refreshed credentials survive restarts. An interrupted OAuth
rotation can require a new dedicated login.

To stop the assistant, disable the option and deploy normally. Do not reset
Signal/Facebook logins or delete portals as assistant recovery. The private
`pi-chat-model` state contains refreshed OAuth credentials; `pi-chat-transport`
state contains only bounded operational requests/tombstones. Never share either
state directory or raw credential files in a diagnostic report.

## Deterministic verification

`nix build .#checks.x86_64-linux.bridge-chat --no-link` runs transport admission,
SQLite crash/replay tests, worker HTTP/capability/credential tests, an actual
packaged worker startup and generated Nix service-isolation assertions. It is
also included in `nix run .#verify`. `nix build .#bridge-chat --no-link` builds the
production pair without enabling them or touching a host configuration.
