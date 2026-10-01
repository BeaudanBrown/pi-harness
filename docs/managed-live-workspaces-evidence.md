# Live-workspace implementation evidence

Implementation authorised by the operator in the epic conversation. Deployment,
activation, live migration and push are not authorised. GitHub #103 remains the
tracker; this file records acceptance evidence, not a second task queue.

## #105 — default-off experiments

| Acceptance | Change | Evidence |
| --- | --- | --- |
| Default normal resources exclude experiments | Engineering profile and guarded package resource selection | Profile/source tests; real packaged RPC command/tool inventory |
| Explicit opt-in, disabled beats development paths | Strict 0/1 launcher switches; NixOS experiment options | RPC probes with stale development overrides; enabled Pi-R probe |
| Dedicated local evaluator unchanged | Keep pi-r-local and its runtime environment/identity | Pi-R integration and eval self-test |
| Managed and inherited workers remain narrow | Existing managed exclusions and worker profiles retained | Profile/module contracts |

Scope: #105 owns experiment resource defaults, not local-only binding/launch
semantics (#116). `pi-local` remains the dedicated experimental lean profile.
No durable state or external side effects change; crash analysis is inapplicable.
Verification: `nix build` of `pi-r-integration`, `source-contracts`,
`module-contracts`, `unit-tests`, and `eval-self-test` passed (2026-10-01).
The real packaged RPC probes cover unset and explicit-off switches, stale
AgentGraph development paths, invalid switch values, opted-in Pi-R activation
and restoration, and unchanged lean Pi-R behavior. Workspace LSP diagnostics
are clean. Canonical aggregate verification and cumulative review remain at the
epic boundary. Local-only alias integration is owned by #116.
