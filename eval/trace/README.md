# Evaluation trace capture and deterministic metrics

`executeAndCaptureEvalRun()` is the failure-safe lifecycle seam: it executes one
RPC/workspace operation, stops the RPC process so stdout/stderr/exit evidence is
complete, and captures workspace after-state plus all trace artifacts whether
that operation succeeds or throws. `captureEvalRunArtifacts()`
is the lower-level pure capture seam for already-complete snapshots. Both accept
immutable RPC evidence, deterministic run timestamps, workspace evidence, and
optional declared behavior policy. Neither starts a model or endpoint.

## Artifact set

Every invocation, including failed, malformed, crashed, and timed-out runs,
produces:

- exact parsed `commands.jsonl`, `records.jsonl`, and event-only `events.jsonl`;
- exact captured `stdout.jsonl` lines and raw `stderr.txt` bytes (with decoded
  string fallback for imported legacy diagnostics);
- diagnostics, messages, entries, session stats, final RPC state/text, and
  workspace before/after JSON;
- `metrics.json`, bounded `report.md`, and indexed `trace-result.json`.

Raw input records are neither annotated nor mutated. RPC record arrival times
are captured separately in `diagnostics.json` and are used only when an event
does not provide its own timestamp. Derived JSON uses recursively sorted object
keys; raw JSONL retains record and property order.

## Metrics v1 (`schemaVersion: 1.0.0`)

Reliability passes only when there is no declared run failure, the trace reaches
`agent_settled`, the process status is zero or unavailable, and no timeout,
extension error, tool error, non-retryable error, or length-truncated completion
is observed. Timeout count comes from the run failure classification. Extension
errors are `extension_error` or extension-sourced `error` records; tool errors
are errored `tool_execution_end` records; non-retryable errors are `error`
records with `retryable: false`; truncation is a completed assistant update with
reason `length`.

Efficiency definitions:

- wall clock is rounded non-negative `finishedAtMs - startedAtMs`;
- first-tool/useful-tool latency uses event timestamp, then separately captured
  arrival time, otherwise `null`;
- turns count `turn_start`; tool calls count `tool_execution_start`;
- unique calls count tool names; identical repetition compares tool name plus
  stable arguments and counts occurrences after the first;
- calls before useful action use the caller's declared useful-tool set;
- token fields come from session stats and remain `null` when unavailable;
  cache tokens combine available cache-read/cache-write counts;
- peak context uses `contextUsage.tokens`; compactions count
  `compaction_start`; response length is JavaScript character length.

Tool behavior compares observed tool names with declared required, forbidden,
stale, and useful sets. Blocked attempts use tool results marked `blocked: true`
or `code: "BLOCKED"`; repeated failures use the same stable call identity;
authority-changing commands match configurable substrings (defaults:
`git checkout`, `git commit`, `git reset`, and `nix flake update`);
UI requests are unexpected unless their payload (without transport type/id)
exactly matches a declared request.

Workspace changed paths are the sorted union of Git porcelain paths and
before/after inventory differences. Protected paths use exact/prefix matching.
Git is clean only when status is empty and after-evidence has no capture errors.
Commit and grader-failure counts are explicit evidence supplied by their owning
layers.

The Markdown summary is capped at 4,000 characters and failure text at 500
characters. Tests use only fabricated fixture traces under
`tests/fixtures/eval-traces/`.
