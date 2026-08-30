# Verified current-checkout evaluation launcher

`launchVerifiedEval()` is the only live-evaluation process startup seam. It
reads the Nix-generated launcher identity, canonicalizes the launcher and pi-r
resource paths, verifies the candidate project Git identity, starts
`pi-r-local` in RPC mode, verifies its machine-readable startup attestation of
the effective pi-r resource/extension/skill paths, and checks the active model
with `get_state`. It
returns the `PiRpcEngine` only after all checks pass, before any prompt command
can be sent.

The expected identity is supplied independently by the run coordinator. A
mismatch stops the complete RPC process tree and retains
`launcher-provenance.json`. Production callers cannot silently fall back from a
candidate pi-r checkout to locked or deployed resources.

Provider configuration is inherited from the environment. Optional overrides
are passed to the child but only sorted key names are recorded. Credential-like
arguments and URI userinfo are rejected; provenance retains option names while
redacting every positional or inline argument value. No endpoint is started, supervised, or
health-checked. `concurrency` defaults to one and must be a positive integer;
parallel scheduling remains a coordinator concern.

The package identity can be rebuilt against a current checkout with:

```bash
nix build .#default --override-input pi-r "path:$(realpath ../pi-r)"
```

This seam is synthetic/offline-testable with a fake RPC process. Live local
Qwen execution remains explicitly opt-in and belongs to the later golden-path
issue.
