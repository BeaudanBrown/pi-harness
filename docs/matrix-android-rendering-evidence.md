# Android-first rendering implementation evidence (#122)

Issue: https://github.com/BeaudanBrown/pi-harness/issues/122

## Scope ownership

Current issue: Android-first managed transcript/text-event rendering, pinned
parser packaging, restart compatibility and deterministic verification.
Out of scope: stateless `!pi`, poll rendering, interactive disclosures/spoilers,
maths, inline image transport, client changes. Deployment/client visual acceptance
is operator-owned follow-up; no service restart or push is implicit.

## Acceptance-to-evidence matrix

| Acceptance | Implementation | Evidence |
| --- | --- | --- |
| Supported Markdown blocks/inline | `relay/transcript-renderer.ts`, pinned `nix/matrix-markdown*` | Android renderer fixtures; parser and relay builds |
| Android-readable tables/tasks/rules/images | Table lowering; text markers/separator/image descriptions | Duplicate/empty headers/cells, image and task fixtures |
| Safe HTML and HTTPS-only links | Token-to-allowlisted-node renderer; escaping, URL policy | Hostile HTML/encoded schemes/credentials fixtures |
| Standalone bounded continuation events | Block-first packing; code/list/container reopening | Unicode, literal code, long lists/tables, attribution and overflow fixtures |
| No silent depth truncation | Fail before parser block-nesting cutoff | Nesting overflow fixture |
| Legacy recovery | Untouched legacy renderer; lookup before new parsing | Partial v1 final/local-user upgrade fixtures and reoffer |
| Stable pending v2 transaction bodies | Versioned frozen pending payloads before send | Acceptance-before-mark restart, frozen historical-output fixture, notice retry |
| Bounded durable data | Per-field UTF-8 limits; 16 MiB host-wide frozen payload cap; release sent payload bytes | Contract/schema validation and projection fixtures |
| Checkpoints and polls | Shared text projection; unchanged poll path | Affected controls/checkpoint/poll suite |

## Crash-boundary matrix

| Boundary | Durable state / side effect | Recovery |
| --- | --- | --- |
| Before beginProjection | No Matrix event or projection yet | Prepare deterministic bounded output |
| After beginProjection, before send | Version, IDs and pending payloads durably recorded | Reuse frozen pending payloads |
| Matrix accepts, sent mark fails | Server may know txn; local chunk still pending | Same txn ID and bytes |
| Partial legacy delivery, upgrade | Old metadata and sent flags | Exact legacy renderer and old boundaries |
| Partial v2 delivery, renderer changes | Frozen pending output plus sent flags | Do not invoke new renderer |
| Sent mark succeeds | Sent identity retained; its payload bytes released | Skip sent chunks; completed reoffers do not parse or send |
| Capacity/validation failure during registry mutation | No accepted new projection | Registry rolls back state; no send |

## Verification and review

- Initial pinned parser Nix build passed; runtime dependency closure is explicitly locked.
  A follow-up advisory audit identified outdated parser releases; pin advanced to
  `markdown-it` **14.3.2**. `npm audit --omit=dev --prefix nix/matrix-markdown`
  reports **0 vulnerabilities** for the final lock. Final gate rebuilds that pin.
- Pre-review packaged managed-session check passed **267/267**, no skips, including
  production relay, lifecycle, adapter, checkpoint/poll and registry tests.
- Review-remediation focused compilation/acceptance passed **38/38**, no skips.
- Workspace LSP diagnostics and `git diff --check` passed.
- Final `nix run .#verify`: **passed all 12 deterministic checks**, including
  the final parser pin, package/module contracts, compilation and **268/268**
  managed-session tests, no skips.
- Final `nix build .#managed-session-relay --no-link --print-out-paths`: **passed**;
  output `/nix/store/4rzvkqvj49bvvwqxs51aysjwzrjx4cfr-pi-managed-session-relay-0.1.0`.
- Final gate log: `.pi/tmp/workers/2026-10-02T04-42-25-184Z-final-deterministic-verification-73084aae5052/command.log`.
- Only this evidence document was updated after the final gate/build to record
  outcomes; Markdown diagnostics and whitespace checks cover that isolated change.

### Standards

Two current-issue findings (medium/low), both accepted and fixed: reject versioned
`offered` projections, and retain inline formatting in table header labels.
Regression fixtures added for both.

### Spec

Two current-issue findings (medium/low), both accepted and fixed: advance the
continued ordered-list frame after closing an item (boundary fixtures added), and
record actual verification outcomes rather than leaving evidence in progress.

Review artifact: `.pi/tmp/reviews/2026-10-02T04-36-51-840Z-worktree-bbe2d216acb3-c1f761dac8f6/`.
No dependent or deployment code changes were introduced by remediation.

Live Android visual acceptance has deliberately been omitted at the operator's
request. No deployment, service restart or push performed. Source Markdown in Pi
history is unchanged; Matrix fallback bodies are readable semantic text, retaining
safe link destinations and literal code rather than exact Markdown delimiters.
