# Approval presentation remediation (#121)

Scope: operator-authorized replacement of raw JSON approval questions with
readable action, target and effect summaries. No changes to voting, frozen
execution authority, notification policy or publication/deployment permissions.
Desktop testing is deferred, not passed. Element X presentation needs fresh
operator confirmation after deterministic verification.

| Acceptance | Intended evidence |
| --- | --- |
| Creation explains new conversation and exact placement without JSON object dump | Real poll-content test and renderer assertions |
| Other actions retain meaningful resource scope, frozen effects and targets | Different effect/target renderer case; existing mutation-owner tests |
| Fork retains literal inherited summary, committed base and generation | Existing fork consent regression |
| Labels cannot inject lines/control characters; no private preconditions leak | Adversarial labels and existing privacy tests |
| Oversized scope fails closed, never truncates | Existing 100-target and overflow tests |
| Votes remain bound to original bot poll and exact scope | Existing real-client approval-prompt checks |

Crash boundary: rendering has no side effects. Existing pending polls retain their
original text; a new renderer cannot authorize a vote against mismatching old
content (existing exact-content check rejects it). No old poll is edited or
replayed. Fresh prompts use the new renderer; expired/restarted requests still
require the existing lifecycle rules. No persistent schema changes intended.

Focused command (21 passed), followed by affected packaged checks (579 managed /
87 bridge, zero skips), passed in
`.pi/tmp/workers/2026-10-27T12-40-41-630Z-readable-approval-focused-and-affected-bbbde190850a/`:

```sh
build=$(nix build .#checks.x86_64-linux.typescript-build --option builders '' --no-link --print-out-paths)
NODE_PATH="$PWD/.pi-types/node_modules" node --test \
  "$build/build/tests/managed-session-host-approval-prompts.test.js" \
  "$build/build/tests/managed-session-host-mutation-owner.test.js" \
  "$build/build/tests/managed-session-host-approvals.test.js"
nix build .#checks.x86_64-linux.managed-session-tests \
  .#checks.x86_64-linux.bridge-chat --option builders '' --no-link -L
```

An initial focused run exposed the 100-target display boundary. The fix removes
only duplicate representations of identical frozen conversation targets; all IDs
remain visible. Real full frozen-target lists now participate in that regression;
other target kinds remain rendered. No truncation or display limit increase.

A final exact-poll-content assertion additionally rejects an old/raw JSON
question rather than accepting consent for changed text; all six prompt tests
passed in `.pi/tmp/workers/2026-10-27T12-43-56-392Z-readable-approval-content-binding-e85c3a26db0f/`.

Paired review: **Standards: no findings. Spec: no findings.**
`.pi/tmp/reviews/2026-10-27T12-44-32-472Z-worktree-36202a38812c-ff67d3b764cd/`.
Final canonical verification passed, with live presentation confirmation pending.

First canonical run failed two existing launch/attachment timing assertions
(split-fork attachment-record timeout and coordinator-refresh missing launch):
`.pi/tmp/workers/2026-10-27T12-46-58-176Z-readable-approval-final-gate-8db497debc79/`.
No source, timeout or assertion was changed. The identical rerun passed all 12
canonical checks, including 579 managed tests with zero skips; bridge (87) and
package (13+17) checks passed, and default/relay/account packages built:
`.pi/tmp/workers/2026-10-27T12-50-29-416Z-readable-approval-canonical-confirmation-29e702773b78/`.
The first failures are retained as a timing-stability caveat, not hidden or fixed
by this presentation patch.

```sh
nix run .#verify --option builders '' -L
nix build .#default .#managed-session-relay .#bridge-chat --option builders '' --no-link -L
nix build .#managed-session-relay --option builders '' -o .pi/tmp/smoke-relay
git diff --check
```

No push, fleet lock update, host activation or migration. Existing test poll
receipts are not reused: a fresh independent request is required for phone review.

Implementation committed locally as `92f0bc6` (unpushed). Fresh real-model poll
`Readable approval test` was created using the updated standalone relay:
`.pi/tmp/workers/2026-10-27T12-53-07-258Z-elementx-readable-prompt-live-c8f0f3da55c5/`.
Authenticated event readback verifies the new readable title/placement and no
raw action JSON. Inventory remains unchanged before consent. The bounded test
supervisor is waiting for human readability confirmation and Deny; that result
and cleanup were initially pending. The operator rejected the labelled-field
layout and requested a single readable description instead. That trial was
cancelled through `!abort` and stopped; temporary credentials were removed.

## Prose refinement

Operator-requested refinement: ordinary creation becomes one sentence describing
the title, checkout/root/subdirectory and new Matrix room, without Action/Title
labels or an approval-reference footer. Internal creation/preview/approval IDs
and the literal confirmation flag remain in the immutable record, not the text.
Resource IDs, generation/session fences, branch/base/merge scope and fork context
remain visible where meaningful. Different effects and exact frozen targets still
appear; large destructive scopes cannot be collapsed into an ambiguous sentence.

Identical descriptions are deliberately possible for distinct per-call requests.
A regression must prove they still get independent poll/approval identities and
cannot share or replay votes. No change to identity derivation, voting, expiry,
executor revalidation or notification metadata. Visible expiry/reference fields
are intentionally omitted; deadline enforcement remains unchanged. The previous
branch test expected the old `Expires:` label, so it now verifies the unchanged
900,000ms internal deadline instead; stale-preview/expiry refusal assertions remain.

Refinement verification passed: **22 focused / 580 managed / 87 bridge**, zero
skips, using the same focused and affected commands above:
`.pi/tmp/workers/2026-10-27T13-05-42-239Z-approval-prose-scope-and-expiry-checks-99ec8b6a263f/`.
Refinement review: **Standards: no findings. Spec: no findings.**
`.pi/tmp/reviews/2026-10-27T13-08-07-346Z-worktree-1059340da2fb-4ef598722291/`.
Final canonical gate passed: all 12 checks, **580 managed / 87 bridge / 13+17
package tests, zero skips**, plus default/relay/account package builds:
`.pi/tmp/workers/2026-10-27T13-10-01-862Z-approval-prose-final-canonical-6ca7d1667333/`.
The command used `nix run .#verify --option builders '' --option max-jobs 1 -L`
to reduce cross-build contention; test timeouts and assertions were unchanged.
The same production build commands above passed. LSP and diff checks are clean.

No additional live poll has been sent for this prose refinement: the prior
labelled trial is stopped and credentials removed. Final wording can be reviewed
from the deterministic rendered description; no fresh phone acceptance is claimed.
Desktop testing remains explicitly deferred, not passed. Publication, fleet lock
updates, host activation and migration remain separately gated.
