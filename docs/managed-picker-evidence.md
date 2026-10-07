# Managed picker handoff evidence (#118 / #119)

## Authorization and ownership

Implementation belongs to nix-dotfiles, not this harness. Operator authorized
source changes, local commits and direct Go/disposable-tmux tests in
`/home/beau/documents/nix-dotfiles-managed-live-workspaces`. No external Nix
evaluation/build, push, activation, service/shared-tmux restart or live traffic.

Operator clarified #118: **managed selection fails closed during relay outages**;
ordinary sessions/raw paths remain available. This supersedes offline marked-window
switching: birth-bound tmux ownership cannot prove absence of retirement.

## #118 implementation

External commit `2286765` (baseline `1ea4bf7`): public bounded inventory and
single generation-fenced window-first open; exact captured name/PID focus; coordinator,
dormant, starting and failed-state rows; immutable conversation keys; canonical
checkout digest dedup; mixed ordinary sessions retained; autojump/name ordering.
No private-registry parsing, stop/delete/refresh hotkeys, launch replay or cancellation.
Ordinary rows explicitly target unmarked windows, so a mixed session's selected
managed window cannot bypass outage refusal. Raw paths are validated before shell
creation. Host lifecycle retains ownership of launch joining and error-window retry.

Acceptance/crash matrix and implementation notes live in the owning repository's
`.loom/workstreams/managed-picker/handoff.md`; durable behavior is documented in
`specs/tooling.md`.

Verification: **58 top-level Go tests passed, zero skips**, including seven new
picker tests (plus inventory subcases) and all existing ownership/kernel/PTY tests.
Focused and full logs:
- `.pi/tmp/workers/2026-10-07T23-52-10-738Z-picker-focused-contracts-401b51403991/`
- `.pi/tmp/workers/2026-10-07T23-55-33-349Z-picker-full-isolated-6c7c024bde4d/`

The integrated picker uses a fake public CLI and selection executable with real
private-socket tmux focus; no live relay is contacted. Backend single-launch,
startup/attachment and retained-window semantics remain covered by the harness's
existing #110 suite (last canonical gate at #117: all 12 checks passed). External
Go LSP lacks an active workspace; direct Go compilation/tests provide evidence.
`git diff --check` passes. No external Nix validation was run or implied.

Individual subjective review is omitted at this boundary; cumulative review is
still required. Real-fzf progressive discovery, cache/cancellation and latency
measurements remain #119, not evidence supplied by these fixture tests. Nothing
has been pushed or deployed; desktop/Element X acceptance remains separately gated.
