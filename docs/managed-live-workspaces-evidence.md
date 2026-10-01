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
are clean. `nix run .#verify` subsequently passed against commit 9893e0f.
Cumulative review remains at the epic boundary. Local-only alias integration is
owned by #116.

## #104 — foundation contracts

| Acceptance | Change/evidence |
| --- | --- |
| Separate identity from title and generations | Target identity/persistence table and ADR amendment |
| Exact operations, actor origin, pagination and errors | Host action/request syntax fixtures, all-operation classification test, CLI/result tables |
| Launch/retirement/approval precedence | Durable phase and recovery tables with dependent test ownership |
| Authenticated bounded host/NAS protocol | Strict account schema, full hierarchy fixtures, credential/endpoint negative tests |
| Frozen notification and recovery semantics | Projection contract and once-attempted rule recovery fixture |
| Old adapters and pending #63 boundary | Explicit baseline inspection and capability/sidecar rollout specification |

Scope: #104 pins target contracts only. Runtime adoption, authentication and
external effects remain owned by the dependent leaves listed in the foundation
contract. The schemas do not prove those behaviors. Recovery analysis is the
contract's crash-boundary matrix. The operator resolved uncertain notification
setup: continue synchronization with current client settings and a warning,
never automatically overwrite a potentially later manual preference.

Focused `managed-session-tests` and `source-contracts` passed before review.
Standards review: two high current-issue findings (executable response contracts,
Matrix origin shape) and one medium (account digest/ID binding). Spec review:
two medium current-issue findings (response contracts, protected coordinator
policy) and one low traceability correction. All accepted and remediated in one
batch: strict per-operation response schemas with every-operation fixtures,
bounded frames/errors, typed Matrix room/MXID provenance, canonical account
identity validation and tampering fixtures, target-aware coordinator protection,
and corrected issue reference. Runtime authentication still belongs to dependent
leaves, not schema validation. Post-remediation `nix run .#verify` passed all
deterministic checks on 2026-10-01; workspace LSP diagnostics are clean. This is
contract-only work, so no separate runtime production build or live activation
is applicable. The gate includes the production package contract build.
