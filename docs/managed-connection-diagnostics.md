# Managed connection diagnostics (#132)

## Scope and acceptance

This is diagnostic instrumentation, not a reconnect fix or a migration. Root
cause and restoration of the missing Matrix reply remain open in #132.

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Identify which endpoint closed and why | Fixed reason categories on existing adapter and relay close paths; first observed reason wins | Adapter fault tests, malformed/oversized/duplicate IPC tests, competing attachment and 4096-ID limit test |
| Correlate without content | UTC time, process ID, connection/conversation/attachment IDs, protocol message types and counters only | Logger allowlist/redaction tests |
| Bound logs across reconnects | One logger retained by each adapter extension instance / relay startup; up to 64 detail records per 60-second window plus one suppression summary | Budget and fake-clock window tests |
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
necessarily the asynchronous handler that failed. `failedReceivedType` identifies
that callback when available; `failureCode` is limited to `timeout`,
`capacity_reached`, or `other`, never raw exception text. `pending` counts pending
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
Diagnostics allow up to 64 detail records per 60-second monotonic window,
including normal closes. On the next valid event after a window expires, logging
resumes and emits one `event: "suppressed_connections"` summary if records were
dropped. Its `counts` keys are fixed side/reason categories, never conversation
IDs or message content, and each count saturates at 1,000,000. Memory is bounded
by the finite category set. At most 65 records are emitted per window by the
default logger; the helper permits at most 256 details plus one summary.

This is event-driven: no timer, background I/O, durable state or transport retry
is added. A quiet logger does not flush a pending summary until another event
arrives. Absence of further records is **not** evidence that an outage ended.
There is no need to restart a process to replenish its diagnostic budget.

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

For the probe-reply follow-up, full TypeScript and recipe-selected relay source
compilation passed; 105 tests passed across 11 affected Node suites, with 14
packaged SDK/security-helper cases skipped. Two timeout repros failed before the
fix. Coverage includes adapter/relay transport, native host proofs and recovery
attention. See [the probe-reply acceptance matrix](managed-probe-reply-backpressure.md).
Standards review had no findings; Spec review requested this verification-count
update, now addressed. LSP diagnostics are clean. Detailed artifacts are recorded
in #132.

The #135 rate-window follow-up passes the cumulative managed suite: 633 tests
passed, zero failed, 48 packaged/environment cases skipped. Full TypeScript and
recipe-selected relay source compilation also pass. Queue/latency metrics and
loaded-adapter inventory reporting remain separate, unfinished #135 work.

Canonical Nix verification, production builds, activation and live diagnostic
acceptance remain pending separate authorization. No deployed root cause or
repair is claimed here.
