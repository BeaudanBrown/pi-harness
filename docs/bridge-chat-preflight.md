# Bridge chat preflight — phase one of issue #90

This is **not the `!pi` assistant**. It is a deployable, read-only prerequisite for
checking the existing bridge logins without granting a coding session access to
bridge credentials. Model execution, automatic room intake, owner-command
routing and replies remain unimplemented. The earlier Signal group proposal is
not the scope of the minimal assistant.

Enable `services.pi-harness.bridgeChat.preflight` on the host running the bridges:

```nix
services.pi-harness.bridgeChat.preflight = {
  enable = true;
  ownerUserId = "@operator:example.com";
  bridges.signal = {
    endpoint = "http://127.0.0.1:29328";
    credentialFile = "/var/lib/mautrix-signal/config.yaml";
    serviceUnit = "mautrix-signal.service";
  };
};
```

The containing pi-harness NixOS module must be imported. Preflight does not require
managed sessions or start Pi. Its private runtime consists only of an isolated
Python interpreter and SafeLoader YAML parser. Paths above are runtime strings,
never `builtins.readFile` inputs or secret Nix paths.

## What activation does

The `pi-bridge-chat-preflight` system service runs once during activation/startup,
after the configured bridge units. systemd copies their runtime configuration
files with `LoadCredential`; existing SOPS ownership and permissions remain
unchanged. The process uses a dynamic user, read-only filesystem protection,
hidden home directories, no capabilities, literal-loopback networking, a 45-second
service deadline and a 128 MiB memory limit. Each of at most eight probes has an
absolute four-second alarm covering parsing and slow-drip HTTP responses, leaving
13 seconds for startup/report overhead. It creates no persistent state.

It reads only its credential copies and public settings. It issues only the fixed
provisioning **GET whoami** for the configured Matrix owner. It does not login,
provision groups, change relay settings, list/read room messages, send messages,
invoke a model or query PostgreSQL. Proxy settings are ignored; redirects are
never followed. Configuration and response bodies are bounded. Exceptions, token
values, response bodies, login IDs, names, phone numbers and room IDs are never
printed. Only known status strings, booleans and counts enter the journal.

This is credential isolation for a **trusted diagnostic**, not the future model's
permission design. The copied YAML contains powerful bridge credentials and is
never to be passed to a model runtime.

## Operator handoff

After updating the harness input and applying the NAS configuration using your
normal rebuild procedure, inspect:

```sh
systemctl status pi-bridge-chat-preflight.service --no-pager
journalctl -u pi-bridge-chat-preflight.service -b --no-pager -o cat
```

The oneshot normally becomes inactive after finishing; that alone is not failure.
Share the single diagnostic JSON report, not runtime configuration or secret
files. Report entries are anonymous ordinals in sorted configuration-key order;
labels themselves are never printed. For the supplied NAS configuration,
`bridge-1` means Facebook and `bridge-2` means Signal. Adding/removing entries can
change that mapping. To repeat later, an authorized operator can start the oneshot again.

- `inspected`: authentication worked; inspect login counts. It does **not** mean
  `!pi` intake or reply delivery works.
- `provisioning_disabled`: no usable provisioning secret was configured. No
  authentication attempt was made; do not rotate existing credentials blindly.
- `credential_unresolved`: runtime YAML still contains a variable placeholder.
- `unauthorized`: the endpoint returned 401/403.
- `probe_timed_out`: that bridge exceeded its absolute four-second budget; the
  report still includes the other bridges.
- `request_failed` / `http_error`: unreachable or unexpected/bounded-invalid API
  response. No sensitive upstream error text is included.
- `config_unavailable`: credential configuration is missing, unsafe or invalid.
  A missing LoadCredential source can instead prevent systemd starting the probe.
- `relayEnabled: null`: no explicit boolean was found; this is not proof that
  runtime relay defaults are enabled or disabled.
- `explicitOwnerPermission: unspecified`: no recognized explicit owner entry;
  wildcard/default permission resolution is not inferred.

A completed diagnostic exits successfully even if bridge inspection reports a
problem; read the per-bridge status. `liveMessagePath` always remains `unverified`.
The next stage still requires controlled Signal/Facebook group and direct-chat
round trips and selecting a supported Matrix intake mechanism. Unencrypted
ordinary Matrix rooms can be a target; encrypted rooms need separate support.

No new secret is automatically generated. If the report shows missing
provisioning configuration (possible for Facebook), configure the required secret
through the owner's SOPS workflow after inspecting this result. Do not paste
secrets into chat, grant broad sudo, or expose provisioning over the public proxy.

## Verification

`nix build .#checks.x86_64-linux.bridge-chat-preflight --no-link` tests actual
loopback GETs, no redirect/proxy use, response and file bounds, secret redaction,
unsafe YAML, malformed logins, symlink/FIFO rejection, generated module settings,
store-path credential rejection and execution of the packaged isolated runner.
It is included in `nix run .#verify`. These deterministic tests do not constitute
NAS activation or live Signal/Facebook acceptance.
