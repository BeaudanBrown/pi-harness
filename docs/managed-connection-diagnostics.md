# Managed connection diagnostics (#132)

## Scope and acceptance

This is diagnostic instrumentation, not a reconnect fix or a migration. Root
cause and restoration of the missing Matrix reply remain open in #132.

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Identify which endpoint closed and why | Fixed reason categories on existing adapter and relay close paths; first observed reason wins | Adapter fault tests, malformed/oversized/duplicate IPC tests, competing attachment and 4096-ID limit test |
| Correlate without content | UTC time, process ID, connection/conversation/attachment IDs, protocol message types and counters only | Logger allowlist/redaction tests |
| Bound logs across reconnects | One logger retained by each adapter extension instance / relay startup, maximum 64 records; maximum 256 permitted in the helper | Budget test |
| Preserve fail-closed behavior | Same socket shutdown branches, registry detach and reconnect logic; diagnostic sink exceptions contained | Existing adapter and IPC suites plus throwing-sink tests |
| No operational mutation | No schema, durable state, replay, restart or migration changes | Diff inspection; deployment remains separately authorized |

## Reading the diagnostic build

Both endpoints write single-line JSON prefixed `[managed-connection]` to stderr.
The relay's records appear in its service journal; the adapter's appear in its
existing terminal/stderr destination. They are **not** Pi history entries,
Matrix messages, or additional user notifications. Do not capture raw socket
frames or whole transcripts to obtain these records.

A record is emitted at socket closure, or immediately on rejection of OS peer
credentials. `peer_closed` means the endpoint observed closure without a local
failure category; it does not prove the other endpoint crashed. Correlate both
sides using the attachment ID and timestamp. Client and server connection IDs
are independently generated. Unattached relay clients have no logged
conversation ID, and rejected attachments may have no shared attachment ID.

`lastSentType` is the last attempted outgoing protocol type, not proof of
successful delivery. `sent` counts send attempts; `received` counts successfully
parsed envelopes (including a duplicate/rejected envelope). `lastReceivedType`
is the last successfully parsed type, **not** the type of a malformed frame or
necessarily the asynchronous handler that failed. `pending` counts pending
requests on the adapter and active host requests on the relay, respectively.
Missing fields mean unavailable/filtered metadata, not zero.

Examples of useful categories:

- `invalid_frame` / `frame_too_large`: local decoder rejected inbound data.
- `unexpected_reply`: adapter rejected an unrecognized/mismatched correlation.
- `unsolicited_handler_failed`: an adapter inbound callback failed.
- `attachment_conflict`: an attachment was explicitly rejected as already owned.
- `handler_rejected` / `connection_handler_failed`: relay rejected a handler
  operation or its connection-work promise failed.
- `request_id_limit`: relay reached its existing 4096-ID connection bound.
- `expired_reply_limit`: adapter exhausted its existing expired-correlation bound.
- `managed_detach` / `local_shutdown`: expected local lifecycle paths.

No raw exceptions, credentials, nonces, message IDs, bodies, paths or frame bytes
are recorded. Unknown fields and protocol types are discarded by the logger.
Diagnostics stop after 64 records per logger lifetime, including normal closes;
absence of further records is **not** evidence that an outage ended. Do not
restart processes to reset this budget without separate approval.

## Deployment-only follow-up

After separately authorized publication/pinning and an operator rebuild, verify
the relay is running the diagnostic revision. A still-running old Pi adapter
will not gain diagnostics merely because the relay was rebuilt; refreshing or
relaunching this conversation also needs separate authorization. Capture a few
consecutive diagnostic records from both endpoints before changing runtime or
migration state. Preserve queued input and the missing reply's original history.

This instrumentation has no new persistent state or retry side effects: a crash
can lose diagnostic output, but cleanup/recovery semantics are unchanged. Do not
infer successful Matrix projection from a restored socket.

## Verification

TypeScript compilation and the six focused Node suites passed: 69 tests passed,
14 packaged SDK/security-helper cases skipped. The suites cover connection
diagnostics, adapter, relay IPC, relay/adapter integration, host adapter controls
and startup IPC (`tests/managed-session-*.test.ts`). Both Standards and Spec
reviews reported no findings; LSP diagnostics are clean. Detailed artifacts are
recorded in #132.

Canonical Nix verification, production builds, activation and live diagnostic
acceptance remain pending separate authorization. No deployed root cause or
repair is claimed here.
